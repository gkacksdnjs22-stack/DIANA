import { createHash, randomBytes } from 'node:crypto';
const secret = () => randomBytes(32).toString('base64url');
const hash = x => createHash('sha256').update(x).digest('hex');
const need = x => {
  if (!x) throw Error('DENIED');
  return x;
};
export const pkce = x => createHash('sha256').update(x).digest('base64url');
export class StagingNativeAuthorization {
  constructor(auth, androidRedirect) {
    this.auth = auth;
    this.androidRedirect = androidRedirect;
  }
  validate(client, redirect) {
    if (client === 'diana-lab-android') return need(redirect === this.androidRedirect);
    need(client === 'diana-lab-desktop');
    const u = new URL(redirect);
    need(u.protocol === 'http:' && u.hostname === '127.0.0.1' && Number(u.port) > 0 && u.pathname === '/oauth2/callback' && !u.username && !u.password && !u.search && !u.hash);
  }
  async begin(params) {
    need(params.response_type === 'code' && params.code_challenge_method === 'S256');
    need(/^[A-Za-z0-9_-]{43}$/.test(params.state) && /^[A-Za-z0-9_-]{43}$/.test(params.code_challenge));
    this.validate(params.client_id, params.redirect_uri);
    const id = secret(),
      a = this.auth;
    await a.run('DELETE FROM native_requests WHERE expires<=?', a.now());
    await a.run('DELETE FROM native_codes WHERE expires<=?', a.now());
    await a.run('INSERT INTO native_requests VALUES(?,?,?,?,?,?)', id, params.client_id, params.redirect_uri, params.state, params.code_challenge, a.now() + 120_000);
    return id;
  }
  async approve({
    requestId
  }, raw) {
    const a = this.auth;
    return await a.tx(async () => {
      const s = await a.session(raw);
      need(['owner', 'admin'].includes(s.role));
      need(s.kind === 'webauthn' && a.now() >= s.webauthn_at && a.now() - s.webauthn_at < 60_000);
      const r = need(await a.get('SELECT * FROM native_requests WHERE id=? AND expires>?', requestId, a.now()));
      await a.run('DELETE FROM native_requests WHERE id=?', requestId);
      const code = secret();
      await a.run('INSERT INTO native_codes VALUES(?,?,?,?,?,?)', hash(code), r.client, r.redirect, r.challenge, s.hash, a.now() + 60_000);
      const redirect = new URL(r.redirect);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', r.state);
      return {
        redirect: redirect.href
      };
    });
  }
  async exchange(body) {
    const a = this.auth;
    // A submitted authorization code is consumed even if the proof is incorrect.
    const c = await a.tx(async () => {
      const row = need(await a.get('SELECT * FROM native_codes WHERE hash=?', hash(String(body.code || ''))));
      await a.run('DELETE FROM native_codes WHERE hash=?', hash(body.code));
      return row;
    });
    return await a.tx(async () => {
      need(body.grant_type === 'authorization_code' && c.expires > a.now());
      need(c.client === body.client_id && c.redirect === body.redirect_uri && /^[A-Za-z0-9_-]{43,128}$/.test(body.code_verifier) && pkce(body.code_verifier) === c.challenge);
      const s = await a.activeSessionHash(c.source);
      need(['owner', 'admin'].includes(s.role));
      need(s.kind === 'webauthn');
      const expires = Math.min(s.expires, s.absolute_expires);
      need(expires > a.now());
      const access = secret();
      await a.run('INSERT INTO sessions VALUES(?,?,?,?,0)', hash(access), s.user_id, s.credential_id, expires);
      await a.run('INSERT INTO session_authentication VALUES(?,?,?,?)', hash(access), s.webauthn_at, s.absolute_expires, 'native');
      return {
        access_token: access,
        token_type: 'Bearer',
        expires_in: Math.floor((expires - a.now()) / 1000)
      };
    });
  }
}
