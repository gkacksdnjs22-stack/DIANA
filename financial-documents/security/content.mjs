// Return categories and counts only. Never retain or return matching values.
const rules = [
  ['PRIVATE_KEY', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/gu, true],
  ['API_TOKEN', /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{20,})/gu, true],
  ['CREDENTIAL', /["']?(?:api[_-]?key|private_key|client_secret|password|agent_token|user_token)["']?\s*[:=]\s*\S+/giu, true],
  ['RESIDENT_ID_PATTERN', /(?<!\d)\d{6}[ -]?[1-8]\d{6}(?!\d)/gu, false],
  ['EMAIL', /\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/gu, false],
  ['PHONE_PATTERN', /(?<!\d)(?:\+82[ -]?1[016789]|01[016789])[ -]?\d{3,4}[ -]?\d{4}(?!\d)/gu, false],
];
export function inspectContent(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2_000_000) throw Object.assign(Error('SECURITY_INPUT_LIMIT'), {code:'SECURITY_INPUT_LIMIT'});
  const findings = rules.flatMap(([category, pattern, secret]) => {
    const count = [...text.matchAll(pattern)].length;
    return count ? [{category, count, secret}] : [];
  });
  return {findings, containsSecret:findings.some(f => f.secret), requiresReviewBeforeTransfer:findings.length > 0, policyDecision:'NOT_EVALUATED'};
}
export const containsSecret = text => inspectContent(text).containsSecret;
