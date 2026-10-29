import {mountAutomatic} from './automatic.mjs';
const $=id=>document.getElementById(id);
const labelOf={target:'검토할 문서',source:'근거 자료',guideline:'검토 지침',checklist_review:'검토',patch:'보완',convert:'변환'};
const messages={REGISTRATION_BUSY:'검토·승인 또는 저장 중이에요. 현재 작업을 마친 뒤 등록해 주세요.',REGISTRATION_CHANGED:'등록 목록이 변경됐어요. 새로고침한 뒤 다시 등록해 주세요.',REGISTRATION_CONFLICT:'같은 등록 요청의 내용이 달라졌어요. 목록을 확인하고 다시 시도해 주세요.',REGISTRATION_DOCUMENT_INVALID:'문서 코드·버전·파일 형식과 크기를 확인해 주세요. 중복된 문서 코드는 사용할 수 없어요.',REGISTRATION_GUIDELINE_INVALID:'지침 JSON의 id·version·rules와 문서 코드·버전이 맞는지 확인해 주세요.',REGISTRATION_TASK_INVALID:'작업 이름, 원문·근거·지침, 동작과 형식을 확인해 주세요. 보완은 항목을 선택해야 해요.',REGISTRATION_REVIEW_INVALID:'이 문서와 지침으로 정상 검토를 만들지 못했어요. 지침 형식과 문서 내용을 확인해 주세요.',LOCAL_POLICY_CHANGED:'원래 PC 설정이 변경됐어요. 실행기를 다시 연결한 뒤 확인해 주세요.',REGISTRATION_STORAGE_CHANGED:'PC 등록 파일이 변경됐어요. 등록 폴더를 점검해 주세요.',REGISTRATION_BOUNDARY_CHANGED:'문서·저장·일반 파일 폴더의 범위를 확인해 주세요.',REGISTRATION_LIMIT:'등록할 수 있는 문서나 작업 수를 초과했어요.'};
const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};

