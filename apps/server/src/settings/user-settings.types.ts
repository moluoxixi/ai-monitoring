export const DEFAULT_TASK_LIMIT = 100;
export const DEFAULT_RESULT_LIMIT = 2_000;
export const MIN_TASK_LIMIT = 1;
export const MAX_TASK_LIMIT = 2_000;
export const MIN_RESULT_LIMIT = 1;
export const MAX_RESULT_LIMIT = 24_000;

export interface NotificationSettings {
  taskLimit: number;
  resultLimit: number;
}

export interface MonitorVerification {
  monitorVerified: true;
  lastVerifiedAt: string;
  verificationSource: string;
}

export interface UserSettingsDocument {
  version: 1;
  notification: NotificationSettings;
  visibleExtensions: string[];
  visibleExtensionsConfigured: boolean;
  monitorVerification: Record<string, MonitorVerification>;
}

export interface UserSettingsSnapshot extends UserSettingsDocument {
  hasVisiblePreference: boolean;
}
