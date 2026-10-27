import {strictJSON,fail} from './strict-json.mjs';

const code=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/u.test(value)?value:'SAVED_REVIEW_FAILED';
const statuses=new Set(['READY','ACTION_REQUIRED','CLARIFICATION_REQUIRED','BLOCKED','ABORTED','FAILED','UNCERTAIN','CANCELLED']);

// Read the classification hint from hash-verified saved bytes, not the current
// original's classification. The core still validates the complete envelope,
// body/notice hashes and this classification before a review can be accepted.
export function storedClassification(content,format){
  let metadata;
  if(format==='json')metadata=strictJSON(content);
  else{
    const pattern=format==='md'?/\n\n<!-- DIANA-COMMON-V([0-9]+) /gu:format==='txt'?/\n\n\[DIANA-COMMON-V([0-9]+) /gu:null;
    if(!pattern)fail('UNSUPPORTED_FORMAT');
    const match=[...content.matchAll(pattern)].at(-1),ending=format==='md'?' -->\n':']\n';
    if(!match||!['1','2'].includes(match[1])||!content.endsWith(ending))fail('INVALID_DOCUMENT_ENVELOPE');
    metadata=strictJSON(content.slice(match.index+match[0].length,-ending.length));
    if(metadata?.schema_version!==Number(match[1])||Object.hasOwn(metadata,'body'))fail('INVALID_DOCUMENT_ENVELOPE');
  }
  if(!metadata||!['synthetic','internal'].includes(metadata.classification))fail('INVALID_CLASSIFICATION');
  return metadata.classification;
}

export function reviewFailure(error){
  return{status:'FAILED',reason:code(error?.code),coreStatus:statuses.has(error?.coreStatus)?error.coreStatus:null};
}

export function assertCompletedCoreReview(plan,requestId){
  const normal=plan?.schema_version===1&&plan.request_id===requestId&&plan.reason==='REVIEW_RESULT'&&
    ['READY','ACTION_REQUIRED'].includes(plan.status)&&Array.isArray(plan.items)&&plan.items.length>0&&plan.items.length<=32&&
    plan.items.every(i=>i&&typeof i.item_id==='string'&&['SATISFIED','MISSING_WITH_EVIDENCE','MISSING_NO_EVIDENCE','NEEDS_CONFIRMATION'].includes(i.status))&&
    typeof plan.expected_body==='string'&&typeof plan.review_complete==='boolean'&&Array.isArray(plan.unresolved)&&
    plan.review_complete===plan.items.every(i=>i.status==='SATISFIED')&&plan.saved===false;
  if(normal)return;
  const reason=plan?.reason&&plan.reason!=='REVIEW_RESULT'?code(plan.reason):'CORE_RESPONSE_INVALID';
  throw Object.assign(new Error('SAVED_REVIEW_FAILED'),{code:reason,coreStatus:statuses.has(plan?.status)?plan.status:null});
}
