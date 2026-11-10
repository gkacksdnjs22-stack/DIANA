import { before, after, evidence, guideline, items, initialState, transition, savedItems, initialTransfer, transferStep } from './scenario.mjs';

const $ = id => document.getElementById(id);
let state = initialState();
let transfer = initialTransfer();
let decision;
let toastTimer;
const hasSaved = () => ['saved', 'rechecked'].includes(state.phase);
const text = (id, value) => { $(id).textContent = value; };

function renderTransfer() {
  const received = ['received', 'forwarded'].includes(transfer.phase);
  text('transfer-status', {
    idle: '요청을 보내면 여기에 미리보기가 표시됩니다.',
    approval: '파일과 형식을 확인한 뒤 승인하세요.',
    received: '승인 후 휴대폰에 파일이 도착했습니다.',
    forwarded: '새 검색 없이 최근 결과를 다시 전달했습니다.',
    missing: '전달할 최근 결과가 없습니다. 원본이나 TXT 요청부터 체험해 보세요.',
  }[transfer.phase]);
  $('transfer-preview').hidden = transfer.phase !== 'approval';
  text('transfer-preview-text', transfer.preview?.preview ?? '');
  $('transfer-received').hidden = !received;
  text('transfer-filename', received ? transfer.last.name : '');
}

$('transfer-request').addEventListener('change', () => {
  transfer = transferStep(transfer, 'choose');
  renderTransfer();
});
$('transfer-start').addEventListener('click', () => {
  transfer = transferStep(transfer, 'request', $('transfer-request').value);
  renderTransfer();
});
$('transfer-approve').addEventListener('click', () => {
  transfer = transferStep(transfer, 'approve');
  renderTransfer();
  $('transfer-start').focus();
});

function notify(message) {
  clearTimeout(toastTimer);
  text('toast', message);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

function selectTab(name, focus = false) {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !selected;
    if (selected && focus) tab.focus();
  }
}

function renderItems(id, rows) {
  $(id).replaceChildren(...rows.map(item => {
    const row = document.createElement('article');
    row.className = 'check-row';
    const header = document.createElement('header');
    const title = document.createElement('h3');
    title.textContent = item.label;
    const badge = document.createElement('span');
    badge.className = 'badge' + (item.status === 'SATISFIED' ? ' good' : item.status === 'MISSING_WITH_EVIDENCE' ? ' patch' : '');
    badge.textContent = { SATISFIED: '충족', MISSING_WITH_EVIDENCE: '근거 있는 보완', MISSING_NO_EVIDENCE: '추가 자료 확인 필요' }[item.status];
    header.append(title, badge);
    const note = document.createElement('p');
    note.textContent = item.note;
    row.append(header, note);
    if (item.quote) {
      const quote = document.createElement('blockquote');
      quote.textContent = item.quote;
      const cite = document.createElement('cite');
      cite.textContent = '가상 실사 자료 · [' + item.citation + ']';
      quote.append(cite);
      row.append(quote);
    }
    return row;
  }));
}

function renderState() {
  const saved = hasSaved();
  text('state', { prepared: '가상 승인 대기', saved: '가상 반영 완료', rechecked: '재검토 예시 확인', rejected: '가상 수정안 거절' }[state.phase]);
  text('saved', saved ? '가상 반영' : state.phase === 'rejected' ? '미반영' : '대기');
  $('approve-open').disabled = state.phase !== 'prepared';
  $('reject-open').disabled = state.phase !== 'prepared';
  text('approval-title', saved ? '가상 수정안이 반영됐어요.' : state.phase === 'rejected' ? '가상 수정안을 거절했어요.' : '근거가 있는 조항을 보완할 수 있어요.');
  text('approval-note', saved ? '핵심 운용역 이탈 조항을 보완했습니다. 저장 결과에서 다시 검토해 보세요. 근거가 없는 LP 자문위원회 참여권은 여전히 추가 확인이 필요합니다.' : state.phase === 'rejected' ? '가상 검토서는 수정되지 않았습니다. 다시 체험하려면 ‘처음부터 체험하기’를 눌러 주세요.' : '실사 자료의 핵심 운용역 이탈 조항을 검토서에 추가합니다. LP 자문위원회 참여권은 근거가 없어 추가 확인으로 남습니다.');
  text('result-title', saved ? '브라우저 메모리에 가상 결과를 반영했어요.' : '가상 저장 전입니다.');
  text('result-note', saved ? 'PC 파일 저장·재읽기를 수행한 결과가 아닙니다. 아래 내용은 승인 흐름을 보여주는 가상 결과입니다.' : state.phase === 'rejected' ? '수정안을 거절해 가상 결과를 저장하지 않았습니다.' : '수정 전후와 근거를 확인한 뒤 ‘가상 수정안 승인’을 눌러 주세요.');
  $('review-saved').disabled = !saved;
  $('file-section').hidden = !saved;
  text('result-unresolved', saved ? 'LP 자문위원회 참여권 · 근거 추가 필요' : '');
  text('result-content', saved ? state.body : '');
  const rechecked = state.phase === 'rechecked';
  text('recheck-title', rechecked ? '보완 후에도 추가 확인이 필요한 항목이 있어요.' : '가상 저장본을 다시 검토해 보세요.');
  text('recheck-note', rechecked ? '재검토 결과 예시: 2개 항목 충족 · 1개 항목 근거 부족. 근거가 없는 내용은 충족으로 바뀌지 않습니다. 실제 문서 분석은 수행하지 않습니다.' : '가상 승인 후 ‘가상 저장 결과’에서 재검토를 누르면 보완 항목의 변화를 확인할 수 있어요.');
  renderItems('recheck-items', rechecked ? savedItems() : []);
  text('recheck-body', rechecked ? state.body : '');
}

