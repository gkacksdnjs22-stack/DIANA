import { createHash, randomUUID } from 'node:crypto';
import {publicKey} from './e2ee.mjs';

const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
export function pairingClaim(data) {
  if (!/^[a-f0-9-]{36}$/.test(data.requestId || '') || !/^[a-f0-9]{64}$/.test(data.pairKey || ''))
    fail(400, '앱을 업데이트한 뒤 새 연결 요청을 보내세요.');
  publicKey(data.publicKey);
  return createHash('sha256').update(JSON.stringify([data.requestId, data.pairKey,data.publicKey])).digest('hex');
}
export function pairingName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value))
    fail(400, '휴대폰 이름을 확인하세요.');
  return value.trim();
}
export function pendingPair(claim, deviceName, expiresAt,data) {
  return { id: randomUUID(), claim, deviceName: pairingName(deviceName), expiresAt, state: 'pending',publicKey:data.publicKey,requestId:data.requestId };
}
export function checkPair(entry, claim, now = Date.now()) {
  if (!entry || entry.claim !== claim || Date.parse(entry.expiresAt) <= now)
    fail(403, '연결 요청이 만료됐거나 변경되었습니다. 새 코드를 받으세요.');
  if (entry.state === 'denied') fail(403, 'PC에서 연결을 거절했습니다. 새 코드를 받으세요.');
  return entry.state === 'approved';
}
export function decidePair(entry, id, approve, now = Date.now()) {
  if (!entry || entry.id !== id || Date.parse(entry.expiresAt) <= now || typeof approve !== 'boolean')
    fail(409, '연결 요청이 만료됐거나 변경되었습니다.');
  const state = approve ? 'approved' : 'denied';
  if (entry.state !== 'pending' && entry.state !== state) fail(409, '이미 처리한 연결 요청입니다.');
  return {...entry, state};
}
export function visiblePair(entry, now = Date.now()) {
  return entry?.state === 'pending' && Date.parse(entry.expiresAt) > now
    ? { id: entry.id, deviceName: entry.deviceName, expiresAt: entry.expiresAt,publicKey:entry.publicKey,requestId:entry.requestId } : null;
}
