const resultStates=new Set(['SATISFIED','MISSING_WITH_EVIDENCE','MISSING_NO_EVIDENCE','NEEDS_CONFIRMATION']);
const judgments={SATISFIED:'충족',MISSING_WITH_EVIDENCE:'근거 있는 보완 필요',MISSING_NO_EVIDENCE:'근거 부족',NEEDS_CONFIRMATION:'추가 확인 필요'};
const diagnostics={
 LOCAL_REVIEW_BUSY:'기존 작업이 승인 대기·처리 중이거나 상태 보고가 미확인입니다. 해당 작업을 마친 뒤 다시 선택을 확인해 주세요.',
 RECORD_REVIEW_BUSY:'기존 작업이 승인 대기·처리 중이거나 상태 보고가 미확인입니다. 해당 작업을 마친 뒤 다시 선택을 확인해 주세요.',
 RECORD_REVIEW_POLICY_CHANGED:'현재 문서 권한 또는 등록 설정이 바뀌었습니다. PC 프로그램과 등록 상태를 확인하고 다시 선택해 주세요.',
 RECORD_REVIEW_SELECTION_REQUIRED:'현재 검토에 필요한 대상·근거·지침·형식을 직접 선택해 주세요. 없음·미확인 값은 자동으로 채우지 않습니다.',
 RECORD_REVIEW_UNAVAILABLE:'현재 PC에서 이 기록의 로컬 검토를 사용할 수 없습니다. 기록과 프로그램 상태를 확인해 주세요.',
 RECORD_REVIEW_DOCUMENT_MISSING:'선택한 문서를 현재 읽을 수 없습니다. 문서 존재와 등록 상태를 확인한 뒤 최신 후보에서 다시 선택해 주세요.',
 RECORD_REVIEW_DOCUMENT_DENIED:'현재 권한 또는 문서 접근 제한으로 선택한 문서를 읽을 수 없습니다. 허용 후보와 문서 등록 상태를 확인해 주세요.',
 LOCAL_REVIEW_RESULT_TOO_LARGE:'본문·근거를 포함한 검토 결과가 로컬 보관 한도 1.5MB를 초과했습니다. 완료로 처리하거나 결과를 잘라 저장하지 않았습니다. 검토 범위를 확인해 주세요.',
 LOCAL_POLICY_CHANGED:'현재 문서 권한 또는 설정이 바뀌었습니다. PC 프로그램과 등록 상태를 확인해 주세요.',
 POLICY_CHANGED:'현재 문서 권한 또는 설정이 바뀌었습니다. PC 프로그램과 등록 상태를 확인해 주세요.',
 ACCESS_DENIED:'현재 권한으로 선택한 문서를 사용할 수 없습니다. 허용 후보에서 다시 선택해 주세요.',
 CONTENT_CHANGED:'문서 내용·버전이 확인 시점 이후 변경됐습니다. 현재 선택을 다시 불러오고 확인해 주세요.',
 LOCAL_REVIEW_CHANGED:'현재 후보나 문서가 변경됐습니다. 현재 선택을 다시 불러오고 확인해 주세요.',
 RECORD_REVIEW_CHANGED:'현재 후보나 문서가 변경됐습니다. 현재 선택을 다시 불러오고 확인해 주세요.',
 RECORD_CONTEXT_CHANGED:'현재 후보나 설정이 변경됐습니다. 현재 선택을 다시 불러오고 확인해 주세요.',
 RECORD_REVIEW_EXPIRED:'검토 확인이 만료됐습니다. 현재 문서 상태를 다시 확인해 주세요.',
 RECORD_CONFIRMATION_EXPIRED:'검토 확인이 만료됐습니다. 현재 문서 상태를 다시 확인해 주세요.',
 DESKTOP_STOPPING:'PC 프로그램이 종료 중입니다. 진행 중 검토가 정리된 뒤 다음 실행에서 이력을 확인해 주세요.',
 CORE_RESPONSE_INVALID:'코어 응답이 정상 검토 결과 형식을 충족하지 못했습니다. 검토 완료로 처리하지 않았습니다.',
 RECORD_NOT_FOUND:'연결할 요청 기록을 찾을 수 없습니다. 저장 기록 목록을 다시 확인해 주세요.'
};

