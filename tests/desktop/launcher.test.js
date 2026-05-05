"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
test("public launcher shows the interactive Electron window and keeps the Node ABI separate",()=>{
 let launched;
 const file=path.resolve(__dirname,"../../tools/desktop.js");
 vm.runInNewContext(fs.readFileSync(file,"utf8"),{__dirname:path.dirname(file),process:{env:{ELECTRON_RUN_AS_NODE:"1"},execPath:"node.exe",argv:["node","launcher"]},require(name){if(name==="node:child_process")return {spawn(exe,args,options){launched={exe,args,options};return {on(){}};}};if(name==="node:path")return path;if(name==="electron")return "electron.exe";throw new Error("Unexpected launcher dependency");}});
 assert.equal(launched.options.windowsHide,false);assert.equal(launched.options.env.GALLERY_NODE,"node.exe");assert.equal(launched.options.env.ELECTRON_RUN_AS_NODE,undefined);
});
