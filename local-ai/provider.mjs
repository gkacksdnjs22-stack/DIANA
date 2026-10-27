import http from 'node:http';

// Only reviewed, downloadable local weights. No host, model or URL from a document.
export const LOCAL_MODELS = new Set(['qwen3:4b-instruct', 'qwen3:8b', 'gemma3:4b']);
export function localError(code) { return Object.assign(new Error(code), { code }); }

export function localConfig(env = process.env) {
  const model = env.DIANA_LOCAL_MODEL || 'qwen3:4b-instruct';
  if (!LOCAL_MODELS.has(model)) throw localError('local_model_not_allowed');
  const port = Number(env.DIANA_OLLAMA_PORT || 11434);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw localError('local_port_invalid');
  return { model, port, provider: 'ollama', endpoint: `http://127.0.0.1:${port}/api/chat` };
}

// node:http goes directly to an IP, without DNS, fetch proxies or redirect following.
// This transport has no remote URL argument and never logs request/response bodies.
export function localJson(port, route, body, signal) {
  if (!['/api/show', '/api/chat'].includes(route)) throw localError('local_route_denied');
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' }, agent: false }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(localError(response.statusCode === 404 ? 'local_model_missing' : 'local_http_failed'));
        return;
      }
      let size = 0; const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) response.destroy(localError('local_response_too_large'));
        else chunks.push(chunk);
      });
      response.on('error', () => reject(localError(signal?.aborted ? 'local_timeout' : 'local_response_invalid')));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(localError('local_response_invalid')); }
      });
    });
    request.on('error', () => reject(localError(signal?.aborted ? 'local_timeout' : 'local_unavailable')));
    request.end(JSON.stringify(body));
  });
}

export async function localCompletion({ env = process.env, messages, schema, signal, timeoutMs = 180_000,
  transport = localJson } = {}) {
  const { model, port } = localConfig(env);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw localError('local_timeout_invalid');
  if (!Array.isArray(messages) || !messages.length || messages.some(m => !m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') ||
      JSON.stringify(messages).length > 24_000) throw localError('local_input_too_large');
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  combined.throwIfAborted();
  // A cloud alias can live on localhost too. Verify local tensor metadata before sending text.
  const info = await transport(port, '/api/show', { model }, combined);
  if (!info || info.remote_model || info.remote_host || /https?:\/\/|\bcloud\b/i.test(info.modelfile || '') ||
      !Number.isFinite(info.model_info?.['general.parameter_count']) || info.model_info['general.parameter_count'] < 1 ||
      !info.details?.quantization_level) throw localError('local_weights_unverified');
  const result = await transport(port, '/api/chat', { model, messages, stream: false, think: false,
    ...(schema ? { format: schema } : {}), keep_alive: 0,
    options: { num_ctx: 8192, num_predict: 1200, temperature: 0, num_gpu: 0 } }, combined);
  if (result?.done !== true || result.done_reason !== 'stop' || result.message?.role !== 'assistant' ||
      typeof result.message.content !== 'string' || !result.message.content.trim() || result.message.tool_calls?.length ||
      result.message.content.length > 16_000) throw localError('local_response_invalid');
  return { text: result.message.content, model, metrics: {
    outputTokens: Number(result.eval_count) || 0, generationMs: (Number(result.eval_duration) || 0) / 1e6,
    totalMs: (Number(result.total_duration) || 0) / 1e6,
  } };
}
