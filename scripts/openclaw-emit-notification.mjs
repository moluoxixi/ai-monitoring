import { readFile, unlink } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const outboundDir = resolve(projectRoot, 'data', 'openclaw-outbound')
const messagePath = process.argv.length === 3 ? resolve(process.argv[2]) : ''

if (!messagePath || dirname(messagePath) !== outboundDir || !basename(messagePath).startsWith('notification-')) {
  process.exitCode = 2
} else {
  try {
    process.stdout.write(await readFile(messagePath, 'utf8'))
  } finally {
    await unlink(messagePath).catch(() => undefined)
  }
}
