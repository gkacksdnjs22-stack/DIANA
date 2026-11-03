/* Tokens and one-time codes stay in memory; no localStorage, cookies, or console logging. */
let session;
const el = id => document.getElementById(id);
function failureText(error) {
  const stages = new Set(['등록권 확인','기기 패스키 생성','등록 결과 저장','인증 요청','기기 패스키 인증','인증 결과 확인','초기 등록권 발급']);
  const names = {
    NotAllowedError: '기기 인증이 취소되었거나 시간이 초과되었습니다.',
    NotSupportedError: '기기 또는 브라우저가 요청한 패스키 방식을 지원하지 않습니다.',
    InvalidStateError: '이미 등록된 인증 수단입니다.',
    SecurityError: '브라우저가 인증 출처 또는 RP ID를 허용하지 않았습니다.',
    AbortError: '기기 인증 요청이 중단되었습니다.',
    TypeError: '연결 또는 브라우저 인증 기능을 확인하세요.',
  };
  const codes = {
    ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT: '선택한 인증 수단이 저장형 패스키를 지원하지 않습니다.',
    ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT: '선택한 인증 수단이 지문·PIN 사용자 확인을 지원하지 않습니다.',
    ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG: '선택한 인증 수단이 요청한 서명 알고리즘을 지원하지 않습니다.',
    ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED: '이미 등록된 인증 수단입니다.',
  };
  const stage=stages.has(error?.stage)?error.stage:'요청';
  const name=error?.cause?.name||error?.name;
  const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?' (HTTP '+error.status+')':'';
  // Never display raw error messages, causes, responses, tokens or registration options.
  return stage+' 실패: '+(Object.hasOwn(codes,error?.code)?codes[error.code]:Object.hasOwn(names,name)?names[name]:'요청이 거절되었습니다. 등록권·권한·만료 상태를 확인하세요.')+status;
}
async function step(stage,work){
  el('result').textContent=stage+' 중…';
  try{return await work();}catch(error){throw{stage,name:error?.name,code:error?.code,cause:{name:error?.cause?.name},status:error?.status};}
}
async function api(action, body = {}) {
  const r = await fetch('/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: 'Bearer ' + session } : {}) }, body: JSON.stringify(body) });
  if (!r.ok) { const error=Error();error.status=r.status;throw error; }
  return r.json();
}
async function verify(scope) {
  const begin = await step('인증 요청',()=>api('login/begin', scope ? { scope } : {}));
  const response = await step('기기 패스키 인증',()=>SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: begin.options }));
  return step('인증 결과 확인',()=>api('login/finish', { ceremonyId: begin.ceremonyId, response }));
}
async function register(body) {
  const begin = await step('등록권 확인',()=>api('register/begin', body));
  const response = await step('기기 패스키 생성',()=>SimpleWebAuthnBrowser.startRegistration({ optionsJSON: begin.options }));
  return step('등록 결과 저장',()=>api('register/finish', { ceremonyId: begin.ceremonyId, response }));
}
async function mutate(action, scope, body = {}) { const { grant } = await verify(scope); return api(action, { ...body, grant }); }
const actions = {
  login: async () => { const r = await verify(); session = r.sessionToken; return { loggedIn: true, expiresIn: r.expiresIn }; },
  logout: async () => { const r = await api('logout'); session = undefined; el('state').textContent = ''; return r; },
  enroll: () => { const ticket = el('ticket').value.trim(); el('ticket').value = ''; return register({ ticket }); },
  invite: () => mutate('invite', 'manage', { role: el('role').value }),
  changeRole: () => mutate('role', 'manage', { userId: el('userId').value, role: el('role').value }),
  disable: () => mutate('disable', 'manage', { userId: el('userId').value }),
  addKey: async () => register({ grant: (await verify('credential')).grant }),
  revokeKey: () => mutate('credential/revoke', 'credential', { credentialId: el('credentialId').value }),
  revokeSession: () => mutate('session/revoke', 'credential', { sessionId: el('sessionId').value }),
  codes: () => mutate('recovery/codes', 'recovery'),
  refresh: async () => { el('state').textContent = JSON.stringify(await api('list'), null, 2); return { refreshed: true }; },
};
for (const [id, fn] of Object.entries(actions)) el(id).onclick = async () => {
  el(id).disabled = true; el('result').textContent = '';
  try { const result=await fn();el('result').textContent = id==='enroll'&&result.registered?'패스키 등록 완료. 이제 패스키로 관리자 로그인을 진행하세요.':JSON.stringify(result, null, 2); }
  catch(error) { el('result').textContent = failureText(error); }
  finally { el(id).disabled = false; }
};

el('bootstrap').onclick=async()=>{if(el('bootstrap').disabled)return;el('bootstrap').disabled=true;const token=el('bootstrapToken').value.trim();el('bootstrapToken').value='';try{const r=await step('초기 등록권 발급',()=>api('stage/bootstrap',{token}));el('ticket').value=r.enrollmentTicket;el('result').textContent='초기 등록권을 받았습니다. 패스키 등록을 진행하세요.';}catch(error){el('result').textContent=failureText(error);}finally{el('bootstrap').disabled=false;}};
