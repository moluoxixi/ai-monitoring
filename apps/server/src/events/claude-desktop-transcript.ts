import { recordValue } from '../utils/event-record';

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
