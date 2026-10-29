// Experimental review contract only. This module never interprets language,
// reads documents, grants permission, loads a model or selects an argument.
import {strictJSON,keys,validId} from '../../financial-documents/strict-json.mjs';
import {explicitOperation} from '../../financial-documents/operation.mjs';
export const INTENTS=Object.freeze(['checklist_review','patch','convert','save','export','cancel','question','mixed','unknown']);
export const FIELDS=Object.freeze(['target_doc','source_ids','guideline_id','format','request']);
const ROLES=['review','source','guideline'],FORMATS=['md','txt','json'];
const normalize=s=>s.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('en');
const text=(s,n)=>typeof s==='string'&&!!s.trim()&&s.length<=n&&!/[\x00-\x1f\x7f]/u.test(s);
const demand=(condition,code='INVALID_INTERPRETATION')=>{if(!condition)throw new Error(code);};
const message={target_doc:'허용 후보에서 대상 검토서를 지정해 주세요.',source_ids:'허용 후보에서 근거 자료를 지정해 주세요.',guideline_id:'허용 후보에서 지침을 지정해 주세요.',format:'검토 결과의 표시 형식을 확인해 주세요.',request:'검토 요청 한 가지를 명확히 적어 주세요.'};
const stop=(reason,fields=['request'],status='CLARIFICATION_REQUIRED')=>({status,reason,fields:[...new Set(fields)],message:[...new Set(fields)].map(f=>message[f]).join(' '),prepared:false});

/** allowed comes ONLY from FinancialDocuments.candidates(), after ACL filtering.
 * catalog is trusted operator-authored metadata, not document body or user JSON.
 * Unknown catalog entries are never serialized, including their aliases. */
