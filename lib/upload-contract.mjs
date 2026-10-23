export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const FORBIDDEN_NAME = /[<>:"/\\|?*\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

export const isUploadId = value => typeof value === 'string' && UUID.test(value);

/** A received name is display metadata, never a path or an instruction. */
export function validateUploadMetadata(value) {
  const { filename, sha256, bytes } = value || {};
  if (typeof filename !== 'string' || filename.length < 1 || filename.length > 180 ||
      FORBIDDEN_NAME.test(filename) || filename.startsWith('.') || /[. ]$/.test(filename) ||
      WINDOWS_DEVICE.test(filename)) {
    throw new Error('파일명을 확인하세요. 경로·제어문자·예약된 파일명은 사용할 수 없습니다.');
  }
  if (typeof sha256 !== 'string' || !HASH.test(sha256)) throw new Error('파일 해시를 확인하세요.');
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_UPLOAD_BYTES) throw new Error('파일은 비어 있지 않은 10MB 이하 파일이어야 합니다.');
  return { filename, sha256, bytes };
}
