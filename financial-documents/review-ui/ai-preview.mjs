const formats=new Set(['md','txt','json']);
const intentLabels={checklist_review:'문서 검토를 요청함',patch:'문서 보완을 요청함',convert:'형식 변환을 요청함',save:'업무 저장을 요청함',export:'내보내기를 요청함',cancel:'취소로 해석함',question:'질문·설명으로 해석함',mixed:'복합 요청으로 해석함',unknown:'판단하지 못함'};
const statusLabels={ready:'구조상 검토 제안 가능',needs_clarification:'추가 확인 필요',unsupported:'지원 범위 밖',cancel_requested:'취소 의도로 해석'};
const fieldLabels={request:'요청 의도',target_doc:'대상',source_ids:'근거',guideline_id:'지침',format:'형식'};
const issueLabels={missing:'미지정',ambiguous:'모호함',unavailable:'후보에서 찾지 못함',unsupported:'지원 범위 밖',non_action:'작업 요청이 아님',cancel:'취소'};

/** Only the validated assembled output can become a user-editable draft. */
export function suggestedConfirmation(response,documents){
 const o=response?.output,contract=response?.contract,op=contract?.operation;
 if(response?.applicable!==true||contract?.status!=='VALIDATED'||o?.status!=='ready'||o?.intent!=='checklist_review'||!Array.isArray(o.issues)||o.issues.length||op?.action!=='checklist_review')return null;
 if(!o.target_doc?.id||!o.guideline_id?.id||!Array.isArray(o.source_ids)||!o.source_ids.length||o.source_ids.length>16||!formats.has(o.format?.value))return null;
 const ids=o.source_ids.map(b=>b?.id),all=[o.target_doc.id,...ids,o.guideline_id.id];
 if(all.some(id=>typeof id!=='string'||!id)||new Set(all).size!==all.length||op.target_doc!==o.target_doc.id||op.guideline_id!==o.guideline_id.id||op.format!==o.format.value||!Array.isArray(op.source_ids)||JSON.stringify(op.source_ids)!==JSON.stringify(ids)||!Array.isArray(op.item_ids)||op.item_ids.length)return null;
 const allowed=(id,role)=>documents.some(d=>d.id===id&&d.roles?.includes(role));
 if(!allowed(o.target_doc.id,'review')||!allowed(o.guideline_id.id,'guideline')||ids.some(id=>!allowed(id,'source')))return null;
 return{intent:'perform',target:{state:'selected',ids:[o.target_doc.id]},sources:{state:'selected',ids},guideline:{state:'selected',ids:[o.guideline_id.id]},format:{state:'selected',value:o.format.value}};
}

export function interpretationSummary(output,documents=[]){
 const name=b=>b?.id?(documents.find(d=>d.id===b.id)?.display_name??b.id)+' · '+b.id:'미지정';
 return[
  ['수행 판단',statusLabels[output?.status]??'응답 확인 필요'],['요청 종류',intentLabels[output?.intent]??'미확인'],
  ['대상',name(output?.target_doc)],['근거',Array.isArray(output?.source_ids)&&output.source_ids.length?output.source_ids.map(name).join('\n'):'선택 없음'],
  ['지침',name(output?.guideline_id)],['형식',formats.has(output?.format?.value)?output.format.value.toUpperCase()+' · '+(output.format.origin==='context'?'현재 확정 형식':'요청문 언급'):'미지정'],
  ['확인 필요',Array.isArray(output?.issues)&&output.issues.length?output.issues.map(i=>(fieldLabels[i.field]??i.field)+': '+(issueLabels[i.code]??i.code)).join('\n'):'표시된 issue 없음 · 의미 정답을 보증하지 않음']
 ];
}

/** A result belongs to one exact editor revision, including manual selection edits. */
export function previewRevision(){let revision=0,value=null;return{invalidate(){revision++;value=null;},capture(){return revision;},accept(at,result){if(at!==revision)return false;value=result;return true;},get value(){return value;}};}