/** Raw user confirmation is only a draft. Never infer a document from text/name/order. */
export function draftReviewSelection(record,documents){
 const raw=record?.raw_user_confirmation;
 const allowed=(id,role)=>documents.some(d=>d.id===id&&d.roles.includes(role));
 const one=(field,role)=>raw?.[field]?.state==='selected'&&raw[field].ids.length===1&&allowed(raw[field].ids[0],role)?raw[field].ids[0]:'';
 return{action:'checklist_review',target_doc:one('target','review'),source_ids:raw?.sources?.state==='selected'?raw.sources.ids.filter(id=>allowed(id,'source')):[],guideline_id:one('guideline','guideline'),item_ids:[],format:raw?.format?.state==='selected'&&['md','txt','json'].includes(raw.format.value)?raw.format.value:''};
}

/** A finished execution is not enough: the actual core review must be structurally normal. */
export function reviewPresentation(execution){
 const review=execution?.review;
 const normal=execution?.state==='completed'&&execution.saved===false&&review?.reason==='REVIEW_RESULT'&&
  ['READY','ACTION_REQUIRED'].includes(review.status)&&review.saved===false&&Array.isArray(review.items)&&review.items.length>0&&
  review.items.every(item=>item&&resultStates.has(item.status))&&typeof review.body==='string'&&typeof review.reviewComplete==='boolean'&&
  review.reviewComplete===review.items.every(item=>item.status==='SATISFIED')&&Array.isArray(review.unresolved)&&Array.isArray(review.documents);
 if(normal)return{state:'completed',title:review.reviewComplete?'검토 완료 · 모든 항목 충족':'검토 완료 · 추가 확인 항목 있음',
  note:'문서 검토 결과입니다. 보완·변환·최종 승인·업무 파일 저장은 하지 않았습니다.',review};
 const diagnostic=execution?.diagnostic??{},code=typeof diagnostic.code==='string'&&/^[A-Z0-9_]+$/.test(diagnostic.code)?diagnostic.code:'CORE_RESPONSE_INVALID';
 if(['running','started','pending','uncertain'].includes(execution?.state))return{state:'uncertain',title:'검토 상태 확인 필요',note:'실행 상태를 확정하지 못했습니다. 같은 실행 ID의 결과를 확인하며 자동으로 다시 실행하지 않습니다.',code:diagnostic.code??null};
 return{state:'failed',title:'문서 검토를 완료하지 못했습니다.',note:diagnostics[code]||'현재 문서·권한·검토 지침과 진단 코드를 확인해 주세요. 오류를 빈 검토 결과로 표시하지 않습니다.',code,coreStatus:diagnostic.coreStatus??null};
}

