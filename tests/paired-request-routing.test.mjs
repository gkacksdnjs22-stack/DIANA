import test from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../financial-documents/workbench.mjs';
import { groupsFor, sourceQuery } from '../financial-desktop/source-roots.mjs';

test('explicit PPTX survives routing while presentations without a format default to PDF', () => {
  const convert = route('바탕화면에서 "현장 기록.txt"를 PPTX로 변환해줘');
  assert.equal(convert.kind, 'convert');
  assert.equal(convert.format, 'pptx');
  assert.equal(route('자료를 PPTX로 발표자료 만들어줘').format, 'pptx');
  assert.equal(route('자료를 발표자료로 만들어줘').format, 'pdf');
});

test('report output clauses leave the attached source reference intact', () => {
  const files = [{ name: '분기 보고서.txt' }, { name: '점검 기록.txt' }];
  const generic = sourceQuery('첨부한 자료를 보고서로 만들어줘');
  assert.deepEqual(generic.terms, ['자료']);
  assert.deepEqual(groupsFor(files, generic)[0].hits, files);

  for (const request of [
    '첨부한 "분기 보고서.txt"를 보고서로 만들어줘',
    '첨부한 "분기 보고서.txt"를 보고서 형식으로 PDF로 작성해줘',
    '첨부한 "분기 보고서.txt"를 보고서 형태로 요약해줘',
    '첨부한 "분기 보고서.txt"를 요약해줘',
  ]) {
    const query = sourceQuery(request);
    assert.deepEqual(query.terms, ['분기 보고서.txt'], request);
    assert.deepEqual(groupsFor(files, query)[0].hits, files.slice(0, 1), request);
  }
  assert.deepEqual(sourceQuery('첨부한 분기 보고서를 요약해줘').terms, ['분기 보고서']);
  const content = sourceQuery('첨부한 "운영 보고서로 만들어줘"가 들어간 자료를 요약해줘');
  assert.equal(content.content, '운영 보고서로 만들어줘');
});
