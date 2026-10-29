const $=id=>document.getElementById(id);
const texts={REGISTRATION_BUSY:'진행 중인 검토·승인을 마친 뒤 자동 연결해 주세요.',REGISTRATION_CHANGED:'등록 목록이 변경됐어요. 폴더에서 다시 찾아 주세요.',DISCOVERY_FOLDER_DENIED:'허용한 문서 폴더인지 확인해 주세요. 일반 전송·설정·저장 폴더와 겹치는 위치는 사용할 수 없어요.',DISCOVERY_SELECTION_REQUIRED:'확실하지 않은 파일을 선택해 주세요. 원문과 근거에 같은 파일을 중복 선택할 수 없어요.',DISCOVERY_EXPIRED:'자동 연결 후보의 시간이 지났어요. 다시 찾아 주세요.',DISCOVERY_CHANGED:'찾은 뒤 파일 내용이 바뀌었어요. 다시 찾아서 확인해 주세요.',DISCOVERY_ID_CONFLICT:'기존 문서 코드와 내용이 다른 파일이 있어요. 기존 문서를 덮어쓰지 않았어요. 지침과 근거 코드를 확인해 주세요.',REGISTRATION_REVIEW_INVALID:'이 연결로 정상 검토를 만들지 못했어요. 원문·근거·지침 조합을 확인해 주세요.',FOLDER_PICKER_UNAVAILABLE:'폴더 선택 프로그램이 없어요. 새 PC 실행기로 열어 주세요.',FOLDER_PICKER_FAILED:'폴더 선택을 완료하지 못했어요. 다시 시도해 주세요.'};
const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
export function mountAutomatic({key,getCatalog,refresh,message,toast}){
  let proposal=null,busy=false,completedSignature=null,request=null;
  const selectedGroup=()=>proposal?.groups.find(g=>g.id===$('automatic-guide').value);
  function options(select,rows,selected,placeholder){select.replaceChildren();const empty=node('option',placeholder);empty.value='';select.append(empty);for(const row of rows){const option=node('option',row.name);option.value=row.id;select.append(option);}select.value=selected||'';}
  function update(catalog){const old=$('automatic-folder').value,folders=catalog?.folders||[];options($('automatic-folder'),folders.map(f=>({id:f.id,name:f.path})),folders.some(f=>f.id===old)?old:folders.length===1?folders[0].id:null,'허용한 폴더를 선택하세요');$('automatic-scan').disabled=busy||!$('automatic-folder').value;}
  function setBusy(value){busy=value;for(const id of ['automatic-pick','automatic-scan','automatic-connect','automatic-guide','automatic-folder'])$(id).disabled=value;for(const e of document.querySelectorAll('#automatic-matches select'))e.disabled=value;if(!value)update(getCatalog());}
  async function post(route,body){const response=await fetch('/api/local-catalog/'+route,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(route==='folders/select'?185000:60000)});const result=await response.json();if(!response.ok)throw Object.assign(Error(),{code:result.code});return result;}
  function describe(error){message(texts[error.code]||'자동 연결을 확인하지 못했어요. 등록 목록을 새로고침하고 다시 확인해 주세요.',true);}
  function matches(){
    const group=selectedGroup();$('automatic-matches').replaceChildren();if(!group)return;
    const add=(title,id,rows,selected)=>{const row=node('label'),caption=node('span',title),select=node('select');select.id=id;select.setAttribute('aria-label',title);options(select,rows,selected,'후보를 선택해 주세요');row.append(caption,select);$('automatic-matches').append(row);};
    add('검토할 문서 후보','automatic-target',group.targets,group.target);
    for(const [index,source]of group.sources.entries())add('근거 자료 후보 · '+source.code,'automatic-source-'+index,source.options,source.selected);
    $('automatic-summary').textContent=proposal.limited?'검색 범위 한도에 도달했어요. 후보를 직접 확인하거나 더 작은 폴더에서 다시 찾아 주세요.':group.ready?'원문·근거·지침을 자동으로 연결했어요. 작업 이름만 확인하고 등록할 수 있어요.':'겹치거나 확실하지 않은 후보가 있어요. 빈 선택칸만 확인해 주세요.';
  }
  async function scan(){
    if(busy||!getCatalog()||!$('automatic-folder').value)return;setBusy(true);proposal=null;$('automatic-result').hidden=true;request=null;message('허용한 PC 폴더에서 문서 후보를 찾고 있어요.');
    try{proposal=await post('discover',{requestId:crypto.randomUUID(),revision:getCatalog().revision,folderId:$('automatic-folder').value});
      options($('automatic-guide'),proposal.groups,proposal.groups.length===1?proposal.groups[0].id:null,'검토 지침 후보를 선택하세요');$('automatic-result').hidden=!proposal.groups.length;matches();
      if(!proposal.groups.length)$('automatic-summary').textContent='연결할 검토 지침 JSON을 찾지 못했어요. 선택한 폴더에 id/version/rules 형식의 지침과 문서를 함께 넣어 주세요.';
      message('이 PC에서 '+proposal.files+'개 파일을 확인했어요. '+(proposal.skipped?'제외한 파일 '+proposal.skipped+'개.':''));
    }catch(error){describe(error);}finally{setBusy(false);}
  }
  $('automatic-pick').addEventListener('click',async()=>{
    if(busy||!getCatalog())return;setBusy(true);message('PC 폴더 선택창에서 접근을 허용할 문서 폴더를 골라 주세요.');let folderId;
    try{const result=await post('folders/select',{requestId:crypto.randomUUID(),revision:getCatalog().revision});if(result.cancelled){message('폴더 선택을 취소했어요.');return;}folderId=result.folderId;await refresh();update(getCatalog());if(folderId)$('automatic-folder').value=folderId;}
    catch(error){describe(error);return;}finally{setBusy(false);}
    await scan();
  });
  $('automatic-scan').addEventListener('click',()=>void scan());$('automatic-folder').addEventListener('change',()=>{proposal=null;$('automatic-result').hidden=true;update(getCatalog());});$('automatic-guide').addEventListener('change',matches);
  $('automatic-connect').addEventListener('click',async()=>{
    const group=selectedGroup();if(busy||!group||!proposal)return;
    const body={revision:proposal.revision,proposalId:proposal.proposalId,groupId:group.id,targetId:$('automatic-target').value,sourceChoices:group.sources.map((s,i)=>({code:s.code,candidateId:$('automatic-source-'+i).value})),label:$('automatic-label').value.trim(),allowPatch:$('automatic-allow-patch').checked,formats:['md','txt','json']};
    if(!body.targetId||body.sourceChoices.some(s=>!s.candidateId)){message(texts.DISCOVERY_SELECTION_REQUIRED,true);return;}
    const signature=JSON.stringify(body);if(!request||signature!==completedSignature){request={requestId:crypto.randomUUID(),...body};completedSignature=signature;}
    setBusy(true);message('PC 코어로 연결과 보완 가능 항목을 검증하고 있어요.');
    try{const result=await post('connect',request);if(!result.saved)throw Error();await refresh();proposal=null;$('automatic-result').hidden=true;message('문서와 작업을 자동으로 연결해 등록했어요. 모바일 작업 목록 반영 상태를 확인해 주세요.');toast('자동 연결 작업을 등록했어요.');request=null;}
    catch(error){describe(error);}finally{setBusy(false);}
  });
  return{update,async onOpen(){update(getCatalog());if($('automatic-folder').value&&!proposal)await scan();}};
}
