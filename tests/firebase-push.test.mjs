import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { readFirebasePushOptions } from '../lib/firebase-push.mjs';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const PROJECT = 'diana-push-test';
const SENDER = '123456789012';
const DEVICE_TOKEN = 'fixture-device-token_' + 'a'.repeat(120);
const ACCESS_TOKEN = 'fixture-oauth-access-token';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = `https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`;
const SECRET_MARKER = 'never-include-upstream-secrets';
function serviceAccount() {
  return { type: 'service_account', project_id: PROJECT, client_email: `push@${PROJECT}.iam.gserviceaccount.com`, private_key_id: 'key-123', private_key: privatePem,
    token_uri: 'https://untrusted.invalid/do-not-contact', arbitrary_secret: SECRET_MARKER };
}
function androidConfig() {
  return { project_info: { project_id: PROJECT, project_number: SENDER, storage_bucket: 'not-public' }, client: [
    { client_info: { mobilesdk_app_id: `1:${SENDER}:android:1234abcd`, android_client_info: { package_name: 'kr.nightdesk.other' } }, api_key: [{ current_key: 'ignored-other-client-key' }] },
    { client_info: { mobilesdk_app_id: `1:${SENDER}:android:5678abcdef`, android_client_info: { package_name: 'kr.nightdesk.phone' } }, api_key: [{ current_key: 'AIza' + 'f'.repeat(35) }], extra_secret: SECRET_MARKER },
  ] };
}
function environment(account = serviceAccount(), android = androidConfig()) {
  return { FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(account), FIREBASE_ANDROID_CONFIG_JSON: JSON.stringify(android) };
}
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
const tokenResponse = (overrides = {}) => json({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600, ...overrides });
const sentResponse = () => json({ name: `projects/${PROJECT}/messages/fixture-1` });
function safeError(error, code) {
  assert.equal(error.name, 'FirebasePushError');
  assert.equal(error.code, code);
  for (const secret of [SECRET_MARKER, DEVICE_TOKEN, ACCESS_TOKEN, privatePem]) assert(!JSON.stringify(error).includes(secret));
  assert(!error.message.includes(SECRET_MARKER));
  assert.equal(error.cause, undefined);
  return true;
}

test('Firebase remains disabled when neither configuration is supplied', async () => {
  const result = await readFirebasePushOptions({ env: {}, fetchImpl: () => assert.fail('network not expected') });
  assert.deepEqual(result, { publicConfig: { enabled: false }, sender: null });
  assert.deepEqual(await readFirebasePushOptions({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: ' ', FIREBASE_ANDROID_CONFIG_FILE: '' } }), result);
});

test('Firebase rejects partial, malformed and ambiguous config without leaking input or paths', async () => {
  const cases = [
    { FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount()) },
    { FIREBASE_ANDROID_CONFIG_JSON: JSON.stringify(androidConfig()) },
    { ...environment(), FIREBASE_SERVICE_ACCOUNT_JSON: SECRET_MARKER },
    { ...environment(), FIREBASE_ANDROID_CONFIG_JSON: '[]' },
    { ...environment(), FIREBASE_SERVICE_ACCOUNT_FILE: SECRET_MARKER },
    { ...environment(), FIREBASE_ANDROID_CONFIG_JSON: 5 },
    { FIREBASE_SERVICE_ACCOUNT_FILE: SECRET_MARKER },
    { ...environment(), FIREBASE_SERVICE_ACCOUNT_JSON: ' '.repeat(1024 * 1024 + 1) + '{}' },
  ];
  for (const env of cases) await assert.rejects(readFirebasePushOptions({ env, readFileImpl: async () => { throw new Error(SECRET_MARKER); } }), e => safeError(e, 'FIREBASE_CONFIG'));
});

