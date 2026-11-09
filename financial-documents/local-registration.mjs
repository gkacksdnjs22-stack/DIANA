import path from 'node:path';
import {mkdir,readdir,lstat,realpath,open} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {strictJSON,keys,validId,fail} from './strict-json.mjs';
import {boundedRead,readSelectedText,verifyOpenedOutput} from './files.mjs';
import {checkedDirectory,digest} from '../personal-ai/documents/files.mjs';
import {createFilePolicy} from '../local-ai/files.mjs';
import {UUID,validTask,publicTask} from '../lib/financial-contract.mjs';
import {FinancialDocuments} from './adapter.mjs';
import {discoverFolder} from './local-discovery.mjs';
import {containsSecret} from './security/content.mjs';

const within=(a,b)=>{const r=path.relative(a,b);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
const plain=value=>JSON.parse(JSON.stringify(value));
const hashJSON=value=>digest(JSON.stringify(value));
const kinds=new Set(['target','source','guideline']);
async function writeNew(filename,content){const parent=path.dirname(filename);await checkedDirectory(parent);const handle=await open(filename,'ax',0o600);try{await verifyOpenedOutput(handle,filename,parent);await handle.writeFile(content);await handle.sync();await verifyOpenedOutput(handle,filename,parent);}finally{await handle.close();}}

/** Append-only PC catalog. Original configs and source files are never edited.
 * Revisions become visible only after all files validate and a final commit
 * marker is flushed. Incomplete staging directories are inert. */
export class LocalRegistration {
  #worker;#base;#root;#documentsRoot;#head=null;#state;#baseHash;#published=-1;#uncertain=false;#proposals=new Map();
  get revision(){return this.#state.sequence;}
  markPublished(revision){if(Number.isSafeInteger(revision)&&revision<=this.#state.sequence)this.#published=Math.max(this.#published,revision);}
  static async open(worker){
    const registry=new LocalRegistration();registry.#worker=worker;registry.#base=worker.registrationBase();
    const b=registry.#base;registry.#baseHash=hashJSON([b.configPath,b.configHash,b.coreHash]);registry.#root=path.resolve(b.config.stateDir+'.registrations');registry.#documentsRoot=path.join(registry.#root,'documents');
    // Validate the nearest existing ancestor BEFORE creating private storage.
    await checkedDirectory(path.dirname(registry.#root));
    for(const protectedRoot of [...b.core.readRoots,b.core.outputRoot,b.config.stateDir,b.documentRoot]){
      const resolved=await realpath(protectedRoot);if(within(resolved,registry.#root)||within(registry.#root,resolved))fail('REGISTRATION_BOUNDARY_CHANGED');
    }
    try{await mkdir(registry.#root,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
    await checkedDirectory(registry.#root);
    await mkdir(registry.#documentsRoot,{recursive:true,mode:0o700});await checkedDirectory(registry.#documentsRoot);
    registry.#state={sequence:0,documents:[],core:plain(registry.#base.core),config:plain(registry.#base.config)};
    const revisions=[];
    for(const entry of await readdir(registry.#root,{withFileTypes:true})){
      if(!UUID.test(entry.name))continue;if(!entry.isDirectory()||entry.isSymbolicLink())fail('REGISTRATION_STORAGE_CHANGED');
      let record;try{record=strictJSON((await boundedRead(path.join(registry.#root,entry.name,'commit.json'),4096)).content);}catch(e){if(e.code==='ENOENT')continue;throw e;}
      keys(record,['schema_version','sequence','previous','baseHash','revision','stateHash','coreHash','configHash','requestId','operationHash']);
      if(record.schema_version!==1||record.revision!==entry.name||record.baseHash!==registry.#baseHash||!Number.isSafeInteger(record.sequence)||record.sequence<1||!UUID.test(record.requestId))fail('REGISTRATION_STORAGE_CHANGED');
      revisions.push(record);if(revisions.length>512)fail('REGISTRATION_LIMIT');
    }
    revisions.sort((a,b)=>a.sequence-b.sequence);
    for(const record of revisions){
      if(record.sequence!==registry.#state.sequence+1||record.previous!==(registry.#head?hashJSON(registry.#head):null))fail('REGISTRATION_STORAGE_CHANGED');
      const directory=path.join(registry.#root,record.revision);
      const state=strictJSON((await boundedRead(path.join(directory,'state.json'),200_000,record.stateHash)).content);
      const core=strictJSON((await boundedRead(path.join(directory,'core.json'),100_000,record.coreHash)).content);
      const config=strictJSON((await boundedRead(path.join(directory,'worker.json'),100_000,record.configHash)).content);
      if(state.sequence!==record.sequence||hashJSON(state.core)!==hashJSON(core)||hashJSON(state.config)!==hashJSON(config))fail('REGISTRATION_STORAGE_CHANGED');
      await registry.#verifyDocuments(state);registry.#state=state;registry.#head=record;
    }
    if(registry.#head)await worker.withRegistration(install=>install(path.join(registry.#root,registry.#head.revision,'worker.json'),async()=>{}));
    return registry;
  }
  async #verifyDocuments(state){
    if(!Array.isArray(state.documents)||state.documents.length>100)fail('REGISTRATION_STORAGE_CHANGED');
    for(const doc of state.documents){if(!validId(doc.id)||!UUID.test(doc.storage)||!['md','txt','json'].includes(doc.format))fail('REGISTRATION_STORAGE_CHANGED');await boundedRead(path.join(this.#documentsRoot,doc.storage,'document.'+doc.format),262144,doc.hash);}
  }
  async #verifyHead(){
    if(this.#uncertain)fail('REGISTRATION_STORAGE_CHANGED');
    if(!this.#head)return;
    const directory=path.join(this.#root,this.#head.revision);
    try{await boundedRead(path.join(directory,'commit.json'),4096,hashJSON(this.#head));await boundedRead(path.join(directory,'state.json'),200_000,this.#head.stateHash);}
    catch{fail('REGISTRATION_STORAGE_CHANGED');}
  }
  async view(){
    return this.#worker.serial(async()=>{
      await this.#verifyHead();
      await this.#verifyDocuments(this.#state);
      const {core,config,documents}=this.#state;
      const privateDocs=core.documents.filter(d=>d.read_roles.includes(core.role)).map(d=>{
        const added=documents.find(x=>x.id===d.id),kind=added?.kind||(config.tasks.some(t=>t.guideline_id===d.id)?'guideline':config.tasks.some(t=>t.source_ids.includes(d.id))?'source':'target');
        return{id:d.id,name:d.display_name||added?.name||path.basename(d.relativePath),kind,classification:d.classification,version:d.version,registered:!!added,items:added?.items||[]};
      });
      // Existing guidelines also remain selectable, without returning bodies.
      const policy=await createFilePolicy(core.readRoots,core.outputRoot);
      for(const doc of privateDocs.filter(d=>d.kind==='guideline'&&!d.registered)){const entry=core.documents.find(d=>d.id===doc.id);const raw=await readSelectedText(policy,entry);doc.items=this.#guideline(raw.content,entry.id,entry.version);}
      return{revision:this.#state.sequence,documents:privateDocs,tasks:config.tasks.map(t=>({...publicTask(t),targetId:t.target_doc,sourceIds:t.source_ids,guidelineId:t.guideline_id,itemIds:t.item_ids})),folders:(this.#state.folders||[]).map(f=>({...f})),synced:this.#published>=this.#state.sequence};
    });
  }
  async withRecordingContext(action){return this.#worker.withRecordingContext(async context=>action(await this.#recordingContext(context)));}
  async withLocalReview(action){return this.#worker.withLocalReview(async({context,...operations})=>action(operations,await this.#recordingContext(context)));}
  async withLocalPatch(action){return this.#worker.withLocalPatch(async({context,...operations})=>action(operations,await this.#recordingContext(context)));}
  async withEvidenceSearch(action){return this.#worker.withLocalReview(async({context,...ops})=>action(ops,await this.#recordingContext(context,true)));}
  async #recordingContext({allowed,config,core},searchOnly=false){
    await this.#verifyHead();
    if(!searchOnly)await this.#verifyDocuments(this.#state);
    const policy=await createFilePolicy(core.readRoots,core.outputRoot);
    const fileHashes=new Map(await Promise.all(allowed.map(async d=>{const entry=core.documents.find(x=>x.id===d.id);const raw=await readSelectedText(policy,entry);return[d.id,raw.hash];})));
    const documents=allowed.map(d=>{
      const entry=core.documents.find(x=>x.id===d.id),added=this.#state.documents.find(x=>x.id===d.id);
      const kind=added?.kind||(config.tasks.some(t=>t.guideline_id===d.id)?'guideline':config.tasks.some(t=>t.source_ids.includes(d.id))?'source':'target');
      // Match the existing PC selectors, plus roles already used by registered tasks.
      const roles=new Set([{target:'review',source:'source',guideline:'guideline'}[kind]]);
      for(const t of config.tasks){if(t.target_doc===d.id)roles.add('review');if(t.source_ids.includes(d.id))roles.add('source');if(t.guideline_id===d.id)roles.add('guideline');}
      return{id:d.id,display_name:entry.display_name||added?.name||path.basename(entry.relativePath),aliases:[],roles:[...roles].sort(),version:d.version,classification:d.classification,file_hash:fileHashes.get(d.id)};
    });
    return {revision:this.revision,documents,tasks:config.tasks.filter(t=>[t.target_doc,...t.source_ids,t.guideline_id].every(id=>allowed.some(d=>d.id===id))).map(t=>({id:t.id,label:t.label,actions:t.actions,formats:t.formats,targetId:t.target_doc,sourceIds:t.source_ids,guidelineId:t.guideline_id})),coverage:{scope:'all_current_acl_filtered_registered_documents',complete:true,aliases:'not_configured_in_existing_catalog',roles:'pc_selector_kind_and_registered_task_usage_not_new_acl_grants'}};
  }
  #guideline(content,id,version){
    const guideline=strictJSON(content);keys(guideline,['id','version','rules']);
    if(guideline.id!==id||guideline.version!==version||!Array.isArray(guideline.rules)||!guideline.rules.length||guideline.rules.length>32)fail('REGISTRATION_GUIDELINE_INVALID');
    const seen=new Set();return guideline.rules.map(rule=>{
      if(!validId(rule.id)||seen.has(rule.id)||typeof rule.label!=='string'||!rule.label.trim()||rule.label.length>120||!Array.isArray(rule.source_ids)||rule.source_ids.some(id=>!validId(id)))fail('REGISTRATION_GUIDELINE_INVALID');seen.add(rule.id);
      return{id:rule.id,label:rule.label,sourceIds:[...rule.source_ids]};
    });
  }
  async #folderPolicy(folder){
    if(typeof folder!=='string'||!path.isAbsolute(folder)||folder.startsWith('\\\\'))fail('DISCOVERY_FOLDER_DENIED');
    let root;try{const policy=await createFilePolicy([folder],this.#base.core.outputRoot);root=policy.roots[0];}catch{fail('DISCOVERY_FOLDER_DENIED');}
    for(const protectedRoot of [this.#base.documentRoot,this.#base.config.stateDir,this.#root])if(within(root,protectedRoot)||within(protectedRoot,root))fail('DISCOVERY_FOLDER_DENIED');
    for(const filename of [this.#base.configPath,this.#base.config.coreConfig])if(within(root,filename))fail('DISCOVERY_FOLDER_DENIED');
    return root;
  }
  async pickFolder(body,picker){
    keys(body,['requestId','revision']);if(!UUID.test(body.requestId)||!Number.isSafeInteger(body.revision))fail('REGISTRATION_INVALID');
    await this.#worker.withRegistration(async()=>{if(body.revision!==this.#state.sequence)fail('REGISTRATION_CHANGED');});
    const folder=await picker();if(folder===null)return{cancelled:true};
    return this.register('folder',{...body,folder});
  }
  async discover(body){
    keys(body,['requestId','revision','folderId']);
    return this.#worker.withRegistration(async()=>{
      await this.#verifyHead();if(!UUID.test(body.requestId)||!UUID.test(body.folderId)||body.revision!==this.#state.sequence)fail('REGISTRATION_CHANGED');
      const folder=this.#state.folders?.find(f=>f.id===body.folderId);if(!folder)fail('DISCOVERY_FOLDER_DENIED');
      const allowed=await this.#folderPolicy(folder.path),scan=await discoverFolder(allowed,this.#base.core.outputRoot),id=randomUUID(),expires=Date.now()+300000;
      this.#proposals.set(id,{scan,revision:body.revision,expires,folderId:folder.id});while(this.#proposals.size>3)this.#proposals.delete(this.#proposals.keys().next().value);
      return{proposalId:id,revision:body.revision,expires,groups:scan.groups,files:scan.files.length,skipped:scan.skipped,limited:scan.limited};
    });
  }
  async connect(body){
    keys(body,['requestId','revision','proposalId','groupId','targetId','sourceChoices','label','allowPatch','formats']);
    return this.#worker.withRegistration(async install=>{
      const proposal=this.#proposals.get(body.proposalId),signature=hashJSON(body);
      if(!proposal||proposal.expires<Date.now())fail('DISCOVERY_EXPIRED');
      if(proposal.completed){if(proposal.signature!==signature)fail('REGISTRATION_CONFLICT');return proposal.completed;}
      if(!UUID.test(body.requestId)||body.revision!==this.#state.sequence||body.revision!==proposal.revision)fail('REGISTRATION_CHANGED');
      if(typeof body.allowPatch!=='boolean'||!Array.isArray(body.formats)||!Array.isArray(body.sourceChoices))fail('REGISTRATION_INVALID');
      const group=proposal.scan.groups.find(g=>g.id===body.groupId),files=proposal.scan.files;
      if(!group||!group.targets.some(t=>t.id===body.targetId)||body.sourceChoices.length!==group.sources.length)fail('DISCOVERY_SELECTION_REQUIRED');
      const sources=[];for(const source of group.sources){const matches=body.sourceChoices.filter(s=>s?.code===source.code);if(matches.length!==1)fail('DISCOVERY_SELECTION_REQUIRED');keys(matches[0],['code','candidateId']);if(!source.options.some(o=>o.id===matches[0].candidateId))fail('DISCOVERY_SELECTION_REQUIRED');sources.push({code:source.code,file:files.find(f=>f.id===matches[0].candidateId)});}
      const target=files.find(f=>f.id===body.targetId),guide=files.find(f=>f.id===group.id);
      if(new Set([target.id,guide.id,...sources.map(s=>s.file.id)]).size!==2+sources.length)fail('DISCOVERY_SELECTION_REQUIRED');
      const folder=this.#state.folders.find(f=>f.id===proposal.folderId);await this.#folderPolicy(folder.path);
      const selected=[guide,target,...sources.map(s=>s.file)];
      const recheck=async()=>{try{for(const file of selected){const current=await readSelectedText(proposal.scan.policy,{id:'SCAN',version:'1',classification:'internal',rootIndex:0,relativePath:file.relativePath});if(current.hash!==file.hash)fail('DISCOVERY_CHANGED');}}catch{fail('DISCOVERY_CHANGED');}};
      await recheck();
      const targetCode='REVIEW_'+target.hash.slice(0,16),documents=[{file:guide,id:group.guidelineCode,version:group.version,kind:'guideline'},{file:target,id:targetCode,version:'1',kind:'target'},...sources.map(s=>({file:s.file,id:s.code,version:'1',kind:'source'}))].map(({file,...rest})=>({...rest,name:file.name,classification:'internal',content:file.content}));
      const task={requestId:body.requestId,revision:body.revision,label:body.label,targetId:targetCode,sourceIds:sources.map(s=>s.code),guidelineId:group.guidelineCode,itemIds:[],actions:['checklist_review','convert'],formats:body.formats};
      const result=await this.#change('bundle',{requestId:body.requestId,revision:body.revision,documents,task,allowPatch:body.allowPatch},install,recheck);
      proposal.completed=result;proposal.signature=signature;return result;
    });
  }
  async register(type,body){return this.#worker.withRegistration(install=>this.#change(type,body,install));}
  async #change(type,body,install,beforeCommit=async()=>{}){
      const fields=type==='document'?['requestId','revision','id','version','kind','name','classification','content']:type==='task'?['requestId','revision','label','targetId','sourceIds','guidelineId','itemIds','actions','formats']:type==='folder'?['requestId','revision','folder']:type==='bundle'?['requestId','revision','documents','task','allowPatch']:null;
      if(!fields)fail('REGISTRATION_INVALID');keys(body,type==='document'?[...fields,'displayName']:fields,fields);
      if(!UUID.test(body.requestId)||!Number.isSafeInteger(body.revision)||body.revision<0)fail('REGISTRATION_INVALID');
      await this.#verifyHead();
      const operationHash=hashJSON([type,body]);
      if(this.#head?.requestId===body.requestId){if(this.#head.operationHash!==operationHash)fail('REGISTRATION_CONFLICT');return{saved:true,revision:this.#state.sequence};}
      if(body.revision!==this.#state.sequence)fail('REGISTRATION_CHANGED');
      await this.#verifyDocuments(this.#state);
      const state=plain(this.#state);state.sequence++;
      if(type==='document')await this.#addDocument(state,body);
      if(type==='task')this.#addTask(state,body);
      let folderId;
      if(type==='folder'){const folder=await this.#folderPolicy(body.folder);state.folders??=[];if(state.folders.length>=8&&!state.folders.some(f=>f.path===folder))fail('REGISTRATION_LIMIT');if(!state.folders.some(f=>f.path===folder))state.folders.push({id:body.requestId,path:folder});folderId=state.folders.find(f=>f.path===folder).id;}
      if(type==='bundle'){
        if(!Array.isArray(body.documents)||body.documents.length>18)fail('REGISTRATION_INVALID');
        for(const document of body.documents){const existing=state.core.documents.find(d=>d.id===document.id);
          if(existing){const policy=await createFilePolicy(state.core.readRoots,state.core.outputRoot);if(!existing.read_roles.includes(state.core.role))fail('DISCOVERY_ID_CONFLICT');const original=await readSelectedText(policy,existing);if(original.hash!==digest(document.content)||document.kind==='guideline'&&existing.version!==document.version)fail('DISCOVERY_ID_CONFLICT');}
          else await this.#addDocument(state,document);
        }
        this.#addTask(state,body.task);
      }
      const revision=randomUUID(),directory=path.join(this.#root,revision);await mkdir(directory,{mode:0o700});
      state.config.coreConfig=path.join(directory,'core.json');
      const coreText=JSON.stringify(state.core);await writeNew(path.join(directory,'core.json'),coreText);
      if(type==='task'||type==='bundle'){
        const selection=type==='task'?body:body.task;
        const adapter=await FinancialDocuments.create({configPath:state.config.coreConfig,runtimePython:this.#base.runtimePython});
        try{const result=await adapter.prepare({action:'checklist_review',target_doc:selection.targetId,source_ids:selection.sourceIds,guideline_id:selection.guidelineId,item_ids:[],format:selection.formats[0]});
          if(result.reason!=='REVIEW_RESULT'||!Array.isArray(result.items)||!result.items.length)fail('REGISTRATION_REVIEW_INVALID');
          if(selection.itemIds.some(id=>!result.items.some(item=>item.item_id===id)))fail('REGISTRATION_REVIEW_INVALID');
          if(type==='bundle'&&body.allowPatch){const eligible=result.items.filter(item=>item.status==='MISSING_WITH_EVIDENCE').map(item=>item.item_id);if(eligible.length){const task=state.config.tasks.at(-1);task.item_ids=eligible;task.actions=['checklist_review','patch','convert'];}}
        }finally{adapter.cancelPending();}
      }
      const configText=JSON.stringify(state.config),stateText=JSON.stringify(state);await writeNew(path.join(directory,'worker.json'),configText);await writeNew(path.join(directory,'state.json'),stateText);
      const record={schema_version:1,sequence:state.sequence,previous:this.#head?hashJSON(this.#head):null,baseHash:this.#baseHash,revision,stateHash:digest(stateText),coreHash:digest(coreText),configHash:digest(configText),requestId:body.requestId,operationHash};
      let committing=false;
      try{await install(path.join(directory,'worker.json'),async()=>{
        await checkedDirectory(this.#root);await this.#verifyDocuments(state);await beforeCommit();
        committing=true;await writeNew(path.join(directory,'commit.json'),JSON.stringify(record));
      });}catch(error){if(committing){this.#uncertain=true;fail('REGISTRATION_STORAGE_CHANGED');}throw error;}
      this.#state=state;this.#head=record;
      return{saved:true,revision:state.sequence,...(folderId?{folderId}:{})};
  }
  async #addDocument(state,body){
    if(!validId(body.id)||!validId(body.version)||!kinds.has(body.kind)||!['synthetic','internal'].includes(body.classification)||state.core.documents.some(d=>d.id===body.id)||state.core.documents.length>=100)fail('REGISTRATION_DOCUMENT_INVALID');
    if(typeof body.name!=='string'||!body.name||body.name.length>255||/[\\/:\x00-\x1f]/u.test(body.name)||typeof body.content!=='string'||!body.content.trim()||Buffer.byteLength(body.content)>262144||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(body.content)||containsSecret(body.content))fail('REGISTRATION_DOCUMENT_INVALID');
    if(body.displayName!==undefined&&(typeof body.displayName!=='string'||!body.displayName.trim()||body.displayName.length>120||/[\\/:\x00-\x1f\x7f]/u.test(body.displayName)))fail('REGISTRATION_DOCUMENT_INVALID');
    const format=path.extname(body.name).slice(1).toLowerCase();if(!['md','txt','json'].includes(format)||body.kind==='guideline'&&format!=='json')fail('REGISTRATION_DOCUMENT_INVALID');
    if(format==='json')strictJSON(body.content);
    const items=body.kind==='guideline'?this.#guideline(body.content,body.id,body.version):[];
    const storage=randomUUID(),directory=path.join(this.#documentsRoot,storage);await checkedDirectory(this.#documentsRoot);await mkdir(directory,{mode:0o700});await writeNew(path.join(directory,'document.'+format),body.content);
    let rootIndex=state.core.readRoots.indexOf(this.#documentsRoot);if(rootIndex<0){rootIndex=state.core.readRoots.length;state.core.readRoots.push(this.#documentsRoot);}
    const entry={id:body.id,version:body.version,rootIndex,relativePath:storage+'/document.'+format,classification:body.classification,read_roles:[state.core.role],...(body.displayName!==undefined?{display_name:body.displayName}:{})};
    const policy=await createFilePolicy(state.core.readRoots,state.core.outputRoot);await readSelectedText(policy,entry);
    state.core.documents.push(entry);state.documents.push({id:body.id,name:body.name,kind:body.kind,format,storage,hash:digest(body.content),items});
  }
  #addTask(state,body){
    if(!Array.isArray(body.actions)||!Array.isArray(body.formats))fail('REGISTRATION_TASK_INVALID');
    const task={id:body.requestId,label:body.label,actions:body.actions,formats:body.formats,target_doc:body.targetId,source_ids:body.sourceIds,guideline_id:body.guidelineId,item_ids:body.itemIds};
    if(!validTask(publicTask(task))||state.config.tasks.length>=20||state.config.tasks.some(t=>t.id===task.id)||!Array.isArray(body.sourceIds)||body.sourceIds.length>16||!body.sourceIds.length||new Set(body.sourceIds).size!==body.sourceIds.length||!Array.isArray(body.itemIds)||body.itemIds.length>32||new Set(body.itemIds).size!==body.itemIds.length||[body.targetId,body.guidelineId,...body.sourceIds,...body.itemIds].some(id=>!validId(id))||new Set([body.targetId,body.guidelineId,...body.sourceIds]).size!==2+body.sourceIds.length||task.actions.includes('patch')&&!body.itemIds.length)fail('REGISTRATION_TASK_INVALID');
    const doc=id=>state.core.documents.find(d=>d.id===id&&d.read_roles.includes(state.core.role));
    if([body.targetId,body.guidelineId,...body.sourceIds].some(id=>!doc(id)))fail('REGISTRATION_TASK_INVALID');
    state.config.tasks.push(task);
  }
}
