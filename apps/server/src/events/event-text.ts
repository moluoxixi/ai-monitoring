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
