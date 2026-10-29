'use strict';
import {recheckView} from './recheck-view.mjs';
import {mountRegistration} from './registration.mjs';
import {mountRequestRecords} from './request-records.mjs';
(()=>{
 const $=id=>document.getElementById(id);
 const fragment=new URLSearchParams(location.hash.slice(1)),key=fragment.get('view')||sessionStorage.getItem('diana-local-view')||'';
 if(/^[a-f0-9]{64}$/.test(key))sessionStorage.setItem('diana-local-view',key);
 if(location.hash)history.replaceState(null,'',location.pathname);
 let data={jobs:[],connection:{}},selected=null,lastNewest=null,signature='',activeTab='diff',sourceId=null,pending=false,pendingAction=false,localAvailable=false,decision=null,toastTimer;
 const actions={checklist_review:'검토',patch:'보완',convert:'변환'};
 const states={PROCESSING:'검토 준비 중',PC_REVIEW_REQUIRED:'PC 승인 대기',WAITING_FOR_INFORMATION:'추가 확인 필요',LOCAL_SAVING:'PC에 저장 중',LOCAL_SAVE_COMPLETED:'저장 · 재읽기 완료',REVIEW_COMPLETED:'검토 완료',CANCELLED:'취소됨',BLOCKED:'PC 확인 필요',FAILED:'작업 실패',UNCERTAIN:'저장 결과 확인 필요'};
 const judgments={SATISFIED:'충족',MISSING_WITH_EVIDENCE:'근거 있음 · 보완 필요',MISSING_NO_EVIDENCE:'근거 추가 필요',NEEDS_CONFIRMATION:'표현 · 조건 확인 필요'};
 const reasons={EXPLICIT_REVIEW_STATEMENT:'검토서에 등록된 확정 진술이 있습니다.',EXPLICIT_SOURCE_STATEMENT:'원문에서 근거를 확인했습니다. 검토서에 보완할 수 있습니다.',REQUEST_SOURCE_OR_MANAGER_CONFIRMATION:'제공 자료에서 근거를 찾지 못했습니다. 추가 자료나 담당자 확인이 필요합니다.',CONFLICT_OR_UNSUPPORTED_EXPRESSION:'질문·조건·부정 또는 미등록 표현이 있어 추가 확인이 필요합니다.'};
 const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
 const current=()=>data.jobs.find(j=>j.job?.id===selected);
 const time=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});};
 function connection(available){$('connection').classList.toggle('online',available&&data.connection.connected===true);$('connection').lastElementChild.textContent=available?(data.connection.connected?'PC 연결됨':'서버 연결 확인 필요'):'로컬 화면 연결 끊김';}
 function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,3000);}
 const recording=mountRequestRecords({key,getCurrent:()=>current()});
 const registration=mountRegistration({key,toast});$('jobs').addEventListener('click',registration.close);
 async function copy(text,message='복사했어요. PC 콘솔에 붙여넣어 주세요.'){try{await navigator.clipboard.writeText(text);toast(message);}catch{toast('복사 권한이 없어요. 화면의 텍스트를 직접 선택해 복사해 주세요.');}}
 function renderList(){
  $('job-count').textContent=String(data.jobs.length);$('jobs').replaceChildren();
  for(const entry of data.jobs){const j=entry.job;if(!j)continue;const b=node('button');b.type='button';b.classList.toggle('selected',j.id===selected);b.setAttribute('aria-current',j.id===selected?'true':'false');b.append(node('strong',entry.label||'금융 문서 작업'),node('small',(actions[j.action]||'작업')+' · '+(j.format||'').toUpperCase()+' · '+time(j.createdAt)),node('small',states[j.state]||'확인 중'));b.addEventListener('click',()=>{selected=j.id;sourceId=null;if(entry.result?.historical)tab('result');renderList();render();});$('jobs').append(b);}
 }
 function renderApproval(){
  const e=current();if(!e)return;const j=e.job,expires=e.approvalExpires-Date.now(),ready=e.approvalReady&&e.reviewId&&j.state==='PC_REVIEW_REQUIRED'&&expires>0&&data.connection.connected&&localAvailable&&!e.busy&&!pendingAction;
  $('approve-open').hidden=data.capabilities?.approve!==true;$('reject-open').hidden=data.capabilities?.approve!==true;
  $('approve-open').disabled=!ready||data.capabilities?.approve!==true;$('reject-open').disabled=$('approve-open').disabled;
  $('review-saved').hidden=data.capabilities?.recheck!==true;
  $('review-saved').disabled=!(data.capabilities?.recheck&&e.result?.saved&&e.result?.storageVerified&&e.resultId&&localAvailable&&!e.busy&&!pendingAction);
  $('review-saved').textContent=pendingAction?'처리 중…':'저장한 파일 다시 검토';
  $('command-fallback').hidden=!ready;$('approval-command').value=ready?'approve '+j.id:'';
  if(j.state==='LOCAL_SAVE_COMPLETED'){$('approval-title').textContent='PC에 저장하고 파일을 다시 읽어 확인했어요.';$('approval-note').textContent=recheckView(e.recheck).state==='failed'?'저장은 확인됐지만 최근 재검토는 완료되지 않았어요. 저장본 재검토 탭에서 원인을 확인해 주세요.':e.result?.historical&&!e.recheck?'이전에 저장한 파일입니다. 저장 결과에서 ‘저장한 파일 다시 검토’를 눌러 현재 결과를 확인해 주세요.':(e.recheck?.reviewComplete??e.result?.reviewComplete)?'최근 검토의 모든 항목이 충족되었습니다. 저장 결과에서 경로를 확인할 수 있어요.':'미해결 항목은 계속 남겨두었습니다. 저장 완료와 전체 검토 완료를 구분해 주세요.';}
  else if(j.state==='PC_REVIEW_REQUIRED'){$('approval-title').textContent=expires>0?'수정안을 확인하고 이 화면에서 승인해 주세요.':'승인 유효 시간이 지났어요.';$('approval-note').textContent=expires>0?'수정안 승인을 누른 뒤 확인창에서 최종 승인하면 이 PC에 저장합니다. 원문·정책·유효 시간을 다시 확인합니다.':'모바일에서 새 작업을 요청하고 수정안을 다시 확인해 주세요.';}
  else{$('approval-title').textContent=states[j.state]||'검토 내용을 준비하고 있어요.';$('approval-note').textContent=j.state==='WAITING_FOR_INFORMATION'?'항목별 검토에서 필요한 근거를 확인해 주세요. 보완은 모바일에서 별도 작업으로 요청할 수 있어요.':j.state==='REVIEW_COMPLETED'?'검토가 끝났습니다. 새 저장 여부와 항목별 결과를 각각 확인해 주세요.':j.state==='UNCERTAIN'?'PC의 실제 결과 파일과 기록을 확인해야 합니다. 자동으로 다시 저장하지 않습니다.':j.state==='CANCELLED'?'작업이 취소되었습니다. 새 작업은 모바일에서 요청해 주세요.':j.state==='BLOCKED'||j.state==='FAILED'?'원문·정책·승인 시간 또는 PC 연결 상태를 확인하고 새 요청을 진행해 주세요.':'원문과 근거를 준비하고 있습니다. 최종 승인은 PC에서 직접 진행합니다.';}
  $('expiry').textContent=j.state==='PC_REVIEW_REQUIRED'&&expires>0?'승인 유효 시간 '+Math.floor(expires/60000)+'분 '+String(Math.floor(expires%60000/1000)).padStart(2,'0')+'초':'';
 }
 function renderSources(e){const docs=e.documents||[];$('source-select').replaceChildren();if(!docs.some(d=>d.id===sourceId))sourceId=docs[0]?.id;for(const d of docs){const o=node('option',d.id+' · '+d.format.toUpperCase());o.value=d.id;$('source-select').append(o);}$('source-select').value=sourceId||'';$('source-content').textContent=docs.find(d=>d.id===sourceId)?.content||'문서를 준비하고 있어요.';}
 function render(){
  const e=current();$('empty').hidden=!!e;$('detail').hidden=!e;if(!e)return;
  const j=e.job,r=e.review,items=r?.items||[];
  $('title').textContent=e.label||'금융 문서 작업';$('subtitle').textContent=(actions[j.action]||'작업')+' · '+(j.format||'').toUpperCase()+' · '+time(j.createdAt)+' 요청';$('state').textContent=states[j.state]||'확인 중';$('state').className='state '+(['WAITING_FOR_INFORMATION','BLOCKED','FAILED','UNCERTAIN'].includes(j.state)?'warning':j.state==='LOCAL_SAVE_COMPLETED'?'':'neutral');
  $('satisfied').textContent=r?String(items.filter(i=>i.status==='SATISFIED').length):'—';$('missing').textContent=r?String(items.filter(i=>i.status==='MISSING_WITH_EVIDENCE').length):'—';$('unresolved').textContent=r?String(items.filter(i=>['MISSING_NO_EVIDENCE','NEEDS_CONFIRMATION'].includes(i.status)).length):'—';
  const saved=j.state==='LOCAL_SAVE_COMPLETED'&&j.saved===true;$('saved').textContent=saved?'완료':'미저장';$('saved-note').textContent=saved?'파일 재읽기까지 확인':'최종 승인 전에는 저장하지 않아요';
  $('before').textContent=r?.before||(e.result?.historical?'이전 저장 작업입니다. 저장 결과에서 저장본을 다시 검토해 주세요.':'원문을 준비하고 있어요.');$('after').textContent=r?.after||(e.result?.historical?'저장 파일을 다시 검토하면 본문과 판단 결과를 확인할 수 있어요.':'수정안을 준비하고 있어요.');$('diff-note').textContent=r?(r.before===r.after?'업무 본문 변경 없음 · 검토 결과와 저장 상태는 별도로 확인해 주세요.':'업무 본문의 변경을 확인해 주세요. 원본 파일은 유지됩니다.'):'업무 본문의 수정 전후를 비교합니다.';
  $('diff-lines').replaceChildren();for(const line of (r?.diff||'본문 변경이 없습니다.').split('\n'))$('diff-lines').append(node('span',line,line.startsWith('+')?'added':line.startsWith('-')?'removed':line.startsWith('@@')?'hunk':''));
  $('checklist').replaceChildren();for(const item of items){const row=node('article',undefined,'check-row'),header=node('header');header.append(node('h3',item.label||item.item_id),node('span',judgments[item.status]||'추가 확인',item.status==='SATISFIED'?'badge good':item.status==='MISSING_WITH_EVIDENCE'?'badge patch':'badge'));row.append(header,node('p',reasons[item.reason]||'상세 근거를 PC에서 확인해 주세요.'));for(const ref of item.evidence||[]){const quote=node('blockquote',ref.quote);quote.append(node('cite',(ref.doc_id||'원문')+' · '+(ref.para_id||'')));row.append(quote);}$('checklist').append(row);}
  renderSources(e);
  $('result-title').textContent=saved?'저장 · 재읽기 확인 완료':'저장 결과';$('result-note').textContent=saved?(e.result?.historical?'이전에 완료된 저장 기록과 현재 파일 해시를 확인했습니다. 저장한 파일을 다시 검토할 수 있어요.':'PC에서 실제 파일 저장과 재읽기를 확인했습니다. 아래에는 승인한 업무 본문을 표시합니다.'):j.state==='UNCERTAIN'?'저장 결과가 불확실합니다. 실제 PC 파일과 감사 기록을 확인해 주세요.':'아직 저장 완료가 확인되지 않았습니다.';
  $('file-section').hidden=!e.result?.outputFile;$('output-path').textContent=e.result?.outputFile||'';
  $('result-unresolved').replaceChildren();for(const item of e.result?.unresolved||r?.unresolved||[])$('result-unresolved').append(node('div',(item.label||item.item_id)+' · '+(judgments[item.status]||'추가 확인')));
  $('result-content').textContent=saved?r?.after||'':'';$('request-id').textContent='요청 '+j.id;
  const recheck=recheckView(e.recheck);$('recheck-title').textContent=recheck.title;$('recheck-note').textContent=recheck.note;
  $('recheck-items').replaceChildren();for(const item of recheck.items){const row=node('article',undefined,'check-row'),header=node('header');header.append(node('h3',item.label||item.item_id),node('span',judgments[item.status]||'추가 확인',item.status==='SATISFIED'?'badge good':'badge'));row.append(header,node('p',reasons[item.reason]||'상세 근거를 확인해 주세요.'));for(const ref of item.evidence||[]){const quote=node('blockquote',ref.quote);quote.append(node('cite',(ref.doc_id||'원문')+' · '+(ref.para_id||'')));row.append(quote);}$('recheck-items').append(row);}
  $('recheck-body').textContent=recheck.body;renderApproval();
 }
 function tab(name){activeTab=name;for(const b of document.querySelectorAll('[data-tab]')){const active=b.dataset.tab===name;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;$('panel-'+b.dataset.tab).hidden=!active;}}
 for(const b of document.querySelectorAll('[data-tab]')){b.addEventListener('click',()=>tab(b.dataset.tab));b.addEventListener('keydown',e=>{const tabs=[...document.querySelectorAll('[data-tab]')],i=tabs.indexOf(b);let target;if(e.key==='ArrowRight')target=tabs[(i+1)%tabs.length];if(e.key==='ArrowLeft')target=tabs[(i+tabs.length-1)%tabs.length];if(e.key==='Home')target=tabs[0];if(e.key==='End')target=tabs.at(-1);if(target){e.preventDefault();tab(target.dataset.tab);target.focus();}});}
 $('toggle-diff').addEventListener('click',()=>{$('diff-lines').hidden=!$('diff-lines').hidden;$('toggle-diff').setAttribute('aria-expanded',String(!$('diff-lines').hidden));});
 $('source-select').addEventListener('change',()=>{sourceId=$('source-select').value;$('source-content').textContent=current()?.documents?.find(d=>d.id===sourceId)?.content||'';});
 function openDecision(action){const e=current();renderApproval();if(!e||$('approve-open').disabled)return;decision={action,requestId:e.job.id,viewId:e.reviewId};$('decision-title').textContent=action==='approve'?'이 수정안을 승인하고 저장할까요?':'이 작업을 거절할까요?';$('decision-summary').textContent=(e.label||'금융 문서 작업')+' · '+e.job.format.toUpperCase()+' · 요청 '+e.job.id;$('decision-warning').textContent=action==='approve'?'새 파일로 저장하고 재읽기를 확인합니다. 미해결 '+(e.review?.unresolved?.length||0)+'개 항목은 그대로 유지됩니다.':'거절하면 현재 수정안을 저장하지 않고 작업을 종료합니다.';$('decision-confirm').textContent=action==='approve'?'승인하고 저장':'거절 확정';$('decision-dialog').showModal();}
 async function sendAction(request){if(pendingAction)return;pendingAction=true;renderApproval();try{const response=await fetch('/api/local-action',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error('LOCAL_ACTION_REJECTED');await poll();if(request.action==='recheck')tab('recheck');else if(request.action==='approve')tab('result');toast(request.action==='recheck'?'저장 파일을 다시 검토했어요.':'처리 결과를 확인해 주세요.');}catch{await poll();if(request.action==='recheck'){tab('recheck');toast('재검토를 완료하지 못했어요. 원인을 확인해 주세요.');}else toast('상태·원문·정책 또는 유효 시간을 확인해 주세요. 결과를 다시 확인한 뒤 진행해 주세요.');}finally{pendingAction=false;renderApproval();}}
 $('approve-open').addEventListener('click',()=>openDecision('approve'));$('reject-open').addEventListener('click',()=>openDecision('reject'));
 $('decision-close').addEventListener('click',()=>$('decision-dialog').close());$('decision-dialog').addEventListener('close',()=>{decision=null;});
 $('decision-confirm').addEventListener('click',()=>{const request=decision;if(!request)return;const e=data.jobs.find(j=>j.job?.id===request.requestId);if(!e||e.reviewId!==request.viewId||!e.approvalReady||e.approvalExpires<=Date.now()){toast('선택한 수정안 상태가 변경됐어요. 다시 확인해 주세요.');$('decision-dialog').close();return;}$('decision-dialog').close();void sendAction(request);});
 $('review-saved').addEventListener('click',()=>{renderApproval();const e=current();if(!e||$('review-saved').disabled)return;void sendAction({requestId:e.job.id,viewId:e.resultId,action:'recheck'});});
 $('approval-command').addEventListener('focus',e=>e.target.select());
 $('copy-path').addEventListener('click',()=>void copy(current()?.result?.outputFile||'','PC 저장 경로를 복사했어요.'));
 async function poll(){
  if(pending)return;pending=true;
  try{if(!/^[a-f0-9]{64}$/.test(key))throw Error('SESSION_REQUIRED');const response=await fetch('/api/view',{headers:{Authorization:'Bearer '+key},cache:'no-store',signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('LOCAL_VIEW_UNAVAILABLE');data=await response.json();registration.setAvailable(data.capabilities?.registration===true);recording.setAvailable(data.capabilities?.requestRecords===true);localAvailable=true;connection(true);const next=JSON.stringify(data.jobs);if(next!==signature){signature=next;if(data.jobs[0]?.job?.id!==lastNewest){lastNewest=data.jobs[0]?.job?.id;selected=lastNewest;sourceId=null;tab(data.jobs[0]?.result?.historical?'result':'diff');}renderList();render();}renderApproval();}
  catch{localAvailable=false;data.connection.connected=false;connection(false);renderApproval();if(!key)$('session-help').textContent='PC 콘솔에 표시된 검토 화면 주소로 열어 주세요.';}
  finally{pending=false;}
 }
 tab(activeTab);void poll();setInterval(()=>void poll(),1200);setInterval(renderApproval,1000);
})();