test('Firebase accepts file configurations and returns only allowlisted Android public fields', async () => {
  const reads = [];
  const result = await readFirebasePushOptions({ env: { FIREBASE_SERVICE_ACCOUNT_FILE: 'service.json', FIREBASE_ANDROID_CONFIG_FILE: 'google-services.json' },
    readFileImpl: async (path, encoding) => { reads.push([path, encoding]); return JSON.stringify(path === 'service.json' ? serviceAccount() : androidConfig()); } });
  assert.deepEqual(reads, [['service.json', 'utf8'], ['google-services.json', 'utf8']]);
  assert.deepEqual(result.publicConfig, { enabled: true, applicationId: `1:${SENDER}:android:5678abcdef`, apiKey: 'AIza' + 'f'.repeat(35), projectId: PROJECT, senderId: SENDER });
  assert.equal(typeof result.sender.send, 'function');
  const serialized = JSON.stringify(result);
  for (const value of [SECRET_MARKER, 'private_key', 'client_email', 'storage_bucket', 'ignored-other-client-key']) assert(!serialized.includes(value));
});

test('Firebase validates matching project, exact Android package, app sender and safe identifiers', async () => {
  const cases = [
    [a => { a.project_id = '../secrets'; }, () => {}],
    [a => { a.client_email = 'bad\r\n' + SECRET_MARKER; }, () => {}],
    [a => { a.private_key_id = SECRET_MARKER + '\n'; }, () => {}],
    [() => {}, a => { a.project_info.project_id = 'different-project'; }],
    [() => {}, a => { a.project_info.project_number = 123; }],
    [() => {}, a => { a.client[1].client_info.android_client_info.package_name = 'kr.nightdesk.other'; }],
    [() => {}, a => { a.client.push(a.client[1]); }],
    [() => {}, a => { a.client[1].client_info.mobilesdk_app_id = '1:999:android:abcd'; }],
    [() => {}, a => { a.client[1].api_key[0].current_key = '\n' + SECRET_MARKER; }],
  ];
  for (const [editAccount, editAndroid] of cases) {
    const account = serviceAccount(), android = androidConfig(); editAccount(account); editAndroid(android);
    await assert.rejects(readFirebasePushOptions({ env: environment(account, android) }), e => safeError(e, 'FIREBASE_CONFIG'));
  }
});

test('Firebase rejects malformed, non-RSA and undersized RSA private keys', async () => {
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  for (const private_key of [SECRET_MARKER, weak.privateKey.export({ type: 'pkcs8', format: 'pem' }), ec.privateKey.export({ type: 'pkcs8', format: 'pem' })]) {
    await assert.rejects(readFirebasePushOptions({ env: environment({ ...serviceAccount(), private_key }) }), e => safeError(e, 'FIREBASE_CONFIG'));
  }
});

test('Firebase signs scoped RS256 JWT and sends only a generic data wake-up to fixed endpoints', async () => {
  const requests = [], now = Date.parse('2026-10-23T09:00:00Z');
  const { sender } = await readFirebasePushOptions({ env: environment(), now: () => now, fetchImpl: async (url, init) => {
    requests.push({ url, init }); assert.equal(init.redirect, 'error'); assert(init.signal instanceof AbortSignal); assert.equal(init.method, 'POST');
    return url === TOKEN_URL ? tokenResponse() : sentResponse();
  } });
  assert.deepEqual(await sender.send(DEVICE_TOKEN), { accepted: true });
  assert.deepEqual(requests.map(r => r.url), [TOKEN_URL, SEND_URL]);
  const parameters = new URLSearchParams(requests[0].init.body);
  assert.equal(parameters.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [header, claims, signature] = parameters.get('assertion').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT', kid: 'key-123' });
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), { iss: serviceAccount().client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: TOKEN_URL, iat: now / 1000, exp: now / 1000 + 3600 });
  assert(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), keys.publicKey, Buffer.from(signature, 'base64url')));
  assert.equal(requests[1].init.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.deepEqual(JSON.parse(requests[1].init.body), { message: { token: DEVICE_TOKEN, data: { type: 'files_ready' }, android: { priority: 'HIGH', ttl: '86400s', collapse_key: 'diana-files-ready' } } });
});