export function mountLocalReview({api,message,getDetail}){
 const $=id=>document.getElementById(id),node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
 const open=node('button','이 선택으로 문서 검토');open.type='button';open.id='lr-open';$('rr-detail-text').before(open);
 const panel=node('section');panel.id='lr-panel';panel.hidden=true;panel.className='local-record-review';
 panel.innerHTML=`<h3>현재 선택으로 문서 검토 · checklist_review</h3>
 <p>요청문을 자동 해석하지 않습니다. 아래에서 직접 확인한 문서 선택으로 검토 코어를 실행합니다. 원래 기록과 해석은 변경하지 않습니다.</p>
 <p id="lr-record-link"></p><h4>사용자가 작성한 원문</h4><pre id="lr-request"></pre><p id="lr-original-note" class="lr-notice"></p>
 <details><summary>과거 기록과 현재 후보·설정</summary><pre id="lr-context"></pre></details>
 <form id="lr-form"><div class="field-pair"><label>현재 검토할 대상 문서<select id="lr-target" required></select></label><label>현재 검토 지침<select id="lr-guideline" required></select></label></div>
 <fieldset><legend>현재 근거 자료 · 한 개 이상 직접 확인</legend><div id="lr-sources" class="registration-choices"></div></fieldset>
 <label>검토 표시 형식<select id="lr-format" required><option value="">선택 필요 / 미확인</option><option value="md">MD</option><option value="txt">TXT</option><option value="json">JSON</option></select></label>
 <p id="lr-missing"></p><button type="submit" id="lr-preview">현재 문서 상태 확인</button><button type="button" id="lr-refresh" class="secondary">최신 후보 다시 불러오기</button></form>
 <section id="lr-confirm" hidden><h4>검토 시작 전 재확인</h4><p>이 동작은 checklist_review입니다. 문서 읽기와 검토 결과 확인만 수행합니다.</p><pre id="lr-preview-summary"></pre>
 <label><input type="checkbox" id="lr-consent"> 원래 기록과 별개로, 표시된 현재 대상·근거·지침·형식으로 문서 검토를 요청합니다.</label>
 <button type="button" id="lr-start" disabled>검토 시작</button></section>
 <p id="lr-status" role="status" aria-live="polite"></p><button type="button" id="lr-check" class="secondary" hidden>같은 실행 ID의 결과 확인</button>
 <section id="lr-result" hidden><h3 id="lr-result-title"></h3><p id="lr-result-note"></p><details id="lr-result-info"><summary>실행 정보·문서 버전</summary><pre id="lr-result-meta"></pre></details><div id="lr-items"></div>
 <h4 id="lr-unresolved-title" hidden>미해결 항목</h4><pre id="lr-unresolved" hidden></pre><details id="lr-body-section" hidden><summary>검토 내용</summary><pre id="lr-body"></pre></details>
 <details id="lr-documents-section" hidden><summary>실제로 읽은 원문·근거·지침</summary><div id="lr-documents"></div></details></section>
 <section><h4>이 기록의 로컬 검토 이력</h4><div id="lr-history"></div></section>`;
 $('rr-detail').after(panel);
 let record=null,context=null,preview=null,executionId=null,busy=false,generation=0;
 const status=text=>$('lr-status').textContent=text;
 function lock(value){
  for(const el of panel.querySelectorAll('input,select,button'))el.disabled=value;
  for(const id of ['rr-new','rr-list','rr-close','rr-edit','rr-delete','lr-open'])$(id).disabled=value;
  for(const el of $('rr-history').querySelectorAll('button'))el.disabled=value;
  if(!value)$('lr-start').disabled=!preview||!$('lr-consent').checked||!!executionId;
 }
 function invalidate(){generation++;preview=null;$('lr-consent').checked=false;$('lr-confirm').hidden=true;$('lr-start').disabled=true;}
 function reset(){if(busy)return;invalidate();executionId=null;record=null;context=null;panel.hidden=true;$('lr-result').hidden=true;$('lr-check').hidden=true;status('');}
 function option(select,value,label){const el=node('option',label);el.value=value;select.append(el);}
 function choices(documents,draft){
  for(const [id,role,value]of [['lr-target','review',draft.target_doc],['lr-guideline','guideline',draft.guideline_id]]){const select=$(id);select.replaceChildren();option(select,'','선택 필요 / 없음·미확인');for(const d of documents.filter(d=>d.roles.includes(role)))option(select,d.id,d.display_name+' · '+d.id);select.value=value;}
  $('lr-sources').replaceChildren();for(const doc of documents.filter(d=>d.roles.includes('source'))){const label=node('label'),checkbox=node('input');checkbox.type='checkbox';checkbox.value=doc.id;checkbox.checked=draft.source_ids.includes(doc.id);label.append(checkbox,node('span',doc.display_name+' · '+doc.id));$('lr-sources').append(label);}
  $('lr-format').value=draft.format;
  const raw=record.raw_user_confirmation,notes=[];
  for(const [label,field,role]of [['대상','target','review'],['근거','sources','source'],['지침','guideline','guideline']]){
   if(raw?.[field]?.state!=='selected')notes.push(label+'은 기록에서 '+(raw?.[field]?.state==='none'?'없음':'미확인')+'입니다.');
   else if(raw[field].ids.some(id=>!documents.some(d=>d.id===id&&d.roles.includes(role))))notes.push(label+'의 과거 선택 중 현재 허용 후보에 없는 문서가 있습니다.');
  }
  if(raw?.format?.state!=='selected')notes.push('형식은 기록에서 '+(raw?.format?.state==='none'?'없음':'미확인')+'입니다.');
  $('lr-missing').textContent=notes.join(' ')+' 필요한 값은 아래 검토용 선택에서 직접 보완해 주세요.';
 }
 function selection(){
  const s={action:'checklist_review',target_doc:$('lr-target').value,source_ids:[...$('lr-sources').querySelectorAll('input:checked')].map(el=>el.value),guideline_id:$('lr-guideline').value,item_ids:[],format:$('lr-format').value};
  if(!s.target_doc||!s.guideline_id||!s.source_ids.length||!s.format)throw Error('검토에 필요한 대상·근거 한 개 이상·지침·형식을 직접 선택해 주세요. 없음·미확인 값을 추측하지 않습니다.');
  if(new Set([s.target_doc,...s.source_ids,s.guideline_id]).size!==s.source_ids.length+2)throw Error('대상·근거·지침에 같은 문서를 중복 지정할 수 없습니다. 역할을 다시 확인해 주세요.');
  return s;
 }
 function explain(error){const code=error?.code;return(diagnostics[code]||error?.message||'검토 요청 처리에 실패했습니다.')+(code?' ('+code+')':'');}
 async function work(fn){if(busy)return;busy=true;lock(true);try{await fn();}catch(error){status(explain(error));message(explain(error));}finally{busy=false;lock(false);}}
 function historyRows(rows){$('lr-history').replaceChildren();if(!rows?.length){$('lr-history').append(node('p','아직 이 기록에서 실행한 로컬 검토가 없습니다.'));return;}for(const item of rows){const id=item.execution_id??item.executionId;const button=node('button',`v${item.record_version??'?'} · ${item.state??'상태 확인'} · ${item.started_at??item.created_at??''} · ${id}`);button.type='button';button.className='secondary lr-history-item';button.onclick=()=>work(async()=>{executionId=id;preview=null;$('lr-confirm').hidden=true;await readExecution();});$('lr-history').append(button);}}
 async function load(){
  const detail=getDetail();if(!detail?.versions?.length)throw Error('먼저 저장된 요청 기록의 상세를 열어 주세요.');
  invalidate();executionId=null;context=null;$('lr-check').hidden=true;$('lr-result').hidden=true;record=detail.versions.at(-1);
  let response;try{response=await api({action:'review-context',recordId:record.record_id,recordVersion:record.version});}catch(error){
   if(!['RECORD_REVIEW_BUSY','LOCAL_REVIEW_BUSY'].includes(error?.code))throw error;
   const history=await api({action:'review-history',recordId:record.record_id});
   $('lr-request').textContent=record.input.request;$('lr-record-link').textContent='원래 기록 '+record.record_id+' / v'+record.version+' · 사용자 로컬 작성';
   $('lr-original-note').textContent='기존 작업의 처리 경계를 보호하기 위해 새 검토용 선택은 현재 사용할 수 없습니다. 저장된 검토 이력은 아래에서 확인할 수 있습니다.';
   $('lr-context').textContent='현재 후보·설정은 확인하지 않았습니다. 기존 작업을 마친 뒤 새 검토를 열어 재확인해 주세요.';
   $('lr-form').hidden=true;historyRows(history.executions);panel.hidden=false;status(explain(error));panel.scrollIntoView({block:'start',behavior:'smooth'});return;
  }context=response;$('lr-form').hidden=false;
  $('lr-request').textContent=response.request;$('lr-record-link').textContent='원래 기록 '+record.record_id+' / v'+record.version+' · 사용자 로컬 작성';
  const intentLabels={perform:'실제 작업 요청',question:'질문·설명',cancel:'취소',mixed:'복합 요청',uncertain:'판단 어려움 / 미확인'};
  const intent=response.original_intent??record.raw_user_confirmation?.intent,action=response.original_action??record.selection?.action;
  $('lr-original-note').textContent=`기록의 의도: ${intentLabels[intent]??'미확인'} · 기록의 선택 동작: ${action??'미확인'}. `+(intent!=='perform'||action!=='checklist_review'?'원래 뜻이나 동작을 검토로 바꾸지 않습니다. 아래의 검토용 선택과 요청을 별도로 확인해야 합니다.':'아래 현재 선택을 다시 확인한 뒤에만 검토를 시작합니다.');
  $('lr-context').textContent=JSON.stringify({과거기록시각:record.confirmed_at,과거입력해시:record.input_snapshot_hash,과거후보해시:response.historical_catalog_hash,현재후보해시:response.current_context_hash,현재후보범위:response.current_context.coverage,현재후보:response.current_context.documents},null,2);
  choices(response.current_context.documents,draftReviewSelection(record,response.current_context.documents));historyRows(response.history??[]);panel.hidden=false;status('먼저 현재 대상·근거·지침·형식을 확인해 주세요. 아직 검토 코어를 실행하지 않았습니다.');panel.scrollIntoView({block:'start',behavior:'smooth'});
 }
 function renderExecution(execution){
  const view=reviewPresentation(execution);$('lr-result').hidden=false;$('lr-result-title').textContent=view.title;$('lr-result-note').textContent=view.note;$('lr-result').dataset.state=view.state;$('lr-result-info').open=false;
  $('lr-result-meta').textContent=JSON.stringify({출처:'PC 로컬 명시 선택 검토 · 모바일 요청 아님',실행ID:execution.execution_id,기록ID:execution.record_id,기록버전:execution.record_version,시작:execution.started_at,종료:execution.ended_at,상태:execution.state,선택:execution.selection,현재입력:execution.input_snapshot,업무저장:false,...(view.code?{진단코드:view.code,코어상태:view.coreStatus??null}:{})},null,2);
  $('lr-items').replaceChildren();$('lr-documents').replaceChildren();$('lr-body').textContent='';$('lr-unresolved').textContent='';
  for(const id of ['lr-unresolved-title','lr-unresolved','lr-body-section','lr-documents-section'])$(id).hidden=view.state!=='completed';
  if(view.state==='completed'){
   const review=view.review;
   for(const item of review.items){const article=node('article'),header=node('div');article.className='lr-check-row';header.append(node('h4',item.label??item.item_id),node('strong',judgments[item.status]));article.append(header);if(item.reason)article.append(node('p','판정: '+item.reason));for(const e of item.evidence??[]){const quote=node('blockquote',e.quote??'');quote.append(node('cite',(e.doc_id??'')+' · '+(e.para_id??'')));article.append(quote);}$('lr-items').append(article);}
   $('lr-unresolved').textContent=review.unresolved.length?JSON.stringify(review.unresolved,null,2):'미해결 항목 없음';$('lr-body').textContent=review.body;
   for(const doc of review.documents){const section=node('section');section.append(node('h4',doc.id+' · '+(doc.version??'')),node('pre',doc.content??''));$('lr-documents').append(section);}
  }
  $('lr-check').hidden=view.state!=='uncertain';status(view.title+' · 업무 파일 저장 없음');$('lr-result').scrollIntoView({block:'start',behavior:'smooth'});
 }
 async function readExecution(){if(!record||!executionId)return;const result=await api({action:'review-detail',recordId:record.record_id,executionId});renderExecution(result.execution);}
 open.onclick=()=>work(load);$('lr-refresh').onclick=()=>work(load);$('lr-form').addEventListener('input',()=>{invalidate();executionId=null;$('lr-check').hidden=true;});$('lr-form').addEventListener('change',()=>{invalidate();executionId=null;$('lr-check').hidden=true;});
 $('lr-form').onsubmit=event=>{event.preventDefault();void work(async()=>{
  invalidate();executionId=null;$('lr-check').hidden=true;const at=generation;const value=await api({action:'review-preview',recordId:record.record_id,recordVersion:record.version,selection:selection()});if(at!==generation)return;preview=value;
  $('lr-preview-summary').textContent=JSON.stringify({실행동작:'checklist_review',원래기록:record.record_id,기록버전:record.version,원문:value.request,검토용선택:value.selection,현재선택문서버전과해시:value.documents,현재입력해시:value.input_hash,현재후보해시:value.current_context_hash,과거후보해시:context.historical_catalog_hash,확인만료:value.expires_at},null,2);$('lr-confirm').hidden=false;
  status(value.current_context_hash!==context.current_context_hash?'현재 후보가 처음 불러온 시점과 달라졌습니다. 새로 표시한 상태를 읽고 재확인해 주세요.':'현재 문서 상태를 확인했습니다. 아래의 별도 검토 요청 확인란을 선택해 주세요.');
 });};
 $('lr-consent').onchange=()=>{$('lr-start').disabled=busy||!preview||!$('lr-consent').checked||!!executionId;};
 $('lr-start').onclick=()=>work(async()=>{
  if(!preview||!$('lr-consent').checked||executionId)throw Error('검토용 현재 선택을 먼저 재확인해 주세요.');
  const selected=preview;executionId=selected.executionId;$('lr-start').disabled=true;status('선택한 문서를 검토 중입니다. 업무 승인·저장은 하지 않습니다.');
  try{const result=await api({action:'review-start',executionId,confirmationId:selected.confirmationId,confirmed:true});preview=null;$('lr-confirm').hidden=true;renderExecution(result.execution);}
  catch(error){preview=null;$('lr-confirm').hidden=true;$('lr-check').hidden=false;status(explain(error)+' 실행 결과가 불확실할 수 있습니다. 같은 실행 ID의 결과 확인만 요청하며 자동 재실행하지 않습니다.');message('검토 완료를 확인하지 못했습니다. 로컬 검토 결과 확인 버튼을 사용해 주세요.');}
 });
 $('lr-check').onclick=()=>work(readExecution);
 return{reset,get busy(){return busy;}};
}
