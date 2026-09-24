"use strict";
const {performance}=require("node:perf_hooks");

// Called on hot paths: consult the control file at most once per interval,
// while keeping the observed cancellation latched for the whole generation.
function createCancellationCheck({generationId,read,now=()=>performance.now(),intervalMs=200}) {
  if(typeof generationId!=="string"||!generationId||typeof read!=="function"||typeof now!=="function"||!Number.isFinite(intervalMs)||intervalMs<=0)throw new TypeError("Invalid cancellation check");
  let nextRead=-Infinity,cancelled=false,reads=0;
  const assertRunning=()=>{if(cancelled)throw Object.assign(new Error("Scan cancelled"),{code:"SCAN_CANCELLED"});};
  const refresh=()=>{
    assertRunning();
    const request=read();reads++;
    nextRead=now()+intervalMs;
    cancelled=request?.generationId===generationId;
    assertRunning();
  };
  const check=()=>{assertRunning();if(now()>=nextRead)refresh();};
  check.force=refresh;
  check.stats=()=>({controlReads:reads,intervalMs});
  return check;
}
module.exports={createCancellationCheck};
