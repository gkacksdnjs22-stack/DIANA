import {randomUUID} from 'node:crypto';
import {keys,fail,validId} from './strict-json.mjs';
import {digest} from '../personal-ai/documents/files.mjs';
const hash=v=>digest(JSON.stringify(v));
export function searchOperation(s){
 keys(s,['action','query','source_ids','limit']);
 if(s.action!=='search_evidence'||typeof s.query!=='string'||!s.query.trim()||[...s.query].length>2000)fail('SEARCH_QUERY_REQUIRED');
 if(!Array.isArray(s.source_ids)||!s.source_ids.length||s.source_ids.length>16||new Set(s.source_ids).size!==s.source_ids.length||s.source_ids.some(id=>!validId(id)))fail('SEARCH_SCOPE_REQUIRED');
 if(!Number.isInteger(s.limit)||s.limit<1||s.limit>20)fail('SEARCH_LIMIT_INVALID');
 return structuredClone(s);
}
/** Ephemeral read-only query receipts. No inference, plan or business writes. */
export class EvidenceSearch{
 #with;#latest=null;#revision=-1;
 constructor(withSearch){this.#with=withSearch;}
 clear(){this.#latest=null;}
 async handle(b){
  if(typeof this.#with!=='function')fail('SEARCH_UNAVAILABLE');
  if(!Number.isSafeInteger(b.revision)||b.revision<0||b.revision<this.#revision)fail('SEARCH_STALE');
  if(b.revision>this.#revision){this.clear();this.#revision=b.revision;}
  if(b.action==='search-cancel'){keys(b,['action','revision']);this.clear();return{cancelled:true,saved:false};}
  if(b.action==='search-list'){keys(b,['action','revision']);this.clear();return this.#with(async(_,ctx)=>({documents:ctx.documents.map(d=>({id:d.id,display_name:d.display_name,roles:d.roles,version:d.version})),saved:false}));}
  if(b.action==='search-run'){
   keys(b,['action','revision','selection']);this.clear();const s=searchOperation(b.selection);
   return this.#with(async(ops,ctx)=>{
    if(s.source_ids.some(id=>!ctx.documents.some(d=>d.id===id)))fail('SEARCH_SCOPE_CHANGED');
    const result=await ops.search(s,ctx.documents);if(!['RESULTS','NO_MATCH'].includes(result.status))fail(result.reason||'SEARCH_FAILED');
    const snapshot=result.search_snapshot;
    if(!snapshot||hash(await ops.searchSnapshot(s.source_ids))!==hash(snapshot))fail('SEARCH_STALE');
    this.#latest={id:randomUUID(),revision:b.revision,ctx:hash(ctx),snapshot,selection:s,result,expires:Date.now()+300000};
    return{...result,search_id:this.#latest.id};
   });
  }
  if(b.action==='search-apply'){
   keys(b,['action','revision','search_id','result_id']);const t=this.#latest;
   if(!t||t.id!==b.search_id||t.revision!==b.revision||t.expires<Date.now())fail('SEARCH_STALE');
   this.clear();return this.#with(async(ops,ctx)=>{
    const r=t.result.results.find(r=>r.result_id===b.result_id);
    if(!r||!ctx.documents.some(d=>d.id===r.doc_id&&d.roles.includes('source')))fail('SEARCH_SCOPE_CHANGED');
    if(hash(ctx)!==t.ctx||hash(await ops.searchSnapshot(t.selection.source_ids))!==hash(t.snapshot))fail('SEARCH_STALE');
    return{source_id:r.doc_id,display_name:r.display_name,selection_scope:'whole_document',provenance:'explicit_search_selection',saved:false};
   });
  }
  fail('SEARCH_INVALID');
 }
}
