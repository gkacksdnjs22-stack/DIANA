import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const httpStatus = value => {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
  return typeof value === 'string' && /^[1-5]\d{2}$/.test(value) ? Number(value) : null;
};
function storageErrorMatches(error, expectedStatus, codes) {
  const status = httpStatus(error.status), legacyStatus = httpStatus(error.statusCode);
  // Older Storage responses used HTTP 400 with a more specific body status.
  // Authentication, rate-limit and server failures must still surface as errors.
  if (status !== null && status !== 400 && status !== expectedStatus) return false;
  if (legacyStatus !== null && legacyStatus !== expectedStatus) return false;
  // New SDK errors put symbolic codes in statusCode as well as in code.
  // Distinguish missing objects/duplicate objects from bucket/config errors.
  const code = typeof error.code === 'string' && httpStatus(error.code) === null ? error.code
    : typeof error.statusCode === 'string' && legacyStatus === null ? error.statusCode : null;
  return code !== null ? codes.includes(code) : (legacyStatus ?? status) === expectedStatus;
}

export function createLocalTransferStore(directory) {
  return {
    async read(name) { const path = join(directory, name); return existsSync(path) ? readFileSync(path) : null; },
    async put(name, bytes) {
      mkdirSync(directory, { recursive: true });
      const path = join(directory, name);
      if (existsSync(path)) {
        if (sha256(readFileSync(path)) !== sha256(bytes)) throw new Error('이미 다른 파일이 저장되었습니다.');
        return;
      }
      writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    },
    async remove(name) { const path = join(directory, name); if (existsSync(path)) unlinkSync(path); },
  };
}

/** All requests use the server's service-role key. Never expose it to phones. */
export function createSupabaseTransferStore({ url, serviceRoleKey, bucket = 'diana-transfers', fetch: fetchImpl }) {
  if (!/^https:\/\/[^/]+\.supabase\.co\/?$/.test(url || '') || !serviceRoleKey || !/^[a-z0-9-]+$/.test(bucket)) {
    throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET 설정을 확인하세요.');
  }
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });
  const storage = client.storage.from(bucket);
  const checkName = name => {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9-]+\.bin$/.test(name)) throw new Error('안전하지 않은 전송 파일 이름입니다.');
    return name;
  };
  return {
    async read(name) {
      const { data, error } = await storage.download(checkName(name));
      if (error) {
        if (storageErrorMatches(error, 404, ['NoSuchKey', 'not_found'])) return null;
        throw new Error('Supabase 파일 다운로드가 실패했습니다.', { cause: error });
      }
      return Buffer.from(await data.arrayBuffer());
    },
    async put(name, bytes) {
      checkName(name);
      const { error } = await storage.upload(name, bytes, { contentType: 'application/octet-stream', upsert: false });
      if (!error) return;
      if (!storageErrorMatches(error, 409, ['ResourceAlreadyExists', 'KeyAlreadyExists', 'already_exists'])) {
        throw new Error('Supabase 파일 업로드가 실패했습니다.', { cause: error });
      }
      const existing = await this.read(name);
      if (!existing || sha256(existing) !== sha256(bytes)) throw new Error('이미 다른 파일이 저장되었습니다.');
    },
    async remove(name) {
      const { error } = await storage.remove([checkName(name)]);
      if (error) throw new Error('Supabase 파일 만료 처리가 실패했습니다.', { cause: error });
    },
  };
}
