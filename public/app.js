let token = sessionStorage.getItem('remote-assistant-token') || '';
let refreshing = false;
const $ = id => document.getElementById(id);
$('token').value = token;
const labels = { scheduled:'예약됨', processing:'PC에서 작업 중', awaiting_phone:'갤럭시 저장 대기', waiting_pc:'PC 연결 대기', searching:'문서 검색 중', needs_selection:'파일 선택', ready_to_send:'작업 대기', sending:'수정·전달 처리 중', download_ready:'다운로드 준비 완료', needs_attention:'확인이 필요합니다', deadline_exceeded:'기한 내 저장하지 못했습니다', dry_run:'연습 완료 · 메일 미발송', submitted:'메일 서버 접수', send_unknown:'발송 결과 확인 필요', failed:'작업 실패' };
function stateLabel(job) {
  if (job.kind === 'upload') return ({waiting_pc:'PC 저장 대기',receiving_pc:'PC에서 저장 중',pc_saved:'PC 저장 완료',failed:'PC 전송 실패'})[job.state] || labels[job.state] || job.state;
  if (job.state === 'download_ready') return job.kind === 'overnight'
    ? (job.phoneSavedAt ? '기한 내 갤럭시 저장 확인' : '갤럭시 저장 확인 대기')
    : (job.phoneSavedAt ? '갤럭시 저장 확인' : '갤럭시 자동 저장 대기');
  return labels[job.state] || job.state;
}
function node(tag, value, cls) { const el = document.createElement(tag); if (value !== undefined) el.textContent = value; if (cls) el.className = cls; return el; }
function notice(text, error=false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
async function api(path, body) {
  if (!token) throw new Error('먼저 사용자 연결 코드를 입력하세요.');
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: { Authorization:`Bearer ${token}`, ...(body ? {'Content-Type':'application/json'} : {}) }, body: body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(15000) });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.'); return data;
}
function date(value) { return new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}); }
function fileSize(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
function initTimes() {
  const start=new Date(Date.now()+15*60000);start.setSeconds(0,0);
  const deadline=new Date(start.getTime()+8*3600000);
  const format=instant=>{const shifted=new Date(instant.getTime()-instant.getTimezoneOffset()*60000);return shifted.toISOString().slice(0,16);};
  $('start-at').value=format(start);$('deadline-at').value=format(deadline);
}
initTimes();
async function loadCatalog() {
  if(!token)return;
  try {
    const data=await api('/api/catalog');const items=Array.isArray(data.documents)?data.documents:[];const select=$('source');
    const current=select.value;const options=[node('option','원본 파일을 선택하세요')];options[0].value='';
    for(const file of items){const option=node('option',`${file.filename} · ${date(file.modifiedAt)} · ${Math.ceil(file.bytes/1024)}KB`);option.value=file.id;options.push(option);}
    select.replaceChildren(...options);if(items.some(file=>file.id===current))select.value=current;
    $('catalog-state').textContent=items.length?`PC에서 ${items.length}개 원본 목록을 확인했습니다. 원본 내용은 PC에서 읽고 해시로 변경 여부를 검사합니다.`:'PC 문서 폴더에서 지원 파일을 찾지 못했습니다. PC 에이전트의 문서 폴더를 확인하세요.';
  }catch(error){$('catalog-state').textContent=error.message;}
}
function saveArtifact(job,artifact) {
  const button=node('button',`연결된 앱에서 받기 · ${artifact.filename}`,'download');
  button.addEventListener('click',()=>notice('암호화된 파일은 연결된 DIANA 앱에서 받아 주세요.'));return button;
}
function renderJob(job) {
  const card = node('article',undefined,'job'); const top=node('div',undefined,'job-top');
  top.append(node('span',stateLabel(job),'badge'),node('span',date(job.createdAt),'time'));
  if(job.kind === 'upload') {
    card.append(top,node('h3',job.request.filename),node('p',`휴대폰 → PC · ${fileSize(job.request.bytes)}`,'recipient'));
    if(job.pcSavedAt)card.append(node('p',`PC에 저장 확인 · ${date(job.pcSavedAt)}`,'saved'));
    else if(job.state === 'waiting_pc')card.append(node('p','전송을 접수했습니다. PC가 연결되면 휴대폰 수신 폴더에 저장합니다.','recipient'));
    else if(job.state === 'receiving_pc')card.append(node('p','PC에서 파일을 받고 있습니다. 저장 확인을 기다려 주세요.','recipient'));
    if(job.error)card.append(node('p',job.error,'error'));
    const events=node('ul',undefined,'event-list');for(const item of (job.events||[]).slice(-5))events.append(node('li',item.text));card.append(events);return card;
  }
  card.append(top,node('h3',job.kind==='overnight'?(job.request.subject||'밤사이 보고서 작업'):job.request.query),node('p',job.kind==='overnight'?`원본 · ${job.source?.filename||'확인 불가'} · 완료 기한 ${date(job.request.deadlineAt)}`:(job.request.delivery==='download'?'받는 방법 · 연결된 갤럭시에 자동 저장':job.request.delivery==='both'?`받는 곳 · 갤럭시 자동 저장 + ${job.request.recipient}`:`받는 곳 · ${job.request.recipient}`),'recipient'));
  if(job.kind==='overnight') {
    card.append(node('p',`진행 · ${job.stage||job.state}${job.round?` · 검토 ${job.round}회`:''}`,'mode'));
    if(job.phoneSavedAt)card.append(node('p',`갤럭시에 저장 확인 · ${date(job.phoneSavedAt)}`,'saved'));
    else if(job.state==='awaiting_phone')card.append(node('p','보고서와 발표자료는 준비됐습니다. 갤럭시 저장과 해시 확인이 완료 기한 안에 도착해야 완료로 표시됩니다.','recipient'));
    if(Array.isArray(job.artifacts))for(const artifact of job.artifacts)card.append(saveArtifact(job,artifact));
    if(job.error)card.append(node('p',job.error,'error'));
    const events=node('ul',undefined,'event-list');for(const item of (job.events||[]).slice(-5))events.append(node('li',item.text));card.append(events);return card;
  }
  if(job.request.editInstruction)card.append(node('p',`수정 요청 · ${job.request.editInstruction}`,'recipient'));
  if(job.phoneSavedAt)card.append(node('p',`갤럭시 저장 및 파일 검증 확인 · ${date(job.phoneSavedAt)}`,'saved'));
  if(job.mode) card.append(node('p',job.mode==='openai'?'AI로 문서 내용을 비교한 결과':'키워드 연습 검색 · AI 해석 미사용','mode'));
  if(job.error) card.append(node('p',job.error,'error'));
  if(job.state==='needs_selection') for(const file of job.candidates) {
    const c=node('div',undefined,'candidate');
    c.append(node('strong',file.filename),node('p',file.reason),node('p',file.excerpt),node('small',`수정 ${date(file.modifiedAt || job.createdAt)} · ${Math.ceil(file.bytes/1024)} KB`));
    const select=node('button','이 파일로 진행');
    select.addEventListener('click',async()=>{ select.disabled=true; try {await api(`/api/jobs/${encodeURIComponent(job.id)}/selection`,{candidateId:file.id,approve:true}); notice('선택한 파일의 발송을 요청했습니다.'); await refresh();}catch(e){notice(e.message,true);select.disabled=false;} });
    c.append(select); card.append(c);
  }
  if(job.artifact){const download=node('button','연결된 앱에서 파일 받기','download');download.addEventListener('click',()=>notice('암호화된 파일은 연결된 DIANA 앱에서 받아 주세요.'));card.append(download);}
  const events=node('ul',undefined,'event-list'); for(const item of job.events.slice(-5)) events.append(node('li',item.text)); card.append(events); return card;
}
async function refresh() {
  if(!token || refreshing) return; refreshing=true;
  try {
    const data=await api('/api/jobs'); const online=data.device.lastSeenAt && Date.now()-Date.parse(data.device.lastSeenAt)<20000;
    $('device-status').textContent=online?'PC 연결됨':'PC 연결 대기'; $('device-status').className=`badge${online?' online':''}`;
    $('jobs').replaceChildren(...data.jobs.map(renderJob)); $('empty').hidden=data.jobs.length>0;
    if(!data.jobs.length) $('empty').textContent='찾을 문서를 설명해서 첫 요청을 보내세요.';
    await loadCatalog();
  } catch(e){notice(e.message,true);}finally{refreshing=false;}
}
$('connect-form').addEventListener('submit',async event=>{event.preventDefault();token=$('token').value.trim();try{await api('/api/jobs');sessionStorage.setItem('remote-assistant-token',token);notice('연결 코드를 확인했습니다. PC가 꺼져 있어도 요청을 등록할 수 있습니다.');await refresh();}catch(e){notice(e.message,true);}});
const MAX_UPLOAD_BYTES=10*1024*1024;
let uploadSelectionVersion=0;
let pendingUpload=null;
let uploading=false;
function uploadStatus(text,error=false){$('upload-status').textContent=text;$('upload-status').className=error?'error':'hint';}
function validateUpload(file){
  if(!file.size)throw new Error('빈 파일은 보낼 수 없습니다. 내용이 있는 파일을 선택하세요.');
  if(file.size>MAX_UPLOAD_BYTES)throw new Error('파일이 10MB보다 큽니다. 더 작은 파일을 선택하세요.');
  if(!file.name || file.name.length>180 || file.name.startsWith('.') || /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(file.name) || /[. ]$/.test(file.name) || /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(file.name))throw new Error('PC에서 사용할 수 없는 파일 이름입니다. 180자 이내의 일반 파일 이름으로 바꾼 뒤 다시 선택하세요.');
  try{encodeURIComponent(file.name);}catch{throw new Error('파일 이름을 읽을 수 없습니다. 이름을 바꾼 뒤 다시 선택하세요.');}
}
$('upload-file').addEventListener('change',async()=>{
  const version=++uploadSelectionVersion;pendingUpload=null;$('upload-submit').disabled=true;$('upload-submit').textContent='PC로 보내기';
  const file=$('upload-file').files[0];
  if(!file){$('upload-selection').textContent='선택한 파일이 없습니다.';uploadStatus('');return;}
  $('upload-selection').textContent=`${file.name} · ${fileSize(file.size)}`;
  try{
    validateUpload(file);
    if(!crypto.subtle || !crypto.randomUUID)throw new Error('이 브라우저에서는 파일 전송을 준비할 수 없습니다. HTTPS 주소로 접속하거나 최신 브라우저를 이용하세요.');
    uploadStatus('파일을 확인하고 있습니다. 아직 전송하지 않았습니다.');
    const bytes=await file.arrayBuffer();
    if(version!==uploadSelectionVersion)return;
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    if(version!==uploadSelectionVersion)return;
    const sha256=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
    pendingUpload={id:crypto.randomUUID(),filename:file.name,sha256,bytes,version};
    $('upload-submit').disabled=false;uploadStatus('파일이 준비됐습니다. ‘PC로 보내기’를 누르면 전송합니다.');
  }catch(error){if(version===uploadSelectionVersion)uploadStatus(error.message||'파일을 읽지 못했습니다. 다시 선택하세요.',true);}
});
$('upload-form').addEventListener('submit',async event=>{
  event.preventDefault();if(uploading||!pendingUpload)return;
  if(!token){uploadStatus('먼저 사용자 연결 코드를 입력하세요.',true);return;}
  const upload=pendingUpload;uploading=true;$('upload-submit').disabled=true;$('upload-file').disabled=true;
  uploadStatus('파일을 전송하고 있습니다. PC 저장 여부는 접수 후 확인합니다.');
  try{
    const response=await fetch(`/api/uploads/${encodeURIComponent(upload.id)}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(upload.filename),'X-File-SHA256':upload.sha256},body:upload.bytes,signal:AbortSignal.timeout(30000)});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'파일 전송을 접수하지 못했습니다.');
    if(data.job?.id!==upload.id || data.job.kind!=='upload' || data.job.request?.filename!==upload.filename || data.job.request.sha256!==upload.sha256 || data.job.request.bytes!==upload.bytes.byteLength)throw new Error('전송 접수를 확인하지 못했습니다. 같은 파일로 다시 전송해 주세요.');
    if(pendingUpload===upload){pendingUpload=null;++uploadSelectionVersion;$('upload-file').value='';$('upload-selection').textContent='선택한 파일이 없습니다.';}
    $('upload-submit').textContent='PC로 보내기';
    uploadStatus('전송을 접수했습니다. 아래 요청 목록에서 PC 저장 확인을 기다립니다.');
    notice('전송을 접수했습니다. PC 저장 확인을 기다립니다.');
    await refresh();
  }catch(error){
    const message=error.name==='TimeoutError'||error.name==='AbortError'?'전송 접수 확인에 시간이 걸립니다. ‘같은 파일 다시 보내기’를 누르면 중복 요청 없이 다시 확인합니다.':error instanceof TypeError?'네트워크 연결을 확인한 뒤 같은 파일로 다시 전송하세요.':error instanceof SyntaxError?'서버의 전송 접수 응답을 확인하지 못했습니다. 같은 파일로 다시 시도하세요.':error.message;
    uploadStatus(message||'전송을 확인하지 못했습니다. 같은 파일로 다시 시도하세요.',true);
    $('upload-submit').textContent='같은 파일 다시 보내기';
  }finally{uploading=false;$('upload-file').disabled=false;$('upload-submit').disabled=!pendingUpload;}
});
let pending = null;
$('job-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=$('submit');button.disabled=true;
  const form={query:$('query').value.trim(),recipient:$('recipient').value.trim(),subject:$('subject').value.trim(),autoSend:$('auto-send').checked,delivery:$('delivery').value,editInstruction:$('edit').value.trim()};
  // Retain the UUID on network failure so pressing again doesn't create a second email job.
  const signature=JSON.stringify(form);if(!pending||pending.signature!==signature)pending={signature,requestId:crypto.randomUUID()};
  try{await api('/api/jobs',{...form,requestId:pending.requestId});pending=null;notice('요청을 등록했습니다. 아래에서 진행 상황을 확인하세요.');await refresh();}catch(e){notice(e.message,true);}finally{button.disabled=false;}
});
$('refresh').addEventListener('click',refresh);
$('catalog-refresh').addEventListener('click',loadCatalog);
$('pair-code').addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;try{const data=await api('/api/phone/pair-code',{});$('pair-box').hidden=false;$('pair-digits').textContent=data.code;$('pair-expiry').textContent=`${date(data.expiresAt)}까지 한 번 사용할 수 있습니다. 앱에 서버 HTTPS 주소와 코드를 입력하세요.`;await loadDevices();}catch(error){notice(error.message,true);}finally{button.disabled=false;}});
async function loadDevices(){try{const data=await api('/api/phone/devices');const root=$('paired-devices');root.replaceChildren();for(const device of data.devices||[]){const row=node('div',undefined,'device-row');row.append(node('span',`${device.name} · ${device.lastSeenAt?`최근 연결 ${date(device.lastSeenAt)}`:'아직 연결되지 않음'}`));const revoke=node('button','연결 해제','subtle');revoke.addEventListener('click',async()=>{try{const response=await fetch(`/api/phone/devices/${encodeURIComponent(device.id)}`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}});const result=await response.json();if(!response.ok)throw new Error(result.error);notice('휴대폰 연결을 해제했습니다.');await loadDevices();}catch(error){notice(error.message,true);}});row.append(revoke);root.append(row);}}catch(error){$('paired-devices').replaceChildren();}}
$('overnight-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=$('overnight-submit');button.disabled=true;
  const signature=JSON.stringify({sourceId:$('source').value,instruction:$('mission').value.trim(),criteria:$('criteria').value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean),startAt:$('start-at').value,deadlineAt:$('deadline-at').value,slideCount:Number($('slide-count').value),delivery:'download'});
  if(!pending||pending.signature!==signature)pending={signature,requestId:crypto.randomUUID()};
  try{const payload=JSON.parse(signature);payload.startAt=new Date(payload.startAt).toISOString();payload.deadlineAt=new Date(payload.deadlineAt).toISOString();await api('/api/jobs',{...payload,kind:'overnight',requestId:pending.requestId});pending=null;notice('예약을 저장했습니다. PC와 앱이 연결되면 진행 상태를 이 화면에서 확인할 수 있습니다.');await refresh();}catch(error){notice(error.message,true);}finally{button.disabled=false;}
});
$('delivery').addEventListener('change',()=>{const email=$('delivery').value!=='download';$('email-fields').hidden=!email;$('recipient').required=email;});
setInterval(refresh,3000);refresh();
