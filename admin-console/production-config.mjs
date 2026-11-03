import {isIP} from 'node:net';

export const PRODUCTION_ADMIN_SCHEMA = 'diana_admin_prod_v1';
const STAGE_HOST = 'diana-admin-passkey-stage.onrender.com';
const STAGE_DB_HOST = 'dpg-dbk9huuc6qcc73duefng-a';
const invalid = code => { throw Error(code); };
const requireValue = (ok, code) => { if (!ok) invalid(code); };
function parseURL(value, code) { try { return new URL(value); } catch { invalid(code); } }
function databaseHost(hostname, code) {
  // postgres URLs retain opaque host spelling. Parse only the host with WHATWG
  // special-scheme rules to normalize case, escapes, IDNA and IP literals offline.
  requireValue(typeof hostname === 'string' && !!hostname, code);
  const parsed = parseURL(`http://${isIP(hostname) === 6 ? '['+hostname+']' : hostname}/`, code);
  requireValue(!!parsed.hostname && !parsed.port && !parsed.username && !parsed.password
    && parsed.pathname === '/' && !parsed.search && !parsed.hash, code);
  const host = parsed.hostname.replace(/\.$/, '');
  requireValue(!!isIP(host.replace(/^\[|\]$/g, '')) || (host.length <= 253
    && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))), code);
  return host;
}
function databasePort(value, code) {
  requireValue(typeof value === 'string' && /^\d+$/.test(value), code);
  const port = Number(value);
  requireValue(Number.isInteger(port) && port >= 1 && port <= 65535, code);
  return port;
}
function decoded(value, code) { try { return decodeURIComponent(value); } catch { invalid(code); } }
const APPLICATION_QUERY_PARAMETERS = new Set(['host','port','user','password',
  'ssl','sslmode','sslcert','sslkey','sslrootcert','sslnegotiation','uselibpqcompat',
  'application_name','fallback_application_name','client_encoding','connect_timeout',
  'statement_timeout','lock_timeout','idle_in_transaction_session_timeout','query_timeout']);
function applicationDatabaseIdentity(value, env) {
  const code = 'ADMIN_APPLICATION_DATABASE_URL_INVALID';
  const url = parseURL(value, code);
  requireValue(['postgres:','postgresql:'].includes(url.protocol) && !url.hash, code);
  // pg uses the last query value, then a truthy fallback to URL authority,
  // then explicit PG* environment defaults. Do not call its full URL parser:
  // TLS file options can read files and nested connectionString is ambiguous.
  const query = Object.create(null);
  for (const [key, entry] of url.searchParams) {
    requireValue(APPLICATION_QUERY_PARAMETERS.has(key), code);
    query[key] = entry;
  }
  const host = query.host || decoded(url.hostname, code) || env.PGHOST || 'localhost';
  const user = query.user || decoded(url.username, code) || env.PGUSER;
  requireValue(typeof user === 'string' && !!user && !user.includes('\0'), code);
  return {host:databaseHost(host, code),user,
    port:databasePort(query.port || url.port || env.PGPORT || '5432', code)};
}
const realHostname = host => host.length <= 253 && host.includes('.') && !isIP(host)
  && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  && !/(?:^|\.)(localhost|invalid|test|example)$/.test(host);

