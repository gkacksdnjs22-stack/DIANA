import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const PHONE_COLUMNS = ['id', 'token_hash', 'name', 'created_at', 'last_seen_at', 'fcm_token', 'revoked_at'];
const PHONE_UPSERT = `INSERT INTO diana.phone_devices (${PHONE_COLUMNS.join(',')})
  VALUES (${PHONE_COLUMNS.map((_, i) => `$${i + 1}`).join(',')})
  ON CONFLICT (id) DO UPDATE SET ${PHONE_COLUMNS.slice(1).map(c => `${c}=EXCLUDED.${c}`).join(',')}`;

/**
 * The control protocol uses synchronous SQLite queries. This adapter keeps an
 * in-memory SQLite view for that protocol, and durably mirrors each mutation
 * to Supabase Postgres before an HTTP response can acknowledge the operation.
 * Only one server instance must use this adapter for a given DIANA database.
 */
export async function createPersistentState({ connectionString, pool: suppliedPool } = {}) {
  if (!suppliedPool && (!connectionString || !/^postgres(?:ql)?:\/\//.test(connectionString))) {
    throw new Error('DATABASE_URL에 Supabase Postgres 연결 문자열이 필요합니다.');
  }
  const pool = suppliedPool || new pg.Pool({
    connectionString, max: 2, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 15_000,
    ssl: { rejectUnauthorized: true },
  });
  const local = new DatabaseSync(':memory:');
  local.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE phone_devices(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,name TEXT NOT NULL,
      created_at TEXT NOT NULL,last_seen_at TEXT,fcm_token TEXT,revoked_at TEXT)`);
  try {
    // A schema/version error stops startup. Never silently fall back to an
    // ephemeral database when persistence was explicitly requested.
    const [jobs, settings, phones] = await Promise.all([
      pool.query('SELECT id,data FROM diana.jobs ORDER BY inserted_seq ASC'),
      pool.query('SELECT key,value FROM diana.settings'),
      pool.query(`SELECT ${PHONE_COLUMNS.join(',')} FROM diana.phone_devices`),
    ]);
    for (const row of jobs.rows) local.prepare('INSERT INTO jobs(id,data) VALUES(?,?)').run(row.id, row.data);
    for (const row of settings.rows) local.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(row.key, row.value);
    for (const row of phones.rows) local.prepare(`INSERT INTO phone_devices(${PHONE_COLUMNS.join(',')}) VALUES(${PHONE_COLUMNS.map(() => '?').join(',')})`)
      .run(...PHONE_COLUMNS.map(c => row[c]));
  } catch (error) {
    local.close();
    if (!suppliedPool) await pool.end();
    throw new Error('Supabase의 DIANA 테이블을 불러오지 못했습니다. 연결 문자열과 SQL 생성 결과를 확인하세요.', { cause: error });
  }

  let pending = Promise.resolve();
  let failed = null;
  const enqueue = operation => {
    pending = pending.then(operation).catch(error => {
      failed = error;
      throw error;
    });
    // A maintenance write can occur without an HTTP response awaiting flush.
    // Keep the failure observable through flush()/requireHealthy() without an
    // unhandled-rejection crash before the server can report an error.
    void pending.catch(() => {});
  };
  const requireHealthy = () => {
    if (failed) throw new Error('Supabase 저장이 실패하여 서버 쓰기를 중단했습니다.', { cause: failed });
  };
  function mirrorWrite(sql, args) {
    if (/\b(?:INSERT|UPDATE|DELETE)\b[\s\S]*\bjobs\b/i.test(sql)) {
      const id = args[0];
      const row = local.prepare('SELECT data FROM jobs WHERE id=?').get(id);
      if (row) enqueue(() => pool.query('INSERT INTO diana.jobs(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data', [id, row.data]));
      else enqueue(() => pool.query('DELETE FROM diana.jobs WHERE id=$1', [id]));
    } else if (/\bsettings\b/i.test(sql)) {
      const literal = sql.match(/VALUES\s*\(\s*'([^']+)'\s*,/i)?.[1];
      const key = literal || args[0];
      const row = local.prepare('SELECT value FROM settings WHERE key=?').get(key);
      if (row) enqueue(() => pool.query('INSERT INTO diana.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, row.value]));
      else enqueue(() => pool.query('DELETE FROM diana.settings WHERE key=$1', [key]));
    } else if (/\bphone_devices\b/i.test(sql)) {
      const id = /^\s*INSERT\b/i.test(sql) ? args[0] : args.at(-1);
      const row = local.prepare(`SELECT ${PHONE_COLUMNS.join(',')} FROM phone_devices WHERE id=?`).get(id);
      if (row) enqueue(() => pool.query(PHONE_UPSERT, PHONE_COLUMNS.map(c => row[c])));
      else enqueue(() => pool.query('DELETE FROM diana.phone_devices WHERE id=$1', [id]));
    }
  }

  const db = {
    exec(sql) { requireHealthy(); return local.exec(sql); },
    prepare(sql) {
      const statement = local.prepare(sql);
      return {
        get(...args) { requireHealthy(); return statement.get(...args); },
        all(...args) { requireHealthy(); return statement.all(...args); },
        run(...args) {
          requireHealthy();
          const result = statement.run(...args);
          mirrorWrite(sql, args);
          return result;
        },
      };
    },
    async flush() { await pending; requireHealthy(); },
    close() { local.close(); if (!suppliedPool) void pool.end(); },
  };
  return db;
}