test('Firebase reuses access token, shares concurrent refresh and renews before expiry', async () => {
  let now = 100000, oauthCalls = 0, sends = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const { sender } = await readFirebasePushOptions({ env: environment(), now: () => now, fetchImpl: async url => {
    if (url === TOKEN_URL) { oauthCalls++; await gate; return tokenResponse(); }
    sends++; return sentResponse();
  } });
  const first = sender.send(DEVICE_TOKEN), second = sender.send(DEVICE_TOKEN);
  await Promise.resolve(); assert.equal(oauthCalls, 1); release();
  await Promise.all([first, second]); assert.equal(sends, 2);
  await sender.send(DEVICE_TOKEN); assert.equal(oauthCalls, 1);
  now += 3600 * 1000 - 60 * 1000;
  await Promise.all([sender.send(DEVICE_TOKEN), sender.send(DEVICE_TOKEN)]); assert.equal(oauthCalls, 2);
});

test('Firebase refresh failure is not cached or retried automatically', async () => {
  let oauthCalls = 0;
  const { sender } = await readFirebasePushOptions({ env: environment(), fetchImpl: async url => {
    if (url === TOKEN_URL) { oauthCalls++; return oauthCalls === 1 ? json({ error: SECRET_MARKER }, 400) : tokenResponse(); }
    return sentResponse();
  } });
  await assert.rejects(sender.send(DEVICE_TOKEN), e => safeError(e, 'FIREBASE_AUTH'));
  assert.equal(oauthCalls, 1);
  await sender.send(DEVICE_TOKEN); assert.equal(oauthCalls, 2);
});

test('Firebase validates OAuth response schema without exposing upstream content', async () => {
  for (const edit of [
    body => { body.access_token = 'bad\r\n' + SECRET_MARKER; },
    body => { body.token_type = 1; },
    body => { body.token_type = 'Basic'; },
    body => { body.expires_in = 0; },
    body => { body.expires_in = '3600'; },
    body => { body.expires_in = 3601; },
  ]) {
    const body = { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600 }; edit(body);
    const { sender } = await readFirebasePushOptions({ env: environment(), fetchImpl: async () => json(body) });
    await assert.rejects(sender.send(DEVICE_TOKEN), e => safeError(e, 'FIREBASE_AUTH'));
  }
});

test('Firebase rejects invalid device tokens before any network request', async () => {
  const { sender } = await readFirebasePushOptions({ env: environment(), fetchImpl: () => assert.fail('network not expected') });
  for (const token of ['', 'short', 'x'.repeat(4097), DEVICE_TOKEN + '\n', null, 1]) {
    await assert.rejects(sender.send(token), e => safeError(e, 'FIREBASE_TOKEN'));
  }
});

