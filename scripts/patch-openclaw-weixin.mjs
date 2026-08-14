import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const quietIfMissing = process.argv.includes('--quiet-if-missing')
const marker = 'AI_MONITOR_CONTEXT_RESTORE_PATCH'
const pluginArgs = ['plugins', 'list', '--json']
const command = process.platform === 'win32' ? process.execPath : 'openclaw'
const commandArgs = process.platform === 'win32'
  ? [join(dirname(process.execPath), 'node_modules', 'openclaw', 'openclaw.mjs'), ...pluginArgs]
  : pluginArgs
const result = spawnSync(command, commandArgs, {
  encoding: 'utf8',
  windowsHide: true,
})

const skip = (message) => {
  if (!quietIfMissing) console.warn(message)
  process.exit(0)
}

if (result.error || result.status !== 0) skip('OpenClaw is unavailable; skipping the Weixin compatibility patch.')

let registry
try {
  registry = JSON.parse(result.stdout)
} catch {
  throw new Error('OpenClaw returned invalid plugin metadata')
}

const plugin = registry.plugins?.find((item) => item.id === 'openclaw-weixin' && item.status === 'loaded')
if (!plugin?.rootDir) skip('The OpenClaw Weixin plugin is not loaded; skipping the compatibility patch.')

const packageJson = JSON.parse(readFileSync(join(plugin.rootDir, 'package.json'), 'utf8'))
const files = [
  {
    path: join(plugin.rootDir, 'src', 'channel.ts'),
    before: `      const accountId = ctx.accountId || resolveOutboundAccountId(ctx.cfg, ctx.to);
      const result = await sendWeixinOutbound({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        accountId,
        contextToken: getContextToken(accountId!, ctx.to),
      });`,
    after: `      const accountId = ctx.accountId || resolveOutboundAccountId(ctx.cfg, ctx.to);
      // AI_MONITOR_CONTEXT_RESTORE_PATCH: direct CLI sends do not start the gateway account lifecycle.
      if (!getContextToken(accountId!, ctx.to)) restoreContextTokens(accountId!);
      const contextToken = getContextToken(accountId!, ctx.to);
      if (!contextToken) throw new Error("weixin: no active context token for direct delivery");
      const result = await sendWeixinOutbound({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        accountId,
        contextToken,
      });`,
  },
  {
    path: join(plugin.rootDir, 'dist', 'src', 'channel.js'),
    before: `            const accountId = ctx.accountId || resolveOutboundAccountId(ctx.cfg, ctx.to);
            const result = await sendWeixinOutbound({
                cfg: ctx.cfg,
                to: ctx.to,
                text: ctx.text,
                accountId,
                contextToken: getContextToken(accountId, ctx.to),
            });`,
    after: `            const accountId = ctx.accountId || resolveOutboundAccountId(ctx.cfg, ctx.to);
            // AI_MONITOR_CONTEXT_RESTORE_PATCH: direct CLI sends do not start the gateway account lifecycle.
            if (!getContextToken(accountId, ctx.to))
                restoreContextTokens(accountId);
            const contextToken = getContextToken(accountId, ctx.to);
            if (!contextToken)
                throw new Error("weixin: no active context token for direct delivery");
            const result = await sendWeixinOutbound({
                cfg: ctx.cfg,
                to: ctx.to,
                text: ctx.text,
                accountId,
                contextToken,
            });`,
  },
]

for (const file of files) {
  const content = readFileSync(file.path, 'utf8')
  if (content.includes(marker)) continue
  if (packageJson.version !== '2.4.6' || !content.includes(file.before)) {
    throw new Error(`Unsupported OpenClaw Weixin plugin layout (version ${packageJson.version})`)
  }
  writeFileSync(file.path, content.replace(file.before, file.after), 'utf8')
}

console.log(`OpenClaw Weixin direct-send compatibility verified for plugin ${packageJson.version}.`)
