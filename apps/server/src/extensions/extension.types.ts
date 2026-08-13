export interface ExtensionDefinition {
  key: string;
  label: string;
  aliases: string[];
  adapter: ExtensionAdapter;
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
