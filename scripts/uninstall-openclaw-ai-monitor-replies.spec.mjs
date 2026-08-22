import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  markerPathFor,
  REPLY_PLUGIN_ID,
  REPLY_PACKAGE_NAME,
  uninstallReplyPlugin,
} from './uninstall-openclaw-ai-monitor-replies.mjs'

test('uninstalls only the AI Monitor reply plugin and removes the exact marker', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-monitor-openclaw-uninstall-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const marker = markerPathFor(root)
  writeFileSync(marker, '{}')
  const calls = []
  const run = (args) => {
    calls.push(args)
    if (args[0] === 'plugins' && args[1] === 'list') {
      return { status: 0, stdout: JSON.stringify({ plugins: [{ id: REPLY_PLUGIN_ID }] }), stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  }

  assert.equal(uninstallReplyPlugin({ run, root, packageNameFor: () => REPLY_PACKAGE_NAME }), 'uninstalled')
  assert.deepEqual(calls, [
    ['plugins', 'list', '--json'],
    ['plugins', 'uninstall', 'ai-monitor-replies', '--force'],
  ])
  assert.equal(calls.flat().includes('openclaw-qqbot'), false)
  assert.equal(calls.flat().includes('openclaw-weixin'), false)
  assert.equal(existsSync(marker), false)
})

test('missing plugin and config is an idempotent no-op', () => {
  const calls = []
  const run = (args) => {
    calls.push(args)
    return { status: 0, stdout: JSON.stringify({ plugins: [] }), stderr: '' }
  }

  assert.equal(uninstallReplyPlugin({ run, root: process.cwd(), fileExists: () => false }), 'already-absent')
  assert.deepEqual(calls, [
    ['plugins', 'list', '--json'],
  ])
})

test('refuses to uninstall another package that reuses the reply plugin id', () => {
  const run = (args) => {
    if (args[0] === 'plugins') {
      return { status: 0, stdout: JSON.stringify({ plugins: [{ id: REPLY_PLUGIN_ID }] }), stderr: '' }
    }
    assert.fail(`unexpected mutation command: ${args.join(' ')}`)
  }

  assert.throws(
    () => uninstallReplyPlugin({ run, root: process.cwd(), packageNameFor: () => '@example/not-ours' }),
    /Refusing to uninstall unowned/,
  )
})
