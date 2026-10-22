import { createControlServer } from './lib/control.mjs';
import { createPersistentState } from './lib/persistent-state.mjs';
import { createSupabaseTransferStore } from './lib/transfer-store.mjs';
import { resolve } from 'node:path';
const port = Number(process.env.PORT || 3410);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT를 확인하세요.');
const databaseUrl = process.env.DATABASE_URL;
const storageUrl = process.env.SUPABASE_URL;
const storageKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if ([databaseUrl, storageUrl, storageKey].some(Boolean) && ![databaseUrl, storageUrl, storageKey].every(Boolean)) {
  throw new Error('Supabase 설정은 DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 모두 필요합니다.');
}
const db = databaseUrl ? await createPersistentState({ connectionString: databaseUrl }) : undefined;
const transfers = databaseUrl ? createSupabaseTransferStore({
  url: storageUrl, serviceRoleKey: storageKey,
  bucket: process.env.SUPABASE_STORAGE_BUCKET || 'diana-transfers',
}) : undefined;
const server = createControlServer({ userToken: process.env.USER_TOKEN, agentToken: process.env.AGENT_TOKEN,
  gatewayToken: process.env.GATEWAY_TOKEN, deviceId: process.env.DEVICE_ID || 'home-pc',
  appOrigin: process.env.APP_ORIGIN, dbPath: resolve('.local/control.sqlite'), db, transfers });
server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`원격비서 제어 화면: http://127.0.0.1:${port}`));
