import crypto from 'node:crypto';
import {buildModelInput} from '../contract.mjs';
import {schemas,schemaErrors,fields} from './schema.mjs';
export const canonical=x=>JSON.stringify(x===null||typeof x!=='object'?x:Array.isArray(x)?x.map(y=>JSON.parse(canonical(y))):Object.fromEntries(Object.keys(x).sort().map(k=>[k,JSON.parse(canonical(x[k]))])));
export const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:canonical(x)).digest('hex');
export const norm=s=>s.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase();
export const coreNames=['participants','allocations','cases','annotations_A','annotations_B','adjudications','references','governance'];
export const scopeHash=d=>hash(Object.fromEntries(coreNames.map(k=>[k,d[k]])));
export const contentHash=d=>hash({...Object.fromEntries(coreNames.map(k=>[k,d[k]])),reviews:d.reviews});
const same=(a,b)=>canonical(a)===canonical(b);
const normalizedOutput=o=>({...o,source_ids:[...o.source_ids].sort((a,b)=>canonical(a).localeCompare(canonical(b))),issues:[...o.issues].sort((a,b)=>canonical(a).localeCompare(canonical(b)))});
const textOK=s=>!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);
function boundaries(text){const out=new Set([0]);let n=0;for(const ch of text){n+=ch.length;out.add(n);}return out;}
function spanText(span,input,errors,label){
 if(!span||!Number.isInteger(span.start)||!Number.isInteger(span.end)||span.start<0||span.end<=span.start||span.end>input.request.length||!boundaries(input.request).has(span.start)||!boundaries(input.request).has(span.end)){errors.push(label+': UTF16_BOUNDARY');return null;}
 return input.request.slice(span.start,span.end);
}
function matches(text,input){
 const exact=input.candidates.filter(c=>norm(c.id)===norm(text));return exact.length?exact:input.candidates.filter(c=>[c.display_name,...c.aliases].some(n=>norm(n)===norm(text)));
}
export function validateInput(input){
 const errors=schemaErrors(input,schemas.cases.properties.input);if(errors.length)return errors;
 if(!textOK(input.request))errors.push('REQUEST_UNPAIRED_SURROGATE');
 try{const rebuilt=buildModelInput(input.request,input.candidates,input.candidates,{confirmedFormat:input.context.confirmed_format});if(!same(input,rebuilt))errors.push('INPUT_CONTRACT_MISMATCH');}catch(e){errors.push('INPUT_CONTRACT:'+e.message);}
 for(const c of input.candidates)if(!textOK(c.display_name)||c.aliases.some(x=>!textOK(x)))errors.push('CANDIDATE_UNPAIRED_SURROGATE');
 return errors;
}
export function validateGold(output,input,evidence=[]){
 const errors=schemaErrors(output,schemas.annotations.properties.output);if(errors.length)return errors;
 const review=output.intent==='checklist_review';const issueKeys=output.issues.map(x=>x.field+'::'+x.code);
 if(new Set(output.issues.map(x=>x.field)).size!==output.issues.length)errors.push('ONE_ISSUE_CLASS_PER_FIELD');
 if(output.status==='ready'&&(!review||output.issues.length||!output.target_doc||!output.guideline_id||!output.source_ids.length||!output.format))errors.push('READY_INCONSISTENT');
 if(output.status==='needs_clarification'&&!output.issues.length)errors.push('CLARIFICATION_WITHOUT_ISSUES');
 if(review&&!['ready','needs_clarification'].includes(output.status))errors.push('REVIEW_STATUS');
 const allowedCodes={target_doc:['missing','unavailable','ambiguous'],source_ids:['missing','unavailable','ambiguous'],guideline_id:['missing','unavailable','ambiguous'],format:['missing','ambiguous'],request:['ambiguous','unsupported','non_action','cancel']};
 if(output.issues.some(i=>!allowedCodes[i.field].includes(i.code)))errors.push('FIELD_ISSUE_CLASS');
 if(review&&output.issues.some(i=>i.field==='request'&&i.code!=='ambiguous'))errors.push('REVIEW_REQUEST_ISSUE');
 if(review)for(const f of ['target_doc','source_ids','guideline_id','format'])if((f==='source_ids'?!output[f].length:output[f]===null)&&!output.issues.some(i=>i.field===f))errors.push('UNRESOLVED_WITHOUT_ISSUE '+f);
 if(output.status==='cancel_requested'&&(output.intent!=='cancel'||!issueKeys.includes('request::cancel')))errors.push('CANCEL_INCONSISTENT');
 if(output.intent==='cancel'&&output.status!=='cancel_requested')errors.push('CANCEL_STATUS');
 if(output.intent==='question'&&(output.status!=='unsupported'||!issueKeys.includes('request::non_action')))errors.push('QUESTION_CONTRACT_LABEL');
 if(['patch','convert','save','export','mixed'].includes(output.intent)&&(output.status!=='unsupported'||!issueKeys.includes('request::unsupported')))errors.push('UNSUPPORTED_TASK_LABEL');
 if(output.intent==='unknown'&&(output.status!=='needs_clarification'||!issueKeys.includes('request::ambiguous')))errors.push('UNKNOWN_INTENT_LABEL');
 if(!review&&(output.target_doc!==null||output.guideline_id!==null||output.source_ids.length||output.format!==null))errors.push('NONREVIEW_ARGUMENTS_MUST_BE_UNANNOTATED');
 if(!review&&output.issues.some(i=>i.field!=='request'))errors.push('NONREVIEW_FIELD_ISSUE');
 const occupied=[];
 for(const [field,role,bindings] of [['target_doc','review',output.target_doc?[output.target_doc]:[]],['source_ids','source',output.source_ids],['guideline_id','guideline',output.guideline_id?[output.guideline_id]:[]]]){
  for(const b of bindings){
   const c=input.candidates.find(x=>x.id===b.id),text=spanText(b.span,input,errors,field);occupied.push({field,id:b.id,span:b.span});
   if(!c)errors.push(field+': CANDIDATE_ABSENT');else if(!c.roles.includes(role))errors.push(field+': ROLE_NOT_ALLOWED');
   if(text!==null){const m=matches(text,input);if(m.length!==1||m[0].id!==b.id)errors.push(field+': GROUNDING_OR_AMBIGUITY');}
  }
 }
 if(new Set(output.source_ids.map(x=>x.id)).size!==output.source_ids.length)errors.push('DUPLICATE_SOURCES');
 for(let i=0;i<occupied.length;i++)for(let j=i+1;j<occupied.length;j++){
  const a=occupied[i],b=occupied[j];if(a.id===b.id)errors.push('OVERLAPPING_DOCUMENT_ROLES');
  if(a.span.start<b.span.end&&b.span.start<a.span.end)errors.push('OVERLAPPING_GOLD_SPANS');
 }
 for(const x of output.issues){
  if(['target_doc','guideline_id','format'].includes(x.field)&&output[x.field]!==null)errors.push(x.field+': ISSUE_WITH_RESOLVED_SINGLE_ARGUMENT');
  if(x.field==='source_ids'&&x.code==='missing'&&output.source_ids.length)errors.push('SOURCE_MISSING_WITH_BINDINGS');
 }
 if(output.format){
  const f=output.format;
  if(f.origin==='context'){if(f.span!==null||input.context.confirmed_format!==f.value)errors.push('FORMAT_CONTEXT');}
  else{const t=spanText(f.span,input,errors,'format'),names={md:['md','markdown','마크다운'],txt:['txt','text','텍스트'],json:['json']};if(t!==null&&!names[f.value].includes(norm(t)))errors.push('FORMAT_GROUNDING');if(input.context.confirmed_format!==null&&input.context.confirmed_format!==f.value)errors.push('FORMAT_CONTEXT_CONFLICT');}
 }
 const evidenceKeys=evidence.map(x=>x.field+'::'+x.code);
 if(!same([...evidenceKeys].sort(),[...issueKeys].sort()))errors.push('ISSUE_EVIDENCE_COVERAGE');
 for(const e of evidence){
  if(e.candidate_ids.some(id=>!input.candidates.some(c=>c.id===id)))errors.push('EVIDENCE_UNKNOWN_CANDIDATE');
  const t=e.span===null?null:spanText(e.span,input,errors,'evidence');const ms=t===null?[]:matches(t,input);
  if(e.kind==='empty_candidates'&&input.candidates.length)errors.push('EVIDENCE_NOT_EMPTY');
  if(e.kind==='out_of_list'&&(t===null||ms.length))errors.push('EVIDENCE_NOT_OUT_OF_LIST');
  if(e.kind==='ambiguous_name'&&(t===null||ms.length<2||!same(ms.map(x=>x.id).sort(),[...e.candidate_ids].sort())))errors.push('EVIDENCE_NOT_AMBIGUOUS_NAME');
  if(e.kind==='role_disallowed'){
   const role={target_doc:'review',source_ids:'source',guideline_id:'guideline'}[e.field];if(!role||!e.candidate_ids.length||!e.candidate_ids.every(id=>ms.some(c=>c.id===id&&!c.roles.includes(role))))errors.push('EVIDENCE_NOT_ROLE_DISALLOWED');
  }
  if(e.code==='unavailable'&&!['out_of_list','role_disallowed','empty_candidates'].includes(e.kind))errors.push('UNAVAILABLE_EVIDENCE_KIND');
  if(e.code==='missing'&&e.kind!=='absence')errors.push('MISSING_EVIDENCE_KIND');
  if(e.kind==='format_conflict'){
   const names={md:['md','markdown','마크다운'],txt:['txt','text','텍스트'],json:['json']},found=Object.keys(names).find(k=>t!==null&&names[k].includes(norm(t)));
   if(e.field!=='format'||e.code!=='ambiguous'||!found||input.context.confirmed_format===null||input.context.confirmed_format===found)errors.push('EVIDENCE_NOT_FORMAT_CONFLICT');
  }
 }
 return [...new Set(errors)];
}
const state=(status,reason,details={})=>({status,reason,...details});
const ok=(yes,reason,details={})=>state(yes?'충족':'미충족',reason,details);
export function maskedRequest(input){let s=norm(input.request);const vals=input.candidates.flatMap(c=>[c.id,c.display_name,...c.aliases]).map(norm).sort((a,b)=>b.length-a.length);for(const v of new Set(vals))s=s.split(v).join('<doc>');return s.replace(/\d+/g,'#');}
function grams(s){return new Set(Array.from(s).map((_,i,a)=>a.slice(i,i+3).join('')).filter(x=>Array.from(x).length===3));}
function dice(a,b){if(a===b)return 1;const x=grams(a),y=grams(b);return x.size+y.size?2*[...x].filter(v=>y.has(v)).length/(x.size+y.size):0;}
function diffs(a,b){const out=[];for(const k of ['status','intent','target_doc','source_ids','guideline_id','format','issues'])if(!same(normalizedOutput(a)[k],normalizedOutput(b)[k]))out.push({field:k,A:a[k],B:b[k]});return out;}
export function validateData(d){
 const errors=[],warnings=[],disagreements=[],resolved=[],checks={};
 const specs={participants:'participants',allocations:'allocations',cases:'cases',annotations_A:'annotations',annotations_B:'annotations',adjudications:'adjudications',references:'references',reviews:'reviews',governance:'governance'};
 for(const [name,sc] of Object.entries(specs)){
  const list=['cases','annotations_A','annotations_B','adjudications'].includes(name);if(list&&!Array.isArray(d[name]))errors.push(name+': expected records array');else errors.push(...(list?d[name].flatMap((x,i)=>schemaErrors(x,schemas[sc],name+'['+i+']')):schemaErrors(d[name],schemas[sc],name)));
 }
 if(errors.length)return {schema_version:1,ready_for_offline_evaluation:false,checks:{schema:state('미충족','Schema errors')},errors,warnings,disagreements,counts:{imported:Array.isArray(d.cases)?d.cases.length:0,eligible:0},final:{ready:false,status:'미확인',reason:'Development-only tool; no final contents inspected'}};
 const scope=scopeHash(d);const byId=(rows,name)=>{const m=new Map();for(const r of rows){if(m.has(r.id))errors.push(name+': DUPLICATE_ID '+r.id);m.set(r.id,r);}return m;};
 const people=byId(d.participants,'participants'),allocs=byId(d.allocations,'allocations'),cases=byId(d.cases,'cases'),refs=byId(d.references,'references');
 const human=(id,role)=>people.get(id)?.kind==='human'&&people.get(id).roles.includes(role);
 const reviewOf=kind=>d.reviews.find(r=>r.kind===kind&&r.scope_sha256===scope&&r.decision==='approved'&&human(r.reviewer_id,'auditor'));
 for(const r of d.reviews)if(r.scope_sha256!==scope)warnings.push('STALE_REVIEW '+r.kind);
 for(const a of d.allocations){if(!people.has(a.assigned_by))errors.push('ALLOCATION_UNKNOWN_OWNER '+a.id);if(a.split==='new_dev'&&!human(a.assigned_by,'auditor'))errors.push('ALLOCATION_NEEDS_HUMAN_AUDITOR '+a.id);}
 const allocationOwners=new Map();
 for(const a of [...d.allocations,...d.references])for(const k of ['root:'+a.source_task_id,'company:'+a.company_corpus_id,'family:'+a.family_id,...a.document_lineage_ids.map(x=>'doc:'+x),...(a.template_batch_id?['template:'+a.template_batch_id]:[])]){
  if(allocationOwners.has(k)&&allocationOwners.get(k)!==a.split)errors.push('ALLOCATION_SPLIT_CROSSING '+k);else allocationOwners.set(k,a.split);
 }
 const indexAnnotations=(rows,name)=>{const m=new Map();for(const r of rows){if(m.has(r.case_id))errors.push(name+': DUPLICATE_CASE '+r.case_id);if(!cases.has(r.case_id))errors.push(name+': ORPHAN '+r.case_id);m.set(r.case_id,r);}return m;};
 const A=indexAnnotations(d.annotations_A,'A'),B=indexAnnotations(d.annotations_B,'B'),adj=indexAnnotations(d.adjudications,'adjudications');
 const validCases=[];let fixtureCount=0;
 for(const c of d.cases){
  const ce=validateInput(c.input);const al=allocs.get(c.allocation_id);if(!al)ce.push('UNKNOWN_ALLOCATION');else{
   if(c.allocation_sha256!==hash(al)||c.split!==al.split)ce.push('ALLOCATION_HASH_OR_SPLIT');
   if(Date.parse(c.created_at)<Date.parse(al.assigned_at)||c.provenance.variant_created_at!==null&&Date.parse(c.provenance.variant_created_at)<Date.parse(al.assigned_at))ce.push('ALLOCATION_AFTER_VARIANT');
  }
  if(c.parent_ids.length&&c.provenance.variant_created_at===null)ce.push('VARIANT_TIMESTAMP_REQUIRED');
  if(c.provenance.author_ids.some(id=>!people.has(id)))ce.push('UNKNOWN_AUTHOR');
  if(c.provenance.usage.status!=='granted')ce.push('USAGE_NOT_GRANTED');
  if(c.purpose==='fixture'||c.provenance.origin==='fixture'||c.id.startsWith('fixture_')){fixtureCount++;warnings.push('FIXTURE_EXCLUDED '+c.id);continue;}
  for(const id of c.parent_ids)if(!cases.has(id)&&!refs.has(id))ce.push('MISSING_PARENT '+id);
  if(c.condition_tags.permission_condition==='absent_candidates'&&c.input.candidates.length)ce.push('ABSENT_CANDIDATES_TAG');
  if(ce.length){errors.push(...ce.map(e=>c.id+': '+e));continue;}validCases.push(c);
  const aa=A.get(c.id),bb=B.get(c.id);const ae=[];
  for(const [slot,n] of [['A',aa],['B',bb]]){
   if(!n){ae.push('MISSING_ANNOTATION_'+slot);continue;}
   if(n.annotator_id!==d.governance['slot_'+slot]||!human(n.annotator_id,'annotator')||c.provenance.author_ids.includes(n.annotator_id))ae.push('ANNOTATOR_NOT_INDEPENDENT_HUMAN_'+slot);
   if(n.input_sha256!==hash(c.input))ae.push('STALE_ANNOTATION_'+slot);
   if(Object.values(n.blind).some(v=>v!==true))ae.push('BLIND_ATTESTATION_'+slot);
   if(Date.parse(n.submitted_at)<Date.parse(c.created_at))ae.push('ANNOTATION_BEFORE_CASE_'+slot);
   if(n.argument_supervision!==(n.output.intent==='checklist_review'?'review':'unannotated'))ae.push('ARGUMENT_MASK_'+slot);
   ae.push(...validateGold(n.output,c.input,n.issue_evidence).map(e=>slot+': '+e));
  }
  if(aa&&bb&&aa.annotator_id===bb.annotator_id)ae.push('ANNOTATORS_SAME_PERSON');
  if(ae.length){disagreements.push({case_id:c.id,status:'incomplete',problems:ae});continue;}
  const differences=diffs(aa.output,bb.output),ad=adj.get(c.id);let gold=aa.output;
  if(differences.length&&!ad){disagreements.push({case_id:c.id,status:'needs_adjudication',differences});continue;}
  if(ad){
   const adErrors=[];
   if(ad.model_predictions_unseen!==true)adErrors.push('ADJUDICATOR_MODEL_EXPOSURE');
   if(!human(ad.reviewer_id,'adjudicator')||[aa.annotator_id,bb.annotator_id,...c.provenance.author_ids].includes(ad.reviewer_id))adErrors.push('THIRD_REVIEWER_NOT_INDEPENDENT');
   if(ad.input_sha256!==hash(c.input)||ad.annotation_A_sha256!==hash(aa)||ad.annotation_B_sha256!==hash(bb))adErrors.push('STALE_ADJUDICATION');
   if(Date.parse(ad.decided_at)<Math.max(Date.parse(aa.submitted_at),Date.parse(bb.submitted_at)))adErrors.push('ADJUDICATION_TIME');
   if(ad.decision==='accept_A'&&!same(normalizedOutput(ad.output),normalizedOutput(aa.output))||ad.decision==='accept_B'&&!same(normalizedOutput(ad.output),normalizedOutput(bb.output)))adErrors.push('ADJUDICATION_DECISION_MISMATCH');
   adErrors.push(...validateGold(ad.output,c.input,ad.issue_evidence));
   if(adErrors.length){disagreements.push({case_id:c.id,status:'invalid_adjudication',differences,problems:adErrors});continue;}gold=ad.output;
  }
  if(differences.length)disagreements.push({case_id:c.id,status:'adjudicated',differences,reviewer_id:ad.reviewer_id,rationale:ad.rationale});
  const evidence=ad?ad.issue_evidence:aa.issue_evidence;
  if(['out_of_list','role_disallowed'].includes(c.condition_tags.permission_condition)&&!evidence.some(e=>e.kind===c.condition_tags.permission_condition))errors.push('PERMISSION_TAG_WITHOUT_EVIDENCE '+c.id);
  if(c.stratum==='primary'&&(![0,6,7,8].includes(c.input.candidates.length)||c.input.candidates.some(x=>!['guideline','review+source'].includes([...x.roles].sort().join('+')))||gold.issues.some(x=>['source_ids','guideline_id'].includes(x.field)&&x.code==='ambiguous')))errors.push('PRIMARY_UNSEEN_CONDITION '+c.id);
  // Annotation consistency does not verify semantic independence or real ACL behavior.
  resolved.push({case:c,allocation:al,gold,input_sha256:hash(c.input),annotation_hashes:[hash(aa),hash(bb)],adjudication_hash:ad?hash(ad):null});
 }
 // Cycles, unknown parents, and connected-component crossing are hard errors.
 const nodes=[...validCases.map(c=>({id:c.id,split:c.split,source_task_id:allocs.get(c.allocation_id).source_task_id,company_corpus_id:allocs.get(c.allocation_id).company_corpus_id,document_lineage_ids:allocs.get(c.allocation_id).document_lineage_ids,family_id:allocs.get(c.allocation_id).family_id,template_batch_id:allocs.get(c.allocation_id).template_batch_id,parent_ids:c.parent_ids,candidate_ids:c.input.candidates.map(x=>x.id),input_sha256:hash(c.input),request_sha256:hash(norm(c.input.request)),masked_request_sha256:hash(maskedRequest(c.input)),input:c.input})),...d.references];
 const nodesBy=byId(nodes,'case/reference');const visited=new Set(),active=new Set();
 function visit(id){if(active.has(id)){errors.push('PARENT_CYCLE '+id);return;}if(visited.has(id))return;active.add(id);for(const p of nodesBy.get(id)?.parent_ids??[]){if(!nodesBy.has(p))errors.push('REFERENCE_PARENT_UNKNOWN '+p);else visit(p);}active.delete(id);visited.add(id);}
 nodes.forEach(n=>visit(n.id));
 const parent=nodes.map((_,i)=>i),find=i=>parent[i]===i?i:(parent[i]=find(parent[i])),owners=new Map();
 function join(i,j){parent[find(i)]=find(j);}
 nodes.forEach((n,i)=>{const keys=[['root',n.source_task_id],['company',n.company_corpus_id],['family',n.family_id],...n.document_lineage_ids.map(x=>['document',x]),...n.candidate_ids.map(x=>['candidate',x]),['input',n.input_sha256],['request',n.request_sha256],['masked',n.masked_request_sha256]];if(n.template_batch_id)keys.push(['template',n.template_batch_id]);for(const p of n.parent_ids)keys.push(['id',p]);keys.push(['id',n.id]);for(const [t,v] of keys){const k=t+':'+v;if(owners.has(k))join(i,owners.get(k));else owners.set(k,i);}});
 const gs=new Map();nodes.forEach((n,i)=>{const k=find(i);if(!gs.has(k))gs.set(k,[]);gs.get(k).push(n);});
 const components=[...gs.values()].map(ns=>({ids:ns.map(x=>x.id),splits:[...new Set(ns.map(x=>x.split))],families:[...new Set(ns.map(x=>x.family_id))]}));
 const crossings=components.filter(g=>g.splits.length>1);for(const g of crossings)errors.push('SPLIT_CROSSING '+g.ids.join(','));
 const near=[];for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
  const a=nodes[i],b=nodes[j];if(!a.input||!b.input)continue;const score=dice(maskedRequest(a.input),maskedRequest(b.input));if(score>=.68)near.push({pair_id:[a.id,b.id].sort().join('|'),ids:[a.id,b.id],score,same_component:find(i)===find(j),automatic_independence:false});
 }
 const nearReview=reviewOf('near_duplicates');const unresolvedNear=near.filter(pair=>!nearReview?.pair_decisions.some(d=>d.pair_id===pair.pair_id&&(d.decision==='distinct_with_reason'||d.decision==='same_lineage'&&pair.same_component)));
 const duplicateGroups=[];
 for(const key of ['input_sha256','request_sha256','masked_request_sha256']){
  const groups=new Map();for(const n of nodes){if(!groups.has(n[key]))groups.set(n[key],[]);groups.get(n[key]).push(n.id);}
  for(const [digest,ids] of groups)if(ids.length>1){duplicateGroups.push({key,sha256:digest,ids});if(key==='input_sha256'){
   const labels=resolved.filter(r=>ids.includes(r.case.id)).map(r=>canonical(normalizedOutput(r.gold)));if(new Set(labels).size>1)errors.push('CONFLICTING_SUPERVISION '+ids.join(','));
  }}
 }
 const tally=values=>Object.fromEntries([...new Set(values)].map(v=>[v,values.filter(x=>x===v).length]));
 const roots=tally(resolved.map(r=>r.allocation.source_task_id));const families=new Set(resolved.map(r=>r.allocation.family_id));
 const count={imported:d.cases.length,fixture_excluded:fixtureCount,valid_inputs:validCases.length,eligible:resolved.length,unique_inputs:new Set(resolved.map(r=>r.input_sha256)).size,roots:Object.keys(roots).length,max_variants_per_root:Math.max(0,...Object.values(roots)),families:families.size,components:components.filter(c=>c.splits.length===1&&c.splits[0]==='new_dev'&&c.ids.some(id=>resolved.some(r=>r.case.id===id))).length,status:tally(resolved.map(r=>r.gold.status)),stratum:tally(resolved.map(r=>r.case.stratum)),normal_sources:tally(resolved.filter(r=>r.gold.status==='ready').map(r=>String(r.gold.source_ids.length))),candidate_buckets:tally(resolved.map(r=>{const n=r.case.input.candidates.length;return n===0?'0':n<=4?'1-4':n<=8?'5-8':n<=16?'9-16':'>16';})),issue_cells:{},phenomena:{},permission_conditions:tally(resolved.map(r=>r.case.condition_tags.permission_condition)),role_patterns:tally(resolved.flatMap(r=>r.case.input.candidates.map(c=>[...c.roles].sort().join('+'))))};
 const deficits=[];
 for(const [s,n] of Object.entries({ready:80,needs_clarification:80,unsupported:60,cancel_requested:20}))if((count.status[s]??0)!==n)deficits.push({condition:'status:'+s,required:n,actual:count.status[s]??0,missing:Math.max(0,n-(count.status[s]??0))});
 for(const [k,n] of Object.entries({'1':40,'2':24,'3':16}))if((count.normal_sources[k]??0)!==n)deficits.push({condition:'normal_sources:'+k,required:n,actual:count.normal_sources[k]??0,missing:Math.max(0,n-(count.normal_sources[k]??0))});
 for(const bucket of ['0','1-4','5-8','9-16'])if((count.candidate_buckets[bucket]??0)<12)deficits.push({condition:'candidate_count:'+bucket,minimum:12,actual:count.candidate_buckets[bucket]??0});
 for(const f of fields.slice(0,4))for(const code of (f==='format'?['missing','ambiguous']:['missing','unavailable','ambiguous'])){
  const rr=resolved.filter(r=>r.gold.issues.some(i=>i.field===f&&i.code===code));const k=f+'::'+code;count.issue_cells[k]={rows:rr.length,roots:new Set(rr.map(r=>r.allocation.source_task_id)).size};if(rr.length<8||count.issue_cells[k].roots<4)deficits.push({condition:k,minimum_rows:8,minimum_roots:4,...count.issue_cells[k]});
 }
 for(const tag of ['quoted_adopted','quoted_explanation','explicit_negation','scope_negation','cancel','cancel_mention','mixed']){const rr=resolved.filter(r=>r.case.condition_tags.phenomena.includes(tag));count.phenomena[tag]={rows:rr.length,families:new Set(rr.map(r=>r.allocation.family_id)).size};if(count.phenomena[tag].families<4)deficits.push({condition:tag,minimum_families:4,...count.phenomena[tag]});}
 for(const pattern of ['review','source','review+source'])if(!count.role_patterns[pattern])deficits.push({condition:'permission_pattern:'+pattern,minimum:1,actual:0});
 for(const cond of ['out_of_list','role_disallowed','absent_candidates'])if(!count.permission_conditions[cond])deficits.push({condition:'permission_condition:'+cond,minimum:1,actual:0});
 count.intent=tally(resolved.map(r=>r.gold.intent));
 count.format_origin=tally(resolved.map(r=>r.gold.format?.origin??'unannotated_or_unresolved'));
 const intersections=tally(resolved.map(r=>[r.case.stratum,r.allocation.family_id,r.gold.status,r.gold.intent,r.case.condition_tags.permission_condition,r.gold.source_ids.length,r.gold.format?.origin??'unannotated_or_unresolved',[...r.gold.issues.map(i=>i.field+'::'+i.code)].sort().join(',')||'none'].join('|')));
 checks.schema=ok(errors.length===0,'Schema/contract/grounding/lineage hard checks',{errors:errors.length});
 checks.quantity=ok(count.eligible===240&&count.unique_inputs===240,'240 reviewed unique inputs',{actual:count.eligible,unique:count.unique_inputs});
 checks.groups=ok(count.roots>=60&&count.families>=12&&count.components>=12&&count.max_variants_per_root<=4,'60roots,12families/components,max4variants',{roots:count.roots,families:count.families,components:count.components,max_variants:count.max_variants_per_root});
 checks.strata=ok((count.stratum.primary??0)>=160&&(count.stratum.extension??0)<=80,'Primary>=160, extension<=80; semantics verified by reviewer');
 checks.coverage=ok(deficits.length===0,'31 section quotas and semantic coverage',{deficits});
 checks.annotations=ok(validCases.length>0&&resolved.length===validCases.length&&fixtureCount===0,'Two independent human annotations; all disagreements adjudicated',{resolved:resolved.length,unresolved:disagreements.filter(x=>x.status!=='adjudicated').length});
 checks.blind_distribution=ok(d.governance.packets_access_separated&&!!d.governance.separation_evidence_ref&&d.governance.slot_A!==d.governance.slot_B&&human(d.governance.slot_A,'annotator')&&human(d.governance.slot_B,'annotator'),'Distinct humans and actual access-separation evidence');
 const inventories=Object.values(d.governance.reference_inventory).every(Boolean)&&['legacy_train','legacy_development','new_final'].every(s=>d.references.some(r=>r.split===s));
 checks.split_leakage=crossings.length||errors.some(x=>x.startsWith('ALLOCATION_SPLIT_CROSSING'))?state('미충족','Cross-split components or allocations',{crossings}):!inventories?state('미확인','External/legacy/final metadata inventories incomplete'):ok(!!reviewOf('reference_inventory'),'Known-reference inventory independently reviewed');
 checks.near_duplicates=nearReview?ok(unresolvedNear.length===0,'Every flagged near pair reviewed; no algorithmic independence claim',{unresolved:unresolvedNear}):state('미확인','Near-text and external semantic review missing');
 for(const kind of ['provenance','semantic_families','independence'])checks[kind]=reviewOf(kind)?state('충족','Human auditor approval bound to current scope'):state('미확인','Independent review absent/stale/blocked');
 const freezeErrors=d.freeze===null?[]:schemaErrors(d.freeze,schemas.freeze);const frozen=d.freeze!==null&&freezeErrors.length===0&&d.freeze.content_sha256===contentHash(d)&&human(d.freeze.created_by,'auditor');
 checks.freeze=frozen?state('충족','Snapshot content hash current'):state(d.freeze===null?'미충족':'미충족','No valid current freeze snapshot');
 const final=d.governance.final;const custodial=human(final.custodian_id,'custodian')&&![d.governance.slot_A,d.governance.slot_B].includes(final.custodian_id)&&final.access_separated&&!!final.evidence_ref&&final.independent_source_attestation&&!!final.metadata_manifest_ref;
 return {schema_version:1,scope_sha256:scope,content_sha256:contentHash(d),ready_for_offline_evaluation:Object.values(checks).every(x=>x.status==='충족'),checks,errors,warnings,counts:count,condition_intersections:intersections,duplicate_groups:duplicateGroups,components,crossings,near_pairs:near,disagreements,eligible_case_ids:resolved.map(r=>r.case.id),final:{ready:false,administrator_and_access:state(custodial?'충족':'미확인',custodial?'Metadata evidence declared; not a final-data verification':'Independent custodian/access/source evidence missing'),status:'미확인',reason:'This development intake tool never opens or validates final contents; custodian must issue separate final readiness.'}};
}
