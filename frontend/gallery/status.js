import { Sidebar } from "./components/sidebar.js";
import { ScanWS } from "../shared/events.js";
import { request } from "../shared/api.js";
export async function checkScanMode() {
  try {
    const s = await request("status");
    Sidebar.setScanStatus({ ...s.scan, platform: s.scan.currentPlatform });
  } catch {}
}
export function checkRunningScan() {
  return checkScanMode();
}
export function initScanWS() {
  ScanWS.onScanStatus((s) =>
    Sidebar.setScanStatus({ ...s, platform: s.currentPlatform }),
  );
  ScanWS.connect();
}
