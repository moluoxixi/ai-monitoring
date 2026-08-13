export interface ChannelStatus {
  id: string;
  label: string;
  bound: boolean;
  error: boolean;
  bindingMode: 'qr' | 'external' | 'none';
  message?: string;
}

export type BindingStartResult =
  | { mode: 'qr'; qrUrl: string; message: string }
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
  waitBinding?(channel: string): Promise<BindingWaitResult>;
  cancelBinding?(channel: string): Promise<void>;
  unbind?(channel: string): Promise<boolean>;
}
