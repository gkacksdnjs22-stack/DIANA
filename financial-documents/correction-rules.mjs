import {validateGold,validateInput} from '../experiments/financial-review/evaluation-intake-v1/core.mjs';
import {schemaErrors,schemas} from '../experiments/financial-review/evaluation-intake-v1/schema.mjs';
import {mentionSpans} from './review-ui/annotation-spans.mjs';
export const confirmationFields=['intent','arguments','spans','issues'];
export function checkCorrection(input,draft){
 const inputErrors=validateInput(input),shape=[...(draft.output?schemaErrors(draft.output,schemas.annotations.properties.output):['주석 미작성']),...schemaErrors(draft.evidence,schemas.annotations.properties.issue_evidence)];
 let correspondence=[];if(!shape.length){try{correspondence=validateGold(draft.output,input,draft.evidence);}catch{correspondence=['문제의 근거 형식이 올바르지 않습니다.'];}}
 const supported=[];if(!shape.length&&draft.output.intent==='checklist_review'){
  for(const b of [draft.output.target_doc,...draft.output.source_ids,draft.output.guideline_id].filter(Boolean)){const c=input.candidates.find(c=>c.id===b.id);if(!c||!mentionSpans(input.request,[c.id,c.display_name,...c.aliases]).some(s=>s.start===b.span.start&&s.end===b.span.end))supported.push('모델 입력에서 찾을 수 없는 문서 언급: '+b.id);}
  const f=draft.output.format;if(f?.origin==='request'&&!mentionSpans(input.request,{md:['md','markdown','마크다운'],txt:['txt','text','텍스트'],json:['json']}[f.value]||[]).some(s=>s.start===f.span?.start&&s.end===f.span?.end))supported.push('모델이 지원하지 않는 형식 언급');
 }
 const confirmed=confirmationFields.every(k=>draft.confirmations[k]===true);
 return{schema:{ok:!shape.length&&!inputErrors.length,errors:[...inputErrors,...shape]},correspondence:{ok:!correspondence.length,errors:correspondence},annotation:{ok:!shape.length&&!correspondence.length},self_review:{ok:confirmed,semantic_correctness:'본인 확인이며 의미 정답을 기계적으로 보증하지 않음'},model_support:{ok:!supported.length&&!shape.length,errors:supported},valid:!shape.length&&!inputErrors.length&&!correspondence.length&&!supported.length&&confirmed,argument_supervision:draft.output?.intent==='checklist_review'?'review':'unannotated'};
}
