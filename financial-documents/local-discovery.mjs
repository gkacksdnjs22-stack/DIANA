import path from 'node:path';
import {opendir} from 'node:fs/promises';
import {createFilePolicy,allowedPart} from '../local-ai/files.mjs';
import {checkedDirectory,digest} from '../personal-ai/documents/files.mjs';
import {readSelectedText} from './files.mjs';
import {strictJSON,validId} from './strict-json.mjs';

const normal=value=>value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const targetHint=name=>/(?:review|report|검토서|보고서|검토보고)/iu.test(name);
const sourceHint=name=>/(?:due.?diligence|source|evidence|(?:^|[^a-z])dd(?:[^a-z]|$)|실사|근거|자료)/iu.test(name);
function guideline(file){
  if(file.format!=='json')return null;
  try{const value=strictJSON(file.content);if(!validId(value.id)||!validId(value.version)||!Array.isArray(value.rules)||!value.rules.length||value.rules.length>32)return null;
    const sourceIds=new Set();for(const rule of value.rules){if(!validId(rule.id)||typeof rule.label!=='string'||!Array.isArray(rule.source_ids)||rule.source_ids.some(id=>!validId(id))||!Array.isArray(rule.positive_statements)||!Array.isArray(rule.negative_statements))return null;for(const id of rule.source_ids)sourceIds.add(id);}
    if(!sourceIds.size||sourceIds.size>16)return null;return{value,sourceIds:[...sourceIds]};
  }catch{return null;}
}
function identity(file,id){
  if(normal(path.basename(file.name,path.extname(file.name)))===normal(id))return true;
  if(file.format==='json')try{return strictJSON(file.content).id===id;}catch{}
  return false;
}
function hits(file,guide,sourceId){const text=file.content.normalize('NFKC').toLowerCase();let result=0;
  for(const rule of guide.rules){if(sourceId&&!rule.source_ids.includes(sourceId))continue;
    if([...(rule.positive_statements||[]),...(rule.negative_statements||[])].some(s=>typeof s==='string'&&s.length>0&&text.includes(s.normalize('NFKC').toLowerCase())))result++;
  }return result;
}
function uniqueBest(rows){if(!rows.length||rows[0].score<=0||rows.length>1&&rows[0].score===rows[1].score)return null;return rows[0].id;}

/** Pure local bounded scan. Paths and contents never enter publicTask/network
 * metadata. The folder is a native user grant, not a browser-supplied path. */
export async function discoverFolder(folder,outputRoot,{maxFiles=80,maxEntries=2000,maxBytes=8*1024*1024}={}){
  const policy=await createFilePolicy([folder],outputRoot),files=[];let entries=0,bytes=0,skipped=0,limited=false;
  async function walk(relative='',depth=0){
    if(depth>6){limited=true;return;}
    const directory=await opendir(await checkedDirectory(path.join(policy.roots[0],relative)));
    for await(const entry of directory){
      if(++entries>maxEntries||files.length>=maxFiles){limited=true;break;}
      if(!allowedPart(entry.name)||entry.isSymbolicLink()){skipped++;continue;}
      const rel=path.join(relative,entry.name);
      if(entry.isDirectory()){try{await walk(rel,depth+1);}catch{skipped++;}}
      else if(entry.isFile()&&['.md','.txt','.json'].includes(path.extname(entry.name).toLowerCase())){
        try{const read=await readSelectedText(policy,{id:'SCAN',version:'1',classification:'internal',rootIndex:0,relativePath:rel});
          bytes+=Buffer.byteLength(read.content);if(bytes>maxBytes){limited=true;break;}
          files.push({...read,id:digest(rel+'\0'+read.hash),name:entry.name,relativePath:rel});
        }catch{skipped++;}
      }
      if(limited)break;
    }
  }
  await walk();files.sort((a,b)=>a.relativePath.localeCompare(b.relativePath));
  const guides=files.map(file=>({file,guide:guideline(file)})).filter(x=>x.guide),guideIds=new Set(guides.map(x=>x.file.id)),documents=files.filter(f=>!guideIds.has(f.id));
  const groups=guides.map(({file,guide})=>{
    const sources=guide.sourceIds.map(code=>{
      const options=documents.map(doc=>({id:doc.id,name:doc.relativePath,score:identity(doc,code)?100:((sourceHint(doc.name)?20:0)-(targetHint(doc.name)?20:0)+hits(doc,guide.value,code)*3),reason:identity(doc,code)?'지침의 문서 코드와 파일명이 일치':sourceHint(doc.name)?'근거 자료 파일명과 지침 표현 확인':'지침에 등록된 표현 비교'})).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
      return{code,selected:limited?null:uniqueBest(options),options};
    });
    const selectedCounts=new Map();for(const source of sources)if(source.selected)selectedCounts.set(source.selected,(selectedCounts.get(source.selected)||0)+1);
    for(const source of sources)if(selectedCounts.get(source.selected)>1)source.selected=null;
    const chosen=new Set(sources.map(s=>s.selected).filter(Boolean));
    const targets=documents.filter(doc=>!chosen.has(doc.id)).map(doc=>({id:doc.id,name:doc.relativePath,score:targetHint(doc.name)?20:documents.length-chosen.size===1?10:0})).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
    return{id:file.id,name:file.relativePath,guidelineCode:guide.value.id,version:guide.value.version,sources,target:limited?null:uniqueBest(targets),targets,items:guide.value.rules.map(r=>({id:r.id,label:r.label})),ready:!limited&&sources.every(s=>s.selected)&&!!uniqueBest(targets)};
  });
  return{files,groups,policy,skipped,limited};
}
