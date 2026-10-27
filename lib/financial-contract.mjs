// Public metadata only. Never pass a core plan/result to these constructors.
export const FINANCE_ACTIONS = ['checklist_review', 'patch', 'convert'];
export const FINANCE_FORMATS = ['md', 'txt', 'json'];
export const FINANCE_STATES = ['QUEUED', 'PROCESSING', 'PC_REVIEW_REQUIRED', 'WAITING_FOR_INFORMATION', 'LOCAL_SAVING', 'LOCAL_SAVE_COMPLETED', 'REVIEW_COMPLETED', 'CANCELLED', 'BLOCKED', 'FAILED', 'UNCERTAIN'];
export const FINANCE_CODES = ['PC_QUEUED', 'PC_PROCESSING', 'PC_CHECK_REQUIRED', 'PC_INFORMATION_REQUIRED', 'PC_SAVING', 'PC_SAVED', 'PC_REVIEWED', 'USER_CANCELLED', 'PC_REJECTED', 'LOCAL_CHECK_FAILED', 'LOCAL_OPERATION_FAILED', 'RECOVERY_REQUIRED', 'REQUEST_EXPIRED', 'POLICY_CHANGED', 'NO_CHANGE_REQUIRED'];
export const FINANCE_FINAL = new Set(['WAITING_FOR_INFORMATION', 'LOCAL_SAVE_COMPLETED', 'REVIEW_COMPLETED', 'CANCELLED', 'BLOCKED', 'FAILED', 'UNCERTAIN']);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function exact(value, fields) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(k => Object.hasOwn(value, k));
}
export function validTask(t) {
  return exact(t, ['id', 'label', 'actions', 'formats']) && UUID.test(t.id) &&
    typeof t.label === 'string' && /^[\p{L}\p{N} ()_-]{1,40}$/u.test(t.label) &&
    [t.actions, t.formats].every(a => Array.isArray(a) && a.length > 0 && new Set(a).size === a.length) &&
    t.actions.every(a => FINANCE_ACTIONS.includes(a)) && t.formats.every(f => FINANCE_FORMATS.includes(f));
}
export function publicTask(t) { return { id: t.id, label: t.label, actions: [...t.actions], formats: [...t.formats] }; }
export function publicFinanceJob(j) {
  return { id: j.id, taskId: j.taskId, action: j.action, format: j.format, state: j.state, code: j.code,
    saved: j.saved, reviewComplete: j.reviewComplete, revision: j.revision, createdAt: j.createdAt, updatedAt: j.updatedAt, expiresAt: j.expiresAt };
}
