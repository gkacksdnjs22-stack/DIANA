import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const PACKAGE_NAME = 'kr.nightdesk.phone';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_MARGIN_MS = 60_000;

class FirebasePushError extends Error {
  constructor(code, message, unregistered = false) {
    super(message);
    this.name = 'FirebasePushError';
    this.code = code;
    if (unregistered) this.unregistered = true;
  }
}

const configError = message => new FirebasePushError('FIREBASE_CONFIG', message);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasText = value => typeof value === 'string' && value.trim().length > 0;

async function readConfig(env, jsonName, fileName, readFileImpl) {
  const direct = env[jsonName], file = env[fileName];
  if ((direct !== undefined && typeof direct !== 'string') || (file !== undefined && typeof file !== 'string')) {
    throw configError('Firebase 설정 환경변수는 문자열이어야 합니다.');
  }
  if (hasText(direct) && hasText(file)) throw configError('Firebase JSON 설정과 파일 설정 중 하나만 지정해 주세요.');
  if (!hasText(direct) && !hasText(file)) return null;
  let text;
  if (hasText(direct)) text = direct;
  else {
    try { text = await readFileImpl(file.trim(), 'utf8'); }
    catch { throw configError('Firebase 설정 파일을 읽을 수 없습니다.'); }
  }
  if (typeof text !== 'string' && !Buffer.isBuffer(text)) throw configError('Firebase 설정 파일 형식이 올바르지 않습니다.');
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw configError('Firebase 설정 파일이 너무 큽니다.');
  let value;
  try { value = JSON.parse(text.toString()); }
  catch { throw configError('Firebase 설정 JSON 형식이 올바르지 않습니다.'); }
  if (!isObject(value)) throw configError('Firebase 설정은 JSON 객체여야 합니다.');
  return value;
}

function validateConfig(account, android) {
  if (!account || !android) throw configError('Firebase 서비스 계정과 Android 설정을 함께 지정해 주세요.');
  const projectId = account.project_id;
  if (account.type !== 'service_account' || typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw configError('Firebase 서비스 계정의 프로젝트 설정이 올바르지 않습니다.');
  }
  if (typeof account.client_email !== 'string' || account.client_email.length > 254 ||
      !/^[A-Za-z0-9._%+-]+@[a-z0-9.-]+\.gserviceaccount\.com$/.test(account.client_email)) {
    throw configError('Firebase 서비스 계정 이메일이 올바르지 않습니다.');
  }
  if (account.private_key_id !== undefined && (typeof account.private_key_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(account.private_key_id))) {
    throw configError('Firebase 서비스 계정 키 식별자가 올바르지 않습니다.');
  }
  let privateKey;
  try {
    if (typeof account.private_key !== 'string' || account.private_key.length > 32768) throw new Error();
    privateKey = createPrivateKey(account.private_key);
    if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails.modulusLength < 2048) throw new Error();
  } catch { throw configError('Firebase 서비스 계정에는 2048비트 이상의 RSA 개인 키가 필요합니다.'); }

  if (!isObject(android.project_info) || android.project_info.project_id !== projectId) {
    throw configError('Firebase 서비스 계정과 Android 설정의 프로젝트가 일치하지 않습니다.');
  }
  const senderId = android.project_info.project_number;
  if (typeof senderId !== 'string' || !/^[1-9][0-9]{0,29}$/.test(senderId)) throw configError('Firebase Android 발신자 ID가 올바르지 않습니다.');
  const clients = Array.isArray(android.client) ? android.client.filter(client =>
    client?.client_info?.android_client_info?.package_name === PACKAGE_NAME) : [];
  if (clients.length !== 1) throw configError('Firebase Android 설정에서 DIANA 앱을 하나 지정해 주세요.');
  const client = clients[0], applicationId = client.client_info.mobilesdk_app_id;
  if (typeof applicationId !== 'string' || !/^1:[1-9][0-9]{0,29}:android:[A-Fa-f0-9]{1,128}$/.test(applicationId) || applicationId.split(':')[1] !== senderId) {
    throw configError('Firebase Android 앱 ID가 올바르지 않습니다.');
  }
  const apiKey = Array.isArray(client.api_key) ? client.api_key[0]?.current_key : undefined;
  if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(apiKey)) throw configError('Firebase Android API 키가 올바르지 않습니다.');
  return {
    publicConfig: Object.freeze({ enabled: true, applicationId, apiKey, projectId, senderId }),
    privateKey, clientEmail: account.client_email, keyId: account.private_key_id,
  };
}

function cancelBody(response) {
  try { response?.body?.cancel().catch(() => {}); } catch {}
}

async function readBoundedJson(response) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    cancelBody(response);
    throw new FirebasePushError('FIREBASE_RESPONSE', 'Firebase 응답 크기가 올바르지 않습니다.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new FirebasePushError('FIREBASE_RESPONSE', 'Firebase 응답 형식이 올바르지 않습니다.');
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        reader.cancel().catch(() => {});
        throw new FirebasePushError('FIREBASE_RESPONSE', 'Firebase 응답이 너무 큽니다.');
      }
      chunks.push(Buffer.from(next.value));
    }
    const value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
    if (!isObject(value)) throw new Error();
    return value;
  } catch (error) {
    if (error instanceof FirebasePushError) throw error;
    throw new FirebasePushError('FIREBASE_RESPONSE', 'Firebase 응답 형식이 올바르지 않습니다.');
  } finally { reader.releaseLock(); }
}

