"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {chromium}=require("playwright");const {fixture,freePort}=require("../support/runtime.js");
const {createManagerTestHost}=require("../../tools/manager-test.js");const {createRuntimeBootstrap}=require("../../internal/runtime/bootstrap.js");
test("test-only Manager uses authenticated loopback and real local use cases without exposing production admin",async t=>{
  const f=await fixture(t);await f.build();f.publish();const configFile=path.join(f.config.instanceRoot,"config.json");
  await assert.rejects(createManagerTestHost(configFile,{port:await freePort()}),{code:"TEST_INSTANCE_REQUIRED"});
  const raw=JSON.parse(fs.readFileSync(configFile));raw.deployment="staging";fs.writeFileSync(configFile,JSON.stringify(raw));
  const runtime=createRuntimeBootstrap({config:{...f.config,deployment:"staging"}});f.cleanup.push(()=>runtime.close());await runtime.start();
  const host=await createManagerTestHost(configFile,{port:await freePort()});f.cleanup.push(()=>host.close());
  assert.equal((await fetch(host.url+"/test-control",{method:"POST",headers:{Origin:host.url,"Content-Type":"application/json"},body:'{"method":"status","args":[]}'})).status,403);
  const wrongHost=await new Promise((resolve,reject)=>{const req=require("node:http").get(host.url,{headers:{Host:"attacker.invalid"}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode));});req.on("error",reject);});assert.equal(wrongHost,403);
  assert.equal((await fetch(host.url,{headers:{Origin:"https://example.invalid"}})).status,403);
  const browser=await chromium.launch({headless:true});f.cleanup.push(()=>browser.close());const page=await browser.newPage();page.on("dialog",d=>d.accept());const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto(host.url);await page.waitForFunction(()=>document.querySelector("#stop")&&!document.querySelector("#stop").disabled);
  await page.locator('[data-tab="scan"]').click();await page.waitForSelector("#scan-platform-picker");
  const platformIds=await page.locator("input[data-platform-id]").evaluateAll((elements)=>elements.map((element)=>element.dataset.platformId));
  assert.equal(platformIds.length,9);assert.ok(platformIds.includes("pixiv"));
  await page.locator("#scan-platform-clear").click();assert.equal(await page.locator("#scan-start").isDisabled(),true);
  await page.locator('input[data-platform-id="pixiv"]').check();assert.equal(await page.locator("#scan-start").isEnabled(),true);
  // Normal incremental updates submit the selected platform set directly.
  let starts=0,startInputs=[];page.on("request",req=>{if(req.url().endsWith("/test-control")){const body=req.postDataJSON();if(body?.method==="admin"&&body.args?.[0]==="scan.start"){starts++;startInputs.push(body.args?.[1]);}}});
  await page.locator("#scan-start").click();
  const scanDeadline=Date.now()+45000;
  let observedScan;
  do { observedScan=await page.evaluate(()=>window.galleryHost.admin("scan.status")); if(observedScan.state==="READY"&&!observedScan.running)break; await new Promise(resolve=>setTimeout(resolve,200)); } while(Date.now()<scanDeadline);
  assert.equal(observedScan.state,"READY");assert.equal(observedScan.running,false);assert.equal(observedScan.mode,"incremental");assert.deepEqual(startInputs[0],{platformIds:["pixiv"],mode:"incremental",confirmReadOnly:true});assert.deepEqual(observedScan.scope?.effectivePlatformIds||observedScan.scope?.requestedPlatformIds||observedScan.platformIds,["pixiv"],JSON.stringify(observedScan));assert.equal(starts,1);const incrementalGeneration=observedScan.generationId;
  // Full/advanced updates still require the in-page confirmation and do not
  // submit from the first click.
  await page.waitForFunction(()=>document.querySelector("#scan-advanced-start")&&!document.querySelector("#scan-advanced-start").disabled);
  await page.locator("#scan-advanced").click();await page.locator("#scan-mode").selectOption("full");await page.locator("#scan-scope").selectOption("platform");await page.locator("#scan-advanced-platform").selectOption("pixiv");
  await page.locator("#scan-advanced-start").click();await page.waitForSelector("#scan-confirmation");assert.equal(starts,1);assert.equal(await page.locator("#scan-confirm-start").isDisabled(),true);
  await page.locator("#scan-confirm-cancel").click();assert.equal(starts,1);
  await page.locator("#scan-advanced-start").click();await page.locator("#scan-confirm-readonly").check();await page.locator("#scan-confirm-start").click();
  const fullDeadline=Date.now()+45000;let fullStarted=false;do { observedScan=await page.evaluate(()=>window.galleryHost.admin("scan.status")); if(observedScan.generationId!==incrementalGeneration)fullStarted=true; if(fullStarted&&observedScan.state==="READY"&&!observedScan.running)break; await new Promise(resolve=>setTimeout(resolve,200)); } while(Date.now()<fullDeadline);
  assert.equal(observedScan.state,"READY",JSON.stringify(observedScan));assert.equal(observedScan.running,false);assert.equal(observedScan.mode,"full",JSON.stringify(observedScan));assert.deepEqual(startInputs[1],{platformIds:["pixiv"],mode:"full",confirmReadOnly:true});assert.equal(starts,2);
  await page.waitForFunction(()=>!document.querySelector("#scan-confirmation")&&!!document.querySelector("#scope-check"));
  await page.locator('[data-tab="validation"]').click();
  await page.waitForSelector("#validation-start");
  await page.locator("#validation-start").click();
  await page.waitForFunction(()=>document.querySelector("#validation-status").textContent.includes('"COMPLETED"')||/VALIDATION_BUSY|START_FAILED|INSTANCE_IN_USE/.test(document.querySelector("#validation-message").textContent),null,{timeout:30000});
  const validationState=await page.evaluate(()=>window.galleryHost.admin("validation.status"));
  assert.equal(validationState.state,"COMPLETED",await page.locator("#validation-message").textContent());
  await page.locator("#validation-results").click();await page.waitForSelector('[data-finding]');assert.ok(await page.locator('[data-finding]').count()>0);
  await page.locator('[data-tab="storage"]').click();await page.waitForSelector("#cache-orphans");
  await page.locator('[data-tab="logs"]').click();await page.waitForSelector("#log-query");
  assert.deepEqual(errors,[]);
  assert.equal((await fetch(f.config.url+"/api/v1/scans",{method:"POST",headers:{"Content-Type":"application/json"},body:'{"confirmReadOnly":true}'})).status,403);
});
