import { BadRequestException } from '@nestjs/common';

export type ChannelFormFieldType = 'text' | 'password' | 'url' | 'number' | 'select';

export interface ChannelFormOption {
  label: string;
  value: string;
}

export interface ChannelFormField {
  key: string;
  label: string;
  type: ChannelFormFieldType;
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
  options?: ChannelFormOption[];
}

export interface ChannelFormSchema {
  fields: ChannelFormField[];
}

export interface ApprisePlatformDefinition {
  id: string;
  label: string;
  message: string;
  helpUrl: string;
  form: ChannelFormSchema;
  buildUrl(values: Record<string, string>): string;
}

const field = (
  key: string,
  label: string,
  type: ChannelFormFieldType,
  required: boolean,
  extra: Omit<ChannelFormField, 'key' | 'label' | 'type' | 'required'> = {},
): ChannelFormField => ({ key, label, type, required, ...extra });

const required = (values: Record<string, string>, key: string, label: string): string => {
  const value = values[key];
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${label}不能为空`);
  return value.trim();
};

const optional = (values: Record<string, string>, key: string): string => {
  const value = values[key];
  return typeof value === 'string' ? value.trim() : '';
};

const match = (value: string, pattern: RegExp, label: string): string => {
  if (!pattern.test(value)) throw new BadRequestException(`${label}格式无效`);
  return value;
};

const splitList = (value: string): string[] => value
  .split(/[\s,;]+/)
  .map((item) => item.trim())
  .filter(Boolean);

const endpoint = (raw: string, label: string): URL => {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new BadRequestException(`${label}格式无效`);
  }
  if (!['http:', 'https:'].includes(value.protocol) || !value.hostname) {
    throw new BadRequestException(`${label}必须是 HTTP 或 HTTPS 地址`);
  }
  return value;
};

const tokenFromWebhook = (
  raw: string,
  label: string,
  hostPattern: RegExp,
  extract: (value: URL) => string,
): string => {
  if (!/^https?:\/\//i.test(raw)) return raw;
  const value = endpoint(raw, label);
  if (!hostPattern.test(value.hostname)) throw new BadRequestException(`${label}域名无效`);
  const token = extract(value);
  if (!token) throw new BadRequestException(`${label}格式无效`);
  return token;
};

const serviceBase = (raw: string, protocol: string): string => {
  const value = endpoint(raw, '服务地址');
  const path = value.pathname.replace(/^\/+|\/+$/g, '');
  return `${protocol}${value.protocol === 'https:' ? 's' : ''}://${value.host}${path ? `/${path}` : ''}`;
};

const query = (values: Record<string, string>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) params.append(key, value);
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
};

