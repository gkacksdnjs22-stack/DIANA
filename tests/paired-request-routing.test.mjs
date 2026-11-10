import test from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../financial-documents/workbench.mjs';
import { groupsFor, scope, sourceQuery } from '../financial-desktop/source-roots.mjs';

test('explicit PPTX survives routing while presentations without a format default to PDF', () => {
  const convert = route('바탕화면에서 "현장 기록.txt"를 PPTX로 변환해줘');
  assert.equal(convert.kind, 'convert');
  assert.equal(convert.format, 'pptx');
  assert.equal(route('자료를 PPTX로 발표자료 만들어줘').format, 'pptx');
  assert.equal(route('자료를 발표자료로 만들어줘').format, 'pdf');
});

test('report output clauses leave the attached source reference intact', () => {
  const files = [{ name: '분기 보고서.txt' }, { name: '점검 기록.txt' }];
  for (const request of [
    '첨부한 자료를 보고서로 만들어줘',
    '첨부한 자료로 보고서 작성해줘',
    '첨부한 자료를 보고서 PDF로 만들어줘',
    '첨부한 자료로 보고서를 써줘',
    '첨부한 자료를 “보고서”로 작성하세요',
    '첨부한 자료를 리포트 형태로 정리',
  ]) {
    const query = sourceQuery(request);
    assert.equal(route(request).kind, 'summary', request);
    assert.deepEqual(query.terms, ['자료'], request);
    assert.deepEqual(groupsFor(files, query)[0].hits, files, request);
  }

  for (const request of [
    '첨부한 "분기 보고서.txt"를 보고서로 만들어줘',
    '첨부한 "분기 보고서.txt"를 보고서 형식으로 PDF로 작성해줘',
    '첨부한 "분기 보고서.txt"를 보고서 형태로 요약해줘',
    '첨부한 "분기 보고서.txt"로 보고서 작성해줘',
    '첨부한 분기 보고서.txt로 보고서 작성해줘',
    '첨부한 "분기 보고서.txt"를 리포트 PDF로 만들어줘',
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

test('sending a named original keeps the file query inside the named folder', () => {
  const desktop = { label: '바탕화면', path: 'desktop' };
  const roots = [desktop, { label: '문서', path: 'documents' }];
  const files = [{ name: '샘플 이력서.pdf' }, { name: '샘플 포트폴리오.pdf' }];
  for (const request of [
    '바탕화면에 이력서 파일 보내줘',
    '바탕화면에 이력서파일 보내줘',
    '바탕화면에 있는 "샘플 이력서.pdf"를 휴대폰으로 보내 주세요',
    '바탕화면에서 이력서 파일을 찾아서 보내줘',
  ]) {
    const location = scope(roots, request);
    assert.deepEqual(location.roots, [desktop]);
    assert.equal(route(request).kind, 'send');
    assert.deepEqual(groupsFor(files, sourceQuery(location.query))[0].hits, files.slice(0, 1));
  }
  assert.equal(route('바탕화면에 있는 이력서를 요약해서 보내줘').kind, 'summary');
  const literal = { name: '이력서파일.pdf' };
  assert.deepEqual(groupsFor([...files, literal], sourceQuery('이력서파일 보내줘'))[0].hits, [literal]);
});

test('a specified delivery format is separate from the source name', () => {
  const roots = [{ label: '바탕화면', path: 'desktop' }];
  for (const [request, term] of [
    ['바탕화면에 이력서를 TXT로 보내줘', '이력서'],
    ['바탕화면에 있는 "샘플 이력서.pdf"를 TXT로 휴대폰으로 보내 주세요', '샘플 이력서.pdf'],
  ]) {
    assert.equal(route(request).kind, 'convert');
    assert.equal(route(request).format, 'txt');
    assert.deepEqual(sourceQuery(scope(roots, request).query).terms, [term]);
  }
});

test('forwarding the latest result is distinct from searching for a named file', () => {
  assert.equal(route('결과를 전달해줘').recentResult, true);
  assert.equal(route('최근 결과를 TXT로 보내줘').recentResult, true);
  assert.equal(route('결과.pdf를 전달해줘').recentResult, false);
});
