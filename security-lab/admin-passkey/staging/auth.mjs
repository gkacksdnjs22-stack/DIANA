import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(String(value || '')).digest('hex');
const deny = () => {
  throw Error('DENIED');
};
const need = value => {
  if (!value) deny();
  return value;
};
const scopes = new Set(['manage', 'credential', 'recovery', 'cleanup']);
const roles = new Set(['owner', 'admin', 'auditor']);
function checkClient(response) {
  const data = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString());
  need(data.crossOrigin !== true && data.topOrigin === undefined);
}

// Isolated staging port of the reviewed lab policy. Database access is async.
export class StagingAdminAuth {
  constructor({
    store,
    origin,
    rpID,
    now = Date.now
  }) {
    this.store = store;
    this.origin = origin;
    this.rpID = rpID;
    this.now = now;
  }
  async get(sql, ...args) {
    return this.store.get(sql, ...args);
  }
  async all(sql, ...args) {
    return this.store.all(sql, ...args);
  }
  async run(sql, ...args) {
    return this.store.run(sql, ...args);
  }
  async tx(fn) {
    return this.store.tx(fn);
  }
  async close() {
    return this.store.close();
  }
  async audit(operation, success) {
    await this.run('INSERT INTO audit(at,operation,success) VALUES(?,?,?)', this.now(), operation, success ? 1 : 0);
    await this.run('DELETE FROM audit WHERE id <= (SELECT COALESCE(MAX(id),0)-1000 FROM audit)');
  }
  async session(raw) {
    return await this.activeSessionHash(hash(raw));
  }
  async activeSessionHash(value) {
    // Sessions issued before authentication provenance was recorded fail closed.
    return need(await this.get(`SELECT s.*,u.role,m.webauthn_at,m.absolute_expires,m.kind FROM sessions s JOIN users u ON u.id=s.user_id JOIN credentials c ON c.id=s.credential_id JOIN session_authentication m ON m.session_hash=s.hash
      WHERE s.hash=? AND s.expires>? AND m.absolute_expires>? AND s.revoked=0 AND u.state='active' AND c.state='active'`, value, this.now(), this.now()));
  }
  async fresh(raw, grant, scope, owner = false) {
    const s = await this.session(raw);
    if (owner) need(s.role === 'owner');
    need((await this.run('DELETE FROM grants WHERE hash=? AND session_hash=? AND scope=? AND expires>?', hash(grant), s.hash, scope, this.now())).changes === 1);
    return s;
  }
  async issueTicket(user, kind, actor = null) {
    const secret = token();
    await this.run('INSERT INTO tickets VALUES(?,?,?,?,?)', hash(secret), user, actor, kind, this.now() + 600_000);
    return secret;
  }
  async bootstrap() {
    return await this.tx(async () => {
      const existing = await this.all('SELECT * FROM users');
      if (existing.length) {
        need(existing.length === 1 && existing[0].state === 'pending' && existing[0].role === 'owner');
        need((await this.get('SELECT COUNT(*) n FROM credentials')).n === 0);
        need((await this.get('SELECT COUNT(*) n FROM tickets WHERE expires>?', this.now())).n === 0);
        need((await this.get('SELECT COUNT(*) n FROM challenges WHERE expires>?', this.now())).n === 0);
        await this.run('DELETE FROM tickets');
        await this.run('DELETE FROM challenges');
        return {
          userId: existing[0].id,
          enrollmentTicket: await this.issueTicket(existing[0].id, 'bootstrap')
        };
      }
      const id = randomUUID();
      await this.run("INSERT INTO users(id,role,state) VALUES(?,'owner','pending')", id);
      return {
        userId: id,
        enrollmentTicket: await this.issueTicket(id, 'bootstrap')
      };
    });
  }
  async registerBegin({
    ticket,
    grant
  }, raw) {
    const context = await this.tx(async () => {
      if (ticket) {
        const t = need(await this.get('SELECT * FROM tickets WHERE hash=? AND expires>?', hash(ticket), this.now()));
        if (t.actor_session) {
          const actor = await this.activeSessionHash(t.actor_session);
          need(actor.role === 'owner');
        }
        await this.run('DELETE FROM tickets WHERE hash=?', hash(ticket));
        return {
          user: t.user_id,
          actor: t.actor_session,
          kind: t.kind
        };
      }
      const s = await this.fresh(raw, grant, 'credential');
      return {
        user: s.user_id,
        actor: s.hash,
        kind: 'add'
      };
    });
    const user = need(await this.get("SELECT * FROM users WHERE id=? AND state!='disabled'", context.user));
    const options = await generateRegistrationOptions({
      rpName: 'DIANA HTTPS STAGE Admin',
      rpID: this.rpID,
      userID: Buffer.from(user.id),
      userName: user.id,
      attestationType: 'none',
      supportedAlgorithmIDs: [-7],
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required'
      },
      excludeCredentials: await this.all('SELECT id FROM credentials WHERE user_id=?', user.id)
    });
    const id = token();
    await this.run('INSERT INTO challenges VALUES(?,?,?,?,?,?,?,?)', id, options.challenge, user.id, context.actor, 'register', context.kind, this.now() + 120_000, user.epoch);
    return {
      ceremonyId: id,
      options
    };
  }
  async takeChallenge(id, kind) {
    return await this.tx(async () => {
      const c = need(await this.get('SELECT * FROM challenges WHERE id=?', id));
      await this.run('DELETE FROM challenges WHERE id=?', id);
      // Delete before checking expiration: even invalid submissions consume their ceremony.
      return c;
    });
  }
  checkChallenge(c, kind) {
    need(c.kind === kind && c.expires > this.now());
  }
  async registerFinish({
    ceremonyId,
    response
  }) {
    const c = await this.takeChallenge(ceremonyId);
    this.checkChallenge(c, 'register');
    checkClient(response);
    const v = await verifyRegistrationResponse({
      response,
      expectedChallenge: c.value,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7]
    });
    need(v.verified);
    return await this.tx(async () => {
      this.checkChallenge(c, 'register');
      if (c.actor_session) {
        const actor = await this.activeSessionHash(c.actor_session);
        need(c.scope === 'add' ? actor.user_id === c.user_id : actor.role === 'owner');
      }
      const u = need(await this.get("SELECT * FROM users WHERE id=? AND state!='disabled' AND epoch=?", c.user_id, c.epoch));
      const info = v.registrationInfo,
        key = info.credential;
      await this.run("INSERT INTO credentials VALUES(?,?,?,?,?,?,'active',?)", key.id, u.id, key.publicKey, key.counter, info.credentialDeviceType, info.credentialBackedUp ? 1 : 0, this.now());
      await this.run("UPDATE users SET state='active' WHERE id=?", u.id);
      if (c.scope === 'recovery') await this.run('DELETE FROM recovery WHERE user_id=?', u.id);
      return {
        registered: true,
        userId: u.id,
        credentialId: key.id
      };
    });
  }
  async loginBegin({
    scope
  } = {}, raw) {
    let s;
    if (scope) {
      need(scopes.has(scope));
      s = await this.session(raw);
    }
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: 'required',
      ...(s ? {
        allowCredentials: await this.all("SELECT id FROM credentials WHERE user_id=? AND state='active'", s.user_id)
      } : {})
    });
    const id = token();
    await this.run('INSERT INTO challenges VALUES(?,?,?,?,?,?,?,NULL)', id, options.challenge, s?.user_id || null, s?.hash || null, 'login', scope || null, this.now() + 120_000);
    return {
      ceremonyId: id,
      options
    };
  }
  async loginFinish({
    ceremonyId,
    response
  }, raw) {
    const c = await this.takeChallenge(ceremonyId);
    this.checkChallenge(c, 'login');
    checkClient(response);
    if (c.actor_session) need((await this.session(raw)).hash === c.actor_session);
    const key = need(await this.get("SELECT * FROM credentials WHERE id=? AND state='active'", response?.id));
    need(!c.user_id || key.user_id === c.user_id);
    if (response.response.userHandle) need(response.response.userHandle === Buffer.from(key.user_id).toString('base64url'));
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: c.value,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      requireUserVerification: true,
      credential: {
        id: key.id,
        publicKey: new Uint8Array(key.public_key),
        counter: key.counter
      }
    });
    need(v.verified);
    return await this.tx(async () => {
      this.checkChallenge(c, 'login');
      need(await this.get("SELECT id FROM credentials WHERE id=? AND state='active' AND counter=?", key.id, key.counter));
      need(await this.get("SELECT id FROM users WHERE id=? AND state='active'", key.user_id));
      await this.run('UPDATE credentials SET counter=?,backed_up=? WHERE id=?', v.authenticationInfo.newCounter, v.authenticationInfo.credentialBackedUp ? 1 : 0, key.id);
      const secret = token();
      if (c.actor_session) {
        need((await this.session(raw)).hash === c.actor_session);
        await this.run('INSERT INTO grants VALUES(?,?,?,?)', hash(secret), c.actor_session, c.scope, this.now() + 60_000);
        return {
          grant: secret,
          expiresIn: 60
        };
      }
      const authenticatedAt = this.now(),
        absoluteExpires = authenticatedAt + 900_000;
      await this.run('INSERT INTO sessions VALUES(?,?,?,?,0)', hash(secret), key.user_id, key.id, absoluteExpires);
      await this.run('INSERT INTO session_authentication VALUES(?,?,?,?)', hash(secret), authenticatedAt, absoluteExpires, 'webauthn');
      return {
        sessionToken: secret,
        expiresIn: 900
      };
    });
  }
  async preserveOwner() {
    need((await this.get(`SELECT COUNT(*) n FROM users u WHERE role='owner' AND state='active' AND EXISTS(SELECT 1 FROM credentials c WHERE c.user_id=u.id AND c.state='active')`)).n > 0);
  }
  async manage(action, b, raw) {
    return await this.tx(async () => {
      const s = await this.fresh(raw, b.grant, 'manage', true);
      if (action === 'invite') {
        need(roles.has(b.role));
        const id = randomUUID();
        await this.run("INSERT INTO users(id,role,state) VALUES(?,?,'pending')", id, b.role);
        return {
          userId: id,
          enrollmentTicket: await this.issueTicket(id, 'invite', s.hash)
        };
      }
      const target = need(await this.get('SELECT * FROM users WHERE id=?', b.userId));
      if (action === 'role') {
        need(roles.has(b.role));
        await this.run('UPDATE users SET role=?,epoch=epoch+1 WHERE id=?', b.role, target.id);
      } else if (action === 'disable') await this.run("UPDATE users SET state='disabled',epoch=epoch+1 WHERE id=?", target.id);else deny();
      await this.preserveOwner();
      await this.run('UPDATE sessions SET revoked=1 WHERE user_id=?', target.id);
      await this.run('DELETE FROM tickets WHERE user_id=?', target.id);
      return {
        changed: true
      };
    });
  }
  async revokeCredential(b, raw) {
    return await this.tx(async () => {
      const s = await this.fresh(raw, b.grant, 'credential');
      const c = need(await this.get("SELECT * FROM credentials WHERE id=? AND state='active'", b.credentialId));
      need(s.role === 'owner' || c.user_id === s.user_id);
      await this.run("UPDATE credentials SET state='revoked' WHERE id=?", c.id);
      await this.preserveOwner();
      await this.run('UPDATE sessions SET revoked=1 WHERE credential_id=?', c.id);
      return {
        revoked: true
      };
    });
  }
  async purgeAccounts({userIds, grant}, raw) {
    return this.tx(async () => {
      const actor = await this.fresh(raw, grant, 'cleanup', true);
      need(Array.isArray(userIds) && userIds.length > 0 && userIds.length <= 50);
      need(new Set(userIds).size === userIds.length);
      for (const id of userIds) {
        need(typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
        const target = need(await this.get('SELECT id,role FROM users WHERE id=?', id));
        // Protect every owner, including another owner, regardless of client UI state.
        need(target.id !== actor.user_id && target.role !== 'owner');
      }
      const counts = {accounts:0, credentials:0, sessions:0};
      // All target checks, grant consumption, deletion and success audit commit together.
      for (const id of userIds) {
        await this.run('DELETE FROM native_codes WHERE source IN (SELECT hash FROM sessions WHERE user_id=?)', id);
        await this.run('DELETE FROM grants WHERE session_hash IN (SELECT hash FROM sessions WHERE user_id=?)', id);
        await this.run('DELETE FROM challenges WHERE user_id=? OR actor_session IN (SELECT hash FROM sessions WHERE user_id=?)', id, id);
        await this.run('DELETE FROM tickets WHERE user_id=? OR actor_session IN (SELECT hash FROM sessions WHERE user_id=?)', id, id);
        await this.run('DELETE FROM session_authentication WHERE session_hash IN (SELECT hash FROM sessions WHERE user_id=?)', id);
        counts.sessions += (await this.run('DELETE FROM sessions WHERE user_id=?', id)).changes;
        counts.credentials += (await this.run('DELETE FROM credentials WHERE user_id=?', id)).changes;
        await this.run('DELETE FROM recovery WHERE user_id=?', id);
        counts.accounts += (await this.run('DELETE FROM users WHERE id=?', id)).changes;
      }
      await this.preserveOwner();
      await this.audit('accounts/purge', true);
      return {deleted:true, ...counts};
    });
  }
  async recoveryCodes(b, raw) {
    return await this.tx(async () => {
      const s = await this.fresh(raw, b.grant, 'recovery');
      const codes = [token(), token()];
      await this.run('DELETE FROM recovery WHERE user_id=?', s.user_id);
      for (const code of codes) await this.run('INSERT INTO recovery VALUES(?,?)', hash(code), s.user_id);
      return {
        recoveryCodes: codes
      };
    });
  }
  // Offline operator CLI only. Never exposed by HTTP. Requires a previously issued code.
  async recoverOffline(userId, code) {
    return await this.tx(async () => {
      need(await this.get("SELECT id FROM users WHERE id=? AND state='active'", userId));
      need((await this.run('DELETE FROM recovery WHERE user_id=? AND hash=?', userId, hash(code))).changes === 1);
      await this.run('UPDATE users SET epoch=epoch+1 WHERE id=?', userId);
      await this.run("UPDATE credentials SET state='revoked' WHERE user_id=?", userId);
      await this.run('UPDATE sessions SET revoked=1 WHERE user_id=?', userId);
      await this.run('DELETE FROM tickets WHERE user_id=?', userId);
      await this.run('DELETE FROM challenges WHERE user_id=?', userId);
      return {
        enrollmentTicket: await this.issueTicket(userId, 'recovery')
      };
    });
  }
  async dispatch(action, body = {}, raw) {
    const allowed = new Set(['register/begin', 'register/finish', 'login/begin', 'login/finish', 'list', 'invite', 'role', 'disable', 'accounts/purge', 'credential/revoke', 'recovery/codes', 'session/revoke', 'logout']);
    need(allowed.has(action));
    try {
      let result;
      if (action === 'accounts/purge') return await this.purgeAccounts(body, raw);
      if (action === 'register/begin') result = await this.registerBegin(body, raw);else if (action === 'register/finish') result = await this.registerFinish(body);else if (action === 'login/begin') result = await this.loginBegin(body, raw);else if (action === 'login/finish') result = await this.loginFinish(body, raw);else if (['invite', 'role', 'disable'].includes(action)) result = await this.manage(action, body, raw);else if (action === 'credential/revoke') result = await this.revokeCredential(body, raw);else if (action === 'recovery/codes') result = await this.recoveryCodes(body, raw);else if (action === 'list') {
        const s = await this.session(raw);
        result = {
          me: {
            id: s.user_id,
            role: s.role
          },
          users: s.role === 'owner' ? await this.all('SELECT id,role,state FROM users') : [],
          credentials: s.role === 'owner' ? await this.all('SELECT id,user_id,device_type,backed_up,state FROM credentials') : await this.all('SELECT id,user_id,device_type,backed_up,state FROM credentials WHERE user_id=?', s.user_id),
          sessions: await this.all('SELECT hash,credential_id,expires,revoked FROM sessions WHERE user_id=?', s.user_id)
        };
      } else if (action === 'session/revoke') {
        result = await this.tx(async () => {
          const s = await this.fresh(raw, body.grant, 'credential');
          need((await this.run('UPDATE sessions SET revoked=1 WHERE hash=? AND user_id=?', body.sessionId, s.user_id)).changes === 1);
          return {
            revoked: true
          };
        });
      } else {
        const s = await this.session(raw);
        await this.run('UPDATE sessions SET revoked=1 WHERE hash=?', s.hash);
        result = {
          loggedOut: true
        };
      }
      await this.audit(action, true);
      return result;
    } catch {
      await this.audit(action, false);
      throw Error('DENIED');
    }
  }
}
