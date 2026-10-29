import test from 'node:test';
import assert from 'node:assert/strict';
import {draftReviewSelection,reviewPresentation} from '../financial-documents/review-ui/local-review.mjs';

const documents=[{id:'T',roles:['review']},{id:'S',roles:['source']},{id:'G',roles:['guideline']},{id:'OTHER',roles:['review','source']}];
const raw=()=>({intent:'perform',target:{state:'selected',ids:['T']},sources:{state:'selected',ids:['S']},guideline:{state:'selected',ids:['G']},format:{state:'selected',value:'md'}});
const execution=()=>({execution_id:'synthetic-only',state:'completed',saved:false,review:{status:'ACTION_REQUIRED',reason:'REVIEW_RESULT',saved:false,reviewComplete:false,items:[{item_id:'QA',status:'MISSING_NO_EVIDENCE'}],unresolved:['QA'],body:'검증용 결과',documents:[{id:'T',content:'검증용 문서'}]}});

test('local review draft uses only explicit selected raw confirmation, not task defaults or first candidate',()=>{
 const missing={raw_user_confirmation:{target:{state:'none',ids:[]},sources:{state:'unknown',ids:[]},guideline:{state:'unknown',ids:[]},format:{state:'none',value:null}},selection:{taskId:'task',format:'json'},explicit_selection_draft:{target:'OTHER',sources:['S'],guideline:'G',format:'json'}};
 assert.deepEqual(draftReviewSelection(missing,documents),{action:'checklist_review',target_doc:'',source_ids:[],guideline_id:'',item_ids:[],format:''});
 assert.deepEqual(draftReviewSelection({},documents),{action:'checklist_review',target_doc:'',source_ids:[],guideline_id:'',item_ids:[],format:''});
});

test('draft drops unavailable IDs and roles without choosing replacements or changing original record',()=>{
 const original={raw_user_confirmation:raw()};original.raw_user_confirmation.target.ids=['OLD'];original.raw_user_confirmation.sources.ids=['S','OTHER','G','MISSING'];
 const before=structuredClone(original),selection=draftReviewSelection(original,documents);
 assert.equal(selection.target_doc,'');assert.deepEqual(selection.source_ids,['S','OTHER']);assert.equal(selection.guideline_id,'G');assert.deepEqual(original,before);
});

test('draft can be shown for a question or conversion but is always a separate checklist selection',()=>{
 const record={selection:{action:'convert'},raw_user_confirmation:{...raw(),intent:'question'}};
 const selection=draftReviewSelection(record,documents);assert.equal(selection.action,'checklist_review');assert.equal(record.selection.action,'convert');assert.equal(record.raw_user_confirmation.intent,'question');
});

test('genuine missing-evidence review is completed inspection, not all-satisfied or business save',()=>{
 const result=reviewPresentation(execution());assert.equal(result.state,'completed');assert.match(result.title,/추가 확인/);assert.match(result.note,/저장은 하지/);assert.equal(result.review.reviewComplete,false);assert.equal(result.review.saved,false);
});

test('genuine all-satisfied review stays distinct from unresolved inspection',()=>{
 const input=execution();input.review.status='READY';input.review.reviewComplete=true;input.review.items=[{item_id:'QA',status:'SATISFIED'}];input.review.unresolved=[];
 const result=reviewPresentation(input);assert.equal(result.state,'completed');assert.match(result.title,/모든 항목 충족/);
});

test('empty, diagnostic, inconsistent, or saved response cannot masquerade as normal inspection',()=>{
 for(const change of [e=>e.review.items=[],e=>e.review.reason='UNRESOLVED_LABEL_REQUIRED',e=>e.review.reviewComplete=true,e=>e.review.saved=true,e=>e.saved=true,e=>e.review.documents=null,e=>e.review.unresolved=null,e=>e.review.body=null,e=>e.review.items=[{status:'UNKNOWN'}]]){
  const e=execution();change(e);assert.equal(reviewPresentation(e).state,'failed');
 }
});

test('permission/content/core diagnostic remains visible and uncertain receipt is never normal result',()=>{
 for(const code of ['ACCESS_DENIED','CONTENT_CHANGED','CORE_RESPONSE_INVALID','RECORD_REVIEW_DOCUMENT_MISSING','RECORD_REVIEW_DOCUMENT_DENIED','LOCAL_REVIEW_RESULT_TOO_LARGE']){const view=reviewPresentation({state:'failed',saved:false,diagnostic:{code,coreStatus:'BLOCKED'}});assert.equal(view.state,'failed');assert.equal(view.code,code);assert.equal(view.coreStatus,'BLOCKED');}
 for(const state of ['uncertain','started','running'])assert.equal(reviewPresentation({state,saved:false}).state,'uncertain');
 assert.equal(reviewPresentation({state:'completed',saved:false}).state,'failed');
});
