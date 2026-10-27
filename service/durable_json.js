const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')

function writeJson(file, value) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = file + '.' + randomUUID() + '.tmp'
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd) }
  finally { fs.closeSync(fd) }
  fs.renameSync(tmp, file)
  try {
    const d = fs.openSync(dir, 'r')
    try { fs.fsyncSync(d) } finally { fs.closeSync(d) }
  } catch (e) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP', 'EBADF'].includes(e.code)) throw e }
}
module.exports = { writeJson }
