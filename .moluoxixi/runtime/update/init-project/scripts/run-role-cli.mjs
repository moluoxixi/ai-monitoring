#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const relativeEntry = path.join('packages', 'cli', 'bin', 'init-project.js')
const candidates = [
  path.resolve(skillRoot, '..', '..', relativeEntry),
  path.resolve(skillRoot, '..', '..', '..', 'roles', 'moluoxixi', relativeEntry),
  path.join(os.homedir(), '.moluoxixi', 'roles', 'moluoxixi', relativeEntry),
]
const entry = candidates.find(candidate => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile())

if (!entry)
  throw new Error('The installed Moluoxixi role-local CLI is missing; run `airules sync --role moluoxixi` first')

const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
})
if (result.error)
  throw result.error
process.exitCode = result.status ?? 1
