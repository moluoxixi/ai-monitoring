import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function assertSafeProject(projectInput) {
  const absolute = path.resolve(projectInput)
  const stats = fs.lstatSync(absolute, { throwIfNoEntry: false })
  if (!stats?.isDirectory() || stats.isSymbolicLink())
    throw new Error(`Project root must be a plain directory: ${absolute}`)
  return fs.realpathSync(absolute)
}

export function assertProjectIsNotHome(projectRoot) {
  const home = fs.realpathSync(os.homedir())
  if (samePath(projectRoot, home) && process.env.MOLUOXIXI_ALLOW_HOMEDIR !== '1')
    throw new Error('Refusing to modify the user home directory; set MOLUOXIXI_ALLOW_HOMEDIR=1 only when this is intentional')
}

export function assertSafeTarget(projectRoot, relativePath) {
  let current = projectRoot
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment)
    const stats = fs.lstatSync(current, { throwIfNoEntry: false })
    if (stats?.isSymbolicLink())
      throw new Error(`Output path contains a symbolic link: ${relativePath}`)
  }
  const resolved = path.resolve(projectRoot, ...relativePath.split('/'))
  const relation = path.relative(projectRoot, resolved)
  if (!relation || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation))
    throw new Error(`Output escapes project root: ${relativePath}`)
  return resolved
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}
