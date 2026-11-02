import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';

const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(String(value || '')).digest('hex');
const deny = () => { throw Error('DENIED'); };
const need = value => { if (!value) deny(); return value; };
const scopes = new Set(['manage', 'credential', 'recovery']);
const roles = new Set(['owner', 'admin', 'auditor']);
function checkClient(response) {
  const data = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString());
  need(data.crossOrigin !== true && data.topOrigin === undefined);
}

// Lab-only module: no environment credentials, remote DB adapter, or production listener.
export class AdminAuth {
  constructor({ dbPath, origin = 'http://localhost:43871', now = Date.now }) {
    const root = resolve(import.meta.dirname, 'test-data');
    need(resolve(dbPath).startsWith(root + '\\') || resolve(dbPath).startsWith(root + '/'));
    const url = new URL(origin);
    need(url.hostname === 'localhost' && url.protocol === 'http:' && url.origin === origin);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath); this.origin = origin; this.now = now;
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('owner','admin','auditor')), state TEXT NOT NULL CHECK(state IN ('pending','active','disabled')), epoch INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), public_key BLOB NOT NULL, counter INTEGER NOT NULL, device_type TEXT NOT NULL, backed_up INTEGER NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), credential_id TEXT NOT NULL REFERENCES credentials(id), expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS tickets(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), actor_session TEXT, kind TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, value TEXT NOT NULL, user_id TEXT, actor_session TEXT, kind TEXT NOT NULL, scope TEXT, expires INTEGER NOT NULL, epoch INTEGER);
      CREATE TABLE IF NOT EXISTS grants(hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, scope TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, operation TEXT NOT NULL, success INTEGER NOT NULL);`);
  }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  close() { this.db.close(); }
  audit(operation, success) {
    this.run('INSERT INTO audit(at,operation,success) VALUES(?,?,?)', this.now(), operation, success ? 1 : 0);
    this.run('DELETE FROM audit WHERE id <= (SELECT COALESCE(MAX(id),0)-1000 FROM audit)');
  }
  session(raw) {
    return need(this.get(`SELECT s.*,u.role FROM sessions s JOIN users u ON u.id=s.user_id JOIN credentials c ON c.id=s.credential_id
      WHERE s.hash=? AND s.expires>? AND s.revoked=0 AND u.state='active' AND c.state='active'`, hash(raw), this.now()));
  }
  activeSessionHash(value) {
    return need(this.get(`SELECT s.*,u.role FROM sessions s JOIN users u ON u.id=s.user_id JOIN credentials c ON c.id=s.credential_id
      WHERE s.hash=? AND s.expires>? AND s.revoked=0 AND u.state='active' AND c.state='active'`, value, this.now()));
  }
  fresh(raw, grant, scope, owner = false) {
    const s = this.session(raw); if (owner) need(s.role === 'owner');
    need(this.run('DELETE FROM grants WHERE hash=? AND session_hash=? AND scope=? AND expires>?', hash(grant), s.hash, scope, this.now()).changes === 1);
    return s;
  }
  issueTicket(user, kind, actor = null) {
    const secret = token();
    this.run('INSERT INTO tickets VALUES(?,?,?,?,?)', hash(secret), user, actor, kind, this.now() + 600_000);
    return secret;
  }
  bootstrap() {
    return this.tx(() => {
      const existing = this.all('SELECT * FROM users');
      if (existing.length) {
        need(existing.length === 1 && existing[0].state === 'pending' && existing[0].role === 'owner');
        need(this.get('SELECT COUNT(*) n FROM credentials').n === 0);
        need(this.get('SELECT COUNT(*) n FROM tickets WHERE expires>?', this.now()).n === 0);
        need(this.get('SELECT COUNT(*) n FROM challenges WHERE expires>?', this.now()).n === 0);
        this.run('DELETE FROM tickets'); this.run('DELETE FROM challenges');
        return { userId: existing[0].id, enrollmentTicket: this.issueTicket(existing[0].id, 'bootstrap') };
      }
      const id = randomUUID(); this.run("INSERT INTO users(id,role,state) VALUES(?,'owner','pending')", id);
      return { userId: id, enrollmentTicket: this.issueTicket(id, 'bootstrap') };
    });
  }
  async registerBegin({ ticket, grant }, raw) {
    const context = this.tx(() => {
      if (ticket) {
        const t = need(this.get('SELECT * FROM tickets WHERE hash=? AND expires>?', hash(ticket), this.now()));
        if (t.actor_session) { const actor = this.activeSessionHash(t.actor_session); need(actor.role === 'owner'); }
        this.run('DELETE FROM tickets WHERE hash=?', hash(ticket));
        return { user: t.user_id, actor: t.actor_session, kind: t.kind };
      }
      const s = this.fresh(raw, grant, 'credential');
      return { user: s.user_id, actor: s.hash, kind: 'add' };
    });
    const user = need(this.get("SELECT * FROM users WHERE id=? AND state!='disabled'", context.user));
    const options = await generateRegistrationOptions({ rpName: 'DIANA LAB Admin', rpID: 'localhost', userID: Buffer.from(user.id), userName: user.id,
      attestationType: 'none', supportedAlgorithmIDs: [-7], authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: this.all('SELECT id FROM credentials WHERE user_id=?', user.id) });
    const id = token();
    this.run('INSERT INTO challenges VALUES(?,?,?,?,?,?,?,?)', id, options.challenge, user.id, context.actor, 'register', context.kind, this.now() + 120_000, user.epoch);
    return { ceremonyId: id, options };
  }
  takeChallenge(id, kind) {
    return this.tx(() => {
      const c = need(this.get('SELECT * FROM challenges WHERE id=?', id));
      this.run('DELETE FROM challenges WHERE id=?', id);
      // Delete before checking expiration: even invalid submissions consume their ceremony.
      return c;
    });
  }
  checkChallenge(c, kind) { need(c.kind === kind && c.expires > this.now()); }
  async registerFinish({ ceremonyId, response }) {
    const c = this.takeChallenge(ceremonyId); this.checkChallenge(c, 'register');
    checkClient(response);
    const v = await verifyRegistrationResponse({ response, expectedChallenge: c.value, expectedOrigin: this.origin, expectedRPID: 'localhost', requireUserVerification: true, supportedAlgorithmIDs: [-7] });
    need(v.verified);
    return this.tx(() => {
      this.checkChallenge(c, 'register');
      if (c.actor_session) { const actor = this.activeSessionHash(c.actor_session); need(c.scope === 'add' ? actor.user_id === c.user_id : actor.role === 'owner'); }
      const u = need(this.get("SELECT * FROM users WHERE id=? AND state!='disabled' AND epoch=?", c.user_id, c.epoch));
      const info = v.registrationInfo, key = info.credential;
      this.run("INSERT INTO credentials VALUES(?,?,?,?,?,?,'active',?)", key.id, u.id, key.publicKey, key.counter, info.credentialDeviceType, info.credentialBackedUp ? 1 : 0, this.now());
      this.run("UPDATE users SET state='active' WHERE id=?", u.id);
      if (c.scope === 'recovery') this.run('DELETE FROM recovery WHERE user_id=?', u.id);
      return { registered: true, userId: u.id, credentialId: key.id };
    });
  }
  async loginBegin({ scope } = {}, raw) {
    let s; if (scope) { need(scopes.has(scope)); s = this.session(raw); }
    const options = await generateAuthenticationOptions({ rpID: 'localhost', userVerification: 'required', ...(s ? { allowCredentials: this.all("SELECT id FROM credentials WHERE user_id=? AND state='active'", s.user_id) } : {}) });
    const id = token(); this.run('INSERT INTO challenges VALUES(?,?,?,?,?,?,?,NULL)', id, options.challenge, s?.user_id || null, s?.hash || null, 'login', scope || null, this.now() + 120_000);
    return { ceremonyId: id, options };
  }
  async loginFinish({ ceremonyId, response }, raw) {
    const c = this.takeChallenge(ceremonyId); this.checkChallenge(c, 'login');
    checkClient(response);
    if (c.actor_session) need(this.session(raw).hash === c.actor_session);
    const key = need(this.get("SELECT * FROM credentials WHERE id=? AND state='active'", response?.id));
    need(!c.user_id || key.user_id === c.user_id);
    if (response.response.userHandle) need(response.response.userHandle === Buffer.from(key.user_id).toString('base64url'));
    const v = await verifyAuthenticationResponse({ response, expectedChallenge: c.value, expectedOrigin: this.origin, expectedRPID: 'localhost', requireUserVerification: true,
      credential: { id: key.id, publicKey: new Uint8Array(key.public_key), counter: key.counter } });
    need(v.verified);
    return this.tx(() => {
      this.checkChallenge(c, 'login');
      need(this.get("SELECT id FROM credentials WHERE id=? AND state='active' AND counter=?", key.id, key.counter));
      need(this.get("SELECT id FROM users WHERE id=? AND state='active'", key.user_id));
      this.run('UPDATE credentials SET counter=?,backed_up=? WHERE id=?', v.authenticationInfo.newCounter, v.authenticationInfo.credentialBackedUp ? 1 : 0, key.id);
      const secret = token();
      if (c.actor_session) {
        need(this.session(raw).hash === c.actor_session);
        this.run('INSERT INTO grants VALUES(?,?,?,?)', hash(secret), c.actor_session, c.scope, this.now() + 60_000);
        return { grant: secret, expiresIn: 60 };
      }
      this.run('INSERT INTO sessions VALUES(?,?,?,?,0)', hash(secret), key.user_id, key.id, this.now() + 900_000);
      return { sessionToken: secret, expiresIn: 900 };
    });
  }
  preserveOwner() { need(this.get(`SELECT COUNT(*) n FROM users u WHERE role='owner' AND state='active' AND EXISTS(SELECT 1 FROM credentials c WHERE c.user_id=u.id AND c.state='active')`).n > 0); }
  manage(action, b, raw) {
    return this.tx(() => {
      const s = this.fresh(raw, b.grant, 'manage', true);
      if (action === 'invite') {
        need(roles.has(b.role)); const id = randomUUID(); this.run("INSERT INTO users(id,role,state) VALUES(?,?,'pending')", id, b.role);
        return { userId: id, enrollmentTicket: this.issueTicket(id, 'invite', s.hash) };
      }
      const target = need(this.get('SELECT * FROM users WHERE id=?', b.userId));
      if (action === 'role') { need(roles.has(b.role)); this.run('UPDATE users SET role=?,epoch=epoch+1 WHERE id=?', b.role, target.id); }
      else if (action === 'disable') this.run("UPDATE users SET state='disabled',epoch=epoch+1 WHERE id=?", target.id);
      else deny();
      this.preserveOwner();
      this.run('UPDATE sessions SET revoked=1 WHERE user_id=?', target.id);
      this.run('DELETE FROM tickets WHERE user_id=?', target.id);
      return { changed: true };
    });
  }
  revokeCredential(b, raw) {
    return this.tx(() => {
      const s = this.fresh(raw, b.grant, 'credential');
      const c = need(this.get("SELECT * FROM credentials WHERE id=? AND state='active'", b.credentialId));
      need(s.role === 'owner' || c.user_id === s.user_id);
      this.run("UPDATE credentials SET state='revoked' WHERE id=?", c.id); this.preserveOwner();
      this.run('UPDATE sessions SET revoked=1 WHERE credential_id=?', c.id);
      return { revoked: true };
    });
  }
  recoveryCodes(b, raw) {
    return this.tx(() => {
      const s = this.fresh(raw, b.grant, 'recovery'); const codes = [token(), token()];
      this.run('DELETE FROM recovery WHERE user_id=?', s.user_id);
      for (const code of codes) this.run('INSERT INTO recovery VALUES(?,?)', hash(code), s.user_id);
      return { recoveryCodes: codes };
    });
  }
  // Offline operator CLI only. Never exposed by HTTP. Requires a previously issued code.
  recoverOffline(userId, code) {
    return this.tx(() => {
      need(this.get("SELECT id FROM users WHERE id=? AND state='active'", userId));
      need(this.run('DELETE FROM recovery WHERE user_id=? AND hash=?', userId, hash(code)).changes === 1);
      this.run('UPDATE users SET epoch=epoch+1 WHERE id=?', userId);
      this.run("UPDATE credentials SET state='revoked' WHERE user_id=?", userId);
      this.run('UPDATE sessions SET revoked=1 WHERE user_id=?', userId);
      this.run('DELETE FROM tickets WHERE user_id=?', userId);
      this.run('DELETE FROM challenges WHERE user_id=?', userId);
      return { enrollmentTicket: this.issueTicket(userId, 'recovery') };
    });
  }
  async dispatch(action, body = {}, raw) {
    const allowed = new Set(['register/begin','register/finish','login/begin','login/finish','list','invite','role','disable','credential/revoke','recovery/codes','session/revoke','logout']);
    need(allowed.has(action));
    try {
      let result;
      if (action === 'register/begin') result = await this.registerBegin(body, raw);
      else if (action === 'register/finish') result = await this.registerFinish(body);
      else if (action === 'login/begin') result = await this.loginBegin(body, raw);
      else if (action === 'login/finish') result = await this.loginFinish(body, raw);
      else if (['invite','role','disable'].includes(action)) result = this.manage(action, body, raw);
      else if (action === 'credential/revoke') result = this.revokeCredential(body, raw);
      else if (action === 'recovery/codes') result = this.recoveryCodes(body, raw);
      else if (action === 'list') {
        const s = this.session(raw);
        result = { me: { id: s.user_id, role: s.role }, users: s.role === 'owner' ? this.all('SELECT id,role,state FROM users') : [],
          credentials: s.role === 'owner' ? this.all('SELECT id,user_id,device_type,backed_up,state FROM credentials') : this.all('SELECT id,user_id,device_type,backed_up,state FROM credentials WHERE user_id=?', s.user_id),
          sessions: this.all('SELECT hash,credential_id,expires,revoked FROM sessions WHERE user_id=?', s.user_id) };
      } else if (action === 'session/revoke') {
        result = this.tx(() => { const s = this.fresh(raw, body.grant, 'credential'); need(this.run('UPDATE sessions SET revoked=1 WHERE hash=? AND user_id=?', body.sessionId, s.user_id).changes === 1); return { revoked: true }; });
      } else { const s = this.session(raw); this.run('UPDATE sessions SET revoked=1 WHERE hash=?', s.hash); result = { loggedOut: true }; }
      this.audit(action, true); return result;
    } catch { this.audit(action, false); throw Error('DENIED'); }
  }
}
