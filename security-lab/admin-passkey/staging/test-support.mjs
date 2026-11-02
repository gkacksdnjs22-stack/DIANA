import {PGlite} from '@electric-sql/pglite';
import {StageStore} from './store.mjs';
export async function pgliteStore({dataDir,bootstrapHash='a'.repeat(64)}={}){
  const db=new PGlite(dataDir);await db.waitReady;
  const pool={query:(sql,args=[])=>db.query(sql,args),connect:async()=>({query:(sql,args=[])=>db.query(sql,args),release(){}}),end:()=>db.close()};
  const store=new StageStore(pool);await store.initialize({expectedDatabase:'postgres',bootstrapHash});return store;
}
