import { lstat, readFile, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const dataRoot = resolve(process.env.AIMONITOR_DATA_ROOT || resolve(projectRoot, 'data'))
const arguments_ = process.argv.slice(2)
const outboundDir = arguments_.length === 2
  ? resolve(arguments_[0])
  : resolve(dataRoot, 'openclaw-outbound')
const messagePath = arguments_.length === 2
  ? resolve(arguments_[1])
  : arguments_.length === 1
    ? resolve(arguments_[0])
    : ''

if (!messagePath || dirname(messagePath) !== outboundDir || !basename(messagePath).startsWith('notification-')) {
  process.stderr.write('AI_MONITOR_NOTIFICATION_ARGUMENT_INVALID\n')
  process.exitCode = 2
} else {
  try {
    const [outboundStats, messageStats, realOutboundDir, realMessagePath] = await Promise.all([
      lstat(outboundDir),
      lstat(messagePath),
      realpath(outboundDir),
      realpath(messagePath),
    ])
    if (outboundStats.isSymbolicLink() || messageStats.isSymbolicLink() || dirname(realMessagePath) !== realOutboundDir) {
      process.stderr.write('AI_MONITOR_NOTIFICATION_ARGUMENT_INVALID\n')
      process.exitCode = 2
    } else {
      process.stdout.write(await readFile(messagePath, 'utf8'))
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN'
    process.stderr.write(code === 'ENOENT'
      ? 'AI_MONITOR_NOTIFICATION_PAYLOAD_MISSING\n'
      : `AI_MONITOR_NOTIFICATION_PAYLOAD_READ_FAILED:${code}\n`)
    process.exitCode = code === 'ENOENT' ? 3 : 1
  } finally {
    await unlink(messagePath).catch(() => undefined)
  }
}
