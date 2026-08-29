export interface ChannelStatus {
  id: string;
  label: string;
  bound: boolean;
  error: boolean;
  bindingMode: 'qr' | 'credential' | 'external' | 'none';
  message?: string;
}

export type BindingStartResult =
  | { mode: 'qr'; qrUrl: string; message: string }
  | { mode: 'credential'; message: string; helpUrl?: string; form?: ChannelFormSchema }
  | { mode: 'external'; message: string };

export interface BindingWaitResult {
  connected: boolean;
  bound: boolean;
  message: string;
  qrUrl?: string;
}

export interface ChannelProvider {
  readonly ids: readonly string[];
  availableChannels(): string[];
  status(): Promise<ChannelStatus[]>;
  /**
   * Deliver the already-rendered notification text.
   *
   * Providers are transport adapters only. They must not prepend titles,
   * append metadata, or otherwise rewrite the message.
   */
  send(channel: string, message: string): Promise<void>;
  startBinding?(channel: string): Promise<BindingStartResult>;
  bindCredential?(channel: string, credential: string | Record<string, unknown>): Promise<BindingWaitResult>;
  waitBinding?(channel: string): Promise<BindingWaitResult>;
  cancelBinding?(channel: string): Promise<void>;
  unbind?(channel: string): Promise<boolean>;
}
import type { ChannelFormSchema } from './apprise-platforms';

/**
 * The remote channel may have accepted a message even though its confirmation
 * command failed or timed out. Retrying this error can create duplicate
 * notifications, so delivery workers must treat it as terminal until a user
 * confirms the remote result.
 */
export class DeliveryOutcomeUnknownError extends Error {
  readonly code = 'delivery_outcome_unknown';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DeliveryOutcomeUnknownError';
  }
}
