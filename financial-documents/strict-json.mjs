// JSON.parse alone accepts duplicate keys. Parse the bounded JSON grammar first.
export const fail = code => { throw Object.assign(new Error(code), { code }); };
export function strictJSON(raw,maximum=2_000_000) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > maximum) fail('INVALID_JSON');
  let at = 0;
  const whitespace = () => { while (/[ \r\n\t]/u.test(raw[at] || 'x')) at++; };
  function string() {
    const start = at++;
    while (at < raw.length) {
      if (raw[at] === '\\') { at += 2; continue; }
      if (raw[at++] === '"') {
        try {
          const value = JSON.parse(raw.slice(start, at));
          if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail('INVALID_JSON');
          return value;
        } catch { fail('INVALID_JSON'); }
      }
    }
    fail('INVALID_JSON');
  }
  function value(depth = 0) {
    if (depth > 64) fail('INVALID_JSON');
    whitespace();
    const first = raw[at];
    if (first === '"') return string();
    if (first === '{' || first === '[') {
      at++; whitespace();
      const object = first === '{'; const close = object ? '}' : ']';
      const result = object ? Object.create(null) : []; const seen = new Set();
      if (raw[at] === close) { at++; return result; }
      while (at < raw.length) {
        if (object) {
          whitespace(); if (raw[at] !== '"') fail('INVALID_JSON');
          const key = string();
          if (seen.has(key)) fail('DUPLICATE_KEY');
          seen.add(key); whitespace(); if (raw[at++] !== ':') fail('INVALID_JSON');
          result[key] = value(depth + 1);
        } else result.push(value(depth + 1));
        whitespace(); if (raw[at] === close) { at++; return result; }
        if (raw[at++] !== ',') fail('INVALID_JSON');
      }
      fail('INVALID_JSON');
    }
    for (const [literal, decoded] of [['true', true], ['false', false], ['null', null]]) {
      if (raw.startsWith(literal, at)) { at += literal.length; return decoded; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(raw.slice(at));
    if (!match || !Number.isFinite(Number(match[0]))) fail('INVALID_JSON');
    at += match[0].length; return Number(match[0]);
  }
  const result = value(); whitespace(); if (at !== raw.length) fail('INVALID_JSON');
  return result;
}

export function keys(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)) ||
      required.some(k => !Object.hasOwn(value, k))) fail('INVALID_SCHEMA');
}
export const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value);
