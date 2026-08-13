export interface PlatformDefinition {
  key: string;
  label: string;
  aliases: string[];
  custom: boolean;
  integration: PlatformIntegration;
}

export interface PlatformBinding {
  channel: string | null;
}

export type IntegrationMode = 'notify-and-app-server' | 'hooks' | 'generic-webhook';
export type IntegrationState = 'ready' | 'manual';

export interface PlatformIntegration {
  adapterId: string;
  mode: IntegrationMode;
  state: IntegrationState;
  capabilities: {
    completed: boolean;
    failed: boolean;
    interrupted: boolean;
    toolFailed: boolean;
    tracing: boolean;
  };
  description: string;
}

export interface PlatformRecord {
  definition: PlatformDefinition;
  binding: PlatformBinding;
}
