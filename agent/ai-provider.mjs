import { setTimeout as delay } from 'node:timers/promises';

const ENDPOINTS = {
  openai: 'https://api.openai.com/v1/responses',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
};
const MAX_API_BYTES = 16 * 1024 * 1024;

function requestError(message, code, httpStatus) {
  return Object.assign(new Error(message), { code, ...(httpStatus === undefined ? {} : { httpStatus }) });
}

function resetMilliseconds(value) {
  if (!value) return null;
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
  if (!parts.length || parts.map(part => part[0]).join('') !== value) return null;
  const units = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const milliseconds = parts.reduce((total, part) => total + Number(part[1]) * units[part[2]], 0);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function retryMilliseconds(headers, attempt) {
  const after = headers?.get?.('retry-after');
  if (after !== null && after !== undefined && after.trim()) {
    const seconds = Number(after);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(after);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const requestLimit = headers?.get?.('x-ratelimit-remaining-requests');
  const reset = resetMilliseconds(headers?.get?.(requestLimit !== null && requestLimit !== undefined && Number(requestLimit) === 0
    ? 'x-ratelimit-reset-requests' : 'x-ratelimit-reset-tokens'));
  return reset ?? 1000 * 2 ** attempt;
}

export function resolveAiConfig(env = process.env) {
  const provider = env.AI_MODE || 'openai';
  if (!Object.hasOwn(ENDPOINTS, provider)) throw new Error('AI_MODE must be openai or groq for AI requests.');
  const key = provider === 'groq' ? (env.GROQ_API_KEY?.trim() ? env.GROQ_API_KEY : env.GROQ_OPENAI_KEY) : env.OPENAI_API_KEY;
  const model = provider === 'groq' ? (env.GROQ_MODEL || 'openai/gpt-oss-120b') : env.OPENAI_MODEL;
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key) || typeof model !== 'string' || !model.trim() || /[\r\n]/.test(model)) {
    throw new Error(provider === 'groq'
      ? 'GROQ_API_KEY (or GROQ_OPENAI_KEY) and a valid GROQ_MODEL are required for AI_MODE=groq.'
      : 'OPENAI_API_KEY and OPENAI_MODEL are required for AI_MODE=openai.');
  }
  return { provider, model: model.trim(), apiKey: key.trim(), endpoint: ENDPOINTS[provider] };
}

async function readApiJson(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_API_BYTES) throw new Error('The AI API response is too large.');
  let buffer;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_API_BYTES) { await reader.cancel(); throw new Error('The AI API response is too large.'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    buffer = Buffer.concat(chunks);
  } else {
    buffer = Buffer.from(await response.text());
    if (buffer.length > MAX_API_BYTES) throw new Error('The AI API response is too large.');
  }
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw new Error('The AI API did not return valid JSON.'); }
}

function chatMessages(instructions, input) {
  const items = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
  if (!Array.isArray(items)) throw new Error('AI input must contain text messages.');
  return [{ role: 'system', content: instructions }, ...items.map(item => {
    if (!item || !['user', 'assistant'].includes(item.role)) throw new Error('AI input contains an unsupported message role.');
    const content = typeof item.content === 'string' ? item.content : Array.isArray(item.content)
      ? item.content.map(part => {
        if (part?.type !== 'input_text' || typeof part.text !== 'string') throw new Error('AI input must contain text only.');
        return part.text;
      }).join('\n') : null;
    if (content === null) throw new Error('AI input must contain text only.');
    return { role: item.role, content };
  })];
}

function normalizeChatResponse(result) {
  if (!Array.isArray(result?.choices) || result.choices.length !== 1 || !result.choices[0]?.message) {
    throw new Error('Groq returned an invalid completion response.');
  }
  const choice = result.choices[0];
  const message = choice.message;
  if (choice.finish_reason !== 'stop') return { status: 'incomplete', output: [] };
  if (typeof message.refusal === 'string' && message.refusal.trim()) {
    return { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: message.refusal }] }] };
  }
  if (typeof message.content !== 'string' || !message.content.trim() ||
      (message.refusal !== undefined && message.refusal !== null && typeof message.refusal !== 'string')) {
    throw new Error('Groq returned an invalid completion message.');
  }
  return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: message.content }] }] };
}

/** Fixed provider URLs keep one provider's credentials out of another provider's requests. */
export async function requestStructuredResponse({ env = process.env, name, schema, instructions, input,
  fetchImpl = fetch, signal, timeoutMs = 55_000, maxRateLimitRetries = 2,
  waitImpl = (milliseconds, options) => delay(milliseconds, undefined, options) }) {
  const config = resolveAiConfig(env);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('AI request timeout must be a positive integer.');
  if (!Number.isSafeInteger(maxRateLimitRetries) || maxRateLimitRetries < 0 || maxRateLimitRetries > 3) throw new Error('AI rate-limit retries must be between zero and three.');
  const body = config.provider === 'openai' ? {
    model: config.model, store: false, instructions, input,
    text: { format: { type: 'json_schema', name, strict: true, schema } },
  } : {
    model: config.model, messages: chatMessages(instructions, input), max_completion_tokens: 8192,
    response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
  };
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let response;
  for (let attempt = 0; ; attempt++) {
    try {
      requestSignal.throwIfAborted();
      response = await fetchImpl(config.endpoint, {
        method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw requestError(requestSignal.aborted ? 'The AI request was aborted or timed out.' : 'The AI provider connection failed.',
        requestSignal.aborted ? 'ai_timeout' : 'ai_connection_failed');
    }
    // A 429 explicitly rejected this attempt. Never retry ambiguous network,
    // server, or incomplete-model results that may already have done work.
    if (config.provider !== 'groq' || response.status !== 429 || attempt >= maxRateLimitRetries) break;
    const wait = retryMilliseconds(response.headers, attempt);
    if (wait + 100 >= deadline - Date.now()) break;
    await response.body?.cancel().catch(() => {});
    try { await waitImpl(wait, { signal: requestSignal }); }
    catch { throw requestError('The AI request was aborted or timed out.', 'ai_timeout'); }
  }
  if (!response.ok) throw requestError(`${config.provider === 'groq' ? 'Groq' : 'OpenAI'} AI request failed (HTTP ${response.status}).`,
    response.status === 429 ? 'ai_rate_limited' : 'ai_http_failed', response.status);
  const result = await readApiJson(response);
  return config.provider === 'groq' ? normalizeChatResponse(result) : result;
}