export function mountAiPreview({api,getInput,getConfirmation,onApply,invalidateConfirmation}){
 const el=document.createElement('section');el.className='local-record-review';el.innerHTML=`<label><input id="ai-enabled" type="checkbox"> 실험용 로컬 AI 해석 (기본 꺼짐)</label><p>연구 모델은 학습·개발 성능 기준에 미달했습니다. 틀린 제안이 가능하며, 구조 검사 통과도 뜻을 정확히 이해했다는 보장이 아닙니다. 직접 확인해 주세요.</p><button type="button" id="ai-infer" disabled>AI 해석 보기</button><button type="button" id="ai-cancel" hidden>추론 취소</button><p id="ai-status" role="status"></p><div id="ai-output"></div><button type="button" id="ai-apply" hidden>선택란에 적용</button><details><summary>원시 head 진단 · 정상 제안 아님</summary><p>점수는 보정되지 않은 모델 출력값이며 정답 확률이 아닙니다.</p><pre id="ai-raw"></pre></details>`;document.getElementById('rr-form').after(el);
 const $=id=>el.querySelector('#'+id),gate=previewRevision();let running=false,current=null,latestId=null;
 const status=s=>$('ai-status').textContent=s;
 const cancel=()=>{if(latestId)void api({action:'ai-cancel',predictionId:latestId}).catch(()=>{});gate.invalidate();current=null;$('ai-apply').hidden=true;$('ai-output').replaceChildren();$('ai-raw').textContent='';};
 function changed(){if(latestId){const x=getInput();if(x)void api({action:'ai-note',recordId:x.recordId,predictionId:latestId,phase:'edited',request:x.request,confirmation:getConfirmation()}).catch(()=>{});}cancel();status('입력·선택이 바뀌었습니다. 필요한 경우 다시 AI 해석 보기를 누르세요.');}
 $('ai-enabled').onchange=()=>{cancel();$('ai-infer').disabled=!$('ai-enabled').checked||running;status('자동 추론하지 않습니다. 직접 버튼을 눌러 주세요.');};$('ai-cancel').onclick=()=>{cancel();status('추론 취소를 요청했습니다. 수동 선택은 계속 사용할 수 있습니다.');};
 $('ai-infer').onclick=async()=>{
  if(running||!$('ai-enabled').checked)return;const x=getInput();if(!x||!x.request.trim()){status('새 요청문을 먼저 작성해 주세요.');return;}
  cancel();latestId=crypto.randomUUID();const predictionId=latestId,at=gate.capture();running=true;$('ai-infer').disabled=true;$('ai-cancel').hidden=false;status('고정 Byte 모델로 해석 중입니다. 문서 검토는 실행하지 않습니다.');
  try{await api({action:'ai-note',recordId:x.recordId,predictionId,phase:'before_inference',request:x.request,confirmation:getConfirmation()});const r=await api({action:'ai-infer',predictionId,recordId:x.recordId,request:x.request,confirmedFormat:x.confirmedFormat,contextHash:x.contextHash});if(!gate.accept(at,r))return;current=r;await api({action:'ai-note',recordId:x.recordId,predictionId,phase:'viewed',request:x.request,confirmation:getConfirmation()});if(at!==gate.capture())return;
   for(const [label,value]of interpretationSummary(r.output,x.documents)){const p=document.createElement('p');p.textContent=label+': '+value;$('ai-output').append(p);}
   $('ai-raw').textContent=JSON.stringify({model:r.model,raw_heads:r.raw_heads,assembled:r.output,contract:r.contract,diagnostic:r.diagnostic},null,2);
   $('ai-apply').hidden=!suggestedConfirmation(r,x.documents);status(r.applicable?'구조 검사 통과 · 의미 정답 미확인. 기존 수동 선택은 변경하지 않았습니다.':'판단 보류 또는 지원하지 않는 결과입니다. 수동 선택을 사용해 주세요.');
  }catch(e){if(at===gate.capture())status('실제 추론을 완료하지 못했습니다: '+(e.code||'연결 오류')+'. 다른 모델이나 가짜 제안으로 대체하지 않습니다.');}
  finally{running=false;$('ai-cancel').hidden=true;$('ai-infer').disabled=!$('ai-enabled').checked;}
 };
 $('ai-apply').onclick=async()=>{
  const x=getInput(),r=current,at=gate.capture();if(!r||!x)return;
  const draft=suggestedConfirmation(r,x.documents);if(!draft)return;
  const isCurrent=()=>at===gate.capture()&&current===r;
  try{
   await api({action:'ai-apply',predictionId:r.predictionId,recordId:x.recordId,request:x.request,confirmedFormat:x.confirmedFormat,contextHash:x.contextHash});
   // Manual edits, mode changes and resets also invalidate in-flight applies.
   if(!isCurrent())return;
   onApply(draft);invalidateConfirmation();
   await api({action:'ai-note',recordId:x.recordId,predictionId:r.predictionId,phase:'applied',request:x.request,confirmation:getConfirmation()});
   if(!isCurrent())return;
   $('ai-apply').hidden=true;status('선택란에 초안만 적용했습니다. 확인·수정 후 기록을 저장하고, 상세에서 별도로 검토 시작을 눌러 주세요.');
  }catch(e){
   if(!isCurrent())return;
   changed();status('제안이 만료됐거나 입력이 바뀌었습니다. 수동 선택을 확인해 주세요.');
  }
 };
 return{changed,reset(){cancel();latestId=null;$('ai-enabled').checked=false;$('ai-infer').disabled=true;status('');},setVisible(value){el.hidden=!value;}};
}
