import { describe, expect, it } from 'vitest';
import { APPRISE_PLATFORMS, normalizePlatformValues } from '../src/channels/apprise-platforms';

const samples: Record<string, Record<string, string>> = {
  'apprise-wecom': { key: 'abc_DEF-123' },
  'apprise-dingtalk': { token: 'abc123', secret: 'SECabc123', phones: '13800138000' },
  'apprise-feishu': { token: 'abc_DEF-123' },
  'apprise-email': {
    host: 'smtp.example.com', port: '587', security: 'starttls', username: 'user@example.com',
    password: 'authorization-code', from: 'monitor@example.com', recipients: 'owner@example.com,backup@example.com',
  },
  'apprise-bark': { server: 'https://api.day.app', deviceKey: 'device-key' },
  'apprise-gotify': { server: 'https://gotify.example.com', token: 'app-token', priority: '5' },
  'apprise-ntfy': { server: 'https://ntfy.sh', topic: 'ai-monitor', token: 'access-token' },
  'apprise-webhook': { url: 'https://example.com/hooks/ai?source=monitor', method: 'POST', bearerToken: 'secret' },
  'apprise-telegram': { botToken: '123456:ABC_def', chatId: '-100123' },
  'apprise-discord': { webhookUrl: 'https://discord.com/api/webhooks/123456/abc_DEF' },
};

const expectedUrls: Record<string, string> = {
  'apprise-wecom': 'wecombot://abc_DEF-123',
  'apprise-dingtalk': 'dingtalk://SECabc123@abc123/13800138000',
  'apprise-feishu': 'feishu://abc_DEF-123',
  'apprise-email': 'mailtos://user%40example.com:authorization-code@smtp.example.com:587/owner%40example.com/backup%40example.com?from=monitor%40example.com&mode=starttls',
  'apprise-bark': 'barks://api.day.app/device-key',
  'apprise-gotify': 'gotifys://gotify.example.com/app-token?priority=5',
  'apprise-ntfy': 'ntfys://access-token@ntfy.sh/ai-monitor?auth=token',
  'apprise-webhook': 'jsons://example.com/hooks/ai?method=POST&-source=monitor&%2BAuthorization=Bearer+secret',
  'apprise-telegram': 'tgram://123456:ABC_def/-100123',
  'apprise-discord': 'discord://123456/abc_DEF',
};

describe('Apprise platform registry', () => {
  it('defines every supported platform with unique stable ids', () => {
    expect(APPRISE_PLATFORMS.map((item) => item.id)).toEqual(Object.keys(samples));
    expect(new Set(APPRISE_PLATFORMS.map((item) => item.id)).size).toBe(APPRISE_PLATFORMS.length);
  });

  it.each(APPRISE_PLATFORMS.map((item) => [item.id, item] as const))('validates and builds %s', (id, definition) => {
    const sample = samples[id];
    expect(sample).toBeDefined();
    const values = normalizePlatformValues(definition, sample!);
    const url = definition.buildUrl(values);
    expect(url).toBe(expectedUrls[id]);
    for (const item of definition.form.fields.filter((field) => field.type === 'password')) {
      expect(values[item.key]).toBe(sample![item.key] || '');
    }
  });

  it('rejects missing required fields and unsupported webhook protocols', () => {
    const wecom = APPRISE_PLATFORMS.find((item) => item.id === 'apprise-wecom')!;
    expect(() => normalizePlatformValues(wecom, {})).toThrow('不能为空');
    const webhook = APPRISE_PLATFORMS.find((item) => item.id === 'apprise-webhook')!;
    expect(() => normalizePlatformValues(webhook, { url: 'file:///secret', method: 'POST' })).toThrow('HTTP');
  });

  it('accepts native webhook URLs for domestic robot platforms', () => {
    const cases = [
      ['apprise-wecom', { key: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc_DEF-123' }, 'wecombot://abc_DEF-123'],
      ['apprise-dingtalk', { token: 'https://oapi.dingtalk.com/robot/send?access_token=abc123' }, 'dingtalk://abc123/'],
      ['apprise-feishu', { token: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc_DEF-123' }, 'feishu://abc_DEF-123'],
    ] as const;
    for (const [id, values, expected] of cases) {
      const definition = APPRISE_PLATFORMS.find((item) => item.id === id)!;
      expect(definition.buildUrl(normalizePlatformValues(definition, values))).toBe(expected);
    }
  });
});