test('Firebase never follows redirects or retries ambiguous network failures', async () => {
  for (const response of [() => { throw new Error(SECRET_MARKER); }, () => new Response('', { status: 302, headers: { location: 'https://untrusted.invalid' } }), () => ({ redirected: true, status: 200, body: null })]) {
    let calls = 0;
    const { sender } = await readFirebasePushOptions({ env: environment(), fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(sender.send(DEVICE_TOKEN), e => safeError(e, 'FIREBASE_TRANSPORT'));
    assert.equal(calls, 1);
  }
});

test('Firebase aborts a stalled request after ten seconds without retrying it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal, calls = 0;
  const { sender } = await readFirebasePushOptions({ env: environment(), fetchImpl: async (_, init) => {
    signal = init.signal; calls++;
    return new Promise(() => {});
  } });
  const pending = sender.send(DEVICE_TOKEN);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(9999); assert.equal(signal.aborted, false);
  t.mock.timers.tick(1); assert.equal(signal.aborted, true);
  await assert.rejects(pending, e => safeError(e, 'FIREBASE_TRANSPORT'));
  assert.equal(calls, 1);
});

test('Firebase treats a lost send response as ambiguous and leaves retry to its caller', async () => {
  let sends = 0;
  const { sender } = await readFirebasePushOptions({ env: environment(), fetchImpl: async url => {
    if (url === TOKEN_URL) return tokenResponse();
    sends++; throw new Error(SECRET_MARKER);
  } });
  await assert.rejects(sender.send(DEVICE_TOKEN), e => safeError(e, 'FIREBASE_TRANSPORT'));
  assert.equal(sends, 1);
});

test('Firebase bounds response bodies by header and streamed bytes and rejects malformed JSON', async () => {
  for (const response of [
    () => json({}, 200, { 'content-length': '65537' }),
    () => json({}, 200, { 'content-length': 'bad' }),
    () => new Response('x'.repeat(65537)),
    () => new Response(SECRET_MARKER),
    () => json([]),
    () => new Response(null, { status: 204 }),
  ]) {
    const { sender } = await readFirebasePushOptions({ env: environment(), fetchImpl: async () => response() });
    await assert.rejects(sender.send(DEVICE_TOKEN), e => safeError(e, 'FIREBASE_RESPONSE'));
  }
});

test('Firebase recognizes UNREGISTERED only inside the typed Google FcmError details', async () => {
  const details = { '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' };
  for (const [error, expected] of [
    [{ status: 'NOT_FOUND', details: [details], message: SECRET_MARKER }, true],
    [{ status: 'UNREGISTERED', message: SECRET_MARKER }, false],
    [{ details: [{ ...details, '@type': 'another.Error' }] }, false],
    [{ details: [{ ...details, errorCode: 'INVALID_ARGUMENT' }] }, false],
    [{ details: { errorCode: 'UNREGISTERED' } }, false],
  ]) {
    const { sender } = await readFirebasePushOptions({ env: environment(), fetchImpl: async url => url === TOKEN_URL ? tokenResponse() : json({ error }, 404) });
    await assert.rejects(sender.send(DEVICE_TOKEN), e => { safeError(e, 'FIREBASE_SEND'); assert.equal(e.unregistered, expected ? true : undefined); return true; });
  }
});

test('Firebase auth failure invalidates access cache for next attempt, including malformed auth error bodies', async () => {
  for (const failure of [() => json({ error: { status: 'UNAUTHENTICATED' } }, 401), () => new Response(SECRET_MARKER, { status: 403 })]) {
    let oauthCalls = 0, sends = 0;
    const { sender } = await readFirebasePushOptions({ env: environment(), fetchImpl: async url => {
      if (url === TOKEN_URL) { oauthCalls++; return tokenResponse({ access_token: `${ACCESS_TOKEN}-${oauthCalls}` }); }
      return ++sends === 1 ? failure() : sentResponse();
    } });
    await assert.rejects(sender.send(DEVICE_TOKEN), e => { assert(['FIREBASE_SEND', 'FIREBASE_RESPONSE'].includes(e.code)); return safeError(e, e.code); });
    assert.equal(oauthCalls, 1); assert.equal(sends, 1);
    await sender.send(DEVICE_TOKEN); assert.equal(oauthCalls, 2);
  }
});

test('Firebase ordinary send errors preserve the cached access token and never claim acceptance', async () => {
  let oauthCalls = 0, sends = 0;
  const { sender } = await readFirebasePushOptions({ env: environment(), fetchImpl: async url => {
    if (url === TOKEN_URL) { oauthCalls++; return tokenResponse(); }
    return ++sends === 1 ? json({ error: { message: SECRET_MARKER } }, 503) : sentResponse();
  } });
  await assert.rejects(sender.send(DEVICE_TOKEN), e => { assert.equal(e.unregistered, undefined); return safeError(e, 'FIREBASE_SEND'); });
  assert.equal(sends, 1);
  assert.deepEqual(await sender.send(DEVICE_TOKEN), { accepted: true }); assert.equal(oauthCalls, 1);
});

test('Firebase requires a project-specific message name before reporting accepted', async () => {
  for (const name of [undefined, SECRET_MARKER, `projects/other/messages/1`, `projects/${PROJECT}/messages/`, `projects/${PROJECT}/messages/bad\n`]) {
    const { sender } = await readFirebasePushOptions({ env: environment(), fetchImpl: async url => url === TOKEN_URL ? tokenResponse() : json({ name }) });
    await assert.rejects(sender.send(DEVICE_TOKEN), e => safeError(e, 'FIREBASE_RESPONSE'));
  }
});
