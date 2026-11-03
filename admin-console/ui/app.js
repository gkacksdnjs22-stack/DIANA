/* Authentication tokens and issued capabilities stay in page memory only. */
let session,state,config,pendingFile,busy=false;
const el=id=>document.getElementById(id);
const roleName={owner:'owner',admin:'admin',auditor:'auditor'};
function notice(text,error=false){el('notice').textContent=text;el('notice').dataset.error=String(error);}
function message(error){const names={NotAllowedError:'기기 인증이 취소되었거나 시간이 초과됐습니다.',NotSupportedError:'이 기기의 패스키 지원 상태를 확인하세요.',SecurityError:'인증 출처 또는 RP ID가 허용되지 않았습니다.'};return names[error?.name]||'연결·로그인 만료·현재 권한을 확인한 뒤 다시 시도하세요.';}
function clearSession(){session=undefined;state=undefined;pendingFile=undefined;el('ticket').value='';el('downloadPanel').hidden=true;render();}
async function api(action,body={}){
  const r=await fetch('./api/'+action,{method:'POST',headers:{'Content-Type':'application/json',...(session?{Authorization:'Bearer '+session}:{})},body:JSON.stringify(body)});
  if(!r.ok){if(r.status===401||r.status===403)clearSession();throw Error('REQUEST_DENIED');}return r.json();
}
async function verify(scope){const begin=await api('login/begin',scope?{scope}:{});const response=await SimpleWebAuthnBrowser.startAuthentication({optionsJSON:begin.options});return api('login/finish',{ceremonyId:begin.ceremonyId,response});}
async function register(body){const begin=await api('register/begin',body);const response=await SimpleWebAuthnBrowser.startRegistration({optionsJSON:begin.options});return api('register/finish',{ceremonyId:begin.ceremonyId,response});}
async function mutate(action,scope,body={}){const {grant}=await verify(scope);return api(action,{...body,grant});}
async function refresh(){state=await api('list');render();}
function button(label,work,danger=false){const b=document.createElement('button');b.textContent=label;b.disabled=busy;b.className=danger?'danger':'';b.onclick=()=>run(work);return b;}
function textCell(tr,text,title){const td=document.createElement('td');td.textContent=String(text);if(title)td.title=title;tr.append(td);return td;}
function short(value){return String(value).slice(0,12)+'…';}
function row(parent){const tr=document.createElement('tr');el(parent).append(tr);return tr;}
function render(){
  const logged=!!state,preview=config&&!config.configured,owner=state?.me.role==='owner';
  el('loginPanel').hidden=logged;el('dashboard').hidden=!logged&&!preview;
  el('connection').textContent=preview?'로컬 미리보기':logged?'서버 인증 확인':'로그인 필요';
  for(const id of ['login','enroll'])el(id).disabled=!config?.configured||busy;
  for(const id of ['refresh','logout','addKey','codes'])el(id).disabled=!logged||busy;
  el('invite').disabled=!owner||busy;el('inviteRole').disabled=!owner||busy;
  el('myRole').textContent=state?roleName[state.me.role]||'—':'—';el('myId').textContent=state?short(state.me.id):'로그인 필요';
  el('keyCount').textContent=state?state.credentials.filter(c=>c.state==='active').length:'—';
  el('sessionCount').textContent=state?state.sessions.filter(s=>!s.revoked&&s.expires>Date.now()).length:'—';
  for(const id of ['accountRows','credentialRows','sessionRows'])el(id).replaceChildren();
  el('accountEmpty').hidden=!!state?.users.length;el('accountEmpty').textContent=logged&&!owner?'계정 관리는 owner 권한으로 이용할 수 있습니다.':'로그인 후 관리자 계정이 표시됩니다.';
  for(const user of state?.users||[]){
    const tr=row('accountRows');textCell(tr,short(user.id),user.id);textCell(tr,user.role);textCell(tr,user.state==='active'?'활성':user.state==='pending'?'등록 대기':'비활성');
    const td=textCell(tr,'');if(owner){const select=document.createElement('select');select.setAttribute('aria-label',user.id+' 역할');for(const value of Object.keys(roleName)){const o=document.createElement('option');o.value=value;o.textContent=value;select.append(o);}select.value=user.role;select.disabled=busy;td.append(select);
      td.append(button('변경',async()=>{if(!confirm('계정 '+user.id+'의 역할을 '+select.value+'으로 변경할까요?'))return;await mutate('role','manage',{userId:user.id,role:select.value});await refresh();notice('권한을 변경했습니다. 해당 계정의 기존 로그인은 종료됩니다.');}));
      if(user.state!=='disabled')td.append(button('비활성화',async()=>{if(!confirm('계정 '+user.id+'을 비활성화할까요?'))return;await mutate('disable','manage',{userId:user.id});await refresh();notice('계정을 비활성화했습니다.');},true));}
  }
  for(const key of state?.credentials||[]){const tr=row('credentialRows');textCell(tr,short(key.id),key.id);textCell(tr,key.device_type==='multiDevice'?'동기화 가능':'인증기 보관');textCell(tr,key.state==='active'?'활성':'폐기됨');const td=textCell(tr,'');if(key.state==='active'&&(owner||key.user_id===state.me.id))td.append(button('등록 폐기',async()=>{if(!confirm('인증 등록 '+key.id+'을 폐기할까요? 이 키의 기존 세션도 종료됩니다.'))return;await mutate('credential/revoke','credential',{credentialId:key.id});await refresh();notice('인증 등록을 폐기했습니다.');},true));}
  for(const item of state?.sessions||[]){const tr=row('sessionRows');textCell(tr,short(item.hash));textCell(tr,new Date(item.expires).toLocaleString('ko-KR'));textCell(tr,item.revoked?'종료됨':item.expires<=Date.now()?'만료됨':'활성');const td=textCell(tr,'');if(!item.revoked&&item.expires>Date.now())td.append(button('세션 종료',async()=>{await mutate('session/revoke','credential',{sessionId:item.hash});await refresh();notice('선택한 세션을 종료했습니다.');}));}
}
async function run(work){if(busy)return;busy=true;render();try{await work();}catch(error){notice(message(error),true);}finally{busy=false;render();}}
function issuedFile(title,filename,data){pendingFile={filename,data};el('downloadTitle').textContent=title;el('downloadPanel').hidden=false;notice('파일을 발급했습니다. 아래 파일 저장을 눌러 비공개 장소에 보관하세요.');}
const actions={
  login:async()=>{const r=await verify();session=r.sessionToken;await refresh();notice('관리자 인증을 확인했습니다.');},
  enroll:async()=>{const ticket=el('ticket').value.trim();el('ticket').value='';const r=await register({ticket});if(!r.registered)throw Error();notice('패스키 등록을 완료했습니다. 이제 로그인하세요.');},
  refresh:async()=>{await refresh();notice('현재 권한과 로그인 상태를 확인했습니다.');},
  logout:async()=>{let confirmed=false;try{await api('logout');confirmed=true;}catch{}finally{clearSession();notice(confirmed?'로그아웃했습니다.':'이 페이지에서 로그아웃했습니다. 서버 세션 종료는 연결 후 확인이 필요합니다.',!confirmed);}},
  invite:async()=>{const role=el('inviteRole').value;const r=await mutate('invite','manage',{role});issuedFile('관리자 초대 파일','DIANA-admin-invitation-'+r.userId+'.json',{kind:'diana-admin-invitation-v1',origin:config.origin,role,userId:r.userId,enrollmentTicket:r.enrollmentTicket});await refresh();},
  addKey:async()=>{const {grant}=await verify('credential');await register({grant});await refresh();notice('내 패스키를 추가했습니다.');},
  codes:async()=>{const r=await mutate('recovery/codes','recovery');issuedFile('복구 코드 파일','DIANA-recovery-'+state.me.id+'.json',{kind:'diana-admin-recovery-v1',origin:config.origin,userId:state.me.id,recoveryCodes:r.recoveryCodes});},
};
for(const[id,work]of Object.entries(actions))el(id).onclick=()=>run(work);
el('saveFile').onclick=()=>{if(!pendingFile)return;try{const url=URL.createObjectURL(new Blob([JSON.stringify(pendingFile.data)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=pendingFile.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notice('파일 저장을 요청했습니다. 다운로드 결과를 확인하세요. 필요하면 다시 저장할 수 있습니다.');}catch{notice('파일 저장을 시작하지 못했습니다. 같은 버튼으로 다시 시도하세요.',true);}};
async function init(){try{const r=await fetch('./config.json',{cache:'no-store'});if(!r.ok)throw Error();config=await r.json();notice(config.configured?'패스키로 관리자 로그인을 진행하세요.':'로컬 미리보기입니다. 인증 연결은 꺼져 있어 계정·DB 변경을 수행할 수 없습니다.');}catch{notice('관리자 연결 정보를 확인하지 못했습니다.',true);}render();}
void init();
