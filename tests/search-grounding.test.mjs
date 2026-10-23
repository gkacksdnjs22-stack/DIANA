import test from 'node:test';
import assert from 'node:assert/strict';
import { lexicalSearch, searchDocuments } from '../agent/search.mjs';

const ENV = { AI_MODE: 'groq', GROQ_OPENAI_KEY: 'test-only-key', GROQ_MODEL: 'test-model' };
const documents = [
  { id: 'a'.repeat(64), sha256: '1'.repeat(64), filename: '가람상사-최종본.txt',
    modifiedAt: '2026-10-23T00:00:00.000Z', bytes: 100,
    text: '가람상사 매출 보고서\n매출액은 1,100만원입니다.\n검토를 완료했습니다.' },
  { id: 'b'.repeat(64), sha256: '2'.repeat(64), filename: '다른문서.txt',
    modifiedAt: '2026-10-23T00:00:00.000Z', bytes: 80, text: '해솔회사 초안. 최종 검토는 아직 진행하지 않았습니다.' },
];
const selection = (document, evidence, overrides = {}) => ({ id: document.id, score: 0.99,
  reason: 'AI가 주장한 근거이며 대체 검색에서 재사용하면 안 됩니다.', evidence, ...overrides });
const completion = selections => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
  message: { content: JSON.stringify({ selections }) } }] }), { headers: { 'Content-Type': 'application/json' } });
const search = (query, selections) => searchDocuments(query, documents, {
  env: ENV, fetchImpl: async () => completion(selections),
});

test('exact source evidence retains AI search and original source metadata', async () => {
  const result = await search('가람상사 최종본', [selection(documents[0], '가람상사 매출 보고서')]);
  assert.equal(result.mode, 'groq');
  assert.equal(result.candidates[0].id, documents[0].id);
  assert.equal(result.candidates[0].sha256, documents[0].sha256);
});

test('a filename quotation or reformatted text cannot pass as an exact body quotation', async t => {
  for (const evidence of [documents[0].filename, '가람상사 매출 보고서 매출액은 1,100만원입니다.', '가람상사 매출은 천백만원']) {
    await t.test(evidence, async () => {
      let requests = 0;
      const result = await searchDocuments('가람상사 최종본', documents, { env: ENV,
        fetchImpl: async () => { requests++; return completion([selection(documents[0], evidence)]); } });
      assert.equal(requests, 1, 'The independent keyword recovery must not issue another AI request.');
      assert.equal(result.mode, 'lexical');
      assert.deepEqual(result.candidates, lexicalSearch('가람상사 최종본', documents));
      assert.equal(JSON.stringify(result).includes('AI가 주장한 근거'), false);
      assert.match(result.candidates[0].reason, /키워드 검색/);
    });
  }
});

test('unverified AI IDs and scores are discarded before independent keyword recovery', async () => {
  const result = await search('가람상사', [selection(documents[1], '원문에 없는 가람상사 최종 보고서')]);
  assert.equal(result.mode, 'lexical');
  assert.deepEqual(result.candidates.map(candidate => candidate.id), [documents[0].id]);
  assert.notEqual(result.candidates[0].score, 0.99);
});

test('unmatched queries still reject invented evidence instead of accepting an ungrounded AI choice', async () => {
  await assert.rejects(search('존재하지않는검색어', [selection(documents[0], '원문에 없는 문구')]), /evidence/);
});

test('keyword recovery cannot hide invalid IDs, duplicate choices, or malformed selection metadata', async t => {
  const badEvidence = selection(documents[0], '원문에 없는 문구');
  for (const [name, choices, expected] of [
    ['unknown ID after invalid evidence', [badEvidence, selection(documents[1], documents[1].text, { id: '../outside.txt' })], /unknown/],
    ['duplicate after invalid evidence', [badEvidence, badEvidence], /repeated/],
    ['invalid score after invalid evidence', [badEvidence, selection(documents[1], documents[1].text, { score: 2 })], /schema/],
    ['invalid reason after invalid evidence', [badEvidence, selection(documents[1], documents[1].text, { reason: '' })], /schema/],
    ['empty evidence', [selection(documents[0], '')], /schema/],
    ['extra routing field', [selection(documents[0], '원문에 없는 문구', { recipient: 'outside@example.com' })], /schema/],
  ]) {
    await t.test(name, async () => { await assert.rejects(search('가람상사', choices), expected); });
  }
});

test('valid no-match AI output is respected without invoking keyword recovery', async () => {
  assert.deepEqual(await search('가람상사', []), { mode: 'groq', candidates: [] });
});

test('provider errors and refusals do not fall back to keyword matches', async t => {
  for (const [name, fetchImpl, expected] of [
    ['provider rejection', async () => new Response('{}', { status: 401 }), /HTTP 401/],
    ['network error', async () => { throw new Error('offline'); }, /connection failed/],
    ['refusal', async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
      message: { content: 'refused', refusal: 'I cannot do this.' } }] })), /declined/],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(searchDocuments('가람상사', documents, { env: ENV, fetchImpl }), expected);
    });
  }
});
