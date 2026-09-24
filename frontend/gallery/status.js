import { Sidebar } from "./components/sidebar.js";
import { ScanWS } from "../shared/events.js";
import { request } from "../shared/api.js";
import { createLiveUpdates } from "./live-updates.js";
let liveUpdates=null;
export async function checkScanMode() {
  try {
    const s = await request("status");
    Sidebar.setScanStatus({ ...s.scan, platform: s.scan.currentPlatform });
    if (typeof window !== "undefined")
      window.dispatchEvent(new CustomEvent("gallery-library-status", { detail: s }));
  } catch {}
}
export function checkRunningScan() {
  return checkScanMode();
}
export function initScanWS() {
  if(!liveUpdates)liveUpdates=createLiveUpdates({
    subscribe:callback=>ScanWS.onLiveStatus(callback),
    subscribeStatus:callback=>ScanWS.onStatus(callback),
  });
  ScanWS.onStatus((s) => {
    const scan=s && s.scan || {};
    Sidebar.setScanStatus({ ...scan, platform: scan.currentPlatform });
    if (typeof window !== "undefined")
      window.dispatchEvent(new CustomEvent("gallery-library-status", { detail: s || {} }));
  });
  ScanWS.connect();
}
