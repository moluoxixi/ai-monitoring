[CmdletBinding()]
param([switch]$QuietIfMissing)

$ErrorActionPreference = "Stop"
$Marker = "AI_MONITOR_CONTEXT_RESTORE_PATCH"

if (-not (Get-Command openclaw -ErrorAction SilentlyContinue)) {
    if (-not $QuietIfMissing) { Write-Warning "OpenClaw is not installed; skipping the Weixin compatibility patch." }
    return
}

$PluginList = & openclaw plugins list --json | ConvertFrom-Json
$Plugin = $PluginList.plugins | Where-Object { $_.id -eq "openclaw-weixin" -and $_.status -eq "loaded" } | Select-Object -First 1
if (-not $Plugin) {
    if (-not $QuietIfMissing) { Write-Warning "The OpenClaw Weixin plugin is not loaded; skipping the compatibility patch." }
    return
}

$PackagePath = Join-Path $Plugin.rootDir "package.json"
$Package = Get-Content -Raw -LiteralPath $PackagePath | ConvertFrom-Json
$Files = @(
    @{
        Path = Join-Path $Plugin.rootDir "src\channel.ts"
        Before = @'
      const accountId = ctx.accountId || resolveOutboundAccountId(ctx.cfg, ctx.to);
      const result = await sendWeixinOutbound({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        accountId,
        contextToken: getContextToken(accountId!, ctx.to),
      });
'@
        After = @'
      const accountId = ctx.accountId || resolveOutboundAccountId(ctx.cfg, ctx.to);
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
      });
'@
    },
    @{
        Path = Join-Path $Plugin.rootDir "dist\src\channel.js"
        Before = @'
            const accountId = ctx.accountId || resolveOutboundAccountId(ctx.cfg, ctx.to);
            const result = await sendWeixinOutbound({
                cfg: ctx.cfg,
                to: ctx.to,
                text: ctx.text,
                accountId,
                contextToken: getContextToken(accountId, ctx.to),
            });
'@
        After = @'
            const accountId = ctx.accountId || resolveOutboundAccountId(ctx.cfg, ctx.to);
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
            });
'@
    }
)

foreach ($File in $Files) {
    if (-not (Test-Path -LiteralPath $File.Path)) { throw "Weixin plugin file is missing: $($File.Path)" }
    $Content = Get-Content -Raw -LiteralPath $File.Path
    if ($Content.Contains($Marker)) { continue }
    if ($Package.version -ne "2.4.6" -or -not $Content.Contains($File.Before)) {
        throw "Unsupported OpenClaw Weixin plugin layout (version $($Package.version)); refusing an unverified patch."
    }
    Set-Content -LiteralPath $File.Path -Value $Content.Replace($File.Before, $File.After) -Encoding UTF8 -NoNewline
}

Write-Host "OpenClaw Weixin direct-send compatibility verified for plugin $($Package.version)."
