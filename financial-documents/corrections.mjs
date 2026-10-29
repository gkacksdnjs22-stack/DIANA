import path from 'node:path';
import {mkdir,open,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {checkedDirectory} from '../personal-ai/documents/files.mjs';
import {boundedRead,verifyOpenedOutput} from './files.mjs';
import {keys,fail,strictJSON} from './strict-json.mjs';
import {UUID} from '../lib/financial-contract.mjs';
import {canonical,hash,maskedRequest} from '../experiments/financial-review/evaluation-intake-v1/core.mjs';
import {schemaErrors,schemas} from '../experiments/financial-review/evaluation-intake-v1/schema.mjs';
import {checkCorrection,confirmationFields} from './correction-rules.mjs';
const demand=(b,c='RECORD_CORRECTION_INVALID')=>{if(!b)fail(c);};
const within=(a,b)=>{const r=path.relative(a,b);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
function draftShape(d){
 keys(d,['output','evidence','confirmations','workflow','reason','author','reviewer','origin','usage','usageReason','sourceTask','parentIds','notes']);keys(d.confirmations,confirmationFields);
 demand(confirmationFields.every(k=>typeof d.confirmations[k]==='boolean')&&['unreviewed','complete','held','excluded'].includes(d.workflow)&&['real','synthetic','fixture'].includes(d.origin)&&['unknown','granted','denied'].includes(d.usage));
 for(const k of ['reason','author','reviewer','usageReason','sourceTask','notes'])demand(typeof d[k]==='string'&&d[k].length<=1000);
 demand(Array.isArray(d.parentIds)&&d.parentIds.length<=30&&d.parentIds.every(x=>typeof x==='string'&&x.length>0&&x.length<=128)&&new Set(d.parentIds).size===d.parentIds.length);
 demand(Array.isArray(d.evidence)&&d.evidence.length<=8);
 if(d.workflow!=='unreviewed')demand(d.reason.trim()&&d.reviewer.trim());
 if(d.workflow==='complete')demand(d.author.trim());
 if(d.usage==='granted')demand(d.usageReason.trim());
}
export class Corrections{
 #root;#exports;#protected;#record;#exposure;
 constructor({stateDir,protectedRoots,getRecord,getExposure}){this.#root=path.resolve(stateDir+'.corrections');this.#exports=path.resolve(stateDir+'.correction-bundles');this.#protected=[...protectedRoots,stateDir,stateDir+'.request-records',stateDir+'.request-reviews',stateDir+'.ai-previews',stateDir+'.registrations'].map(p=>path.resolve(p));this.#record=getRecord;this.#exposure=getExposure;}
 async #dir(root){for(const p of this.#protected)demand(!within(p,root)&&!within(root,p),'RECORD_CORRECTION_BOUNDARY');await checkedDirectory(path.dirname(root));await mkdir(root,{recursive:true,mode:0o700});await checkedDirectory(root);}
 async #write(root,name,data){await this.#dir(root);const bytes=canonical(data)+'\n';demand(Buffer.byteLength(bytes)<=1800000,'RECORD_CORRECTION_TOO_LARGE');const p=path.join(root,name),h=await open(p,'ax',0o600);try{await verifyOpenedOutput(h,p,root);await h.writeFile(bytes);await h.sync();await verifyOpenedOutput(h,p,root);}finally{await h.close();}}
 async #read(name){return strictJSON((await boundedRead(path.join(this.#root,name),1800000)).content);}
 async #names(){await this.#dir(this.#root);const names=await readdir(this.#root);demand(names.length<=10000,'RECORD_CORRECTION_LIMIT');return names;}
 async #versions(id){demand(UUID.test(id));const names=(await this.#names()).filter(n=>n.startsWith(id+'-v')&&/^[a-f0-9-]{36}-v[1-9][0-9]*\.json$/.test(n)).sort((a,b)=>Number(a.match(/-v(\d+)/)[1])-Number(b.match(/-v(\d+)/)[1]));const rows=[];for(const n of names){const r=await this.#read(n);demand(r.record_id===id&&r.version===rows.length+1&&r.previous_hash===(rows.length?hash(rows.at(-1)):null),'RECORD_CORRECTION_STORAGE_CHANGED');rows.push(r);}return rows;}
 async #fresh(r){try{const original=await this.#record(r.record_id);return original.version===r.record_version&&hash(original)===r.record_hash&&original.input_snapshot_hash===r.input_hash?null:'원본 버전 변경: 재검토 필요';}catch{return'원본 삭제 또는 확인 불가: 철회·재검토 필요';}}
 async #all(){const ids=[...new Set((await this.#names()).filter(n=>/^[a-f0-9-]{36}-v[1-9][0-9]*\.json$/.test(n)).map(n=>n.slice(0,36)))],out=[];for(const id of ids){const r=(await this.#versions(id)).at(-1);if(r)out.push({...r,stale_reason:await this.#fresh(r)});}return out;}
 async handle(b){
  if(b.action==='correction-open'){keys(b,['action','recordId','recordVersion']);const record=await this.#record(b.recordId,b.recordVersion);return{record,versions:await this.#versions(b.recordId),exposure:await this.#exposure(b.recordId)};}
  if(b.action==='correction-list'){keys(b,['action']);return{items:(await this.#all()).map(r=>({record_id:r.record_id,version:r.version,record_version:r.record_version,request:r.input.request,workflow:r.draft.workflow,origin:r.draft.origin,usage:r.draft.usage,stale_reason:r.stale_reason,checks:r.checks}))};}
  if(['correction-check','correction-save'].includes(b.action)){
   keys(b,['action','recordId','recordVersion','inputHash','baseVersion','draft']);draftShape(b.draft);demand(Number.isSafeInteger(b.baseVersion)&&b.baseVersion>=0);const record=await this.#record(b.recordId,b.recordVersion),current=await this.#record(b.recordId);demand(record.input_snapshot_hash===b.inputHash&&current.version===record.version,'RECORD_CORRECTION_SOURCE_CHANGED');demand(record.data_origin!=='synthetic'||b.draft.origin!=='real','RECORD_CORRECTION_ORIGIN');
   const checks=checkCorrection(record.input,b.draft);if(b.action==='correction-check')return{checks};
   if(b.draft.workflow==='complete')demand(checks.valid,'RECORD_CORRECTION_INCOMPLETE');const versions=await this.#versions(b.recordId);demand((versions.at(-1)?.version??0)===b.baseVersion,'RECORD_CORRECTION_CHANGED');
   const result={schema_version:1,record_id:record.record_id,record_version:record.version,record_hash:hash(record),input_hash:record.input_snapshot_hash,input:record.input,version:b.baseVersion+1,previous_hash:versions.length?hash(versions.at(-1)):null,draft:b.draft,checks,confirmed_at:new Date().toISOString(),provenance:'self_review_not_independent_annotation',original_user_confirmation:record.raw_user_confirmation,original_data_origin:record.data_origin,exposure:{record_ai:record.ai_exposure??[],record_review:record.review_exposure_at_save??[],...await this.#exposure(record.record_id)}};
   await this.#write(this.#root,record.record_id+'-v'+result.version+'.json',result);return{saved:true,correction:result};
  }
  if(b.action==='correction-export'){
   keys(b,['action','selected','fixtureValidation']);demand(typeof b.fixtureValidation==='boolean'&&Array.isArray(b.selected)&&b.selected.length>0&&b.selected.length<=50);for(const s of b.selected){keys(s,['recordId','version']);demand(UUID.test(s.recordId)&&Number.isSafeInteger(s.version));}demand(new Set(b.selected.map(s=>s.recordId)).size===b.selected.length);
   const all=await this.#all(),included=[],excluded=[],rows=[],duplicates=[],conflicts=[],counts={intent:{},issues:{},sources:{},ai_exposure:{}};const byInput=new Map();
   const labelHash=o=>hash(o?{...o,source_ids:[...o.source_ids].sort((a,b)=>a.id.localeCompare(b.id)),issues:[...o.issues].sort((a,b)=>a.field.localeCompare(b.field))}:null);
   for(const r of all){const arr=byInput.get(r.input_hash)||[];arr.push(r);byInput.set(r.input_hash,arr);}
   for(const [inputHash,group]of byInput)if(group.length>1){const item={input_hash:inputHash,record_ids:group.map(r=>r.record_id)};duplicates.push(item);if(new Set(group.filter(r=>r.draft.workflow==='complete'&&!r.stale_reason).map(r=>labelHash(r.draft.output))).size>1)conflicts.push(item);}
   const templates=new Map(),lineageWarnings=[];for(const r of all){const h=hash(maskedRequest(r.input));templates.set(h,[...(templates.get(h)||[]),r.record_id]);for(const parent of r.draft.parentIds)if(!all.some(x=>x.record_id===parent))lineageWarnings.push({record_id:r.record_id,parent_id:parent,reason:'부모 원천 외부 또는 미등록: 계보 확인 필요'});}
   const visited=new Set(),active=new Set(),byId=new Map(all.map(r=>[r.record_id,r]));function visit(id){if(active.has(id)){lineageWarnings.push({record_id:id,reason:'부모 관계 순환: 계보 재검토 필요'});return;}if(visited.has(id))return;active.add(id);for(const p of byId.get(id)?.draft.parentIds||[])if(byId.has(p))visit(p);active.delete(id);visited.add(id);}all.forEach(r=>visit(r.record_id));
   const emitted=new Set();for(const selected of b.selected){const r=all.find(r=>r.record_id===selected.recordId),reasons=[];if(!r){excluded.push({...selected,reasons:['교정본 없음']});continue;}if(r.version!==selected.version)reasons.push('교정 최신 버전 변경');if(r.stale_reason)reasons.push(r.stale_reason);if(r.draft.workflow!=='complete'||!checkCorrection(r.input,r.draft).valid)reasons.push('본인 검토 완료·검사 조건 미충족');if(r.draft.usage!=='granted')reasons.push('연구 사용권한 미확인 또는 불허');if(r.draft.origin==='fixture'&&!b.fixtureValidation)reasons.push('기능 검증용 자료는 학습 내보내기 제외');if(b.fixtureValidation&&r.draft.origin!=='fixture')reasons.push('기능 검증 묶음에는 검증용 자료만 포함');if(conflicts.some(c=>c.record_ids.includes(r.record_id)))reasons.push('같은 입력의 상충 정답');if(emitted.has(r.input_hash))reasons.push('동일 입력 중복');
    if(reasons.length){excluded.push({...selected,record_version:r.record_version,input_hash:r.input_hash,correction_hash:hash(Object.fromEntries(Object.entries(r).filter(([k])=>k!=='stale_reason'))),reasons});continue;}
    emitted.add(r.input_hash);const {stale_reason,...clean}=r;const entry={record_id:r.record_id,record_version:r.record_version,record_hash:r.record_hash,correction_version:r.version,correction_hash:hash(clean),input_hash:r.input_hash};included.push(entry);
    const review=r.draft.output.intent==='checklist_review';rows.push({example_id:'personal-'+r.record_id+'-v'+r.version,input:r.input,target:r.draft.output,supervision:{status:true,intent:true,issues:true,arguments:review,argument_supervision:review?'review':'unannotated'},metadata:{...entry,provenance:r.provenance,origin:r.draft.origin,author:r.draft.author,reviewer:r.draft.reviewer,confirmed_at:r.confirmed_at,usage:r.draft.usage,usage_reason:r.draft.usageReason,source_task:r.draft.sourceTask||null,parent_ids:r.draft.parentIds,issue_evidence:r.draft.evidence,notes:r.draft.notes,exposure:r.exposure,split:'unassigned',lineage_review:'pending',group_id:r.draft.sourceTask||r.record_id}});
    const inc=(group,key)=>counts[group][key]=(counts[group][key]||0)+1;inc('intent',r.draft.output.intent);inc('sources',review?String(r.draft.output.source_ids.length):'unannotated');inc('ai_exposure',r.exposure.ai?.length||r.exposure.record_ai?.length?'exposed':'not_recorded');for(const i of r.draft.output.issues)inc('issues',i.field+'.'+i.code);
   }
   const id=randomUUID(),bundle={schema_version:1,bundle_id:id,version:1,created_at:new Date().toISOString(),purpose:b.fixtureValidation?'fixture_validation_not_training':'self_reviewed_training_candidates',training_ready:false,evaluation_ready:false,split_assigned:false,manifest:{included,excluded,duplicates,conflicts,counts,lineage_warnings:lineageWarnings,similar_template_groups:[...templates].filter(([,ids])=>ids.length>1).map(([hash,ids])=>({masked_request_hash:hash,record_ids:ids,independence_confirmed:false})),derived_relationships:all.filter(r=>r.draft.parentIds.length).map(r=>({record_id:r.record_id,parent_ids:r.draft.parentIds,review:'pending'})),source_groups:[...new Set(all.map(r=>r.draft.sourceTask).filter(Boolean))].map(id=>({source_task:id,record_ids:all.filter(r=>r.draft.sourceTask===id).map(r=>r.record_id)})),lineage_pending:included.map(x=>x.record_id),notice:'내보낸 사본은 원본 삭제로 자동 삭제되지 않음. 같은 원천·수정본·파생은 행 무작위 분할 금지.'},rows};
   await this.#write(this.#exports,id+'-v1.json',bundle);return{bundle,filename:'personal-corrections-'+id+'-v1.json',bundle_hash:hash(bundle)};
  }
  fail('RECORD_CORRECTION_INVALID');
 }
}
