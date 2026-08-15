const recordValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export const hasClaudeDesktopEntrypoint = (source: string): boolean => source
  .split(/\r?\n/)
  .some((line) => {
    if (!line.trim()) return false;
    try {
      return recordValue(JSON.parse(line)).entrypoint === 'claude-desktop-3p';
    } catch {
      return false;
    }
  });
