import assert from 'node:assert/strict'
import test from 'node:test'

import { isWindowsMsvcLinkerPath } from './desktop-toolchain.mjs'

test('recognizes the MSVC linker and rejects the Git link utility', () => {
  assert.equal(
    isWindowsMsvcLinkerPath('C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64\\link.exe'),
    true,
  )
  assert.equal(isWindowsMsvcLinkerPath('C:\\Program Files\\Git\\usr\\bin\\link.exe'), false)
  assert.equal(isWindowsMsvcLinkerPath('/usr/bin/link'), false)
})
