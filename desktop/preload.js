"use strict";
const { contextBridge, ipcRenderer } = require("electron");
async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result?.ok)
    throw Object.assign(new Error(result?.code || "HOST_REQUEST_FAILED"), {
      code: result?.code || "HOST_REQUEST_FAILED",
    });
  return result.data;
}
contextBridge.exposeInMainWorld(
  "galleryHost",
  Object.freeze({
    openGallery: () => call("host:open-gallery"),
    restart: () => call("host:restart"),
    start: () => call("host:start"),
    stop: () => call("host:stop"),
    scan: () => call("host:scan"),
    status: () => call("host:status"),
    admin: (operation,input) => call("host:admin",operation,input),
    openDirectory: kind => call("host:directory",kind),
    pickDirectory: () => call("host:pick-directory"),
    openFinding: (id,index) => call("host:open-finding",id,index),
  }),
);
