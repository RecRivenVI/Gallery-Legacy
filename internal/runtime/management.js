"use strict";
// Local application use cases. Never exposed as public HTTP endpoints.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),cp=require("node:child_process");
const {readRuntimeConfig,normalizeRuntimeConfig,ensureLayout}=require("../instance/config.js");
const {readJson,writeJson}=require("../instance/files.js");
const {noLinks,inside}=require("../library/io-paths.js");
const {PLATFORM_REGISTRY}=require("../library/platforms.js");
const {owner,control}=require("./control.js");
const {processIdentity,sameIdentity,acquireOwnership}=require("../instance/ownership.js");
const {withMaintenance,retentionPlan,retainGenerations}=require("../publication/retention.js");
const generations=require("../publication/generations.js");
function fail(code){throw Object.assign(new Error(code),{code});}
const sha=(value)=>crypto.createHash("sha256").update(value).digest("hex");
async function startFullScan(config,configPath,input={}){
  const launch=await acquireOwnership(config,"scan-launch");
  try{
    if(scanState(config).running)fail("SCAN_IN_USE");
    const mode=input.mode||"full";if(!["full","incremental"].includes(mode))fail("SCAN_MODE_INVALID");
    const selected=require("../indexing/scope.js").scanPlatforms(input);
    const authorPlatform=input.platformId || (selected?.length===1 ? selected[0] : null);
    if(input.authorDirectoryName!==undefined&&input.authorDirectoryName!==null&&(!authorPlatform||typeof input.authorDirectoryName!=="string"||!input.authorDirectoryName||/[\\/\x00-\x1f:]/.test(input.authorDirectoryName)||[".",".."].includes(input.authorDirectoryName)))fail("AUTHOR_DIRECTORY_INVALID");
    const args=[path.resolve(__dirname,"../../cmd/gallery/main.js"),"scan","--config",configPath,"--confirm-read-only","--mode",mode];
    if(selected)args.push("--platforms",JSON.stringify(selected));if(input.authorDirectoryName)args.push("--author",input.authorDirectoryName);
    const child=cp.spawn(process.execPath,args,{detached:true,windowsHide:true,stdio:"ignore",env:{...process.env,TEMP:config.tempRoot,TMP:config.tempRoot,UV_THREADPOOL_SIZE:"64",GALLERY_SCAN_IO_POOL:"64"}});
    let failed=false;child.once("error",()=>failed=true);child.once("exit",code=>{if(code)failed=true;});child.unref();
    for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));const s=readJson(config.scanStatusPath);if(s?.pid===child.pid){if(["FAILED","CANCELLED"].includes(s.state))fail(s.failure?.code||"SCAN_START_FAILED");return {started:true,pid:child.pid,generationId:s.generationId};}if(failed)fail("SCAN_START_FAILED");}
    fail("SCAN_START_TIMEOUT");
  }finally{await launch.release();}
}
function safeName(value){if(typeof value!=="string"||! /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(value))fail("MANAGEMENT_ID_INVALID");return value;}
function scanState(config){
  const s=readJson(config.scanStatusPath);
  if(s?.running){
    let live;try{live=sameIdentity(processIdentity(s.pid),s.identity);}catch{fail("OWNER_UNVERIFIABLE");}
    if(!live){
      const latest=readJson(config.scanStatusPath);
      if(latest&&!latest.running&&latest.generationId===s.generationId&&latest.pid===s.pid&&sameIdentity(latest.identity,s.identity))return latest;
      return {...s,running:false,state:"FAILED",failure:{code:"SCAN_OWNER_EXITED"}};
    }
  }
  return s||{running:false,state:"IDLE"};
}
function requireIdle(config){if(owner(config)||scanState(config).running)fail("STOP_RUNTIME_BEFORE_CLEANUP");}
function safeFile(root,name){const p=path.resolve(root,safeName(name));if(!inside(root,p))fail("PATH_ESCAPE");noLinks(p);return p;}
function fileList(root,extension){if(!fs.existsSync(root))return [];return fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isFile()&&e.name.endsWith(extension)).map(e=>{const p=safeFile(root,e.name),s=fs.statSync(p);return {name:e.name,size:s.size,mtimeMs:s.mtimeMs};}).sort((a,b)=>b.mtimeMs-a.mtimeMs).slice(0,200);}
function usage(root){noLinks(root);let bytes=0,files=0;if(!fs.existsSync(root))return {bytes,files};for(const e of fs.readdirSync(root,{withFileTypes:true})){const p=path.join(root,e.name);noLinks(p);if(e.isDirectory()){const s=usage(p);bytes+=s.bytes;files+=s.files;}else if(e.isFile()){bytes+=fs.statSync(p).size;files++;}}return {bytes,files};}
function summarize(value,depth=0){if(depth>6)return undefined;if(typeof value==="number"||typeof value==="boolean"||value===null)return value;if(typeof value==="string")return /^[A-Z][A-Z0-9_]{0,63}$/.test(value)||["info","warn","error","debug","full","incremental","ready","missing","partial","valid","unavailable","platform-sample","selected-author"].includes(value)||PLATFORM_REGISTRY.some(p=>p.id===value)?value:undefined;if(Array.isArray(value))return value.slice(0,30).map(v=>summarize(v,depth+1));if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([k])=>!/(identity|path|root|source|text|title|name|url|token|secret|config|handle)/i.test(k)).map(([k,v])=>[k,summarize(v,depth+1)]).filter(([,v])=>v!==undefined));return undefined;}
function safeLog(file,raw=false){const s=fs.statSync(file),n=Math.min(s.size,65536),b=Buffer.alloc(n),fd=fs.openSync(file,"r");try{fs.readSync(fd,b,0,n,s.size-n);}finally{fs.closeSync(fd);}return b.toString("utf8").split(/\r?\n/).slice(-200).map(line=>{if(raw)return line;if(!line)return "";if(/^[A-Z0-9_]{1,64}$/.test(line))return line;try{return JSON.stringify(summarize(JSON.parse(line)));}catch{return "[非结构化日志已隐藏；可在本机打开日志目录查看]";}}).join("\n");}
async function manage(configPath,operation,input={}){
  if(!input||typeof input!=="object"||Array.isArray(input))fail("MANAGEMENT_INPUT_INVALID");
  const config=readRuntimeConfig(configPath);ensureLayout(config);
  if(operation.startsWith("validation."))return require("./validation.js").operation(config,configPath,operation,input);
  if(operation==="live.reset")return withMaintenance(config,()=>{
    if(input.confirm!==true)fail("CONFIRMATION_REQUIRED");requireIdle(config);
    const target=path.join(config.instanceRoot,"live");noLinks(target);
    const {overlap}=require("../library/io-paths.js");
    if([config.generationsRoot,config.cacheRoot,config.logsRoot,config.stateRoot,config.tempRoot,config.desktopDataRoot].some(p=>overlap(p,target)))fail("LIVE_PATH_OVERLAP");
    const valid=generations.resolveActiveGeneration(config.instanceRoot,{generationsRoot:config.generationsRoot,activePointerPath:config.activeGenerationPath});
    const {CatalogReader}=require("../catalog/reader.js");const r=new CatalogReader(valid.catalogPath,valid.generationId,config.sources);r.close();
    const archive=path.join(config.tempRoot,`live-reset-${Date.now()}-${crypto.randomUUID()}`);
    if(!inside(config.instanceRoot,target)||!inside(config.tempRoot,archive))fail("PATH_ESCAPE");noLinks(archive);
    if(fs.existsSync(target))fs.renameSync(target,archive);
    return {reset:true,checkpoint:valid.generationId,archive:path.basename(archive),restartRequired:true};
  });
  if(operation==="scope.authors"){
    const p=config.platforms.find(p=>p.id===input.platformId);if(!p)fail("INVALID_PLATFORM");
    const page=input.page||1,q=input.query||"";if(!Number.isInteger(page)||page<1||typeof q!=="string"||q.length>256)fail("AUTHOR_QUERY_INVALID");
    noLinks(p.physicalRoot);const names=fs.readdirSync(p.physicalRoot,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&e.name.toLowerCase().includes(q.toLowerCase())).map(e=>e.name).sort();
    return {page,total:names.length,items:names.slice((page-1)*100,page*100).map(directoryName=>({directoryName}))};
  }
  if(operation==="cache.orphans"||operation==="cache.orphans.clear")return withMaintenance(config,()=>{
    if(operation.endsWith(".clear")){if(input.confirm!==true)fail("CONFIRMATION_REQUIRED");requireIdle(config);}
    return require("./orphan-cache.js").orphanCache(config,{apply:operation.endsWith(".clear")});
  });
  const configFile=path.resolve(configPath),revision=()=>sha(fs.readFileSync(configFile));
  const configView=()=>({value:readJson(configFile),revision:revision(),platforms:PLATFORM_REGISTRY.map(p=>p.id)});
  if(operation==="config.read")return configView();
  if(operation==="config.validate"||operation==="config.save"){
    const candidate=input.value;if(!candidate||typeof candidate!=="object")fail("CONFIG_INVALID");
    for(const key of Object.keys(candidate))if(!Object.hasOwn(require("../../config/runtime.schema.json").properties,key))fail("CONFIG_FIELD_UNSUPPORTED");
    const next=normalizeRuntimeConfig(candidate);
    for(const k of ["instanceRoot","generationsRoot","stateRoot","cacheRoot","tempRoot","reportsRoot","logsRoot","desktopDataRoot"])if(next[k]!==config[k])fail("INSTANCE_LAYOUT_CHANGE_REQUIRES_NEW_INSTANCE");
    const result={valid:true,restartRequired:true,rebuildRequired:JSON.stringify(next.sources)!==JSON.stringify(config.sources)};
    if(config.liveUpdates&&next.liveUpdates&&result.rebuildRequired)fail("LIVE_SOURCE_CHANGE_REQUIRES_CHECKPOINT");
    if(operation==="config.validate")return result;
    if(input.confirm!==true)fail("CONFIRMATION_REQUIRED");
    if(!inside(config.instanceRoot,configFile))fail("CONFIG_EDIT_OUTSIDE_INSTANCE");
    return withMaintenance(config,()=>{if(input.revision!==revision())fail("CONFIG_REVISION_CHANGED");const backup=path.join(config.stateRoot,"config-backups",`${Date.now()}-${crypto.randomUUID()}.json`);writeJson(backup,readJson(configFile));writeJson(configFile,candidate);return {...result,...configView(),backup:path.basename(backup)};});
  }
  if(operation==="config.backups")return {items:fileList(path.join(config.stateRoot,"config-backups"),".json")};
  if(operation==="config.backup.read")return {value:readJson(safeFile(path.join(config.stateRoot,"config-backups"),input.name))};
  if(operation==="locations")return {instance:config.instanceRoot,config:path.dirname(configFile),logs:config.logsRoot,reports:config.reportsRoot,cache:config.cacheRoot};
  if(operation==="logs.list")return {items:fileList(config.logsRoot,".log")};
  if(operation==="logs.read"){
    if(typeof(input.query||"")!=="string"||(input.query||"").length>256||![undefined,"","info","warn","error"].includes(input.level))fail("LOG_FILTER_INVALID");
    const lines=safeLog(safeFile(config.logsRoot,input.name),input.raw===true).split("\n");
    return {text:lines.filter(line=>(!input.query||line.toLowerCase().includes(input.query.toLowerCase()))&&(!input.level||new RegExp('"level"\\s*:\\s*"'+input.level+'"','i').test(line)||input.level==="error"&&/ERROR|FAILED|INVALID/.test(line))).join("\n")};
  }
  if(operation==="logs.clear"){if(!input.confirm)fail("CONFIRMATION_REQUIRED");return withMaintenance(config,()=>{requireIdle(config);fs.truncateSync(safeFile(config.logsRoot,input.name),0);return {cleared:true};});}
  if(operation==="reports.list")return {items:fileList(config.reportsRoot,".json")};
  if(operation==="reports.read")return {value:summarize(readJson(safeFile(config.reportsRoot,input.name)))};
  if(operation==="storage.read")return {cache:usage(config.cacheRoot),logs:usage(config.logsRoot),temp:usage(config.tempRoot),generations:usage(config.generationsRoot),reports:usage(config.reportsRoot)};
  if(operation==="cache.clear"){if(!input.confirm)fail("CONFIRMATION_REQUIRED");return withMaintenance(config,()=>{requireIdle(config);const target=path.join(config.cacheRoot,"thumbnails"),before=usage(target);if(fs.existsSync(target))fs.rmSync(target,{recursive:true});return {cleared:true,...before};});}
  if(operation==="generations.list")return {active:readJson(config.activeGenerationPath)?.generationId,loaded:readJson(config.statusPath)?.loadedGenerationId,items:fs.readdirSync(config.generationsRoot,{withFileTypes:true}).filter(e=>e.isDirectory()&&generations.GENERATION_ID_PATTERN.test(e.name)).map(e=>{const m=readJson(safeFile(path.join(config.generationsRoot,e.name),"manifest.json"));return {id:e.name,state:m?.state,createdAtMs:m?.createdAtMs,works:m?.catalog?.workCount,bytes:(m?.catalog?.sizeBytes||0)+(m?.search?.sizeBytes||0)};})};
  if(["generation.validate","generation.publish","generation.rollback"].includes(operation))return withMaintenance(config,()=>{
    const paths=generations.generationPaths(config.instanceRoot,safeName(input.id),config.generationsRoot);
    const valid=generations.validateGeneration(paths.generationRoot,{instanceRoot:config.instanceRoot,generationsRoot:config.generationsRoot});
    const {CatalogReader}=require("../catalog/reader.js");const reader=new CatalogReader(valid.catalogPath,valid.generationId,config.sources);reader.close();
    if(operation!=="generation.validate"){if(!input.confirm)fail("CONFIRMATION_REQUIRED");generations.publishGeneration(config.instanceRoot,input.id,{generationsRoot:config.generationsRoot,activePointerPath:config.activeGenerationPath});}
    return {valid:true,generationId:input.id,works:valid.catalogFacts.workCount,published:operation!=="generation.validate",restartRequired:operation!=="generation.validate"};
  });
  if(operation==="retention.plan")return withMaintenance(config,()=>({items:retentionPlan(config)}));
  if(operation==="retention.apply"){if(!input.confirm)fail("CONFIRMATION_REQUIRED");return retainGenerations(config);}
  if(operation.startsWith("access."))return control(config,operation,input);
  if(operation==="scan.status"){const {identity,...state}=scanState(config);return state;}
  if(operation==="scan.start"){if(input.confirmReadOnly!==true)fail("READ_ONLY_CONFIRMATION_REQUIRED");return startFullScan(config,configFile,input);}
  if(operation==="scope.check"){
    if(input.confirmReadOnly!==true)fail("READ_ONLY_CONFIRMATION_REQUIRED");
    const p=config.platforms.find(p=>p.id===input.platformId);if(!p)fail("INVALID_PLATFORM");
    const author=input.authorDirectoryName||"";
    if(typeof author!=="string"||/[\\/\x00-\x1f:]/.test(author)||[".",".."].includes(author))fail("AUTHOR_DIRECTORY_INVALID");
    if(author){const target=path.join(p.physicalRoot,author);noLinks(target);if(!fs.statSync(target).isDirectory())fail("AUTHOR_DIRECTORY_INVALID");}
    const {NODE_FS_IO,observePlatformWorksStreaming}=require("../library/observer.js");
    const {evaluateFilesystemMediaEligibility}=require("../media/eligibility.js");
    const {adaptJsonWithMetadata}=require("../metadata/contract.js");const {adapterForPlatform}=require("../metadata/index.js");
    const result={platformId:p.id,scope:author?"selected-author":"platform-sample",limit:1000,works:0,media:0,authors:0,incompleteWorks:0,metadataStates:{},diagnostics:0,truncated:false,catalogModified:false};
    const io={...NODE_FS_IO,readdir(file){const entries=NODE_FS_IO.readdir(file);return author&&path.resolve(file)===path.resolve(p.physicalRoot)?entries.filter(e=>e.name===author):entries;}};
    try{const observed=observePlatformWorksStreaming({platformId:p.id,observationRoot:p.physicalRoot,io,onAuthorStart(){result.authors++;},onAuthorEnd(a){result.diagnostics+=a.diagnostics.length;},onWork(w){
      if(result.works>=result.limit)throw Object.assign(new Error("Sample limit"),{code:"CHECK_LIMIT"});result.works++;
      if(w.filesystemFilesState!=="complete")result.incompleteWorks++;
      result.media+=evaluateFilesystemMediaEligibility({filesystemFiles:w.filesystemFiles||[]}).files.filter(f=>f.eligible).length;
      let state=w.metadata.state;if(state==="present"){const a=adaptJsonWithMetadata(adapterForPlatform(p.id),w.metadata.sourceText,{platformId:p.id,authorDirectoryName:w.authorDirectoryName,workDirectoryName:w.workDirectoryName});state=a.result.valid?"valid":a.result.invalidReason||"invalid";}
      result.metadataStates[state]=(result.metadataStates[state]||0)+1;
    }});result.enumerationComplete=observed.authorsState==="complete";result.diagnostics+=observed.diagnostics.length;}catch(e){if(e.code!=="CHECK_LIMIT")throw e;result.truncated=true;result.enumerationComplete=false;}
    const name=`manager-scope-${Date.now()}.json`;writeJson(path.join(config.reportsRoot,name),result);return {...result,report:name};
  }
  if(operation==="scan.cancel"){
    const s=scanState(config);if(!s.running)fail("SCAN_NOT_RUNNING");if(["PUBLISHING","READY"].includes(s.state))fail("SCAN_COMMIT_IN_PROGRESS");
    writeJson(path.join(config.stateRoot,"scan-cancel.json"),{generationId:s.generationId,requestedAtMs:Date.now()});return {requested:true};
  }
  if(operation==="diagnostics.run"){
    const findings=[],checks=[];
    for(const p of config.platforms){let ok=false;try{noLinks(p.physicalRoot);ok=fs.statSync(p.physicalRoot).isDirectory();}catch{}checks.push({platform:p.id,available:ok});if(!ok)findings.push({code:"SOURCE_UNAVAILABLE",platform:p.id});}
    for(const tool of ["ffmpeg","magick"]){const r=cp.spawnSync(tool,["-version"],{stdio:"ignore",windowsHide:true,timeout:10000});checks.push({tool,available:r.status===0});if(r.status!==0)findings.push({code:"MEDIA_TOOL_UNAVAILABLE",tool});}
    try{const g=generations.resolveActiveGeneration(config.instanceRoot,{generationsRoot:config.generationsRoot,activePointerPath:config.activeGenerationPath});const {CatalogReader}=require("../catalog/reader.js");const reader=new CatalogReader(g.catalogPath,g.generationId,config.sources);const counts=reader.stats();reader.close();checks.push({generation:g.generationId,valid:true,works:g.catalogFacts.workCount,counts});}catch(e){findings.push({code:/^[A-Z0-9_]+$/.test(e.code||"")?e.code:"GENERATION_INVALID"});}
    const report={atMs:Date.now(),state:findings.length?"ISSUES":"PASS",checks,findings,scan:summarize(scanState(config)),privacy:"aggregate only"};
    const name=`manager-diagnostics-${Date.now()}.json`;writeJson(path.join(config.reportsRoot,name),report);return {...report,report:name};
  }
  fail("MANAGEMENT_OPERATION_INVALID");
}
module.exports={manage,scanState,summarize,startFullScan};
