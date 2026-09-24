"use strict";
const test=require("node:test"),assert=require("node:assert/strict");const {chromium}=require("playwright");
const {fixture}=require("../support/runtime.js");const {normalizeRuntimeConfig}=require("../../internal/instance/config.js");
const {createRuntimeBootstrap}=require("../../internal/runtime/bootstrap.js");
const {openLive,applyLiveBatch}=require("../../internal/catalog/live.js");
const {observePlatformTree}=require("../../internal/library/observer.js");const {prepareAuthorObservation}=require("../../internal/indexing/preparation.js");
test("live frontend refreshes idle first page, protects scroll/viewer, and explicitly refreshes stale pagination",async t=>{
  const f=await fixture(t,{empty:true});for(let i=0;i<30;i++)f.work("baseline-"+i,{title:"Baseline "+i});const generation=await f.build();f.publish();
  const config=normalizeRuntimeConfig({...f.config,liveUpdates:true});const runtime=createRuntimeBootstrap({config});f.cleanup.push(()=>runtime.close());await runtime.start();
  const writer=openLive(config,generation,{readonly:false});f.cleanup.push(()=>writer.close());
  const browser=await chromium.launch({headless:true});f.cleanup.push(()=>browser.close());const page=await browser.newPage({viewport:{width:1000,height:600}});page.setDefaultTimeout(20000);const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto(config.url+"/#/@all/pixiv");await page.waitForFunction(()=>document.querySelectorAll("#content .card").length===30);
  function add(author){f.work("incoming-"+author,{title:"New "+author,date:"2030-01-01T00:00:00Z"},undefined,author);const tree=observePlatformTree({platformId:"pixiv",observationRoot:f.bindings.pixiv});const p=prepareAuthorObservation(tree.authors.find(a=>a.authorDirectoryName===author));applyLiveBatch(writer.db,{mappedCandidates:p.preparedCandidates,preparedAuthors:[p.preparedAuthor]});}
  add("200");await page.waitForFunction(()=>document.querySelectorAll("#content .card").length===31);
  await page.evaluate(()=>window.scrollTo(0,600));const y=await page.evaluate(()=>window.scrollY);add("201");await page.waitForSelector("#live-update-notice:not([hidden])");assert.equal(await page.locator("#content .card").count(),31);assert.equal(await page.evaluate(()=>window.scrollY),y);
  assert.equal(await page.evaluate(async()=>{await (await import('/frontend/shared/api.js')).request('status');return (await import('/frontend/gallery/model.js')).state.queryRevision;}),1);
  await page.locator("#live-update-apply").click();await page.waitForFunction(()=>document.querySelectorAll("#content .card").length===32);
  await page.evaluate(()=>window.scrollTo(0,0));await page.locator("#content .card .media-cover").first().click();await page.locator('.lb-slide.active img').first().waitFor({state:"visible"});
  const media=await page.locator('.lb-slide.active img').first().getAttribute('src');add("202");await page.waitForFunction(()=>!document.querySelector('#live-update-notice').hidden&&document.querySelector('#live-update-apply').disabled);assert.equal(await page.locator('.lb-slide.active img').first().getAttribute('src'),media);
  await page.keyboard.press("Escape");await page.waitForFunction(()=>!document.querySelector('#live-update-apply').disabled);await page.locator('#live-update-apply').click();await page.waitForFunction(()=>document.querySelectorAll('#content .card').length===33);
  assert.deepEqual(errors,[]);
});

test("live updates in another platform do not reload the current platform list",async t=>{
  const f=await fixture(t);const generation=await f.build();f.publish();
  const config=normalizeRuntimeConfig({...f.config,liveUpdates:true});const runtime=createRuntimeBootstrap({config});f.cleanup.push(()=>runtime.close());await runtime.start();
  const writer=openLive(config,generation,{readonly:false});f.cleanup.push(()=>writer.close());
  const browser=await chromium.launch({headless:true});f.cleanup.push(()=>browser.close());const page=await browser.newPage();
  let revisionSeen=-1,requests=0;
  page.on("websocket",socket=>socket.on("framereceived",({payload})=>{try{const v=JSON.parse(String(payload));if(v.data?.live)revisionSeen=v.data.live.revision;}catch{}}));
  page.on("request",request=>{if(new URL(request.url()).pathname==="/api/v1/works")requests++;});
  await page.goto(config.url+"/#/@all/pixiv");await page.waitForSelector("#content .card");
  const initial=requests;
  f.work("other-platform",{title:"Synthetic unrelated work"},undefined,"200","pixivFANBOX");
  const tree=observePlatformTree({platformId:"pixivFANBOX",observationRoot:f.bindings.pixivFANBOX});const p=prepareAuthorObservation(tree.authors[0]);
  applyLiveBatch(writer.db,{mappedCandidates:p.preparedCandidates,preparedAuthors:[p.preparedAuthor]});
  const deadline=Date.now()+10000;while(revisionSeen<1&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
  assert.ok(revisionSeen>=1,"received the actual server update");
  await page.waitForTimeout(5500);
  assert.equal(requests,initial,"unrelated commits must not rebuild the current list");
  assert.equal(await page.locator("#live-update-notice").isVisible(),false);
});
