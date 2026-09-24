"use strict";
// Copy a finalized generation, never a mutable/live database or source media tree.
const fs=require("node:fs"),path=require("node:path");
const {readRuntimeConfig,normalizeRuntimeConfig,ensureLayout}=require("../internal/instance/config.js");
const {writeJson}=require("../internal/instance/files.js");
const {overlap,noLinks}=require("../internal/library/io-paths.js");
const {resolveActiveGeneration,validateGeneration}=require("../internal/publication/generations.js");
function prepare(sourceConfigPath,instanceRoot,port){
  const source=readRuntimeConfig(sourceConfigPath);if(!path.isAbsolute(instanceRoot))throw new Error("Absolute test instance required");noLinks(instanceRoot);
  if(fs.existsSync(instanceRoot)||overlap(source.instanceRoot,instanceRoot)||source.protectedRoots.some(r=>overlap(instanceRoot,r.physicalRoot)))throw new Error("New isolated test instance required");
  if(port===8081||port===source.port)throw new Error("Independent test port required");
  const raw={deployment:"staging",instanceRoot,listenAddress:"127.0.0.1",port,sources:source.sources,fileBrowserRoots:source.fileBrowserRoots.map(r=>({id:r.id,name:r.name,path:r.path})),shortLinks:source.shortLinks,retention:{enabled:true,staleAfterMs:86400000}};
  const config=normalizeRuntimeConfig(raw),generation=resolveActiveGeneration(source.instanceRoot,{generationsRoot:source.generationsRoot,activePointerPath:source.activeGenerationPath});
  ensureLayout(config);
  const target=path.join(config.generationsRoot,generation.generationId);
  for(const sourceFile of [path.join(generation.generationRoot,"manifest.json"),generation.catalogPath,generation.searchIndexPath]){
    noLinks(sourceFile);const dest=path.join(target,path.relative(generation.generationRoot,sourceFile));fs.mkdirSync(path.dirname(dest),{recursive:true});
    // On Windows native CopyFile preserves FILETIME exactly. fs.cp's
    // preserveTimestamps round-trips through Date and can round up one ms,
    // invalidating the Search binding despite byte-identical databases.
    fs.copyFileSync(sourceFile,dest,fs.constants.COPYFILE_EXCL);
    if(fs.statSync(dest,{bigint:true}).mtimeNs!==fs.statSync(sourceFile,{bigint:true}).mtimeNs)
      throw Object.assign(new Error("Copy did not preserve immutable file time"),{code:"GENERATION_COPY_TIME_MISMATCH"});
  }
  const validated=validateGeneration(target,{instanceRoot:config.instanceRoot,generationsRoot:config.generationsRoot});
  if(validated.catalogFacts.sha256!==generation.catalogFacts.sha256||validated.searchFacts.sha256!==generation.searchFacts.sha256)throw new Error("Generation copy mismatch");
  writeJson(config.activeGenerationPath,{pointerVersion:1,generationId:generation.generationId,manifestPath:`generations/${generation.generationId}/manifest.json`,publishedAtMs:Date.now()});
  writeJson(path.join(config.instanceRoot,"config.json"),raw);
  return {state:"READY",instanceRoot:config.instanceRoot,generationId:generation.generationId,works:validated.catalogFacts.workCount,url:config.url,sourceUntouched:true};
}
if(require.main===module){function opt(name){const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];}try{console.log(JSON.stringify(prepare(opt("--from"),opt("--out"),Number(opt("--port")||18107))));}catch(e){console.error(e.code||e.message);process.exitCode=1;}}
module.exports={prepare};
