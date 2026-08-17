export const MAX_ANSWER_TEXT_LENGTH = 24_000;

/** Truncate by Unicode code points so surrogate pairs stay intact. */
export const truncateText = (value: string, limit: number): string => {
  if (limit <= 0) return '';
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  if (limit <= 3) return characters.slice(0, limit).join('');
  return `${characters.slice(0, limit - 3).join('').trimEnd()}...`;
};

export const truncateTail = (value: string, limit: number): string => {
  if (limit <= 0) return '';
  const characters = Array.from(value);
  return characters.length <= limit ? value : characters.slice(-limit).join('');
};

/** Redact credentials before failure details enter persisted event metadata. */
export const sanitizeFailureMessage = (value: unknown, preserveAuthorizationScheme = false): string => {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/\b(Authorization\s*[:=]\s*)(Bearer\s+)?[^\s,;]+/gi, (_match, prefix: string, scheme: string | undefined) => `${prefix}${preserveAuthorizationScheme ? (scheme || '') : ''}<redacted>`)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/\b((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, '$1<redacted>')
    .replace(/([?&](?:api[_-]?key|token|secret|password|access_token)=)[^&#\s]+/gi, '$1<redacted>')
    .replace(/\bC:\\Users\\[^\\\s]+/gi, 'C:\\Users\\<user>')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateText(cleaned, 24_000);
};

/** Remove host-supplied context so notifications describe only the user task. */
export const summarizeTask = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/gi, ' ')
    .replace(/##\s*My request:\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^The following is the Codex agent history whose request action you are assessing\./i.test(cleaned)) return '';
  return truncateText(cleaned, 2_000);
};

export const cleanAnswerText = (value: string): string => {
  const cleaned = value
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/gi, ' ')
    .replace(/\b(Authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, '$1<redacted>')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/\b((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, '$1<redacted>')
    .replace(/([?&](?:api[_-]?key|token|secret|password|access_token)=)[^&#\s]+/gi, '$1<redacted>')
    .trim();
  return truncateTail(cleaned, MAX_ANSWER_TEXT_LENGTH);
};

/**
 * Provider/network failures can end one turn while the client is still able
 * to retry or continue the conversation. They are kept in the event history,
 * but their notification must wait for a terminal outcome.
 */
export const isRecoverableFailure = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  return /(?:stream\s+(?:disconnected|closed)|before\s+(?:completion|response\.completed)|server(?:s)?\s+(?:are\s+)?overloaded|(?:too\s+many\s+requests|rate\s+limit)|(?:https?|upstream|unexpected\s+status)\s*(?:status\s*)?(?:408|425|429|5\d\d)|\b(?:502|503|504|512)\b|(?:connection|network|socket)\s+(?:failed|reset|refused|closed)|\b(?:timeout|timed\s+out)\b)/i.test(value);
};

