"use strict";
const fs=require("node:fs"),path=require("node:path");
const {inside,noLinks}=require("../library/io-paths.js");
const {readJson}=require("../instance/files.js");
function orphanCache(config,{apply=false}={}){
  const root=path.join(config.cacheRoot,"thumbnails");noLinks(root);
  const result={files:0,orphanFiles:0,orphanBytes:0,retained:0,unknown:0,removed:0,removedBytes:0};
  if(!fs.existsSync(root))return result;
  for(const dir of fs.readdirSync(root,{withFileTypes:true})){
    if(!dir.isDirectory()||! /^[a-f0-9]{2}$/.test(dir.name)||dir.isSymbolicLink())continue;
    const folder=path.join(root,dir.name);noLinks(folder);
    for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
      if(!entry.isFile()||! /^[a-f0-9]{64}\.webp$/.test(entry.name))continue;
      const image=path.join(folder,entry.name),reference=image+".json";noLinks(image);noLinks(reference);result.files++;
      let record;try{record=readJson(reference);}catch{result.unknown++;continue;}
      if(record?.version!==1||typeof record.source!=="string"||!config.protectedRoots.some(r=>inside(r.physicalRoot,record.source))){result.unknown++;continue;}
      function missing(){try{noLinks(record.source);fs.lstatSync(record.source);return false;}catch(e){return e.code==="ENOENT";}}
      if(!missing()){result.retained++;continue;}
      const size=fs.lstatSync(image).size;result.orphanFiles++;result.orphanBytes+=size;
      // Recheck immediately before deletion. Never remove source or unknown caches.
      if(apply&&missing()){fs.unlinkSync(image);fs.unlinkSync(reference);result.removed++;result.removedBytes+=size;}
    }
  }
  return result;
}
module.exports={orphanCache};
