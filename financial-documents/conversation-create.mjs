import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DocumentIntentModel} from '../personal-ai/documents/intent-model.mjs';
const expected='47b0db575fa5535e2f7dcdc790a47ba7ba960485ef81f930416d7ab350ff2856';
export async function loadExistingCreate(){const root=new URL('./conversation-assets/',import.meta.url),raw=await readFile(new URL('existing-document-create.json',root)),m=JSON.parse(await readFile(new URL('existing-create-manifest.json',root),'utf8'));if(m.sha256!==expected||createHash('sha256').update(raw).digest('hex')!==expected)throw Error('CREATE_MODEL_ASSET_ERROR');const model=DocumentIntentModel.load(JSON.parse(raw),{source:'existing-document-intent',trainingThisTask:0});return text=>model.predict(text);}
export const creationScope=text=>/(?:새|신규)\s*검토서|검토서.{0,6}(?:새로|신규)/u.test(text);
export const creationAccepted=p=>p.label==='create'&&p.probability>=.8&&p.margin>=.35&&p.coverage>=.45;
export function draftUserReply(draft,text){const value=text.trim();if(draft.stage==='title'){if(!value||value.length>120||/[\r\n]/u.test(value))throw Error('CHAT_DRAFT_TITLE');return{...draft,title:value,stage:'investment'};}if(draft.stage==='investment'){if(!value||value.length>300)throw Error('CHAT_DRAFT_INVESTMENT');return{...draft,investment:value,stage:'memo'};}if(draft.stage==='memo'){if(value.length>2000)throw Error('CHAT_DRAFT_MEMO');return{...draft,memo:value==='없음'?'':text,stage:'materials'};}throw Error('CHAT_DRAFT_STAGE');}
