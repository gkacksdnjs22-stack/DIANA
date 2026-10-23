import { createHash } from 'node:crypto';
import { resolveAiConfig } from '../agent/ai-provider.mjs';
import { searchDocuments } from '../agent/search.mjs';

// One small authenticated request using synthetic text only. Never print keys,
// raw provider errors, or the configured document library.
try {
  const config = resolveAiConfig();
  const text = 'DIANA 연결 검증용 가상 문서입니다. 매출 보고서의 보고 기간은 2026년 9월입니다. 매출액은 1,100만원입니다.';
  const digest = createHash('sha256').update(text).digest('hex');
  const result = await searchDocuments('DIANA 가상 매출 보고서', [{
    id: digest, sha256: digest, filename: 'ai-connection-test.txt', text,
    bytes: Buffer.byteLength(text), modifiedAt: new Date().toISOString(),
  }]);
  if (result.candidates.length !== 1 || result.candidates[0].id !== digest) {
    throw new Error('The AI provider returned no grounded match for the connection test.');
  }
  console.log(JSON.stringify({ ok: true, provider: config.provider, model: config.model,
    structuredOutput: true, sourceEvidenceVerified: true, syntheticDataOnly: true }));
} catch (error) {
  let message = error instanceof Error ? error.message : 'AI connection check failed.';
  for (const key of [process.env.OPENAI_API_KEY, process.env.GROQ_API_KEY, process.env.GROQ_OPENAI_KEY]) {
    if (key) message = message.replaceAll(key, '[redacted]');
  }
  console.error(message.slice(0, 300));
  process.exitCode = 1;
}
