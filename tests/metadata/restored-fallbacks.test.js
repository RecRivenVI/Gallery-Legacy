"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {adapterForPlatform}=require("../../internal/metadata/index.js");
function adapt(platform,metadata){return adapterForPlatform(platform).adapt({platformId:platform,metadata,authorDirectoryName:platform==="Pawchive"?"patreon_100":"100",workDirectoryName:"2026-01-02_03-04-05_900"});}
test("restored metadata fallback and source evidence preserve text without making media",()=>{
  const p=adapt("pixiv",{text:"Synthetic plain 🧪",url:"https://example.invalid/post"});assert.equal(p.richText.primary.sourceText,"Synthetic plain 🧪");assert.equal(p.richText.primary.sourceFormat,"plain");assert.equal(p.richText.supplementary.find(x=>x.role==="source_link").sourceText,"https://example.invalid/post");
  for(const field of ["user_name","creator","artist"]){const a=adapt("Pawchive",{service:"patreon",[field]:"Synthetic creator",description:"Fallback text"});assert.equal(a.authorProfile.displayName,"Synthetic creator");assert.equal(a.richText.primary.sourceText,"Fallback text");}
  for(const id of ["X","微博"]){const a=adapt(id,{date:"2026-01-02T03:04:05Z"});assert.equal(a.work.title,"2026-01-02T03:04:05.000Z");}
  for(const url of ["javascript:alert(1)","https://user:password@example.invalid/","https://example.invalid/?token=private"]){assert.equal(adapt("pixiv",{url}).richText.supplementary.length,0);}
});
