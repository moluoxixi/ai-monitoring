import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfigService } from '../src/config/app-config.service';
import { OPENCLAW_QQ, OPENCLAW_WEIXIN, OpenClawProvider } from '../src/channels/openclaw.provider';
import type { ProcessRunnerService } from '../src/channels/process-runner.service';

let connectorCallbacks: {
  onQrDisplayed?: (url: string) => void;
  onSuccess: (credentials: Array<{ appId: string; appSecret: string; userOpenid?: string }>) => void;
  onFailure: (error: Error) => void;
} | null = null;
let weixinCallbacks: {
  onQrDisplayed: (url: string) => void;
  onSuccess: () => void;
  onFailure: (error: Error) => void;
} | null = null;
const dispose = vi.fn();

const temporary: string[] = [];

afterEach(() => {
  connectorCallbacks = null;
  weixinCallbacks = null;
  dispose.mockClear();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('OpenClawProvider binding', () => {
  let root: string;
  let config: AppConfigService;
  let run: ReturnType<typeof vi.fn>;
  let provider: OpenClawProvider;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ai-monitor-openclaw-'));
    temporary.push(root);
    config = {
      projectRoot: root,
      openClawBindingsPath: join(root, 'bindings.json'),
    } as AppConfigService;
    run = vi.fn(async (_executable: string, args: string[]) => {
      if (args.includes('status')) return JSON.stringify({ gatewayReachable: true, channels: {} });
      return 'configuration updated';
    });
    provider = new OpenClawProvider(config, { run } as unknown as ProcessRunnerService);
    (provider as any).loadConnector = async () => (callbacks: typeof connectorCallbacks) => {
      connectorCallbacks = callbacks;
      callbacks?.onQrDisplayed?.('https://q.qq.com/example');
      return dispose;
    };
    (provider as any).launchWeixinLogin = async (callbacks: typeof weixinCallbacks) => {
      weixinCallbacks = callbacks;
      callbacks?.onQrDisplayed('https://weixin.qq.com/example');
      return dispose;
    };
  });

  it('uses the official Weixin QR flow and persists only its outbound target', async () => {
    let hasContext = false;
    (provider as any).latestWeixinBinding = () => ({ accountId: 'weixin-account', target: 'self@im.wechat', hasContext });
    const started = await provider.startBinding(OPENCLAW_WEIXIN);
    expect(started).toMatchObject({ mode: 'qr', qrUrl: 'https://weixin.qq.com/example' });

    weixinCallbacks?.onSuccess();
    const pending = await provider.waitBinding(OPENCLAW_WEIXIN);
    expect(pending).toEqual({
      connected: false,
      bound: false,
      message: '扫码已确认，请先在微信中给机器人发送任意一条消息以启用通知',
    });
    hasContext = true;
    const result = await provider.waitBinding(OPENCLAW_WEIXIN);

    expect(result).toEqual({ connected: true, bound: true, message: '微信机器人已绑定' });
    expect(provider.availableChannels()).toContain(OPENCLAW_WEIXIN);
    const persisted = JSON.parse(readFileSync(config.openClawBindingsPath, 'utf8'));
    expect(persisted.bindings[OPENCLAW_WEIXIN]).toEqual({
      provider: OPENCLAW_WEIXIN, target: 'self@im.wechat', account_id: 'weixin-account',
    });
    expect(readFileSync(config.openClawBindingsPath, 'utf8')).not.toContain('token');
  });

  it('starts QQ QR login, persists the official result, and stores only the delivery binding', async () => {
    const started = await provider.startBinding(OPENCLAW_QQ);
    expect(started).toMatchObject({ mode: 'qr', qrUrl: 'https://q.qq.com/example' });

    connectorCallbacks?.onSuccess([{ appId: 'app-id', appSecret: 'app-secret', userOpenid: 'user-openid' }]);
    const result = await provider.waitBinding(OPENCLAW_QQ);

    expect(result).toEqual({ connected: true, bound: true, message: 'QQ 机器人已绑定' });
    expect(provider.availableChannels()).toContain(OPENCLAW_QQ);
    const persisted = JSON.parse(readFileSync(config.openClawBindingsPath, 'utf8'));
    expect(persisted.version).toBe(2);
    expect(persisted.bindings[OPENCLAW_QQ]).toEqual({
      provider: 'qqbot', target: 'qqbot:c2c:user-openid', account_id: 'default',
    });
    expect(readFileSync(config.openClawBindingsPath, 'utf8')).not.toContain('app-secret');
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['config', 'set', '--batch-file']),
      expect.objectContaining({ redact: expect.arrayContaining(['app-secret', 'user-openid']) }),
    );
    expect(existsSync(join(root, 'data', 'openclaw-outbound'))).toBe(true);
  });

  it('ignores legacy recent-chat bindings', () => {
    writeFileSync(config.openClawBindingsPath, JSON.stringify({
      version: 1,
      bindings: { [OPENCLAW_QQ]: { provider: 'qqbot', target: 'legacy', account_id: 'legacy' } },
    }));
    expect(provider.availableChannels()).not.toContain(OPENCLAW_QQ);
  });

  it('does not bind incomplete QR credentials', async () => {
    await provider.startBinding(OPENCLAW_QQ);
    connectorCallbacks?.onSuccess([{ appId: 'app-id', appSecret: 'app-secret' }]);
    const result = await provider.waitBinding(OPENCLAW_QQ);
    expect(result.connected).toBe(true);
    expect(result.bound).toBe(false);
    expect(provider.availableChannels()).not.toContain(OPENCLAW_QQ);
  });
});
