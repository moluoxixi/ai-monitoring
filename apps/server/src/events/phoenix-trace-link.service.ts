import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../database/database.service';
import type { EventRow } from '../database/database.types';
import { PhoenixTaskTraceService } from './phoenix-task-trace.service';

interface PhoenixSpanNode {
  id: string;
  spanId: string;
  startTime?: string | null;
  trace: {
    traceId: string;
    project: { id: string; name: string };
  };
}

interface PhoenixResponse {
  data?: {
    projects?: { edges?: Array<{ node?: { name?: string } }> };
    getProjectByName?: {
      spans?: { edges?: Array<{ node?: PhoenixSpanNode }> };
    } | null;
    getTraceByOtelId?: {
      traceId: string;
      project: { id: string; name: string };
      spans?: { edges?: Array<{ node?: { id?: string } }> };
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

const PROJECTS_QUERY = `
  query ProjectsForTraceLink {
    projects(first: 100) { edges { node { name } } }
  }
`;

const SPANS_QUERY = `
  query SpanForTraceLink($project: String!, $filter: String!) {
    getProjectByName(name: $project) {
      spans(first: 50, filterCondition: $filter) {
        edges { node { id spanId startTime trace { traceId project { id name } } } }
      }
    }
  }
`;

const TRACE_QUERY = `
  query TraceForLink($traceId: String!) {
    getTraceByOtelId(traceId: $traceId) {
      traceId project { id name } spans(first: 1) { edges { node { id } } }
    }
  }
`;

const SESSION_FALLBACK_MAX_DISTANCE_MS = 5 * 60_000;

@Injectable()
export class PhoenixTraceLinkService {
  private readonly pending = new Map<string, Promise<string>>();

  constructor(
    private readonly config: AppConfigService,
    private readonly taskTraces: PhoenixTaskTraceService,
    private readonly database: DatabaseService,
  ) {}

  async resolve(event: EventRow): Promise<string> {
    const existing = this.pending.get(event.source_event_id);
    if (existing) return existing;
    const task = this.resolveOnce(event).finally(() => {
      if (this.pending.get(event.source_event_id) === task) this.pending.delete(event.source_event_id);
    });
    this.pending.set(event.source_event_id, task);
    return task;
  }

  private async resolveOnce(event: EventRow): Promise<string> {
    const direct = this.directLink(event.metadata);
    if (direct) return direct;
    const storedTraceId = this.text(event.metadata.trace_id || event.metadata.traceId);
    if (storedTraceId) {
      try {
        const storedTrace = await this.traceById(storedTraceId);
        if (storedTrace) return this.traceLink(storedTrace);
      } catch {
        return `${this.baseUrl()}/projects`;
      }
    }
    try {
      const projects = await this.projects();
      const exact = await this.lookup(event, projects, true);
      if (exact) return this.spanLink(exact);
      const session = await this.lookup(event, projects, false);
      if (session) return this.spanLink(session);
    } catch {
      // Phoenix may be starting or unavailable; navigation must still produce a useful destination.
    }
    const generated = this.taskTraces.record(event, null, Date.parse(event.created_at));
    if (generated) {
      const exported = await this.taskTraces.flush();
      if (exported) {
        event.metadata.trace_id = generated;
        this.database.setEventTraceId(event.source_event_id, generated);
        const generatedTrace = await this.waitForTrace(generated);
        return generatedTrace
          ? this.traceLink(generatedTrace)
          : `${this.baseUrl()}/projects`;
      }
    }
    return `${this.baseUrl()}/projects`;
  }

  private directLink(metadata: Record<string, unknown>): string | null {
    const projectId = this.text(metadata.project_id || metadata.phoenix_project_id);
    const traceId = this.text(metadata.trace_id || metadata.traceId);
    const spanId = this.text(metadata.span_node_id || metadata.phoenix_span_id);
    if (!projectId || !traceId) return null;
    const base = `${this.baseUrl()}/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}`;
    return spanId ? `${base}?selectedSpanNodeId=${encodeURIComponent(spanId)}` : base;
  }

  private async lookup(event: EventRow, projects: string[], exact: boolean): Promise<PhoenixSpanNode | null> {
    const metadata = event.metadata;
    const sessionId = this.text(metadata.thread_id || metadata.session_id);
    const turnId = this.text(metadata.turn_id);
    if (!sessionId) return null;
    const filters = exact
      ? (turnId ? this.exactFilters(event.client, sessionId, turnId) : [])
      : [`attributes["session"]["id"] == ${JSON.stringify(sessionId)}`];
    for (const filter of filters) {
      const matches = (await Promise.all(projects.map((project) => this.projectSpans(project, filter)))).flat();
      const selected = this.closest(
        matches,
        event.created_at,
        exact ? null : SESSION_FALLBACK_MAX_DISTANCE_MS,
      );
      if (selected) return selected;
    }
    return null;
  }

  private exactFilters(client: string, sessionId: string, turnId: string): string[] {
    const session = `attributes["session"]["id"] == ${JSON.stringify(sessionId)}`;
    if (client === 'codex') {
      return [
        `${session} and attributes["codex"]["turn_id"] == ${JSON.stringify(turnId)}`,
        `${session} and attributes["codex"]["turn"]["id"] == ${JSON.stringify(turnId)}`,
      ];
    }
    if (client === 'claude') return [`${session} and attributes["turn"]["id"] == ${JSON.stringify(turnId)}`];
    return [];
  }

  private async projects(): Promise<string[]> {
    const response = await this.graphql(PROJECTS_QUERY, {});
    return (response.data?.projects?.edges || [])
      .map((edge) => edge.node?.name)
      .filter((name): name is string => Boolean(name));
  }

  private async projectSpans(project: string, filter: string): Promise<PhoenixSpanNode[]> {
    const response = await this.graphql(SPANS_QUERY, { project, filter });
    return (response.data?.getProjectByName?.spans?.edges || [])
      .map((edge) => edge.node)
      .filter((node): node is PhoenixSpanNode => Boolean(node?.id && node.trace?.traceId && node.trace.project?.id));
  }

  private async traceById(traceId: string): Promise<NonNullable<NonNullable<PhoenixResponse['data']>['getTraceByOtelId']> | null> {
    const response = await this.graphql(TRACE_QUERY, { traceId });
    return response.data?.getTraceByOtelId || null;
  }

  private async waitForTrace(traceId: string): Promise<NonNullable<NonNullable<PhoenixResponse['data']>['getTraceByOtelId']> | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let trace;
      try {
        trace = await this.traceById(traceId);
      } catch {
        return null;
      }
      if (trace) return trace;
      if (attempt < 4) await new Promise<void>((resolve) => setTimeout(resolve, 400));
    }
    return null;
  }

  private closest(
    nodes: PhoenixSpanNode[],
    eventTime: string,
    maxDistanceMs: number | null,
  ): PhoenixSpanNode | null {
    const timestamp = Date.parse(eventTime);
    if (Number.isNaN(timestamp)) return maxDistanceMs === null ? nodes[0] || null : null;
    const candidates = nodes
      .map((node) => ({ node, start: Date.parse(node.startTime || '') }))
      .filter((candidate) => !Number.isNaN(candidate.start))
      .map((candidate) => ({ ...candidate, distance: Math.abs(candidate.start - timestamp) }))
      .filter((candidate) => maxDistanceMs === null || candidate.distance <= maxDistanceMs)
      .sort((left, right) => left.distance - right.distance);
    return candidates[0]?.node || (maxDistanceMs === null ? nodes[0] || null : null);
  }

  private spanLink(span: PhoenixSpanNode): string {
    return `${this.baseUrl()}/projects/${encodeURIComponent(span.trace.project.id)}/traces/${encodeURIComponent(span.trace.traceId)}?selectedSpanNodeId=${encodeURIComponent(span.id)}`;
  }

  private traceLink(trace: NonNullable<NonNullable<PhoenixResponse['data']>['getTraceByOtelId']>): string {
    const base = `${this.baseUrl()}/projects/${encodeURIComponent(trace.project.id)}/traces/${encodeURIComponent(trace.traceId)}`;
    const spanId = trace.spans?.edges?.[0]?.node?.id;
    return spanId ? `${base}?selectedSpanNodeId=${encodeURIComponent(spanId)}` : base;
  }

  private async graphql(query: string, variables: Record<string, string>): Promise<PhoenixResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${this.baseUrl()}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Phoenix GraphQL returned ${response.status}`);
      const payload = await response.json() as PhoenixResponse;
      if (payload.errors?.length) throw new Error('Phoenix GraphQL query failed');
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  private text(value: unknown): string {
    return typeof value === 'string' && value && value.length <= 256 ? value : '';
  }

  private baseUrl(): string {
    return this.config.phoenixUrl.replace(/\/+$/, '');
  }
}
