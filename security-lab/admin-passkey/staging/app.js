/* Tokens and one-time codes stay in memory; no localStorage, cookies, or console logging. */
let session;
const el = id => document.getElementById(id);
async function api(action, body = {}) {
  const r = await fetch('/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: 'Bearer ' + session } : {}) }, body: JSON.stringify(body) });
  if (!r.ok) throw Error('요청이 거부되었습니다. 인증·권한·등록 상태를 확인하세요.');
  return r.json();
}
async function verify(scope) {
  const begin = await api('login/begin', scope ? { scope } : {});
  const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: begin.options });
  return api('login/finish', { ceremonyId: begin.ceremonyId, response });
}
async function register(body) {
  const begin = await api('register/begin', body);
  const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: begin.options });
  return api('register/finish', { ceremonyId: begin.ceremonyId, response });
}
async function mutate(action, scope, body = {}) { const { grant } = await verify(scope); return api(action, { ...body, grant }); }
const actions = {
  login: async () => { const r = await verify(); session = r.sessionToken; return { loggedIn: true, expiresIn: r.expiresIn }; },
  logout: async () => { const r = await api('logout'); session = undefined; el('state').textContent = ''; return r; },
  enroll: () => { const ticket = el('ticket').value; el('ticket').value = ''; return register({ ticket }); },
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
  try { el('result').textContent = JSON.stringify(await fn(), null, 2); }
  catch { el('result').textContent = '처리가 거부 또는 취소되었습니다. 재인증 후 다시 시도하세요.'; }
  finally { el(id).disabled = false; }
};

el('bootstrap').onclick=async()=>{el('result').textContent='';const token=el('bootstrapToken').value;el('bootstrapToken').value='';try{const r=await api('stage/bootstrap',{token});el('ticket').value=r.enrollmentTicket;el('result').textContent='초기 등록권을 받았습니다. 패스키 등록을 진행하세요.';}catch{el('result').textContent='초기 등록이 거부되었습니다. 토큰과 만료·등록 상태를 확인하세요.';}};
