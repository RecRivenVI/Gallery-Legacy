"use strict";
const { contextBridge, ipcRenderer } = require("electron");
async function call(channel) {
  const result = await ipcRenderer.invoke(channel);
  if (!result?.ok)
    throw Object.assign(new Error(result?.code || "HOST_REQUEST_FAILED"), {
      code: result?.code || "HOST_REQUEST_FAILED",
    });
}
contextBridge.exposeInMainWorld(
  "galleryHost",
  Object.freeze({
    openGallery: () => call("host:open-gallery"),
    restart: () => call("host:restart"),
  }),
);
