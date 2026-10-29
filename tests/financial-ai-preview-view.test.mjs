import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestedConfirmation,interpretationSummary,previewRevision} from '../financial-documents/review-ui/ai-preview.mjs';

const documents=[{id:'T',display_name:'가상 대상',roles:['review']},{id:'S',display_name:'가상 근거',roles:['source']},{id:'G',display_name:'가상 지침',roles:['guideline']}];
const binding=id=>({id,span:{start:0,end:1}});
const ready=()=>({applicable:true,output:{status:'ready',intent:'checklist_review',target_doc:binding('T'),source_ids:[binding('S')],guideline_id:binding('G'),format:{value:'md',origin:'context',span:null},issues:[]},contract:{status:'VALIDATED',operation:{action:'checklist_review',target_doc:'T',source_ids:['S'],guideline_id:'G',format:'md',item_ids:[]}}});

test('ready validated assembled output becomes only a draft without changing model or input data',()=>{
 const response=ready(),before=structuredClone(response),draft=suggestedConfirmation(response,documents);
 assert.deepEqual(draft,{intent:'perform',target:{state:'selected',ids:['T']},sources:{state:'selected',ids:['S']},guideline:{state:'selected',ids:['G']},format:{state:'selected',value:'md'}});
 draft.sources.ids.push('manual');assert.deepEqual(response,before);
});

test('raw arguments cannot recover assembled cancel, nonreview, missing, or invalid output',()=>{
 for(const mutate of [r=>r.output.intent='cancel',r=>r.output.status='needs_clarification',r=>r.output.target_doc=null,r=>r.output.source_ids=[],r=>r.output.issues=[{field:'request',code:'non_action'}],r=>r.contract.status='UNSUPPORTED',r=>r.applicable=false]){
  const response=ready();response.raw_heads=structuredClone(response.output);mutate(response);assert.equal(suggestedConfirmation(response,documents),null);
 }
});

test('stale or inconsistent candidate/operation data cannot be applied as a proposal',()=>{
 for(const mutate of [r=>r.contract.operation.target_doc='S',r=>r.output.source_ids=[binding('T')],r=>r.output.format.value='pdf',r=>r.contract.operation.item_ids=['item'],r=>r.contract.operation.source_ids=['G']]){const response=ready();mutate(response);assert.equal(suggestedConfirmation(response,documents),null);}
 assert.equal(suggestedConfirmation(ready(),documents.filter(d=>d.id!=='S')),null);
 assert.equal(suggestedConfirmation(ready(),documents.map(d=>({...d,roles:['guideline']}))),null);
});

test('summary separates assembled interpretation and unresolved fields without accuracy probabilities',()=>{
 const response=ready();response.output.scores={kind:'uncalibrated_probability',intent:.99,arguments:.95};response.output.status='needs_clarification';response.output.issues=[{field:'source_ids',code:'missing'}];
 const summary=interpretationSummary(response.output,documents).map(([a,b])=>a+': '+b).join('\n');
 assert.match(summary,/추가 확인 필요/);assert.match(summary,/근거: 미지정/);assert.doesNotMatch(summary,/0\.99|99%|정답 확률/);
});

test('request, context, selection, or mode invalidation discards late inference and apply responses',()=>{
 const gate=previewRevision(),old=gate.capture();gate.invalidate();assert.equal(gate.accept(old,ready()),false);assert.equal(gate.value,null);
 const current=gate.capture();assert.equal(gate.accept(current,ready()),true);gate.invalidate();assert.equal(gate.value,null);assert.equal(gate.accept(current,ready()),false);
});
