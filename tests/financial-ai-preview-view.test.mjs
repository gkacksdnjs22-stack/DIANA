import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestedConfirmation,interpretationSummary,previewRevision,mountAiPreview} from '../financial-documents/review-ui/ai-preview.mjs';
import {aiPreviewDOM,deferred} from './helpers/ai-preview-dom.mjs';

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

async function mounted(t,{deferAudit=false}={}){
 const dom=aiPreviewDOM(t),response=deferred(),audit=deferred(),auditStarted=deferred(),calls=[],applied=[];
 let input={recordId:'record-A',request:'가상 대상을 검토해줘',confirmedFormat:'md',contextHash:'context-A',documents},confirmation={manual:'initial'},invalidations=0;
 const widget=mountAiPreview({
  api:async body=>{calls.push(structuredClone(body));if(body.action==='ai-infer')return{...ready(),predictionId:body.predictionId};if(body.action==='ai-apply')return response.promise;if(body.action==='ai-note'&&body.phase==='applied'&&deferAudit){auditStarted.resolve();return audit.promise;}return{ok:true};},
  getInput:()=>input,getConfirmation:()=>confirmation,
  onApply:draft=>{applied.push(draft);confirmation=draft;},invalidateConfirmation:()=>{invalidations++;}
 });
 dom.id('ai-enabled').checked=true;dom.id('ai-enabled').onchange();await dom.id('ai-infer').onclick();
 return{dom,widget,response,audit,auditStarted,calls,applied,get input(){return input;},get confirmation(){return confirmation;},get invalidations(){return invalidations;},editRequest(){input={...input,request:'새로운 사용자 요청'};widget.changed();},editSelection(){confirmation={manual:'USER_CHOICE'};widget.changed();},editFormat(){input={...input,confirmedFormat:'txt'};widget.changed();},reset(){input={...input,recordId:'record-B'};widget.reset();}};
}
for(const edit of ['editRequest','editSelection','editFormat','reset'])test('mounted apply handler ignores delayed success after '+edit,async t=>{
 const f=await mounted(t),pending=f.dom.id('ai-apply').onclick();f[edit]();const confirmation=f.confirmation,status=f.dom.id('ai-status').textContent;
 f.response.resolve({operation:{}});await pending;
 assert.equal(f.applied.length,0);assert.equal(f.invalidations,0);assert.deepEqual(f.confirmation,confirmation);assert.equal(f.dom.id('ai-status').textContent,status);
 assert.equal(f.calls.filter(b=>b.phase==='applied').length,0);
});
test('mounted apply handler ignores delayed success after the user disables AI',async t=>{
 const f=await mounted(t),pending=f.dom.id('ai-apply').onclick();f.dom.id('ai-enabled').checked=false;f.dom.id('ai-enabled').onchange();const status=f.dom.id('ai-status').textContent;
 f.response.resolve({operation:{}});await pending;assert.equal(f.applied.length,0);assert.equal(f.invalidations,0);assert.equal(f.dom.id('ai-status').textContent,status);assert.equal(f.dom.id('ai-infer').disabled,true);
});
for(const outcome of ['resolve','reject'])test('old apply '+outcome+' cannot clear or overwrite a newer mounted preview',async t=>{
 const f=await mounted(t),pending=f.dom.id('ai-apply').onclick();f.editRequest();await f.dom.id('ai-infer').onclick();
 const status=f.dom.id('ai-status').textContent,output=f.dom.id('ai-output').children.slice(),cancelCount=f.calls.filter(b=>b.action==='ai-cancel').length;
 f.response[outcome](outcome==='reject'?Error('old failure'):{operation:{}});await pending;
 assert.equal(f.applied.length,0);assert.equal(f.invalidations,0);assert.equal(f.dom.id('ai-apply').hidden,false);assert.equal(f.dom.id('ai-status').textContent,status);assert.deepEqual(f.dom.id('ai-output').children,output);assert.equal(f.calls.filter(b=>b.action==='ai-cancel').length,cancelCount);
});
test('mounted apply handler still applies a current proposal and invalidates record confirmation',async t=>{
 const f=await mounted(t),pending=f.dom.id('ai-apply').onclick();f.response.resolve({operation:{}});await pending;
 assert.equal(f.applied.length,1);assert.equal(f.invalidations,1);assert.deepEqual(f.confirmation,suggestedConfirmation(ready(),documents));assert.equal(f.dom.id('ai-apply').hidden,true);assert.equal(f.calls.filter(b=>b.phase==='applied').length,1);
});
for(const outcome of ['resolve','reject'])test('a delayed applied-audit '+outcome+' cannot overwrite a new mounted preview',async t=>{
 const f=await mounted(t,{deferAudit:true}),pending=f.dom.id('ai-apply').onclick();f.response.resolve({operation:{}});await f.auditStarted.promise;
 assert.equal(f.applied.length,1);f.editSelection();await f.dom.id('ai-infer').onclick();const status=f.dom.id('ai-status').textContent;
 f.audit[outcome](outcome==='reject'?Error('old audit failure'):{ok:true});await pending;assert.equal(f.applied.length,1);assert.equal(f.dom.id('ai-apply').hidden,false);assert.equal(f.dom.id('ai-status').textContent,status);assert.deepEqual(f.confirmation,{manual:'USER_CHOICE'});
});
