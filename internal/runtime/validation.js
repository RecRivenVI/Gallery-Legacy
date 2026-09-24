"use strict";
// Private, local-only diagnostics. Findings never enter the public Catalog/API.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),cp=require("node:child_process"),readline=require("node:readline");
const {readJson,writeJson}=require("../instance/files.js");
const {readRuntimeConfig,ensureLayout}=require("../instance/config.js");
const {inside,noLinks}=require("../library/io-paths.js");
const {normalizeRelativePath}=require("../library/paths.js");
const {acquireOwnership,processIdentity,sameIdentity}=require("../instance/ownership.js");
const {withMaintenance}=require("../publication/retention.js");
const {observePlatformWorksStreaming,NODE_FS_IO}=require("../library/observer.js");
const {evaluateFilesystemMediaEligibility}=require("../media/eligibility.js");
const {presentation}=require("../media/presentation.js");
const {adapterForPlatform}=require("../metadata/index.js");
const {adaptJsonWithMetadata}=require("../metadata/contract.js");
const VALIDATION_MAINTENANCE_WAIT_MS=8000;
const VALIDATION_MAINTENANCE_RETRY_MS=100;
const VALIDATION_START_WAIT_MS=VALIDATION_MAINTENANCE_WAIT_MS+10000;
const CHECKS=Object.freeze([
  ["filesystem.incomplete","目录或文件观察不完整","error"],
  ["filesystem.unreadable","平台／作者目录不可读取","error"],
  ["filesystem.ignored","目录层级中的散落文件或未跟随链接","warning"],
  ["media.none","作品没有实际媒体","info"],
  ["media.all_hidden","媒体全部默认隐藏","info"],
  ["media.unknown_extension","存在非媒体附件","info"],
  ["cover.multiple","多个显式封面","info"],
  ["cover.conflict","禁用封面标记与显式封面并存","info"],
  ["metadata.missing","缺少 metadata（保留物理作品）","info"],
  ["metadata.unreadable","metadata 不可读取／读取竞争","warning"],
  ["metadata.invalid","metadata 损坏或非对象","warning"],
  ["metadata.fields","metadata 字段或格式存在诊断","warning"],
].map(([id,label,severity])=>Object.freeze({id,label,severity})));
function fail(code){throw Object.assign(new Error(code),{code});}
const stateFile=c=>path.join(c.stateRoot,"validation.json");
function reportFile(c,id,suffix){if(typeof id!=="string"||!/^validation-[0-9]+-[a-f0-9]{12}$/.test(id))fail("VALIDATION_ID_INVALID");const f=path.join(c.reportsRoot,id+suffix);noLinks(f);return f;}
function selection(c,input){
  if(!input||input.confirmReadOnly!==true)fail("READ_ONLY_CONFIRMATION_REQUIRED");
  const ids=input.checks||CHECKS.map(x=>x.id);
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>!CHECKS.some(c=>c.id===id)))fail("VALIDATION_CHECK_INVALID");
  if(input.platformId&&!c.platforms.some(p=>p.id===input.platformId))fail("INVALID_PLATFORM");
  return {checks:[...new Set(ids)],platformId:input.platformId||null,confirmReadOnly:true};
}
function status(c){
  const s=readJson(stateFile(c))||{state:"IDLE",running:false};
  if(s.running&&!sameIdentity(processIdentity(s.pid),s.identity)){
    // The child can finish and exit while Windows resolves its identity.
    const latest=readJson(stateFile(c));
    if(latest&&!latest.running&&latest.id===s.id&&latest.pid===s.pid&&sameIdentity(latest.identity,s.identity))return latest;
    return {...s,state:"FAILED",running:false,error:"VALIDATION_OWNER_EXITED"};
  }
  return s;
}
async function withValidationMaintenance(c,action){
  const deadline=Date.now()+VALIDATION_MAINTENANCE_WAIT_MS;
  let owner;
  for(;;){
    try{owner=await acquireOwnership(c,"maintenance");break;}
    catch(error){
      if(error.code!=="INSTANCE_IN_USE"||error.scope!=="maintenance"||Date.now()>=deadline)throw error;
      await new Promise(resolve=>setTimeout(resolve,VALIDATION_MAINTENANCE_RETRY_MS));
    }
  }
  try{return await action();}finally{await owner.release();}
}
async function runValidation(c,input,{io=NODE_FS_IO,onWork}={}){
  const options=selection(c,input);ensureLayout(c);
  return withValidationMaintenance(c,async()=>{
    const scanLease=await acquireOwnership(c,"scan");
    const lock=await acquireOwnership(c,"validation").catch(async e=>{await scanLease.release();throw e;});
    const id=`validation-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    const s={id,state:"RUNNING",running:true,pid:process.pid,identity:lock.identity,startedAtMs:Date.now(),works:0,authors:0,total:0,counts:{},checks:options.checks,truncated:false};
    const output=reportFile(c,id,".findings.jsonl");let fd=null;
    let last=0;
    function persist(force=false){if(force||Date.now()-last>500){writeJson(stateFile(c),s);last=Date.now();}}
    function cancellation(){const cancel=readJson(path.join(c.stateRoot,"validation-cancel.json"));if(cancel?.id===id)fail("VALIDATION_CANCELLED");}
    function add(code,p,relative,detail=null){if(!options.checks.includes(code))return;s.counts[code]=(s.counts[code]||0)+1;s.total++;if(s.total>100000){s.truncated=true;return;}const rule=CHECKS.find(x=>x.id===code);fs.writeSync(fd,JSON.stringify({index:s.total,code,severity:rule.severity,platformId:p.id,relativePath:String(relative||""),detail})+"\n");}
    try{
      fd=fs.openSync(output,"wx");
      persist(true);
      for(const p of c.platforms.filter(p=>!options.platformId||p.id===options.platformId)){
        cancellation();s.platformId=p.id;persist(true);
        const observed=observePlatformWorksStreaming({platformId:p.id,observationRoot:p.physicalRoot,io,
          onAuthorStart(){s.authors++;cancellation();},
          onAuthorEnd(a){if(a.worksState!=="complete")add("filesystem.unreadable",p,a.authorRelativePath);for(const d of a.diagnostics)if(["unexpected_author_file","reparse_not_followed"].includes(d.code))add("filesystem.ignored",p,d.path,{code:d.code});},
          onWork(w){
            cancellation();s.works++;onWork?.(w,s);
            if(w.filesystemFilesState!=="complete")add("filesystem.incomplete",p,w.workRelativePath);
            const eligible=evaluateFilesystemMediaEligibility({filesystemFiles:w.filesystemFiles||[]}).files;
            const actual=eligible.filter(x=>x.eligible),names=actual.map(x=>path.win32.basename(x.relativePathKey));
            let adapted=null;
            if(w.metadata.state==="present")adapted=adaptJsonWithMetadata(adapterForPlatform(p.id),w.metadata.sourceText,{platformId:p.id,authorDirectoryName:w.authorDirectoryName,workDirectoryName:w.workDirectoryName}).result;
            const previews=adapted?.fieldSources?.some(f=>f.field==="media.extractedPreviews");
            if(!actual.length)add("media.none",p,w.workRelativePath);
            else if(names.every(n=>!presentation(n,previews).defaultVisible))add("media.all_hidden",p,w.workRelativePath);
            const unknown=eligible.filter(x=>!x.eligible&&!/\.(?:vtt|json)$/i.test(x.relativePathKey)&&!path.win32.basename(x.relativePathKey).startsWith("."));
            if(unknown.length)add("media.unknown_extension",p,w.workRelativePath,{count:unknown.length});
            const covers=names.filter(n=>/^\.?cover\.[^.]+$/i.test(n));
            if(covers.length>1)add("cover.multiple",p,w.workRelativePath,{count:covers.length});
            if(covers.length&&(w.filesystemFiles||[]).some(x=>x.relativePath.toLowerCase()===".nocover"))add("cover.conflict",p,w.workRelativePath);
            if(w.metadata.state==="missing")add("metadata.missing",p,w.workRelativePath);
            else if(w.metadata.state!=="present")add("metadata.unreadable",p,w.workRelativePath);
            else if(!adapted?.valid)add("metadata.invalid",p,w.workRelativePath);
            else if(adapted.diagnostics.invalidFields.length||adapted.diagnostics.warnings.length)add("metadata.fields",p,w.workRelativePath,{invalidFields:adapted.diagnostics.invalidFields.length,warnings:adapted.diagnostics.warnings.length});
            persist();
          }});
        if(observed.authorsState!=="complete")add("filesystem.unreadable",p,"");
        for(const d of observed.diagnostics)if(["unexpected_platform_file","reparse_not_followed"].includes(d.code))add("filesystem.ignored",p,d.path,{code:d.code});
      }
      cancellation();s.state="COMPLETED";
    }catch(e){s.state=e.code==="VALIDATION_CANCELLED"?"CANCELLED":"FAILED";s.error=/^[A-Z0-9_]+$/.test(e.code||"")?e.code:"VALIDATION_FAILED";}
    finally{try{if(fd!==null)fs.closeSync(fd);s.running=false;s.finishedAtMs=Date.now();s.elapsedMs=s.finishedAtMs-s.startedAtMs;persist(true);const {identity,...summary}=s;writeJson(reportFile(c,id,".json"),summary);}finally{try{await lock.release();}finally{await scanLease.release();}}}
    const {identity,...summary}=s;return summary;
  });
}
async function start(c,configPath,input){
  const options=selection(c,input),launch=await acquireOwnership(c,"validation-launch");
  try{
    if(status(c).running)fail("VALIDATION_IN_USE");
    const file=path.join(c.stateRoot,`validation-request-${crypto.randomUUID()}.json`);writeJson(file,options);
    const child=cp.spawn(process.execPath,[__filename,configPath,file],{detached:true,windowsHide:true,stdio:["ignore","ignore","pipe"],env:{...process.env,TEMP:c.tempRoot,TMP:c.tempRoot}});child.unref();child.stderr.unref?.();let exited=false,failure="";child.stderr.on("data",chunk=>{failure=(failure+chunk.toString()).slice(0,256);});child.on("error",()=>exited=true);child.on("exit",()=>exited=true);
    const deadline=Date.now()+VALIDATION_START_WAIT_MS;
    while(Date.now()<deadline){await new Promise(r=>setTimeout(r,100));const s=readJson(stateFile(c));if(s?.pid===child.pid){const {identity,...v}=s;return v;}if(exited)fail(/^[A-Z0-9_]{1,64}$/.test(failure.trim())?failure.trim():"VALIDATION_START_FAILED");}
    fail("VALIDATION_START_TIMEOUT");
  }finally{await launch.release();}
}
async function eachFinding(c,id,callback){const file=reportFile(c,id,".findings.jsonl");const input=fs.createReadStream(file,{encoding:"utf8"});const lines=readline.createInterface({input,crlfDelay:Infinity});try{for await(const line of lines){const row=JSON.parse(line);if(await callback(row)===false)break;}}finally{lines.close();input.destroy();}}
async function findings(c,input){
  const id=input.id||status(c).id,page=input.page??1,limit=input.limit??100;
  if(!Number.isInteger(page)||page<1||!Number.isInteger(limit)||limit<1||limit>200||typeof(input.query||"")!=="string"||(input.query||"").length>256)fail("VALIDATION_QUERY_INVALID");
  const q=(input.query||"").toLowerCase(),items=[];let total=0;
  await eachFinding(c,id,row=>{if(input.check&&row.code!==input.check||input.severity&&row.severity!==input.severity||input.platformId&&row.platformId!==input.platformId||q&&!row.relativePath.toLowerCase().includes(q))return;if(total>=(page-1)*limit&&items.length<limit)items.push(row);total++;});
  return {id,page,limit,total,items};
}
async function exportFindings(c,input){
  const id=input.id||status(c).id,format=input.format||"json";if(!["json","csv"].includes(format))fail("VALIDATION_FORMAT_INVALID");
  const file=reportFile(c,id,`.export.${format}`),fd=fs.openSync(file,"w");let first=true,count=0;
  const quote=v=>{const text=String(v??"");return '"'+(/^[=+@-]/.test(text)?"'":"")+text.replace(/"/g,'""')+'"';};
  try{fs.writeSync(fd,format==="json"?"[\n":"platform,check,severity,relativePath\r\n");await eachFinding(c,id,row=>{fs.writeSync(fd,format==="json"?(first?"":",\n")+JSON.stringify(row):[row.platformId,row.code,row.severity,row.relativePath].map(quote).join(",")+"\r\n");first=false;count++;});if(format==="json")fs.writeSync(fd,"\n]\n");}finally{fs.closeSync(fd);}return {file:path.basename(file),count,format};
}
async function findingPath(c,input){let match;await eachFinding(c,input.id,row=>{if(row.index===input.index){match=row;return false;}});if(!match)fail("VALIDATION_FINDING_MISSING");const p=c.platforms.find(p=>p.id===match.platformId);if(!p)fail("INVALID_PLATFORM");const rel=match.relativePath?normalizeRelativePath(match.relativePath).relativePath:"";const target=path.resolve(p.physicalRoot,rel);if(!inside(p.physicalRoot,target))fail("PATH_ESCAPE");noLinks(target);return {path:target};}
async function operation(c,configPath,name,input){
  if(name==="validation.checks")return {items:CHECKS};
  if(name==="validation.start")return start(c,configPath,input);
  if(name==="validation.status"){const {identity,...s}=status(c);return s;}
  if(name==="validation.cancel"){const s=status(c);if(!s.running)fail("VALIDATION_NOT_RUNNING");writeJson(path.join(c.stateRoot,"validation-cancel.json"),{id:s.id});return {requested:true};}
  if(name==="validation.findings")return findings(c,input);
  if(name==="validation.export")return exportFindings(c,input);
  if(name==="validation.location")return findingPath(c,input);
  if(name==="validation.purge")return withMaintenance(c,()=>{if(input.confirm!==true)fail("CONFIRMATION_REQUIRED");if(status(c).running)fail("VALIDATION_IN_USE");const id=input.id||status(c).id;for(const suffix of [".json",".findings.jsonl",".export.json",".export.csv"]){const file=reportFile(c,id,suffix);if(fs.existsSync(file))fs.unlinkSync(file);}return {removed:true};});
  fail("MANAGEMENT_OPERATION_INVALID");
}
if(require.main===module){(async()=>{const c=readRuntimeConfig(process.argv[2]),request=path.resolve(process.argv[3]);if(!inside(c.stateRoot,request))fail("PATH_ESCAPE");noLinks(request);try{await runValidation(c,readJson(request));}finally{fs.unlinkSync(request);}})().catch(error=>{const code=error.code==="INSTANCE_IN_USE"&&error.scope==="scan"?"SCAN_IN_USE":/^[A-Z0-9_]{1,64}$/.test(error.code||"")?error.code:"VALIDATION_START_FAILED";console.error(code);process.exitCode=1;});}
module.exports={CHECKS,runValidation,operation};
