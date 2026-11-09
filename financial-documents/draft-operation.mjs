import {keys,fail,validId} from './strict-json.mjs';
// A separate explicit contract; never accepted by model interpretation.
export function draftOperation(input){
 keys(input,['action','source_ids','guideline_id','format','template_version','user_input']);
 if(input.action!=='draft_review'||input.format!=='md'||input.template_version!=='review-draft-v1'||!validId(input.guideline_id)||!Array.isArray(input.source_ids)||input.source_ids.length>16||input.source_ids.some(x=>!validId(x))||new Set([...input.source_ids,input.guideline_id]).size!==input.source_ids.length+1)fail('INVALID_DRAFT_OPERATION');
 keys(input.user_input,['title','investment','memo']);
 for(const [key,max]of [['title',120],['investment',300],['memo',2000]]){const v=input.user_input[key];if(typeof v!=='string'||v.length>max||(key!=='memo'&&!v.trim())||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(v))fail('INVALID_DRAFT_INPUT');}
 return structuredClone(input);
}
