import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfigService } from '../src/config/app-config.service';
import { OPENCLAW_QQ, OPENCLAW_WEIXIN, OpenClawProvider } from '../src/channels/openclaw.provider';
import { DeliveryOutcomeUnknownError } from '../src/channels/channel-provider';
import { ProcessExecutionError } from '../src/channels/process-runner.service';
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
let previousGatewayToken: string | undefined;

afterEach(() => {
  connectorCallbacks = null;
  weixinCallbacks = null;
  dispose.mockClear();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  if (previousGatewayToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
  else process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
});

describe('OpenClawProvider binding', () => {
  let root: string;
  let config: AppConfigService;
  let run: ReturnType<typeof vi.fn>;
  let provider: OpenClawProvider;

  beforeEach(() => {
    previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = 'test-gateway-token';
    root = mkdtempSync(join(tmpdir(), 'ai-monitor-openclaw-'));
    temporary.push(root);
    config = {
      projectRoot: root,
      dataRoot: join(root, 'data'),
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

  it('sends through the standard direct outbound command and requires a message id', async () => {
    writeFileSync(config.openClawBindingsPath, JSON.stringify({
      version: 2,
      bindings: { [OPENCLAW_WEIXIN]: { provider: OPENCLAW_WEIXIN, target: 'self@im.wechat', account_id: 'weixin-account' } },
    }));
    run.mockResolvedValueOnce(JSON.stringify({
      action: 'send', channel: OPENCLAW_WEIXIN, dryRun: false, messageId: 'message-1',
    }));

    await provider.send(OPENCLAW_WEIXIN, 'title', 'body');

    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['message', 'send', '--channel', OPENCLAW_WEIXIN, '--message', 'title\n\nbody', '--json']),
      expect.objectContaining({ redact: expect.arrayContaining(['self@im.wechat', 'weixin-account']) }),
    );
  });

  it('sends QQ through the running Gateway cron announcement path', async () => {
    writeFileSync(config.openClawBindingsPath, JSON.stringify({
      version: 2,
      bindings: { [OPENCLAW_QQ]: { provider: 'qqbot', target: 'qqbot:c2c:user-openid', account_id: 'default' } },
    }));
    run.mockImplementation(async (_executable: string, args: string[]) => {
      if (args.includes('cron') && args.includes('add')) return JSON.stringify({ id: 'job-1' });
      if (args.includes('cron') && args.includes('run')) return 'completed';
      if (args.includes('cron') && args.includes('runs')) return JSON.stringify({
        entries: [{ jobId: 'job-1', status: 'ok', delivered: true, deliveryStatus: 'delivered' }],
      });
      return JSON.stringify({ ok: true });
    });

    await provider.send(OPENCLAW_QQ, 'title', 'body');

    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['cron', 'add', '--announce', '--channel', 'qqbot', '--to', 'qqbot:c2c:user-openid', '--account', 'default']),
      expect.objectContaining({ redact: expect.arrayContaining(['qqbot:c2c:user-openid', 'default']) }),
    );
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['cron', 'run', 'job-1', '--wait']),
      expect.objectContaining({ redact: expect.arrayContaining(['qqbot:c2c:user-openid', 'default']) }),
    );
    const addCall = run.mock.calls.find(([, args]) => args.includes('cron') && args.includes('add'));
    expect(addCall).toBeDefined();
    if (!addCall) throw new Error('cron add was not called');
    const addArgs = addCall[1] as string[];
    const commandArgvIndex = addArgs.indexOf('--command-argv');
    const encodedCommandArgv = addArgs[commandArgvIndex + 1];
    expect(encodedCommandArgv).toBeTypeOf('string');
    if (!encodedCommandArgv) throw new Error('cron command argv was not provided');
    const commandArgv = JSON.parse(encodedCommandArgv) as string[];
    expect(commandArgv.slice(0, 3)).toEqual([
      process.execPath,
      join(root, 'scripts', 'openclaw-emit-notification.mjs'),
      join(root, 'data', 'openclaw-outbound'),
    ]);
    const messagePath = commandArgv[3];
    expect(messagePath).toMatch(/openclaw-outbound[\\/]notification-[\w-]+\.txt$/);
    if (!messagePath) throw new Error('notification payload path was not provided');
    expect(existsSync(messagePath)).toBe(false);
  });

  it('rejects QQ Gateway runs without a delivered result', async () => {
    writeFileSync(config.openClawBindingsPath, JSON.stringify({
      version: 2,
      bindings: { [OPENCLAW_QQ]: { provider: 'qqbot', target: 'qqbot:c2c:user-openid', account_id: 'default' } },
    }));
    run.mockImplementation(async (_executable: string, args: string[]) => {
      if (args.includes('cron') && args.includes('add')) return JSON.stringify({ id: 'job-1' });
      if (args.includes('cron') && args.includes('runs')) return JSON.stringify({
        entries: [{ jobId: 'job-1', status: 'error', delivered: false, deliveryStatus: 'failed' }],
      });
      return 'completed';
    });

    await expect(provider.send(OPENCLAW_QQ, 'title', 'body')).rejects.toThrow('did not confirm');
  });

  it('does not classify a QQ execution timeout as retryable', async () => {
    writeFileSync(config.openClawBindingsPath, JSON.stringify({
      version: 2,
      bindings: { [OPENCLAW_QQ]: { provider: 'qqbot', target: 'qqbot:c2c:user-openid', account_id: 'default' } },
    }));
    run.mockImplementation(async (_executable: string, args: string[]) => {
      if (args.includes('cron') && args.includes('add')) return JSON.stringify({ id: 'job-1' });
      if (args.includes('cron') && args.includes('run')) throw new ProcessExecutionError('gateway timed out after delivery');
      return JSON.stringify({ ok: true });
    });

    await expect(provider.send(OPENCLAW_QQ, 'title', 'body')).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
  });

  it('does not classify an unreadable QQ history as retryable', async () => {
    writeFileSync(config.openClawBindingsPath, JSON.stringify({
      version: 2,
      bindings: { [OPENCLAW_QQ]: { provider: 'qqbot', target: 'qqbot:c2c:user-openid', account_id: 'default' } },
    }));
    run.mockImplementation(async (_executable: string, args: string[]) => {
      if (args.includes('cron') && args.includes('add')) return JSON.stringify({ id: 'job-1' });
      if (args.includes('cron') && args.includes('run')) return 'completed';
      if (args.includes('cron') && args.includes('runs')) throw new ProcessExecutionError('history unavailable');
      return JSON.stringify({ ok: true });
    });

    await expect(provider.send(OPENCLAW_QQ, 'title', 'body')).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
  });

  it('does not retry a QQ history entry that is still pending', async () => {
    writeFileSync(config.openClawBindingsPath, JSON.stringify({
      version: 2,
      bindings: { [OPENCLAW_QQ]: { provider: 'qqbot', target: 'qqbot:c2c:user-openid', account_id: 'default' } },
    }));
    run.mockImplementation(async (_executable: string, args: string[]) => {
      if (args.includes('cron') && args.includes('add')) return JSON.stringify({ id: 'job-1' });
      if (args.includes('cron') && args.includes('runs')) return JSON.stringify({
        entries: [{ jobId: 'job-1', status: 'pending', delivered: false, deliveryStatus: 'pending' }],
      });
      return 'completed';
    });

    await expect(provider.send(OPENCLAW_QQ, 'title', 'body')).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
  });

  it('rejects direct outbound responses without a message id', async () => {
    writeFileSync(config.openClawBindingsPath, JSON.stringify({
      version: 2,
      bindings: { [OPENCLAW_WEIXIN]: { provider: OPENCLAW_WEIXIN, target: 'self@im.wechat', account_id: 'weixin-account' } },
    }));
    run.mockResolvedValueOnce(JSON.stringify({ action: 'send', channel: OPENCLAW_WEIXIN, dryRun: false }));

    await expect(provider.send(OPENCLAW_WEIXIN, 'title', 'body')).rejects.toThrow('did not confirm');
  });

  it('explains when Weixin rejects an expired conversation context', async () => {
    writeFileSync(config.openClawBindingsPath, JSON.stringify({
      version: 2,
      bindings: { [OPENCLAW_WEIXIN]: { provider: OPENCLAW_WEIXIN, target: 'self@im.wechat', account_id: 'weixin-account' } },
    }));
    run.mockRejectedValueOnce(new ProcessExecutionError('OutboundDeliveryError: sendMessage ret=-2 errmsg=prepare failed'));

    await expect(provider.send(OPENCLAW_WEIXIN, 'title', 'body'))
      .rejects.toThrow('微信会话不可用，请在微信中给机器人发送任意一条消息后重试');
  });
});
