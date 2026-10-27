const reasons={
  UNRESOLVED_LABEL_REQUIRED:'저장본에 남은 미해결 항목이 현재 지침에서 제거되었습니다. 해당 항목을 지침에 유지하거나 검토 범위를 확인해 주세요.',
  CLASSIFICATION_MISMATCH:'저장 파일의 문서 분류와 메타데이터가 일치하는지 확인해 주세요.',
  INVALID_CLASSIFICATION:'저장 파일의 문서 분류 정보를 확인해 주세요.',
  INVALID_DOCUMENT_ENVELOPE:'저장 파일의 문서 메타데이터를 확인해 주세요.',
  NOTICE_METADATA_MISMATCH:'저장 파일의 본문·상태 표시와 검증 메타데이터가 일치하지 않습니다.',
  CONTENT_CHANGED:'저장 파일이나 원문·지침이 변경되었습니다. 현재 파일과 등록 자료를 확인해 주세요.',
  POLICY_CHANGED:'등록 정책이 변경되었습니다. PC 검토 프로그램을 다시 실행하고 권한을 확인해 주세요.',
  LOCAL_REVIEW_INVALIDATED:'등록 설정이나 정책을 확인한 뒤 PC 검토 프로그램을 다시 실행해 주세요.'
};

/** Presentation accepts an actual review result, never a diagnostic status alone. */
export function recheckView(value){
  if(!value)return{state:'idle',title:'저장 파일을 다시 검토할 수 있어요.',note:'저장 결과에서 ‘저장한 파일 다시 검토’를 눌러 주세요. PC의 현재 원문·지침을 사용합니다.',items:[],body:''};
  const normal=value.reason==='REVIEW_RESULT'&&['READY','ACTION_REQUIRED'].includes(value.status)&&
    Array.isArray(value.items)&&value.items.length>0&&value.items.every(i=>i&&['SATISFIED','MISSING_WITH_EVIDENCE','MISSING_NO_EVIDENCE','NEEDS_CONFIRMATION'].includes(i.status))&&
    typeof value.body==='string'&&typeof value.reviewComplete==='boolean'&&value.reviewComplete===value.items.every(i=>i.status==='SATISFIED');
  if(!normal){
    const reason=typeof value.reason==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.reason)&&value.reason!=='REVIEW_RESULT'?value.reason:'CORE_RESPONSE_INVALID';
    return{state:'failed',reason,title:'저장본 재검토를 완료하지 못했어요.',
      note:(reasons[reason]||'검토 응답을 완료 결과로 사용할 수 없습니다. 저장 파일·원문·지침과 PC 상태를 확인해 주세요.')+' ('+reason+')',items:[],body:''};
  }
  return{state:'completed',title:value.reviewComplete?'저장본의 모든 검토 항목이 충족됐어요.':'저장본 검토 완료 · 추가 확인 항목이 있어요.',
    note:'이 PC의 현재 원문·지침으로 확인 · '+new Date(value.checkedAt).toLocaleString('ko-KR')+' · 충족 '+value.items.filter(i=>i.status==='SATISFIED').length+' / 전체 '+value.items.length,
    items:value.items,body:value.body};
}