function openDecision(action) {
  if (state.phase !== 'prepared') return;
  decision = { action, revision: state.revision };
  $('decision-check').checked = false;
  $('confirmation-label').hidden = action === 'reject';
  $('decision-confirm').disabled = action === 'approve';
  text('decision-title', action === 'approve' ? '가상 수정안을 승인할까요?' : '가상 수정안을 거절할까요?');
  text('decision-summary', action === 'approve' ? '가상 실사 자료의 핵심 운용역 이탈 조항을 검토서에 추가합니다. LP 자문위원회 참여권은 근거 부족 상태로 유지됩니다.' : '이번 가상 수정안을 반영하지 않습니다. 처음부터 체험하기로 다시 시작할 수 있습니다.');
  text('decision-confirm', action === 'approve' ? '승인하고 가상 저장' : '가상 수정안 거절');
  $('decision-dialog').showModal();
}

$('approve-open').addEventListener('click', () => openDecision('approve'));
$('reject-open').addEventListener('click', () => openDecision('reject'));
$('decision-check').addEventListener('change', () => { $('decision-confirm').disabled = !decision || (decision.action === 'approve' && !$('decision-check').checked); });
$('decision-close').addEventListener('click', () => $('decision-dialog').close());
$('decision-dialog').addEventListener('close', () => { decision = undefined; });
$('decision-confirm').addEventListener('click', () => {
  if (!decision || (decision.action === 'approve' && !$('decision-check').checked)) return;
  try {
    const action = decision.action;
    state = transition(state, action, decision.revision);
    $('decision-dialog').close();
    renderState();
    if (action === 'approve') selectTab('result', true);
    notify(action === 'approve' ? '가상 수정안이 브라우저 메모리에 반영됐습니다.' : '가상 수정안을 거절했습니다.');
  } catch {
    $('decision-dialog').close();
    notify('화면 상태가 바뀌었습니다. 수정안을 다시 확인해 주세요.');
  }
});

$('reset').addEventListener('click', () => {
  decision = undefined;
  if ($('decision-dialog').open) $('decision-dialog').close();
  state = transition(state, 'reset');
  transfer = initialTransfer();
  $('transfer-request').value = 'original';
  renderTransfer();
  $('source-select').value = 'target';
  text('source-content', before);
  $('diff-lines').hidden = true;
  $('toggle-diff').setAttribute('aria-expanded', 'false');
  text('toggle-diff', '변경 줄 보기');
  renderState();
  selectTab('diff');
  notify('처음 상태로 돌아왔습니다.');
});
$('sample-job').addEventListener('click', () => selectTab('diff', true));
$('toggle-diff').addEventListener('click', () => {
  $('diff-lines').hidden = !$('diff-lines').hidden;
  $('toggle-diff').setAttribute('aria-expanded', String(!$('diff-lines').hidden));
  text('toggle-diff', $('diff-lines').hidden ? '변경 줄 보기' : '변경 줄 숨기기');
});
$('source-select').addEventListener('change', () => { text('source-content', { target: before, evidence, guideline }[$('source-select').value]); });
$('review-saved').addEventListener('click', () => {
  if (!hasSaved()) return;
  state = transition(state, 'recheck', state.revision);
  renderState();
  selectTab('recheck', true);
});
$('download-result').addEventListener('click', () => {
  if (!hasSaved()) return;
  const url = URL.createObjectURL(new Blob([state.body], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'DIANA-demo-fund-review.md';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
const tabs = [...document.querySelectorAll('[role="tab"]')];
for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  tab.addEventListener('keydown', event => {
    let index = tabs.indexOf(tab);
    if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else return;
    event.preventDefault();
    selectTab(tabs[index].dataset.tab, true);
  });
}
text('before', before);
text('after', after);
text('source-content', before);
for (const line of after.slice(before.length).split('\n')) {
  const span = document.createElement('span');
  span.className = 'added';
  span.textContent = '+ ' + line;
  $('diff-lines').append(span);
}
renderItems('checklist', items);
renderState();
renderTransfer();