export function mountRegistration({key,toast}){
  let catalog=null,available=false,opened=false,fetching=false,submitting=false,file=null,content=null,selection=0,retry=null;
  const checked=name=>[...document.querySelectorAll('input[name="'+name+'"]:checked')].map(e=>e.value);
  function message(text,error=false){$('registration-message').textContent=text;$('registration-message').classList.toggle('error',error);}
  const automatic=mountAutomatic({key,getCatalog:()=>catalog,refresh,message,toast});
  function close(){opened=false;$('registration-workspace').hidden=true;$('review-workspace').hidden=false;$('registration-open').classList.remove('selected');}
  function choice(parent,value,text,name,selected){const label=node('label'),input=node('input');input.type='checkbox';input.name=name;input.value=value;input.checked=selected;label.append(input,node('span',text));parent.append(label);}
  function options(id,documents){const select=$(id),previous=select.value;select.replaceChildren();for(const doc of documents){const option=node('option',doc.name+' · '+doc.id);option.value=doc.id;select.append(option);}if(documents.some(d=>d.id===previous))select.value=previous;}
  function renderItems(){const selected=new Set(checked('registration-item'));$('registration-items').replaceChildren();const guideline=catalog?.documents.find(d=>d.id===$('registration-guideline').value);for(const item of guideline?.items||[])choice($('registration-items'),item.id,item.label,'registration-item',selected.has(item.id));if(!guideline)$('registration-items').append(node('p','먼저 검토 지침을 등록해 주세요.'));}
  function render(){
    automatic.update(catalog);
    $('catalog-published').textContent=catalog.synced?'모바일 작업 목록 반영 완료':'PC 등록 완료 · 서버에 작업 목록 반영 대기';
    const sourceSelection=new Set(checked('registration-source'));
    options('registration-target',catalog.documents.filter(d=>d.kind==='target'));options('registration-guideline',catalog.documents.filter(d=>d.kind==='guideline'));
    $('registration-sources').replaceChildren();for(const doc of catalog.documents.filter(d=>d.kind==='source'))choice($('registration-sources'),doc.id,doc.name+' · '+doc.id,'registration-source',sourceSelection.has(doc.id));
    if(!catalog.documents.some(d=>d.kind==='source'))$('registration-sources').append(node('p','근거 자료를 등록해 주세요.'));
    renderItems();$('registration-documents').replaceChildren();$('registration-tasks').replaceChildren();
    for(const doc of catalog.documents){const row=node('article'),title=node('strong',doc.name);row.append(title,node('span',labelOf[doc.kind]+' · '+doc.id+' · v'+doc.version+' · '+(doc.classification==='internal'?'내부 문서':'가상 자료')));$('registration-documents').append(row);}
    for(const task of catalog.tasks){const row=node('article');row.append(node('strong',task.label),node('span',task.actions.map(a=>labelOf[a]).join(' · ')+' / '+task.formats.map(f=>f.toUpperCase()).join(' · ')));$('registration-tasks').append(row);}
  }
  async function refresh(){
    if(!available||fetching)return;fetching=true;
    try{const response=await fetch('/api/local-catalog',{headers:{Authorization:'Bearer '+key},cache:'no-store',signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('REGISTRATION_FAILED');const next=await response.json();const changed=!catalog||catalog.revision!==next.revision;catalog=next;if(changed)render();else $('catalog-published').textContent=catalog.synced?'모바일 작업 목록 반영 완료':'PC 등록 완료 · 서버에 작업 목록 반영 대기';}
    catch{message('PC 등록 정보를 불러오지 못했어요. 연결 상태를 확인하고 새로고침해 주세요.',true);}
    finally{fetching=false;}
  }
  async function save(type,body){
    if(submitting||!catalog)return;submitting=true;for(const control of document.querySelectorAll('.registration-form input,.registration-form select,.registration-form button'))control.disabled=true;
    message('PC에서 등록 내용을 확인하고 있어요.');
    const signature=JSON.stringify([type,body]);if(!retry||retry.signature!==signature)retry={signature,payload:{requestId:crypto.randomUUID(),revision:catalog.revision,...body}};
    try{const response=await fetch('/api/local-catalog/'+type,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(retry.payload),signal:AbortSignal.timeout(60000)});const result=await response.json();if(!response.ok||!result.saved)throw Object.assign(Error(),{code:result.code});retry=null;
      await refresh();message(type==='documents'?'문서를 PC에 등록했어요. 아래에서 작업을 연결해 주세요.':'PC에 작업을 등록했어요. 서버 연결이 확인되면 모바일 목록에 반영돼요.');toast(type==='documents'?'이 PC에 문서를 등록했어요.':'작업을 등록했어요.');
      if(type==='documents'){$('register-document').reset();file=null;content=null;selection++;}
      else $('registration-task-label').value='';
    }catch(error){message(messages[error.code]||'등록을 확인하지 못했어요. 목록을 새로고침해 결과를 확인해 주세요.',true);if(error.code){retry=null;if(['REGISTRATION_CHANGED','REGISTRATION_CONFLICT'].includes(error.code))await refresh();}}
    finally{submitting=false;for(const control of document.querySelectorAll('.registration-form input,.registration-form select,.registration-form button'))control.disabled=false;}
  }
  function fileMetadata(){
    if(!file||content===null)return;
    if($('registration-kind').value==='guideline'){
      try{const json=JSON.parse(content);$('registration-doc-id').value=typeof json.id==='string'?json.id:'';$('registration-version').value=typeof json.version==='string'?json.version:'1';}catch{message('검토 지침은 JSON 파일이어야 해요.',true);}
    }
  }
  $('registration-file').addEventListener('change',async()=>{
    const selected=++selection;file=$('registration-file').files[0]||null;content=null;if(!file)return;const selectedFile=file;
    if(file.size>262144||!/^.+\.(txt|md|json)$/iu.test(file.name)){message('256KB 이하의 TXT·MD·JSON 파일을 선택해 주세요.',true);file=null;return;}
    try{const decoded=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await selectedFile.arrayBuffer());if(selected!==selection)return;content=decoded;const suggested=selectedFile.name.replace(/\.[^.]+$/u,'').replace(/[^A-Za-z0-9_-]/gu,'_').replace(/^_+|_+$/gu,'').slice(0,64);$('registration-doc-id').value=/^[A-Za-z0-9]/u.test(suggested)?suggested:'DOC_'+crypto.randomUUID().slice(0,8);$('registration-version').value='1';fileMetadata();message('선택한 파일은 등록할 때 이 PC의 로컬 화면으로만 전달돼요.');}
    catch{if(selected!==selection)return;file=null;content=null;message('UTF-8 텍스트 파일인지 확인해 주세요.',true);}
  });
  $('registration-kind').addEventListener('change',fileMetadata);$('registration-guideline').addEventListener('change',renderItems);
  $('register-document').addEventListener('submit',event=>{event.preventDefault();if(!file||content===null){message('먼저 등록할 파일을 선택해 주세요.',true);return;}void save('documents',{id:$('registration-doc-id').value,version:$('registration-version').value,kind:$('registration-kind').value,name:file.name,classification:$('registration-classification').value,content});});
  $('register-task').addEventListener('submit',event=>{event.preventDefault();void save('tasks',{label:$('registration-task-label').value.trim(),targetId:$('registration-target').value,sourceIds:checked('registration-source'),guidelineId:$('registration-guideline').value,itemIds:checked('registration-item'),actions:checked('registration-action'),formats:checked('registration-format')});});
  $('registration-open').addEventListener('click',()=>{opened=true;$('review-workspace').hidden=true;$('registration-workspace').hidden=false;$('registration-open').classList.add('selected');void refresh().then(()=>automatic.onOpen());});
  $('review-open').addEventListener('click',close);$('catalog-refresh').addEventListener('click',()=>void refresh());
  setInterval(()=>{if(opened&&!submitting)void refresh();},5000);
  return{close,setAvailable(value){available=value;$('registration-open').hidden=!available;if(!available&&opened)close();}};
}