function createSender({ privateKey, clientEmail, keyId, publicConfig }, { fetchImpl, now }) {
  let cachedToken = null, tokenRequest = null;

  async function post(url, headers, body, onResponse = () => {}) {
    const controller = new AbortController(); let timeout;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new FirebasePushError('FIREBASE_TRANSPORT', 'Firebase 요청 시간이 초과되었습니다.'));
      }, REQUEST_TIMEOUT_MS);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'error', signal: controller.signal });
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          cancelBody(response);
          throw new FirebasePushError('FIREBASE_TRANSPORT', 'Firebase 요청의 리디렉션을 거부했습니다.');
        }
        onResponse(response.status);
        return { status: response.status, body: await readBoundedJson(response) };
      })()]);
    } catch (error) {
      if (error instanceof FirebasePushError) throw error;
      throw new FirebasePushError('FIREBASE_TRANSPORT', 'Firebase 연결 요청에 실패했습니다.');
    } finally { clearTimeout(timeout); }
  }

  async function fetchToken() {
    const issuedAt = now(), iat = Math.floor(issuedAt / 1000);
    if (!Number.isSafeInteger(iat) || iat < 0) throw new FirebasePushError('FIREBASE_AUTH', 'Firebase 인증 시간을 확인할 수 없습니다.');
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    let assertion;
    try {
      const header = { alg: 'RS256', typ: 'JWT', ...(keyId ? { kid: keyId } : {}) };
      const claims = { iss: clientEmail, scope: MESSAGING_SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 };
      const input = `${encode(header)}.${encode(claims)}`;
      assertion = `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
    } catch { throw new FirebasePushError('FIREBASE_AUTH', 'Firebase 인증 서명을 만들 수 없습니다.'); }
    const response = await post(TOKEN_URL, { 'Content-Type': 'application/x-www-form-urlencoded' },
      new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString());
    const token = response.body.access_token, lifetime = response.body.expires_in;
    if (response.status < 200 || response.status >= 300) throw new FirebasePushError('FIREBASE_AUTH', 'Firebase 서비스 계정 인증에 실패했습니다.');
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~+\/=-]{1,8192}$/.test(token) ||
        typeof response.body.token_type !== 'string' || response.body.token_type.toLowerCase() !== 'bearer' ||
        !Number.isInteger(lifetime) || lifetime <= 0 || lifetime > 3600) {
      throw new FirebasePushError('FIREBASE_AUTH', 'Firebase 인증 응답이 올바르지 않습니다.');
    }
    cachedToken = { value: token, expiresAt: issuedAt + lifetime * 1000 };
    return token;
  }

  async function accessToken() {
    if (cachedToken && cachedToken.expiresAt - now() > TOKEN_MARGIN_MS) return cachedToken.value;
    if (!tokenRequest) tokenRequest = fetchToken().finally(() => { tokenRequest = null; });
    return tokenRequest;
  }

  return Object.freeze({
    async send(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9:_-]{20,4096}$/.test(token)) {
        throw new FirebasePushError('FIREBASE_TOKEN', 'Firebase 기기 토큰 형식이 올바르지 않습니다.');
      }
      const authToken = await accessToken();
      const response = await post(`https://fcm.googleapis.com/v1/projects/${publicConfig.projectId}/messages:send`,
        { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        JSON.stringify({ message: { token, data: { type: 'files_ready' }, android: { priority: 'HIGH', ttl: '86400s', collapse_key: 'diana-files-ready' } } }),
        status => { if ((status === 401 || status === 403) && cachedToken?.value === authToken) cachedToken = null; });
      if (response.status < 200 || response.status >= 300) {
        if (response.status === 401 || response.status === 403 || response.body.error?.status === 'UNAUTHENTICATED') {
          if (cachedToken?.value === authToken) cachedToken = null;
        }
        const details = response.body.error?.details;
        const unregistered = Array.isArray(details) && details.some(detail => detail?.['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' && detail.errorCode === 'UNREGISTERED');
        throw new FirebasePushError('FIREBASE_SEND', 'Firebase 푸시 전송에 실패했습니다.', unregistered);
      }
      if (typeof response.body.name !== 'string' || !response.body.name.startsWith(`projects/${publicConfig.projectId}/messages/`) ||
          response.body.name.length > 1024 || response.body.name.length === `projects/${publicConfig.projectId}/messages/`.length || /[\x00-\x20\x7f]/.test(response.body.name)) {
        throw new FirebasePushError('FIREBASE_RESPONSE', 'Firebase 전송 확인 응답이 올바르지 않습니다.');
      }
      return { accepted: true };
    },
  });
}

// See Google's OAuth service-account flow and FCM HTTP v1 API documentation.
// https://developers.google.com/identity/protocols/oauth2/service-account
// https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages
export async function readFirebasePushOptions({ env = process.env, fetchImpl = fetch, now = Date.now, readFileImpl = readFile } = {}) {
  const account = await readConfig(env, 'FIREBASE_SERVICE_ACCOUNT_JSON', 'FIREBASE_SERVICE_ACCOUNT_FILE', readFileImpl);
  const android = await readConfig(env, 'FIREBASE_ANDROID_CONFIG_JSON', 'FIREBASE_ANDROID_CONFIG_FILE', readFileImpl);
  if (!account && !android) return { publicConfig: { enabled: false }, sender: null };
  const config = validateConfig(account, android);
  return { publicConfig: config.publicConfig, sender: createSender(config, { fetchImpl, now }) };
}
