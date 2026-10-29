// Draft2020-12 JSON schemas; intentionally no model/runtime dependency.
const str=(extra={})=>({type:'string',minLength:1,...extra}), en=values=>({type:'string',enum:values});
const arr=(items,min=0)=>({type:'array',items,minItems:min});
const obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const nullable=s=>({anyOf:[s,{type:'null'}]});
const id=str({pattern:'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'}), hash=str({pattern:'^[a-f0-9]{64}$'}), time=str({format:'date-time'}), bool={type:'boolean'};
export const fields=['target_doc','source_ids','guideline_id','format','request'];
export const codes=['missing','unavailable','ambiguous','unsupported','non_action','cancel'];
export const phenomena=['role_reversal','mention_order','quoted_adopted','quoted_explanation','explicit_negation','scope_negation','cancel','cancel_mention','mixed'];
export const span=obj({start:{type:'integer',minimum:0},end:{type:'integer',minimum:1}});
const binding=obj({id,span}), candidate=obj({id,display_name:str({maxLength:120}),aliases:{...arr(str({maxLength:120})),maxItems:16},roles:{...arr(en(['review','source','guideline']),1),uniqueItems:true}});
export const input=obj({schema_version:{const:1},request:str({maxLength:2000}),context:obj({allowed_action:{const:'checklist_review'},confirmed_format:nullable(en(['md','txt','json']))}),candidates:{...arr(candidate),maxItems:100}});
export const output=obj({schema_version:{const:1},status:en(['ready','needs_clarification','unsupported','cancel_requested']),intent:en(['checklist_review','patch','convert','save','export','cancel','question','mixed','unknown']),target_doc:nullable(binding),source_ids:{...arr(binding),maxItems:16},guideline_id:nullable(binding),format:nullable(obj({value:en(['md','txt','json']),origin:en(['context','request']),span:nullable(span)})),issues:{...arr(obj({field:en(fields),code:en(codes)})),maxItems:8},scores:{type:'null'}});
export const schemas={
 participants:arr(obj({id,kind:en(['human','ai','organization']),display_name:str(),roles:arr(en(['author','annotator','adjudicator','auditor','custodian']),1),qualification:str(),independence_statement:str()})),
 allocations:arr(obj({id,assigned_at:time,assigned_by:id,split:en(['legacy_train','legacy_development','new_dev','new_final']),source_task_id:id,company_corpus_id:id,document_lineage_ids:arr(id,1),family_id:id,family_rationale:str(),template_batch_id:nullable(id)})),
 cases:obj({id,purpose:en(['evaluation','fixture']),allocation_id:id,allocation_sha256:hash,split:{const:'new_dev'},created_at:time,parent_ids:arr(id),provenance:obj({origin:en(['real','synthetic','mixed','fixture']),source_ref:str(),source_version:str(),source_created_at:time,collected_at:time,author_ids:arr(id,1),usage:obj({status:en(['granted','pending','denied']),basis:str(),evidence_ref:str()}),transformations:arr(str()),variant_created_at:nullable(time)}),stratum:en(['primary','extension']),stratum_rationale:str(),condition_tags:obj({phenomena:{...arr(en(phenomena)),uniqueItems:true},permission_condition:en(['in_scope','out_of_list','role_disallowed','absent_candidates'])}),input}),
 annotations:obj({case_id:id,annotator_id:id,input_sha256:hash,submitted_at:time,blind:obj({other_annotations_unseen:bool,model_predictions_unseen:bool,not_author:bool}),argument_supervision:en(['review','unannotated']),output,rationale:obj({status:str(),intent:str(),roles:str(),issues:str(),format:str()}),issue_evidence:arr(obj({field:en(fields),code:en(codes),kind:en(['absence','out_of_list','role_disallowed','ambiguous_name','format_conflict','empty_candidates','semantic']),span:nullable(span),candidate_ids:arr(id),explanation:str()}))}),
 adjudications:obj({case_id:id,reviewer_id:id,input_sha256:hash,annotation_A_sha256:hash,annotation_B_sha256:hash,decided_at:time,decision:en(['accept_A','accept_B','revised']),output,rationale:str(),issue_evidence:arr(obj({field:en(fields),code:en(codes),kind:en(['absence','out_of_list','role_disallowed','ambiguous_name','format_conflict','empty_candidates','semantic']),span:nullable(span),candidate_ids:arr(id),explanation:str()}))}),
 references:arr(obj({id,split:en(['legacy_train','legacy_development','new_final']),source_task_id:id,company_corpus_id:id,document_lineage_ids:arr(id,1),family_id:id,template_batch_id:nullable(id),parent_ids:arr(id),candidate_ids:arr(id),input_sha256:hash,request_sha256:hash,masked_request_sha256:hash,metadata_only:{const:true}})),
 reviews:arr(obj({kind:en(['provenance','semantic_families','independence','near_duplicates','reference_inventory']),reviewer_id:id,scope_sha256:hash,completed_at:time,decision:en(['approved','blocked']),notes:str(),pair_decisions:arr(obj({pair_id:str(),decision:en(['same_lineage','distinct_with_reason']),reason:str()}))})),
 governance:obj({schema_version:{const:1},slot_A:nullable(id),slot_B:nullable(id),packets_access_separated:bool,separation_evidence_ref:nullable(str()),reference_inventory:obj({legacy_train_complete:bool,legacy_development_complete:bool,new_final_allocation_metadata_complete:bool}),final:obj({custodian_id:nullable(id),access_separated:bool,evidence_ref:nullable(str()),independent_source_attestation:bool,metadata_manifest_ref:nullable(str())})}),
 freeze:obj({schema_version:{const:1},content_sha256:hash,created_at:time,created_by:id,files:{type:'object',additionalProperties:hash}})
};
schemas.cases.properties.provenance.properties.original_text_sha256=hash;
schemas.cases.properties.provenance.required.push('original_text_sha256');
schemas.adjudications.properties.model_predictions_unseen=bool;
schemas.adjudications.required.push('model_predictions_unseen');
export const schemaDocument={$schema:'https://json-schema.org/draft/2020-12/schema',title:'Financial review evaluation intake v1',...schemas.cases,$defs:{input,output,...schemas}};
export function schemaErrors(value,s,path='$'){
 const errors=[];
 if(s.anyOf){if(!s.anyOf.some(x=>schemaErrors(value,x,path).length===0))errors.push(path+': no anyOf branch');return errors;}
 if('const' in s&&value!==s.const)errors.push(path+': const');
 if(s.enum&&!s.enum.includes(value))errors.push(path+': enum');
 const type=value===null?'null':Array.isArray(value)?'array':typeof value;
 if(s.type&&!(s.type==='integer'?Number.isInteger(value):s.type===type)){errors.push(path+': type '+s.type);return errors;}
 if(type==='string'){
  if(s.minLength&&value.length<s.minLength||s.maxLength&&value.length>s.maxLength)errors.push(path+': length');
  if(s.pattern&&!new RegExp(s.pattern,'u').test(value))errors.push(path+': pattern');
  if(s.format==='date-time'&&(!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value))))errors.push(path+': date-time');
 }
 if(type==='number'&&(!Number.isFinite(value)||s.minimum!==undefined&&value<s.minimum))errors.push(path+': numeric bounds');
 if(type==='array'){
  if(s.minItems&&value.length<s.minItems||s.maxItems&&value.length>s.maxItems)errors.push(path+': item count');
  if(s.uniqueItems&&new Set(value.map(x=>JSON.stringify(x))).size!==value.length)errors.push(path+': duplicate items');
  value.forEach((x,i)=>errors.push(...schemaErrors(x,s.items,path+'['+i+']')));
 }
 if(type==='object'){
  for(const k of s.required??[])if(!Object.hasOwn(value,k))errors.push(path+'.'+k+': required');
  for(const [k,x] of Object.entries(value)){
   const child=s.properties?.[k];if(child)errors.push(...schemaErrors(x,child,path+'.'+k));else if(s.additionalProperties===false)errors.push(path+'.'+k+': unknown');else if(typeof s.additionalProperties==='object')errors.push(...schemaErrors(x,s.additionalProperties,path+'.'+k));
  }
 }
 return errors;
}
