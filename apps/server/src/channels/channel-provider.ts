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
  send(channel: string, title: string, body: string): Promise<void>;
  startBinding?(channel: string): Promise<BindingStartResult>;
  bindCredential?(channel: string, credential: string | Record<string, unknown>): Promise<BindingWaitResult>;
  waitBinding?(channel: string): Promise<BindingWaitResult>;
  cancelBinding?(channel: string): Promise<void>;
  unbind?(channel: string): Promise<boolean>;
}
import type { ChannelFormSchema } from './apprise-platforms';
