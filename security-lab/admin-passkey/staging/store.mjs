import {AsyncLocalStorage} from 'node:async_hooks';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {STAGE_SCHEMA} from './config.mjs';
const tables=new Set(['users','credentials','sessions','session_authentication','tickets','challenges','grants','recovery','audit','native_requests','native_codes','staging_metadata']);
export function prepareSQL(sql) {
  let index=0;
  return sql.replace(/'(?:''|[^'])*'|[a-zA-Z_][a-zA-Z0-9_]*|\?/g,part=>part.startsWith("'")?part:part==='?'?'$'+(++index):tables.has(part)?STAGE_SCHEMA+'.'+part:part);
}
function rows(result){const fields=new Map((result.fields||[]).map(f=>[f.name,f.dataTypeID]));return (result.rows||[]).map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>{
  if(typeof value==='bigint'||typeof value==='string'&&fields.get(key)===20){const n=Number(value);if(!Number.isSafeInteger(n))throw Error('INTEGER_RANGE');return[key,n];}return[key,value];
})));}
export class StageStore {
  constructor(pool){this.pool=pool;this.scope=new AsyncLocalStorage();this.tail=Promise.resolve();}
  async serial(fn){const previous=this.tail;let release;this.tail=new Promise(r=>release=r);await previous;try{return await fn();}finally{release();}}
  async query(sql,args=[]){const client=this.scope.getStore();const execute=()=>client?client.query(prepareSQL(sql),args):this.pool.query(prepareSQL(sql),args);return client?execute():this.serial(execute);}
  async get(sql,...args){return rows(await this.query(sql,args))[0];}
  async all(sql,...args){return rows(await this.query(sql,args));}
  async run(sql,...args){const r=await this.query(sql,args);return{changes:r.rowCount??r.affectedRows??0};}
  async tx(fn){
    if(this.scope.getStore())return fn();
    return this.serial(async()=>{const client=await this.pool.connect();try{
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const value=await this.scope.run(client,fn);await client.query('COMMIT');return value;
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}});
  }
  async initialize({expectedDatabase,bootstrapHash,now=Date.now()}){
    const database=await this.get('SELECT current_database() AS name');if(database.name!==expectedDatabase)throw Error('WRONG_STAGE_DATABASE');
    await this.tx(async()=>{
      await this.query('CREATE SCHEMA IF NOT EXISTS '+STAGE_SCHEMA);
      for(const statement of (await readFile(new URL('schema.sql',import.meta.url),'utf8')).split(';').map(x=>x.trim()).filter(Boolean))await this.query(statement);
      await this.run('INSERT INTO staging_metadata VALUES(1,1,?,?,?) ON CONFLICT (id) DO NOTHING',randomBytes(16).toString('hex'),bootstrapHash,now+3_600_000);
      const metadata=await this.get('SELECT * FROM staging_metadata WHERE id=1');if(metadata.version!==1)throw Error('STAGE_SCHEMA_VERSION');
    });
  }
  async close(){await this.tail;await this.pool.end();}
}
export async function openPostgresStore(config){
  const {Pool}=await import('pg');
  // Render's internal endpoint is private-network only (external access is blocked).
  // Public endpoints always require a trusted certificate; never use rejectUnauthorized:false.
  const pool=new Pool({connectionString:config.databaseUrl,max:4,connectionTimeoutMillis:10000,idleTimeoutMillis:10000,ssl:config.privateNetwork?false:{rejectUnauthorized:true}});
  pool.on('error',()=>{});
  const store=new StageStore(pool);try{await store.initialize(config);return store;}catch{await store.close().catch(()=>{});throw Error('STAGE_DATABASE_UNAVAILABLE');}
}
