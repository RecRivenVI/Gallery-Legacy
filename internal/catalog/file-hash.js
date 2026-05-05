"use strict";
const fs=require("node:fs"),crypto=require("node:crypto");
function hashDatabaseFile(file){const hash=crypto.createHash("sha256"),fd=fs.openSync(file,"r"),buffer=Buffer.allocUnsafe(1024*1024);try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,n));}finally{fs.closeSync(fd);}return hash.digest("hex");}
module.exports={hashDatabaseFile};
