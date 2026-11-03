import {isIP} from 'node:net';

export const PRODUCTION_ADMIN_SCHEMA = 'diana_admin_prod_v1';
const STAGE_HOST = 'diana-admin-passkey-stage.onrender.com';
const STAGE_DB_HOST = 'dpg-dbk9huuc6qcc73duefng-a';
const invalid = code => { throw Error(code); };
const requireValue = (ok, code) => { if (!ok) invalid(code); };
function parseURL(value, code) { try { return new URL(value); } catch { invalid(code); } }
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
  let databaseName;try { databaseName = decodeURIComponent(database.pathname.slice(1)); } catch { invalid('ADMIN_PRODUCTION_DATABASE_URL_INVALID'); }
  requireValue(['postgres:','postgresql:'].includes(database.protocol) && !!database.username && !!database.password
    && !database.search && !database.hash && databaseName === expectedDatabase
    && database.hostname !== STAGE_DB_HOST && !database.hostname.startsWith(STAGE_DB_HOST+'.')
    && !['localhost','127.0.0.1','::1','[::1]'].includes(database.hostname), 'ADMIN_PRODUCTION_DATABASE_URL_INVALID');
  // Existing application credentials are not a production authentication DB default.
  if (env.DATABASE_URL) {
    const application = parseURL(env.DATABASE_URL, 'ADMIN_APPLICATION_DATABASE_URL_INVALID');
    let applicationUser, adminUser;
    try { applicationUser = decodeURIComponent(application.username); adminUser = decodeURIComponent(database.username); }
    catch { invalid('ADMIN_PRODUCTION_DATABASE_URL_INVALID'); }
    requireValue(!(application.hostname === database.hostname
      && (application.port || '5432') === (database.port || '5432')
      && applicationUser === adminUser), 'ADMIN_SEPARATE_DATABASE_CREDENTIALS_REQUIRED');
  }
  const transport = env.DIANA_ADMIN_DATABASE_TRANSPORT;
  requireValue(['verified-tls','render-private'].includes(transport), 'ADMIN_PRODUCTION_TRANSPORT_REQUIRED');
  if (transport === 'render-private') {
    const host = env.DIANA_ADMIN_PRIVATE_DATABASE_HOST;
    requireValue(env.RENDER === 'true' && typeof host === 'string' && /^dpg-[a-z0-9-]+$/.test(host)
      && database.hostname === host && host !== STAGE_DB_HOST, 'ADMIN_PRODUCTION_PRIVATE_DATABASE_INVALID');
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
