"use strict";
const fs = require("node:fs"), path = require("node:path");
const { noLinks } = require("../library/io-paths.js");
function rotatingLog(root, name, { maxBytes = 8 * 1024 * 1024, history = 5 } = {}) {
  if (!/^[a-z0-9-]+\.log$/.test(name) || !Number.isSafeInteger(maxBytes) || maxBytes < 64 || !Number.isInteger(history) || history < 1 || history > 10) throw new TypeError("Invalid log policy");
  noLinks(root); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, name), archived = i => path.join(root,name.replace(/\.log$/,`.${i}.log`));
  function write(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const payload = bytes.length > maxBytes ? bytes.subarray(bytes.length-maxBytes) : bytes;
    noLinks(file);
    if (fs.existsSync(file) && fs.statSync(file).size + payload.length > maxBytes) {
      for (let i=history;i>=1;i--) { const dest=archived(i),src=i===1?file:archived(i-1);noLinks(dest);noLinks(src);if(fs.existsSync(dest))fs.unlinkSync(dest);if(fs.existsSync(src))fs.renameSync(src,dest); }
    }
    fs.appendFileSync(file,payload);
  }
  return { write, file };
}
function installRuntimeLog(config,name) {
  const log=rotatingLog(config.logsRoot,name);
  for(const stream of [process.stdout,process.stderr]) {
    const original=stream.write.bind(stream);
    stream.write=function(chunk,encoding,callback){try{log.write(chunk);}catch{/* A temporarily locked log must not crash the service or grow unbounded. */}return original(chunk,encoding,callback);};
  }
}
module.exports={rotatingLog,installRuntimeLog};