const definitions: ApprisePlatformDefinition[] = [
  {
    id: 'apprise-wecom',
    label: '企业微信机器人',
    message: '粘贴企业微信群机器人的 Webhook Key',
    helpUrl: 'https://developer.work.weixin.qq.com/document/path/91770',
    form: { fields: [field('key', 'Webhook URL 或 Key', 'password', true, { placeholder: '粘贴完整 Webhook URL 或 key' })] },
    buildUrl(values) {
      const input = required(values, 'key', 'Webhook URL 或 Key');
      const key = match(tokenFromWebhook(input, 'Webhook URL', /(^|\.)qyapi\.weixin\.qq\.com$/i, (value) => value.searchParams.get('key') || ''), /^[A-Za-z0-9_-]+$/, 'Webhook Key');
      return `wecombot://${key}`;
    },
  },
  {
    id: 'apprise-dingtalk',
    label: '钉钉机器人',
    message: '配置钉钉群机器人的 Access Token',
    helpUrl: 'https://open.dingtalk.com/document/robots/custom-robot-access',
    form: { fields: [
      field('token', 'Webhook URL 或 Access Token', 'password', true),
      field('secret', '加签密钥', 'password', false, { placeholder: '启用加签时填写' }),
      field('phones', '提醒手机号', 'text', false, { placeholder: '多个手机号用逗号分隔' }),
    ] },
    buildUrl(values) {
      const input = required(values, 'token', 'Webhook URL 或 Access Token');
      const token = match(tokenFromWebhook(input, 'Webhook URL', /(^|\.)oapi\.dingtalk\.com$/i, (value) => value.searchParams.get('access_token') || ''), /^[A-Za-z0-9]+$/, 'Access Token');
      const secret = optional(values, 'secret');
      if (secret) match(secret, /^[A-Za-z0-9]+$/, '加签密钥');
      const phones = splitList(optional(values, 'phones'));
      if (phones.some((phone) => !/^\d{11,14}$/.test(phone))) throw new BadRequestException('提醒手机号格式无效');
      return `dingtalk://${secret ? `${secret}@` : ''}${token}/${phones.join('/')}`;
    },
  },
  {
    id: 'apprise-feishu',
    label: '飞书机器人',
    message: '粘贴飞书群机器人的 Webhook Token',
    helpUrl: 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot',
    form: { fields: [field('token', 'Webhook URL 或 Token', 'password', true)] },
    buildUrl(values) {
      const input = required(values, 'token', 'Webhook URL 或 Token');
      const token = match(tokenFromWebhook(input, 'Webhook URL', /(^|\.)open\.feishu\.cn$/i, (value) => value.pathname.split('/').filter(Boolean).at(-1) || ''), /^[A-Za-z0-9_-]+$/, 'Webhook Token');
      return `feishu://${token}`;
    },
  },
  {
    id: 'apprise-email',
    label: '邮件 SMTP',
    message: '配置 SMTP 账号作为跨平台兜底通道',
    helpUrl: 'https://github.com/caronc/apprise/wiki/Notify_email',
    form: { fields: [
      field('host', 'SMTP 主机', 'text', true, { placeholder: 'smtp.example.com' }),
      field('port', '端口', 'number', false, { placeholder: '留空使用协议默认端口' }),
      field('security', '连接安全', 'select', true, {
        defaultValue: 'starttls',
        options: [
          { label: 'STARTTLS', value: 'starttls' },
          { label: 'SSL/TLS', value: 'ssl' },
          { label: '不加密', value: 'insecure' },
        ],
      }),
      field('username', '用户名', 'text', true),
      field('password', '密码或授权码', 'password', true),
      field('from', '发件地址', 'text', true, { placeholder: 'monitor@example.com' }),
      field('recipients', '收件地址', 'text', true, { placeholder: '多个地址用逗号分隔' }),
    ] },
    buildUrl(values) {
      const host = required(values, 'host', 'SMTP 主机');
      if (/[:/\s]/.test(host)) throw new BadRequestException('SMTP 主机格式无效');
      const security = required(values, 'security', '连接安全');
      if (!['starttls', 'ssl', 'insecure'].includes(security)) throw new BadRequestException('连接安全选项无效');
      const portValue = optional(values, 'port');
      const defaultPort = security === 'ssl' ? 465 : security === 'insecure' ? 25 : 587;
      const port = portValue ? Number(portValue) : defaultPort;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BadRequestException('SMTP 端口格式无效');
      const username = required(values, 'username', '用户名');
      const password = values.password;
      if (typeof password !== 'string' || !password) throw new BadRequestException('密码或授权码不能为空');
      const from = required(values, 'from', '发件地址');
      const recipients = splitList(required(values, 'recipients', '收件地址'));
      if (!recipients.length || [from, ...recipients].some((address) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) {
        throw new BadRequestException('邮件地址格式无效');
      }
      const schema = security === 'insecure' ? 'mailto' : 'mailtos';
      const targets = recipients.map(encodeURIComponent).join('/');
      return `${schema}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${targets}${query({ from, mode: security })}`;
    },
  },
  {
    id: 'apprise-bark',
    label: 'Bark',
    message: '配置 Bark 服务与 iOS 设备 Key',
    helpUrl: 'https://github.com/Finb/Bark',
    form: { fields: [
      field('server', '服务地址', 'url', true, { defaultValue: 'https://api.day.app' }),
      field('deviceKey', '设备 Key', 'password', true),
    ] },
    buildUrl(values) {
      const base = serviceBase(required(values, 'server', '服务地址'), 'bark');
      const deviceKey = required(values, 'deviceKey', '设备 Key');
      return `${base}/${encodeURIComponent(deviceKey)}`;
    },
  },
  {
    id: 'apprise-gotify',
    label: 'Gotify',
    message: '配置自建 Gotify 服务与应用 Token',
    helpUrl: 'https://gotify.net/docs/',
    form: { fields: [
      field('server', '服务地址', 'url', true, { placeholder: 'https://gotify.example.com' }),
      field('token', '应用 Token', 'password', true),
      field('priority', '优先级', 'number', false, { defaultValue: '5' }),
    ] },
    buildUrl(values) {
      const base = serviceBase(required(values, 'server', '服务地址'), 'gotify');
      const token = required(values, 'token', '应用 Token');
      const priority = optional(values, 'priority');
      if (priority && !/^-?\d+$/.test(priority)) throw new BadRequestException('优先级格式无效');
      return `${base}/${encodeURIComponent(token)}${query({ priority })}`;
    },
  },
  {
    id: 'apprise-ntfy',
    label: 'ntfy',
    message: '配置 ntfy 公共或自建服务',
    helpUrl: 'https://docs.ntfy.sh/',
    form: { fields: [
      field('server', '服务地址', 'url', true, { defaultValue: 'https://ntfy.sh' }),
      field('topic', 'Topic', 'text', true),
      field('token', 'Access Token', 'password', false, { placeholder: '公开 Topic 可留空' }),
    ] },
    buildUrl(values) {
      const value = endpoint(required(values, 'server', '服务地址'), '服务地址');
      const topic = match(required(values, 'topic', 'Topic'), /^[A-Za-z0-9_-]{1,64}$/, 'Topic');
      const token = optional(values, 'token');
      const path = value.pathname.replace(/^\/+|\/+$/g, '');
      const schema = value.protocol === 'https:' ? 'ntfys' : 'ntfy';
      return `${schema}://${token ? `${encodeURIComponent(token)}@` : ''}${value.host}${path ? `/${path}` : ''}/${topic}${query({ auth: token ? 'token' : '' })}`;
    },
  },
  {
    id: 'apprise-webhook',
    label: '通用 Webhook',
    message: '向自有 HTTP 接口发送标准 Apprise JSON 消息',
    helpUrl: 'https://github.com/caronc/apprise/wiki/Notify_Custom_JSON',
    form: { fields: [
      field('url', 'Webhook URL', 'password', true, { placeholder: 'https://example.com/hooks/ai-monitor' }),
      field('method', '请求方法', 'select', true, {
        defaultValue: 'POST',
        options: ['POST', 'PUT', 'DELETE', 'GET'].map((value) => ({ label: value, value })),
      }),
      field('bearerToken', 'Bearer Token', 'password', false),
    ] },
    buildUrl(values) {
      const value = endpoint(required(values, 'url', 'Webhook URL'), 'Webhook URL');
      const method = required(values, 'method', '请求方法').toUpperCase();
      if (!['POST', 'PUT', 'GET', 'DELETE'].includes(method)) throw new BadRequestException('请求方法不受支持');
      const params = new URLSearchParams({ method });
      for (const [key, entry] of value.searchParams) params.append(`-${key}`, entry);
      const bearerToken = optional(values, 'bearerToken');
      if (bearerToken) params.append('+Authorization', `Bearer ${bearerToken}`);
      const schema = value.protocol === 'https:' ? 'jsons' : 'json';
      return `${schema}://${value.host}${value.pathname}?${params.toString()}`;
    },
  },
  {
    id: 'apprise-telegram',
    label: 'Telegram',
    message: '配置 Telegram Bot Token 与 Chat ID',
    helpUrl: 'https://core.telegram.org/bots/features#botfather',
    form: { fields: [
      field('botToken', 'Bot Token', 'password', true),
      field('chatId', 'Chat ID 或用户名', 'text', true, { placeholder: '-100123456789 或 channel_name' }),
    ] },
    buildUrl(values) {
      const token = required(values, 'botToken', 'Bot Token').replace(/^bot/i, '');
      match(token, /^\d+:[A-Za-z0-9_-]+$/, 'Bot Token');
      const chatId = match(required(values, 'chatId', 'Chat ID 或用户名').replace(/^@/, ''), /^(?:-?\d{1,32}|[A-Za-z_-][A-Za-z0-9_-]+)$/, 'Chat ID 或用户名');
      return `tgram://${token}/${chatId}`;
    },
  },
  {
    id: 'apprise-discord',
    label: 'Discord',
    message: '粘贴 Discord 频道的 Webhook URL',
    helpUrl: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks',
    form: { fields: [field('webhookUrl', 'Webhook URL', 'password', true)] },
    buildUrl(values) {
      const value = endpoint(required(values, 'webhookUrl', 'Webhook URL'), 'Webhook URL');
      if (!/(^|\.)discord(?:app)?\.com$/i.test(value.hostname)) throw new BadRequestException('Discord Webhook URL 域名无效');
      const parts = value.pathname.split('/').filter(Boolean);
      const index = parts.indexOf('webhooks');
      const webhookId = index >= 0 ? parts[index + 1] : '';
      const webhookToken = index >= 0 ? parts[index + 2] : '';
      if (!webhookId || !webhookToken) throw new BadRequestException('Discord Webhook URL 格式无效');
      return `discord://${webhookId}/${webhookToken}`;
    },
  },
];

export const APPRISE_PLATFORMS = definitions;

export const apprisePlatform = (id: string): ApprisePlatformDefinition | undefined => definitions.find((item) => item.id === id);

export const normalizePlatformValues = (
  definition: ApprisePlatformDefinition,
  input: Record<string, unknown>,
): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const item of definition.form.fields) {
    const value = input[item.key];
    if (value !== undefined && typeof value !== 'string') throw new BadRequestException(`${item.label}格式无效`);
    const normalized = typeof value === 'string' ? value : item.defaultValue || '';
    if (normalized.length > 4096) throw new BadRequestException(`${item.label}内容过长`);
    if (item.required && !normalized.trim()) throw new BadRequestException(`${item.label}不能为空`);
    values[item.key] = normalized;
  }
  definition.buildUrl(values);
  return values;
};
