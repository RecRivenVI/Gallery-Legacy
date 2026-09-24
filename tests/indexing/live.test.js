"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {fixture}=require("../support/runtime.js");
const {normalizeRuntimeConfig}=require("../../internal/instance/config.js");
const {observePlatformTree}=require("../../internal/library/observer.js");
const {prepareAuthorObservation,createStreamingAuthorPreparation}=require("../../internal/indexing/preparation.js");
const {ensureLive,openLive,applyLiveBatch,getLiveState}=require("../../internal/catalog/live.js");
const {QueryIndex}=require("../../internal/search/query.js");
const {fullScan}=require("../../internal/indexing/task.js");
const {NODE_FS_IO}=require("../../internal/library/observer.js");
const {verifyCatalogContract}=require("../../internal/catalog/writer.js");
const {CatalogReader}=require("../../internal/catalog/reader.js");
function liveConfig(f){return normalizeRuntimeConfig({instanceRoot:f.config.instanceRoot,sources:f.bindings,port:f.config.port,liveUpdates:true,retention:{enabled:false}});}
function prepared(f){const tree=observePlatformTree({platformId:"pixiv",observationRoot:f.bindings.pixiv});return prepareAuthorObservation(tree.authors.find(a=>a.authorDirectoryName==="100"));}
function assertLiveStatsMatch(db){const stored=db.prepare("SELECT works,media,authors FROM live_stats WHERE singleton=1").get(),actual={works:db.prepare("SELECT count(*) n FROM works").get().n,media:db.prepare("SELECT count(*) n FROM media").get().n,authors:db.prepare("SELECT count(*) n FROM authors").get().n};assert.deepEqual(stored,actual);const platforms=db.prepare("SELECT platform_id,count_works,count_media FROM live_platform_stats ORDER BY platform_id").all(),actualPlatforms=db.prepare("SELECT p.platform_id,count(w.work_id) count_works,coalesce(sum(w.media_count),0) count_media FROM platforms p LEFT JOIN works w ON w.platform_id=p.platform_id GROUP BY p.platform_id ORDER BY p.platform_id").all();assert.deepEqual(platforms.map(({platform_id,count_works,count_media})=>({platform_id,count_works,count_media})),actualPlatforms);}

