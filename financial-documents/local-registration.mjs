import path from 'node:path';
import {mkdir,readdir,lstat,realpath,open} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {strictJSON,keys,validId,fail} from './strict-json.mjs';
import {boundedRead,readSelectedText,verifyOpenedOutput} from './files.mjs';
import {checkedDirectory,digest} from '../personal-ai/documents/files.mjs';
import {createFilePolicy} from '../local-ai/files.mjs';
import {UUID,validTask,publicTask} from '../lib/financial-contract.mjs';
import {FinancialDocuments} from './adapter.mjs';

const within=(a,b)=>{const r=path.relative(a,b);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
const plain=value=>JSON.parse(JSON.stringify(value));
const hashJSON=value=>digest(JSON.stringify(value));
const kinds=new Set(['target','source','guideline']);
const sensitive=/-----BEGIN .*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{30,})|["']?(?:api[_-]?key|private_key|client_secret|password)["']?\s*[:=]\s*\S+/iu;
async function writeNew(filename,content){const parent=path.dirname(filename);await checkedDirectory(parent);const handle=await open(filename,'ax',0o600);try{await verifyOpenedOutput(handle,filename,parent);await handle.writeFile(content);await handle.sync();await verifyOpenedOutput(handle,filename,parent);}finally{await handle.close();}}

/** Append-only PC catalog. Original configs and source files are never edited.
 * Revisions become visible only after all files validate and a final commit
 * marker is flushed. Incomplete staging directories are inert. */
export class LocalRegistration {
  #worker;#base;#root;#documentsRoot;#head=null;#state;#baseHash;#published=-1;#uncertain=false;
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
        return{id:d.id,name:added?.name||path.basename(d.relativePath),kind,classification:d.classification,version:d.version,registered:!!added,items:added?.items||[]};
      });
      // Existing guidelines also remain selectable, without returning bodies.
      const policy=await createFilePolicy(core.readRoots,core.outputRoot);
      for(const doc of privateDocs.filter(d=>d.kind==='guideline'&&!d.registered)){const entry=core.documents.find(d=>d.id===doc.id);const raw=await readSelectedText(policy,entry);doc.items=this.#guideline(raw.content,entry.id,entry.version);}
      return{revision:this.#state.sequence,documents:privateDocs,tasks:config.tasks.map(t=>({...publicTask(t),targetId:t.target_doc,sourceIds:t.source_ids,guidelineId:t.guideline_id,itemIds:t.item_ids})),synced:this.#published>=this.#state.sequence};
    });
  }
  #guideline(content,id,version){
    const guideline=strictJSON(content);keys(guideline,['id','version','rules']);
    if(guideline.id!==id||guideline.version!==version||!Array.isArray(guideline.rules)||!guideline.rules.length||guideline.rules.length>32)fail('REGISTRATION_GUIDELINE_INVALID');
    const seen=new Set();return guideline.rules.map(rule=>{
      if(!validId(rule.id)||seen.has(rule.id)||typeof rule.label!=='string'||!rule.label.trim()||rule.label.length>120||!Array.isArray(rule.source_ids)||rule.source_ids.some(id=>!validId(id)))fail('REGISTRATION_GUIDELINE_INVALID');seen.add(rule.id);
      return{id:rule.id,label:rule.label,sourceIds:[...rule.source_ids]};
    });
  }
  async register(type,body){
    return this.#worker.withRegistration(async install=>{
      keys(body,type==='document'?['requestId','revision','id','version','kind','name','classification','content']:['requestId','revision','label','targetId','sourceIds','guidelineId','itemIds','actions','formats']);
      if(!UUID.test(body.requestId)||!Number.isSafeInteger(body.revision)||body.revision<0)fail('REGISTRATION_INVALID');
      await this.#verifyHead();
      const operationHash=hashJSON([type,body]);
      if(this.#head?.requestId===body.requestId){if(this.#head.operationHash!==operationHash)fail('REGISTRATION_CONFLICT');return{saved:true,revision:this.#state.sequence};}
      if(body.revision!==this.#state.sequence)fail('REGISTRATION_CHANGED');
      await this.#verifyDocuments(this.#state);
      const state=plain(this.#state);state.sequence++;
      if(type==='document')await this.#addDocument(state,body);else if(type==='task')this.#addTask(state,body);else fail('REGISTRATION_INVALID');
      const revision=randomUUID(),directory=path.join(this.#root,revision);await mkdir(directory,{mode:0o700});
      state.config.coreConfig=path.join(directory,'core.json');
      const configText=JSON.stringify(state.config),coreText=JSON.stringify(state.core),stateText=JSON.stringify(state);
      await writeNew(path.join(directory,'core.json'),coreText);await writeNew(path.join(directory,'worker.json'),configText);await writeNew(path.join(directory,'state.json'),stateText);
      if(type==='task'){
        const adapter=await FinancialDocuments.create({configPath:state.config.coreConfig});
        try{const result=await adapter.prepare({action:'checklist_review',target_doc:body.targetId,source_ids:body.sourceIds,guideline_id:body.guidelineId,item_ids:[],format:body.formats[0]});
          if(result.reason!=='REVIEW_RESULT'||!Array.isArray(result.items)||!result.items.length)fail('REGISTRATION_REVIEW_INVALID');
          if(body.itemIds.some(id=>!result.items.some(item=>item.item_id===id)))fail('REGISTRATION_REVIEW_INVALID');
        }finally{adapter.cancelPending();}
      }
      const record={schema_version:1,sequence:state.sequence,previous:this.#head?hashJSON(this.#head):null,baseHash:this.#baseHash,revision,stateHash:digest(stateText),coreHash:digest(coreText),configHash:digest(configText),requestId:body.requestId,operationHash};
      let committing=false;
      try{await install(path.join(directory,'worker.json'),async()=>{
        await checkedDirectory(this.#root);await this.#verifyDocuments(state);
        committing=true;await writeNew(path.join(directory,'commit.json'),JSON.stringify(record));
      });}catch(error){if(committing){this.#uncertain=true;fail('REGISTRATION_STORAGE_CHANGED');}throw error;}
      this.#state=state;this.#head=record;
      return{saved:true,revision:state.sequence};
    });
  }
  async #addDocument(state,body){
    if(!validId(body.id)||!validId(body.version)||!kinds.has(body.kind)||!['synthetic','internal'].includes(body.classification)||state.core.documents.some(d=>d.id===body.id)||state.core.documents.length>=100)fail('REGISTRATION_DOCUMENT_INVALID');
    if(typeof body.name!=='string'||!body.name||body.name.length>255||/[\\/:\x00-\x1f]/u.test(body.name)||typeof body.content!=='string'||!body.content.trim()||Buffer.byteLength(body.content)>262144||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(body.content)||sensitive.test(body.content))fail('REGISTRATION_DOCUMENT_INVALID');
    const format=path.extname(body.name).slice(1).toLowerCase();if(!['md','txt','json'].includes(format)||body.kind==='guideline'&&format!=='json')fail('REGISTRATION_DOCUMENT_INVALID');
    if(format==='json')strictJSON(body.content);
    const items=body.kind==='guideline'?this.#guideline(body.content,body.id,body.version):[];
    const storage=randomUUID(),directory=path.join(this.#documentsRoot,storage);await checkedDirectory(this.#documentsRoot);await mkdir(directory,{mode:0o700});await writeNew(path.join(directory,'document.'+format),body.content);
    let rootIndex=state.core.readRoots.indexOf(this.#documentsRoot);if(rootIndex<0){rootIndex=state.core.readRoots.length;state.core.readRoots.push(this.#documentsRoot);}
    const entry={id:body.id,version:body.version,rootIndex,relativePath:storage+'/document.'+format,classification:body.classification,read_roles:[state.core.role]};
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
