// Bind numeric vectors to the bytes loaded into the native runtime. A package
// replacement on disk must not advertise new weights while old ones are loaded.
const identity = stat => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])
module.exports = { identity }
