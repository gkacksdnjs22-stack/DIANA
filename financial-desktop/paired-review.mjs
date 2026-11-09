import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {bytes} from '../financial-documents/workbench.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const check=(v,m)=>{if(!v)throw Error(m);};
export async function reviewOptions(w){const files=(await w.list()).filter(f=>/\.(json|md|txt)$/i.test(f.name));check(files.length<=120,'검토 자료가 많습니다. 검색 위치를 좁혀 주세요.');const guides=[],docs=[];
 for(const f of files){if(!/\.json$/i.test(f.name)){docs.push({id:f.id,name:f.name,path:f.path});continue;}
 try{const b=await bytes(f.path,path.dirname(f.path),262144),g=JSON.parse(b);if(typeof g.id!=='string'||!Array.isArray(g.rules))continue;const codes=[...new Set(g.rules.flatMap(r=>r.source_ids))];if(codes.length&&codes.length<=16)guides.push({id:f.id,name:f.name,path:f.path,codes});}catch{}}
 return {guides,docs};}
export async function connectReview(w,reg,b){
 const opts=await reviewOptions(w),g=opts.guides.find(f=>f.id===b.guide),target=opts.docs.find(f=>f.id===b.target);
 check(g&&target&&Array.isArray(b.sources)&&b.sources.length===g.codes.length,'대상과 지침 및 지침에 필요한 근거를 확인하세요.');
 const src=b.sources.map(id=>opts.docs.find(f=>f.id===id));check(src.every(Boolean)&&new Set([target.id,...src.map(f=>f.id)]).size===1+src.length,'대상과 각 근거는 서로 다른 파일로 지정하세요.');
 const refs=[];async function document(f,kind){const data=await bytes(f.path,path.dirname(f.path),262144);refs.push({path:f.path,hash:hash(data)});return {kind,name:f.name,classification:'internal',version:'1',content:new TextDecoder('utf-8',{fatal:true}).decode(data)};}
 const guide=await document(g,'guideline'),parsed=JSON.parse(guide.content);guide.id=parsed.id;guide.version=parsed.version;check(JSON.stringify([...new Set(parsed.rules.flatMap(r=>r.source_ids))])===JSON.stringify(g.codes),'검토 지침이 변경되었습니다.');
 const t=await document(target,'target');t.id='DOC_'+refs.at(-1).hash.slice(0,20);
 const documents=[guide,t];for(let i=0;i<src.length;i++)documents.push({...await document(src[i],'source'),id:g.codes[i]});
 const view=await reg.view();const selection={target:t.id,guideline:guide.id,sources:g.codes};const requestId=randomUUID();
 if(!view.tasks.some(x=>x.targetId===t.id&&x.guidelineId===guide.id&&JSON.stringify(x.sourceIds)===JSON.stringify(g.codes))){
 await reg.register('bundle',{revision:view.revision,requestId,documents,allowPatch:true,task:{requestId,revision:view.revision,label:'확인한 문서 검토',targetId:t.id,sourceIds:g.codes,guidelineId:guide.id,itemIds:[],actions:['checklist_review','convert'],formats:['md','txt','json']}});}
 else{const ctx=await w.old.currentContext();for(let i=0;i<documents.length;i++)check(ctx.context.documents.some(d=>d.id===documents[i].id&&d.file_hash===refs[i].hash),'기존 등록 파일이 바뀌었습니다. 새 지침 버전과 식별자를 확인하세요.');}
 w.set('review-refs',JSON.stringify(refs));const r=await w.old.handle({action:'select',requestId:randomUUID(),selection},'owner');check(r.selected||r.state?.pending,'검토 자료 선택을 완료하지 못했습니다.');return {ok:true};}
export async function validateReview(w){for(const f of JSON.parse(w.get('review-refs')||'[]')){const data=await bytes(f.path,path.dirname(f.path),262144);check(hash(data)===f.hash,'검토 원문이 바뀌었습니다. 자료를 다시 확인하세요.');}}

