import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const supervisorPath = join(scriptsDirectory, 'run-relay-supervisor.ps1')
const installTaskPath = join(scriptsDirectory, 'install-task.ps1')

test('Windows startup entries use the relay supervisor and remove legacy Phoenix entries', () => {
  const source = readFileSync(installTaskPath, 'utf8')

  assert.match(source, /scripts\\run-relay-supervisor\.ps1/)
  assert.match(source, /AI Monitor - Phoenix/)
  assert.match(source, /Remove-StartupEntry -TaskName \$LegacyTaskName/)
  assert.match(source, /schtasks\.exe \/Delete \/TN \$TaskName \/F/)
  assert.match(source, /Join-Path \$StartupDir "\$TaskName\.lnk"/)
  assert.match(source, /\$Action = .*"\$RunScript/)
  assert.match(source, /\$Shortcut\.Arguments = .*"\$RunScript/)
  assert.match(source, /-WindowStyle Hidden/)
})

test('relay supervisor retries a stopped relay without a tight loop', { skip: process.platform !== 'win32' }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-relay-supervisor-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const relayStub = join(directory, 'relay-stub.ps1')
  const markerPath = join(directory, 'runs.txt')
  const logPath = join(directory, 'supervisor.log')
  writeFileSync(relayStub, [
    '[CmdletBinding()]',
    'param([string]$BindHost, [int]$Port)',
    'Add-Content -LiteralPath $env:AIMONITOR_SUPERVISOR_TEST_MARKER -Value "$BindHost`:$Port"',
    'Write-Output "relay-output"',
    '$global:LASTEXITCODE = 23',
  ].join('\r\n'))

  const startedAt = Date.now()
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', supervisorPath,
    '-RelayScript', relayStub,
    '-LogPath', logPath,
    '-RestartDelaySeconds', '1',
    '-MaxRuns', '2',
    '-MutexName', `Local\\AiMonitorRelaySupervisorTest-${process.pid}-${Date.now()}`,
    '-Port', '65534',
  ], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, AIMONITOR_SUPERVISOR_TEST_MARKER: markerPath },
  })
  const elapsedMs = Date.now() - startedAt

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.ok(elapsedMs >= 900, `expected a restart delay, completed in ${elapsedMs}ms`)
  assert.equal(readFileSync(markerPath, 'utf8').trim().split(/\r?\n/).length, 2)
  const log = readFileSync(logPath, 'utf8')
  assert.match(log, /relay-output/)
  assert.match(log, /Relay exited with code 23 \(run 1\)\./)
  assert.match(log, /Restarting relay in 1 second\(s\)\./)
  assert.match(log, /Supervisor stopped after reaching MaxRuns=2\./)
})
