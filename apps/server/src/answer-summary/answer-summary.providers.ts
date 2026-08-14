export const ANSWER_SUMMARY_PROVIDER_IDS = ['groq', 'openrouter', 'gemini', 'custom'] as const;
export type AnswerSummaryProviderId = typeof ANSWER_SUMMARY_PROVIDER_IDS[number];

export interface AnswerSummaryProviderDefinition {
  id: AnswerSummaryProviderId;
  label: string;
  baseUrl: string;
  defaultModel: string;
  apiKeyUrl?: string;
  custom: boolean;
}

export const ANSWER_SUMMARY_PROVIDERS: readonly AnswerSummaryProviderDefinition[] = [
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-20b',
    apiKeyUrl: 'https://console.groq.com/keys',
    custom: false,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/free',
    apiKeyUrl: 'https://openrouter.ai/keys',
    custom: false,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash-lite',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    custom: false,
  },
  {
    id: 'custom',
    label: '自定义渠道',
    baseUrl: '',
    defaultModel: '',
    custom: true,
  },
];

export const answerSummaryProvider = (id: string): AnswerSummaryProviderDefinition | undefined =>
  ANSWER_SUMMARY_PROVIDERS.find((provider) => provider.id === id);
