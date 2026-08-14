export interface ExtensionDefinition {
  key: string;
  product: string;
  runtime: 'cli' | 'desktop' | 'quest';
  label: string;
  adapter: ExtensionAdapter;
}

export interface ExtensionRuntimeState {
  detected: boolean;
  cliAvailable: boolean;
  running: boolean;
  monitorConfigured: boolean;
  detectionSignals: string[];
}

export interface ExtensionAdapter {
  id: string;
  active: boolean;
  capabilities: {
    completed: boolean;
    failed: boolean;
    interrupted: boolean;
    toolFailed: boolean;
    tracing: boolean;
  };
}
