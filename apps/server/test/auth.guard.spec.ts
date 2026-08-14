import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../src/auth/auth.guard';
import type { AppConfigService } from '../src/config/app-config.service';
import { DashboardController } from '../src/dashboard/dashboard.controller';
import type { ChannelsService } from '../src/channels/channels.service';
import type { DatabaseService } from '../src/database/database.service';

const directories: string[] = [];

const contextFor = (request: Record<string, unknown>): ExecutionContext => ({
  getHandler: () => function handler() {},
  getClass: () => class Controller {},
  switchToHttp: () => ({ getRequest: () => request }),
} as unknown as ExecutionContext);

const config = {
  ingestToken: 'private-token', host: '0.0.0.0', port: 8787,
} as AppConfigService;

const guardFor = () => new AuthGuard({
  getAllAndOverride: vi.fn(() => false),
} as unknown as Reflector, config);

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('AuthGuard dashboard session boundary', () => {
  it('accepts dashboard cookies only from loopback peers while remote bearer auth still works', () => {
    const guard = guardFor();
    const cookie = `ai_monitor_session=${guard.dashboardCookie()}`;

    expect(() => guard.canActivate(contextFor({
      headers: { cookie }, method: 'GET', socket: { remoteAddress: '192.168.1.20' },
    }))).toThrow(UnauthorizedException);
    expect(guard.canActivate(contextFor({
      headers: { cookie }, method: 'GET', socket: { remoteAddress: '::ffff:127.0.0.1' },
    }))).toBe(true);
    expect(guard.canActivate(contextFor({
      headers: { authorization: 'Bearer private-token' }, method: 'POST', socket: { remoteAddress: '192.168.1.20' },
    }))).toBe(true);
  });

  it('keeps the origin check for local cookie-authenticated writes', () => {
    const guard = guardFor();
    const cookie = `ai_monitor_session=${guard.dashboardCookie()}`;
    expect(() => guard.canActivate(contextFor({
      headers: { cookie, origin: 'http://attacker.example' }, method: 'POST', socket: { remoteAddress: '127.0.0.1' },
    }))).toThrow(ForbiddenException);
  });

  it('does not issue a dashboard session cookie to a remote peer', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-dashboard-'));
    directories.push(directory);
    writeFileSync(join(directory, 'index.html'), '<html>dashboard</html>');
    const controller = new DashboardController(
      { ...config, webDistPath: directory } as AppConfigService,
      guardFor(),
      { stats: vi.fn() } as unknown as DatabaseService,
      { availableChannels: vi.fn(() => []) } as unknown as ChannelsService,
    );
    const response = {
      cookie: vi.fn(), setHeader: vi.fn(), send: vi.fn(),
      status: vi.fn(), type: vi.fn(),
    };
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);

    controller.index(
      { socket: { remoteAddress: '192.168.1.20' } } as never,
      response as never,
    );

    expect(response.cookie).not.toHaveBeenCalled();
    expect(response.send).toHaveBeenCalledWith('<html>dashboard</html>');
  });
});