/** Preparation only. Nothing imports this from the running application. */
export function productionAdminConfig(env = {}) {
  const enabled = env.DIANA_ADMIN_ENABLED;
  if (enabled === undefined || enabled === '' || enabled === 'false') return Object.freeze({enabled:false});
  requireValue(enabled === 'true', 'ADMIN_ENABLE_VALUE_INVALID');
  const origin = parseURL(env.DIANA_ADMIN_ORIGIN, 'ADMIN_PRODUCTION_ORIGIN_REQUIRED');
  requireValue(origin.protocol === 'https:' && origin.origin === env.DIANA_ADMIN_ORIGIN
    && !origin.username && !origin.password && !origin.port && realHostname(origin.hostname)
    && origin.hostname !== STAGE_HOST, 'ADMIN_PRODUCTION_ORIGIN_INVALID');
  requireValue(env.DIANA_ADMIN_RP_ID === origin.hostname, 'ADMIN_PRODUCTION_RP_ID_MISMATCH');

  const expectedDatabase = env.DIANA_ADMIN_DATABASE_NAME;
  requireValue(typeof expectedDatabase === 'string' && /^[a-z][a-z0-9_]{2,62}$/.test(expectedDatabase)
    && expectedDatabase !== 'diana_admin_stage', 'ADMIN_PRODUCTION_DATABASE_REQUIRED');
  requireValue(env.DIANA_ADMIN_DATABASE_SCHEMA === PRODUCTION_ADMIN_SCHEMA, 'ADMIN_PRODUCTION_SCHEMA_REQUIRED');
  const database = parseURL(env.DIANA_ADMIN_DATABASE_URL, 'ADMIN_PRODUCTION_DATABASE_URL_REQUIRED');
  const adminHost = databaseHost(database.hostname, 'ADMIN_PRODUCTION_DATABASE_URL_INVALID');
  const adminPort = databasePort(database.port || env.PGPORT || '5432', 'ADMIN_PRODUCTION_DATABASE_URL_INVALID');
  let databaseName;try { databaseName = decodeURIComponent(database.pathname.slice(1)); } catch { invalid('ADMIN_PRODUCTION_DATABASE_URL_INVALID'); }
  requireValue(['postgres:','postgresql:'].includes(database.protocol) && !!database.username && !!database.password
    && !database.search && !database.hash && databaseName === expectedDatabase
    && adminHost !== STAGE_DB_HOST && !adminHost.startsWith(STAGE_DB_HOST+'.')
    && !['localhost','127.0.0.1','[::1]'].includes(adminHost), 'ADMIN_PRODUCTION_DATABASE_URL_INVALID');
  // Existing application credentials are not a production authentication DB default.
  if (env.DATABASE_URL) {
    const application = applicationDatabaseIdentity(env.DATABASE_URL, env);
    const adminUser = decoded(database.username, 'ADMIN_PRODUCTION_DATABASE_URL_INVALID');
    requireValue(!(application.host === adminHost && application.port === adminPort
      && application.user === adminUser), 'ADMIN_SEPARATE_DATABASE_CREDENTIALS_REQUIRED');
  }
  const transport = env.DIANA_ADMIN_DATABASE_TRANSPORT;
  requireValue(['verified-tls','render-private'].includes(transport), 'ADMIN_PRODUCTION_TRANSPORT_REQUIRED');
  if (transport === 'render-private') {
    const host = env.DIANA_ADMIN_PRIVATE_DATABASE_HOST;
    requireValue(env.RENDER === 'true' && typeof host === 'string' && /^dpg-[a-z0-9-]+$/.test(host)
      && adminHost === host && host !== STAGE_DB_HOST, 'ADMIN_PRODUCTION_PRIVATE_DATABASE_INVALID');
  }
  const rawProxies = env.DIANA_ADMIN_TRUSTED_PROXY_IPS;
  requireValue(typeof rawProxies === 'string' && rawProxies.trim().length > 0, 'ADMIN_VERIFIED_PROXY_IPS_REQUIRED');
  const trustedProxyIPs = rawProxies.split(',').map(x => x.trim());
  requireValue(trustedProxyIPs.length <= 32 && trustedProxyIPs.every(ip => isIP(ip))
    && new Set(trustedProxyIPs).size === trustedProxyIPs.length, 'ADMIN_TRUSTED_PROXY_IPS_INVALID');
  return Object.freeze({enabled:true,origin:origin.origin,rpID:origin.hostname,
    path:'/admin/',apiBasePath:'/admin/api/',expectedDatabase,schema:PRODUCTION_ADMIN_SCHEMA,
    databaseUrl:database.href,privateNetwork:transport === 'render-private',
    trustedProxyIPs:Object.freeze(trustedProxyIPs),nativeEnabled:false});
}

/** Safe inspection output: never serializes database URLs, passwords or raw errors. */
export function inspectProductionAdminConfig(env = {}) {
  try {
    const config = productionAdminConfig(env);
    return {configurationValid:true,enabled:config.enabled,deploymentReady:false,
      requiresProductionAdapter:true,requiresProvisioning:true,requiresRuntimeWiring:true};
  } catch (error) {
    return {configurationValid:false,enabled:false,deploymentReady:false,
      code:/^ADMIN_[A-Z_]+$/.test(error.message) ? error.message : 'ADMIN_CONFIGURATION_INVALID'};
  }
}