test("live checkpoint honors multi-platform and singleton-author scopes without deleting unselected facts",async t=>{
  const f=await fixture(t,{empty:true});
  const dirs=[f.work("remove",undefined,undefined,"one","pixiv"),f.work("keep",undefined,undefined,"two","pixiv"),f.work("remove",undefined,undefined,"one","X"),f.work("keep",undefined,undefined,"one","Gank")];
  const generation=await f.build();f.publish();const config=liveConfig(f);await ensureLive(config,generation);
  // Synthetic sources only: disappearances outside requested scopes must remain unconfirmed.
  for(const dir of dirs)fs.rmSync(dir,{recursive:true});
  await fullScan(config,{confirmReadOnly:true,generationId:"author-selection",mode:"incremental",platformIds:["pixiv"],authorDirectoryName:"one"});
  let live=openLive(config,{generationId:"author-selection"},{readonly:true});
  assert.deepEqual(live.db.prepare("SELECT platform_id,count(*) n FROM works GROUP BY platform_id ORDER BY platform_id").all(),[{platform_id:"Gank",n:1n},{platform_id:"X",n:1n},{platform_id:"pixiv",n:1n}]);live.close();
  await fullScan(config,{confirmReadOnly:true,generationId:"multi-selection",mode:"incremental",platformIds:["X","pixiv"]});
  live=openLive(config,{generationId:"multi-selection"},{readonly:true});f.cleanup.push(()=>live.close());
  assert.deepEqual(live.db.prepare("SELECT platform_id,count(*) n FROM works GROUP BY platform_id").all(),[{platform_id:"Gank",n:1n}]);assertLiveStatsMatch(live.db);
});
test("live Catalog commits complete work and Search atomically while preserving media identities",async t=>{
  const f=await fixture(t);const generation=await f.build();f.publish();const config=liveConfig(f);
  const initial=await ensureLive(config,generation);assert.equal(initial.baseGenerationId,"first");
  const live=openLive(config,generation,{readonly:false});f.cleanup.push(()=>live.close());
  const index=new QueryIndex(null,null,{db:live.db,prefix:"live_",ownsDb:false});
  const before=getLiveState(live.db),work=live.db.prepare("SELECT work_id FROM works WHERE relative_path_key=?").get("100\\2026-01-01_00-00-00_1");
  assert.equal(before.platformRevisions.pixiv,0);assert.equal(Object.keys(before.platformRevisions).length,9);
  const mediaBefore=live.db.prepare("SELECT media_id FROM media WHERE work_id=? AND relative_path_key='1.png'").get(work.work_id).media_id;
  fs.writeFileSync(path.join(f.bindings.pixiv,"100","2026-01-01_00-00-00_1","metadata.json"),JSON.stringify({id:"same",date:"2030-01-01T00:00:00Z",title:"Visible now",user:{id:"100",name:"Live author"}}));
  const update=prepared(f);const result=applyLiveBatch(live.db,{mappedCandidates:update.preparedCandidates,preparedAuthors:[update.preparedAuthor]});
  assert.equal(result.revision,before.revision+1);assert.equal(index.workPage({query:"Visible now"}).total,1);assert.ok(index.workPage({query:"Live author"}).total>1);
  assert.equal(result.platformRevisions.pixiv,result.revision);assert.equal(result.platformRevisions.Gank,0);assertLiveStatsMatch(live.db);
  assert.equal(live.db.prepare("SELECT media_id FROM media WHERE work_id=? AND relative_path_key='1.png'").get(work.work_id).media_id,mediaBefore);
  const directory=path.join(f.bindings.pixiv,"100","2026-01-01_00-00-00_1");fs.unlinkSync(path.join(directory,"1.png"));fs.writeFileSync(path.join(directory,"2.png"),f.PNG);
  const replacement=prepared(f);applyLiveBatch(live.db,{mappedCandidates:replacement.preparedCandidates,preparedAuthors:[replacement.preparedAuthor]});
  const mediaAfter=live.db.prepare("SELECT media_id FROM media WHERE work_id=? AND relative_path_key='2.png'").get(work.work_id).media_id;
  assert.ok(mediaAfter>mediaBefore);assert.equal(live.db.prepare("SELECT count(*) n FROM media WHERE media_id=?").get(mediaBefore).n,0n);
  assertLiveStatsMatch(live.db);
  const beforeRejected=getLiveState(live.db).revision;
  fs.writeFileSync(path.join(directory,"metadata.json"),JSON.stringify({id:"same",title:"Must roll back",user:{id:"100",name:"Live author"}}));
  const rollback=prepared(f);live.db.exec("CREATE TEMP TRIGGER live_test_search_abort BEFORE INSERT ON live_work_sort BEGIN SELECT RAISE(ABORT,'synthetic search failure'); END");
  assert.throws(()=>applyLiveBatch(live.db,{mappedCandidates:rollback.preparedCandidates,preparedAuthors:[rollback.preparedAuthor]}),/synthetic search failure/);
  live.db.exec("DROP TRIGGER live_test_search_abort");
  assert.equal(live.db.prepare("SELECT title FROM works WHERE work_id=?").get(work.work_id).title,"Visible now");
  assert.throws(()=>applyLiveBatch(live.db,{mappedCandidates:[{rows:{work:{filesystem_state:"present",filesystem_files_state:"incomplete"}}}]}),{code:"LIVE_WORK_INCOMPLETE"});
  assert.equal(getLiveState(live.db).revision,beforeRejected);
});
test("live Search hideEmpty follows current presentation facts and shared QueryIndex does not own the DB",async t=>{
  const f=await fixture(t,{empty:true});f.work("hidden",undefined,{"cover.png":f.PNG});f.work("shown",undefined,{"1.png":f.PNG});
  const generation=await f.build();f.publish();const config=liveConfig(f);await ensureLive(config,generation);
  const live=openLive(config,generation,{readonly:false});f.cleanup.push(()=>live.close());const index=new QueryIndex(null,null,{db:live.db,prefix:"live_",ownsDb:false});
  const reader=new CatalogReader(live.catalogPath,live.epoch,f.bindings,{db:live.db,live:true,ownsDb:false});
  assert.ok(live.db.prepare("EXPLAIN QUERY PLAN SELECT works,media,authors FROM live_stats WHERE singleton=1").all().every(row=>!String(row.detail).includes("works")));
  assert.deepEqual(reader.stats(),{works:2,media:2,authors:1,metadataStates:{missing:2}});
  assert.equal(index.workPage({hideEmpty:true}).total,1);index.close();assert.equal(live.db.prepare("SELECT count(*) n FROM works").get().n,2n);
  const changed={...f.bindings,pixiv:path.join(f.root,"alternate-pixiv")};fs.mkdirSync(changed.pixiv,{recursive:true});
  const changedConfig=normalizeRuntimeConfig({instanceRoot:f.config.instanceRoot,sources:changed,port:f.config.port,liveUpdates:true,retention:{enabled:false}});
  await assert.rejects(ensureLive(changedConfig,generation),{code:"LIVE_SOURCE_BINDING_MISMATCH"});
  live.db.prepare("UPDATE live_meta SET revision=-1").run();assert.throws(()=>getLiveState(live.db),{code:"LIVE_META_INVALID"});live.db.prepare("UPDATE live_meta SET revision=0").run();
  live.db.exec("CREATE TABLE live_unrecognized(value TEXT)");assert.throws(()=>verifyCatalogContract(live.db,{allowLive:true}),{code:"catalog_live_contract_mismatch"});
});
test("schema v1 live databases upgrade aggregates in place without losing committed facts",async t=>{
  const f=await fixture(t);const generation=await f.build();f.publish();const config=liveConfig(f);await ensureLive(config,generation);
  const live=openLive(config,generation,{readonly:false});const count=live.db.prepare("SELECT count(*) n FROM works").get().n;
  live.db.exec("DROP TABLE live_platform_stats;DROP TABLE live_metadata_stats;DROP TABLE live_stats;UPDATE live_meta SET schema_version=1,revision=7");live.close();
  const upgraded=await ensureLive(config,generation);assert.equal(upgraded.schemaVersion,2);assert.equal(upgraded.revision,7);assert.equal(upgraded.reset,false);
  const read=openLive(config,generation,{readonly:true});f.cleanup.push(()=>read.close());assert.equal(read.db.prepare("SELECT count(*) n FROM works").get().n,count);assertLiveStatsMatch(read.db);
  assert.ok(Object.values(getLiveState(read.db).platformRevisions).every(value=>value===7));
});
test("live metadata aggregate transitions update existing rows before inserting new positive states",async t=>{
  const f=await fixture(t,{empty:true}),dir=f.work("only",{id:"only",title:"Valid",user:{id:"100",name:"A"}});const generation=await f.build();f.publish();const config=liveConfig(f);await ensureLive(config,generation);const live=openLive(config,generation,{readonly:false});f.cleanup.push(()=>live.close());
  const apply=()=>{const item=prepared(f);applyLiveBatch(live.db,{mappedCandidates:item.preparedCandidates,preparedAuthors:[item.preparedAuthor]});assertLiveStatsMatch(live.db);};
  fs.unlinkSync(path.join(dir,"metadata.json"));apply();
  assert.equal(live.db.prepare("SELECT count FROM live_metadata_stats WHERE metadata_state='valid'").get().count,0n);assert.equal(live.db.prepare("SELECT count FROM live_metadata_stats WHERE metadata_state='missing'").get().count,1n);
  fs.writeFileSync(path.join(dir,"metadata.json"),JSON.stringify({id:"only",title:{invalid:true},user:{id:"100",name:"A"}}));apply();
  assert.equal(live.db.prepare("SELECT count FROM live_metadata_stats WHERE metadata_state='missing'").get().count,0n);assert.equal(live.db.prepare("SELECT count FROM live_metadata_stats WHERE metadata_state='partial'").get().count,1n);
  fs.writeFileSync(path.join(dir,"metadata.json"),JSON.stringify({id:"only",title:"Valid again",user:{id:"100",name:"A"}}));apply();
  assert.equal(live.db.prepare("SELECT count FROM live_metadata_stats WHERE metadata_state='partial'").get().count,0n);assert.equal(live.db.prepare("SELECT count FROM live_metadata_stats WHERE metadata_state='valid'").get().count,1n);
});
test("scan batches become live and successful checkpoint advances the live base generation",async t=>{
  const f=await fixture(t);const generation=await f.build();f.publish();const config=liveConfig(f);await ensureLive(config,generation);
  f.work("2029-01-01_00-00-00_live",{id:"live",date:"2029-01-01T00:00:00Z",title:"Batch visible",user:{id:"100",name:"Live"}});
  const report=await fullScan(config,{confirmReadOnly:true,generationId:"live-scan",mode:"incremental",platformId:"pixiv",authorDirectoryName:"100"});
  assert.equal(report.state,"READY");
  assert.equal(JSON.parse(fs.readFileSync(config.scanStatusPath,"utf8")).restartRequired,false);
  const live=openLive(config,{generationId:"live-scan"},{readonly:true});f.cleanup.push(()=>live.close());
  assert.equal(getLiveState(live.db).baseGenerationId,"live-scan");
  assert.equal(live.db.prepare("SELECT count(*) n FROM works WHERE title='Batch visible'").get().n,1n);
  assert.ok(getLiveState(live.db).revision>0);
  const published=require("../../internal/publication/generations.js").resolveActiveGeneration(config.instanceRoot,{generationsRoot:config.generationsRoot,activePointerPath:config.activeGenerationPath});
  const publishedDb=new (require("better-sqlite3"))(published.catalogPath,{readonly:true});try{assert.equal(publishedDb.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'live_%'").get().n,0);}finally{publishedDb.close();}
});
test("failed scan keeps committed live batches and the next candidate starts from that live snapshot",async t=>{
  const f=await fixture(t);fs.rmSync(path.join(f.config.tempRoot,"rimraf-prewarm"),{recursive:true,force:true});
  const generation=await f.build();f.publish();const config=liveConfig(f);await ensureLive(config,generation);
  f.work("2029-02-01_00-00-00_retained",{id:"retained",date:"2029-02-01T00:00:00Z",title:"Retained batch",user:{id:"100",name:"Live"}});
  const io={...NODE_FS_IO,readdir(target){if(path.resolve(target)===path.resolve(f.bindings.pixivFANBOX))throw Object.assign(new Error("synthetic incomplete"),{code:"EACCES"});return NODE_FS_IO.readdir(target);}};
  await assert.rejects(fullScan(config,{confirmReadOnly:true,generationId:"live-failed",mode:"incremental",io}),{code:"GENERATION_CATALOG_INCOMPLETE"});
  const retained=openLive(config,generation,{readonly:true});
  assert.equal(retained.db.prepare("SELECT count(*) n FROM works WHERE title='Retained batch'").get().n,1n);
  assert.equal(getLiveState(retained.db).baseGenerationId,"first");retained.close();
  f.work("2029-03-01_00-00-00_cancelled",{id:"cancelled",date:"2029-03-01T00:00:00Z",title:"Cancelled retained",user:{id:"100",name:"Live"}});
  let requested=false;const cancelIo={...NODE_FS_IO,readdir(target){if(!requested&&path.resolve(target)===path.resolve(f.bindings.pixivFANBOX)){requested=true;fs.writeFileSync(path.join(config.stateRoot,"scan-cancel.json"),JSON.stringify({generationId:"live-cancelled"}));}return NODE_FS_IO.readdir(target);}};
  await assert.rejects(fullScan(config,{confirmReadOnly:true,generationId:"live-cancelled",mode:"incremental",io:cancelIo}),{code:"SCAN_CANCELLED"});
  const cancelled=openLive(config,generation,{readonly:true});assert.equal(cancelled.db.prepare("SELECT count(*) n FROM works WHERE title='Cancelled retained'").get().n,1n);cancelled.close();
  const next=await fullScan(config,{confirmReadOnly:true,generationId:"live-next",mode:"incremental",platformId:"pixivFANBOX"});
  assert.equal(next.state,"READY");
  const final=openLive(config,{generationId:"live-next"},{readonly:true});f.cleanup.push(()=>final.close());
  assert.equal(final.db.prepare("SELECT count(*) n FROM works WHERE title='Retained batch'").get().n,1n);
  assert.equal(final.db.prepare("SELECT count(*) n FROM works WHERE title='Cancelled retained'").get().n,1n);
});
test("live deletion waits for complete scope and the final successful checkpoint",async t=>{
  const f=await fixture(t);fs.rmSync(path.join(f.config.tempRoot,"rimraf-prewarm"),{recursive:true,force:true});
  const generation=await f.build();f.publish();const config=liveConfig(f);await ensureLive(config,generation);
  const key="100\\2026-01-01_00-00-00_1";fs.rmSync(path.join(f.bindings.pixiv,"100","2026-01-01_00-00-00_1"),{recursive:true});
  let observedDuringLaterPlatform=false;
  const io={...NODE_FS_IO,readdir(target){if(!observedDuringLaterPlatform&&path.resolve(target)===path.resolve(f.bindings.pixivFANBOX)){const live=openLive(config,generation,{readonly:true});try{assert.equal(live.db.prepare("SELECT count(*) n FROM works WHERE relative_path_key=?").get(key).n,1n);observedDuringLaterPlatform=true;}finally{live.close();}}return NODE_FS_IO.readdir(target);}};
  await fullScan(config,{confirmReadOnly:true,generationId:"live-delete",mode:"incremental",io});
  assert.equal(observedDuringLaterPlatform,true);
  const final=openLive(config,{generationId:"live-delete"},{readonly:true});f.cleanup.push(()=>final.close());
  assert.equal(final.db.prepare("SELECT count(*) n FROM works WHERE relative_path_key=?").get(key).n,0n);
  assertLiveStatsMatch(final.db);assert.ok(Object.values(getLiveState(final.db).platformRevisions).every(value=>value===getLiveState(final.db).revision));
});
test("active generation change resets live with a new epoch instead of mutating READY",async t=>{
  const f=await fixture(t);const first=await f.build();f.publish();const config=liveConfig(f);const initial=await ensureLive(config,first);
  f.work("new-generation",{id:"new",title:"New generation",user:{id:"100",name:"A"}});const second=await f.build("reset-target");f.publish("reset-target");
  const reset=await ensureLive(config,second);assert.equal(reset.reset,true);assert.equal(reset.baseGenerationId,"reset-target");assert.notEqual(reset.epoch,initial.epoch);
  assert.equal(fs.existsSync(first.catalogPath),true);assert.equal(fs.existsSync(second.catalogPath),true);
});
test("scan owns the lock and exposes PREPARING before slow baseline validation",async t=>{
  const f=await fixture(t);fs.rmSync(path.join(f.config.tempRoot,"rimraf-prewarm"),{recursive:true,force:true});await f.build();f.publish();
  let release,startedResolve;const started=new Promise(resolve=>{startedResolve=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const running=fullScan(f.config,{confirmReadOnly:true,generationId:"preparing-handshake",beforeBaselineValidation:async()=>{startedResolve();await gate;}});
  await started;
  const status=JSON.parse(fs.readFileSync(f.config.scanStatusPath,"utf8"));assert.equal(status.state,"PREPARING");assert.equal(status.running,true);assert.equal(fs.existsSync(path.join(f.config.stateRoot,"scan.lock")),true);
  await assert.rejects(fullScan(f.config,{confirmReadOnly:true,generationId:"duplicate-preparing"}),{code:"INSTANCE_IN_USE"});
  release();const report=await running;assert.equal(report.state,"READY");
});
test("complete empty authors reach live and remain count-equivalent to the final checkpoint",async t=>{
  const f=await fixture(t,{empty:true});const generation=await f.build();f.publish();const config=liveConfig(f);await ensureLive(config,generation);
  fs.mkdirSync(path.join(f.bindings.pixiv,"empty-author"),{recursive:true});
  await fullScan(config,{confirmReadOnly:true,generationId:"empty-author-checkpoint",mode:"incremental",platformId:"pixiv",authorDirectoryName:"empty-author"});
  const live=openLive(config,{generationId:"empty-author-checkpoint"},{readonly:true});f.cleanup.push(()=>live.close());
  assert.equal(live.db.prepare("SELECT count(*) n FROM authors WHERE relative_path_key='empty-author'").get().n,1n);
  const final=require("../../internal/publication/generations.js").resolveActiveGeneration(config.instanceRoot,{generationsRoot:config.generationsRoot,activePointerPath:config.activeGenerationPath});
  const finalDb=new (require("better-sqlite3"))(final.catalogPath,{readonly:true});finalDb.defaultSafeIntegers(true);try{assert.equal(live.db.prepare("SELECT count(*) n FROM authors").get().n,finalDb.prepare("SELECT count(*) n FROM authors").get().n);}finally{finalDb.close();}
});
test("provisional old-work batches preserve profile until final authority switches and deleted latest is finally recomputed",async t=>{
  const f=await fixture(t);f.work("2030-01-01_00-00-00_baseline",{id:"base-latest",date:"2030-01-01T00:00:00Z",title:"Baseline",user:{id:"100",name:"Baseline Latest"}});
  const generation=await f.build();f.publish();const config=liveConfig(f);await ensureLive(config,generation);const live=openLive(config,generation,{readonly:false});f.cleanup.push(()=>live.close());
  const newer=f.work("2040-01-01_00-00-00_new",{id:"new-latest",date:"2040-01-01T00:00:00Z",title:"New",user:{id:"100",name:"New Latest"}});
  const tree=observePlatformTree({platformId:"pixiv",observationRoot:f.bindings.pixiv}),author=tree.authors.find(a=>a.authorDirectoryName==="100"),stream=createStreamingAuthorPreparation(author);
  const preparedWorks=author.works.map(work=>stream.prepareWork(work)),completed=stream.finish(author);
  applyLiveBatch(live.db,{mappedCandidates:[preparedWorks[0].candidate]});
  assert.equal(live.db.prepare("SELECT display_name FROM authors WHERE relative_path_key='100'").get().display_name,"Baseline Latest");
  assert.equal(live.db.prepare("SELECT count(*) n FROM author_profiles p JOIN authors a USING(author_id) WHERE a.relative_path_key='100'").get().n,1n);
  const incompleteIo={...NODE_FS_IO,readdir(target){if(path.basename(target)==="nested")throw Object.assign(new Error("synthetic incomplete author"),{code:"EACCES"});return NODE_FS_IO.readdir(target);}};
  await assert.rejects(fullScan(config,{confirmReadOnly:true,generationId:"profile-incomplete",mode:"incremental",platformId:"pixiv",authorDirectoryName:"100",io:incompleteIo}),{code:"GENERATION_CATALOG_INCOMPLETE"});
  assert.equal(live.db.prepare("SELECT display_name FROM authors WHERE relative_path_key='100'").get().display_name,"Baseline Latest");
  applyLiveBatch(live.db,{mappedCandidates:[completed.authoritativeCandidate],preparedAuthors:[completed.preparedAuthor]});
  assert.equal(live.db.prepare("SELECT display_name FROM authors WHERE relative_path_key='100'").get().display_name,"New Latest");
  live.close();f.cleanup.pop();fs.rmSync(newer,{recursive:true});
  await fullScan(config,{confirmReadOnly:true,generationId:"profile-delete-checkpoint",mode:"incremental",platformId:"pixiv",authorDirectoryName:"100"});
  const final=openLive(config,{generationId:"profile-delete-checkpoint"},{readonly:true});f.cleanup.push(()=>final.close());
  assert.equal(final.db.prepare("SELECT display_name FROM authors WHERE relative_path_key='100'").get().display_name,"Baseline Latest");
  assert.equal(final.db.prepare("SELECT count(*) n FROM works WHERE relative_path_key='100\\2040-01-01_00-00-00_new'").get().n,0n);
});
test("live batches refresh only changed source identities without full relation or foreign-key sweeps",async t=>{
  const f=await fixture(t,{empty:true});
  f.work("target",{id:"target",title:"Target",user:{id:"100",name:"A"}});f.work("other",{id:"other",title:"Other",user:{id:"100",name:"A"}});f.work("relation",{id:"relation",title:"Relation",user:{id:"100",name:"A"}});
  const generation=await f.build();f.publish();const config=liveConfig(f);await ensureLive(config,generation);const live=openLive(config,generation,{readonly:false});f.cleanup.push(()=>live.close());
  const ids=Object.fromEntries(live.db.prepare("SELECT source_work_id,work_id FROM works WHERE platform_id='pixiv'").all().map(row=>[row.source_work_id,row.work_id]));
  assert.ok(live.db.prepare("EXPLAIN QUERY PLAN UPDATE social_relations SET target_work_id=NULL WHERE target_platform_id=? AND target_source_work_id=?").all("pixiv","target").some(row=>String(row.detail).includes("live_idx_relation_target_all")));
  live.db.prepare("INSERT INTO social_relations(work_id,ordinal,relation_type,target_platform_id,target_source_work_id,target_work_id) VALUES (?,?,?,?,?,?)").run(ids.relation,0,"quote","pixiv","target",ids.target);
  live.db.prepare("INSERT INTO social_relations(work_id,ordinal,relation_type,target_platform_id,target_source_work_id,target_work_id) VALUES (?,?,?,?,?,NULL)").run(ids.relation,1,"reply","pixiv","other");
  const originalPragma=live.db.pragma.bind(live.db);let fullForeignChecks=0;live.db.pragma=(source,...args)=>{if(String(source).includes("foreign_key_check"))fullForeignChecks++;return originalPragma(source,...args);};
  const duplicate=f.work("duplicate",{id:"target",title:"Duplicate",user:{id:"100",name:"A"}}),first=prepared(f).preparedCandidates.find(candidate=>candidate.rows.work.relative_path_key.endsWith("\\duplicate"));
  applyLiveBatch(live.db,{mappedCandidates:[first]});
  assert.equal(live.db.prepare("SELECT target_work_id FROM social_relations WHERE ordinal=0").get().target_work_id,null);
  assert.equal(live.db.prepare("SELECT target_work_id FROM social_relations WHERE ordinal=1").get().target_work_id,null);
  fs.writeFileSync(path.join(duplicate,"metadata.json"),JSON.stringify({id:"different",title:"Duplicate",user:{id:"100",name:"A"}}));
  const changed=prepared(f).preparedCandidates.find(candidate=>candidate.rows.work.relative_path_key.endsWith("\\duplicate"));applyLiveBatch(live.db,{mappedCandidates:[changed]});
  assert.equal(live.db.prepare("SELECT target_work_id FROM social_relations WHERE ordinal=0").get().target_work_id,ids.target);
  assert.equal(live.db.prepare("SELECT target_work_id FROM social_relations WHERE ordinal=1").get().target_work_id,null);
  assert.equal(fullForeignChecks,0);live.db.pragma=originalPragma;
});