export function buildModelInput(request,allowed,catalog,{confirmedFormat=null}={}){
  demand(typeof request==='string'&&request.trim()&&request.length<=2000&&!/[\x00-\x08\x0b-\x1f\x7f]/u.test(request),'INVALID_REQUEST');
  demand(Array.isArray(allowed)&&Array.isArray(catalog)&&catalog.length<=100,'INVALID_CATALOG');
  demand(confirmedFormat===null||FORMATS.includes(confirmedFormat),'INVALID_FORMAT_CONTEXT');
  const allowedIds=new Set(allowed.map(c=>c.id)),ids=new Set(),candidates=[];
  for(const c of catalog){
    keys(c,['id','display_name','aliases','roles']);
    demand(validId(c.id)&&!ids.has(c.id)&&text(c.display_name,120)&&Array.isArray(c.aliases)&&c.aliases.length<=16&&c.aliases.every(s=>text(s,120))&&
      Array.isArray(c.roles)&&c.roles.length>0&&new Set(c.roles).size===c.roles.length&&c.roles.every(r=>ROLES.includes(r)),'INVALID_CATALOG');
    ids.add(c.id);
    if(allowedIds.has(c.id))candidates.push(structuredClone(c));
  }
  return {schema_version:1,request,context:{allowed_action:'checklist_review',confirmed_format:confirmedFormat},candidates};
}
function span(value,request){
  keys(value,['start','end']);demand(Number.isInteger(value.start)&&Number.isInteger(value.end)&&value.start>=0&&value.end>value.start&&value.end<=request.length);
  return request.slice(value.start,value.end);
}
function bindingShape(value,request){if(value===null)return;keys(value,['id','span']);demand(validId(value.id));span(value.span,request);}
function parse(raw,input){
  demand(typeof raw==='string'&&Buffer.byteLength(raw)<=16384);
  const o=strictJSON(raw);keys(o,['schema_version','status','intent','target_doc','source_ids','guideline_id','format','issues','scores']);
  demand(o.schema_version===1&&['ready','needs_clarification','unsupported','cancel_requested'].includes(o.status)&&INTENTS.includes(o.intent));
  bindingShape(o.target_doc,input.request);bindingShape(o.guideline_id,input.request);
  demand(Array.isArray(o.source_ids)&&o.source_ids.length<=16);for(const b of o.source_ids){demand(b!==null);bindingShape(b,input.request);}
  if(o.format!==null){keys(o.format,['value','origin','span']);demand(FORMATS.includes(o.format.value)&&['context','request'].includes(o.format.origin));if(o.format.origin==='context')demand(o.format.span===null);else span(o.format.span,input.request);}
  demand(Array.isArray(o.issues)&&o.issues.length<=8);for(const issue of o.issues){keys(issue,['field','code']);demand(FIELDS.includes(issue.field)&&['missing','ambiguous','unavailable','unsupported','non_action','cancel'].includes(issue.code));}
  if(o.scores!==null){keys(o.scores,['kind','intent','arguments']);demand(o.scores.kind==='uncalibrated_probability'&&[o.scores.intent,o.scores.arguments].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1));}
  return o;
}
function ground(b,role,input){
  const c=input.candidates.find(c=>c.id===b.id);
  if(!c)return 'CANDIDATE_UNAVAILABLE';
  if(!c.roles.includes(role))return 'CANDIDATE_ROLE_MISMATCH';
  const mention=normalize(span(b.span,input.request));
  // An explicit unique ID is authoritative. Otherwise every visible matching
  // alias participates; the model cannot pick one duplicate name by confidence.
  const exactId=input.candidates.find(x=>normalize(x.id)===mention);
  const matches=exactId?[exactId]:input.candidates.filter(x=>[x.display_name,...x.aliases].some(n=>normalize(n)===mention));
  if(matches.length>1)return 'AMBIGUOUS_CANDIDATE_NAME';
  if(matches.length!==1||matches[0].id!==b.id)return 'UNGROUNDED_CANDIDATE_REFERENCE';
  return null;
}
export function validateInterpretation(raw,input){
  let o;try{o=parse(raw,input);}catch{return stop('INVALID_INTERPRETATION');}
  if(o.status==='cancel_requested')return o.intent==='cancel'?{...stop('NATURAL_LANGUAGE_CANCEL_NOT_CONNECTED',[],'NOT_EXECUTED'),message:'자연어 취소는 연결되지 않았습니다. 기존 금융 CLI의 /cancel을 사용하세요.'}:stop('INCONSISTENT_INTERPRETATION');
  if(o.status==='unsupported')return stop('UNSUPPORTED_REVIEW_REQUEST',[],'UNSUPPORTED');
  if(o.status==='needs_clarification')return stop('INTERPRETATION_NEEDS_CLARIFICATION',o.issues.length?o.issues.map(i=>i.field):['request']);
  if(o.intent!=='checklist_review')return stop('REVIEW_ONLY',[],'UNSUPPORTED');
  if(o.issues.length)return stop('UNRESOLVED_FIELDS',o.issues.map(i=>i.field));
  const missing=[];if(!o.target_doc)missing.push('target_doc');if(!o.source_ids.length)missing.push('source_ids');if(!o.guideline_id)missing.push('guideline_id');if(!o.format)missing.push('format');
  if(missing.length)return stop('MISSING_REQUIRED_FIELDS',missing);
  for(const [field,role,list]of [['target_doc','review',[o.target_doc]],['source_ids','source',o.source_ids],['guideline_id','guideline',[o.guideline_id]]])
    for(const b of list){const error=ground(b,role,input);if(error)return stop(error,[field]);}
  const sources=o.source_ids.map(b=>b.id);
  if(new Set(sources).size!==sources.length)return stop('DUPLICATE_SOURCE_IDS',['source_ids']);
  if(o.target_doc.id===o.guideline_id.id||sources.includes(o.target_doc.id)||sources.includes(o.guideline_id.id))return stop('OVERLAPPING_DOCUMENT_ROLES',['target_doc','source_ids','guideline_id']);
  if(o.format.origin==='context'){
    if(input.context.confirmed_format!==o.format.value)return stop('UNCONFIRMED_FORMAT',['format']);
  }else{
    const names={md:['md','markdown','마크다운'],txt:['txt','text','텍스트'],json:['json']};
    if(!names[o.format.value].includes(normalize(span(o.format.span,input.request))))return stop('UNGROUNDED_FORMAT',['format']);
    if(input.context.confirmed_format!==null&&input.context.confirmed_format!==o.format.value)return stop('FORMAT_CONTEXT_CONFLICT',['format']);
  }
  // Fixed empty item_ids is review contract assembly, not a learned prediction.
  const operation=explicitOperation({action:'checklist_review',target_doc:o.target_doc.id,source_ids:sources,guideline_id:o.guideline_id.id,item_ids:[],format:o.format.value});
  return {status:'VALIDATED',reason:'STRUCTURE_AND_BINDINGS_VALID',prepared:false,operation,scores:o.scores,
    semanticCorrectness:'unverified; structural validation does not establish intent/role meaning',scorePolicy:'No calibration or threshold selected. Scores grant no capability.'};
}
