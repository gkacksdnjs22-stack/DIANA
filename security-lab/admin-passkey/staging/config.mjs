export const STAGE_DATABASE='diana_admin_stage';
export const STAGE_SCHEMA='diana_admin_stage_v1';
export function stageConfig(env) {
  if(env.DIANA_STAGE!=='admin-passkey')throw Error('STAGE_MARKER_REQUIRED');
  const origin=new URL(env.ADMIN_ORIGIN||'');
  if(origin.protocol!=='https:'||origin.origin!==env.ADMIN_ORIGIN||origin.username||origin.password||origin.port||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(origin.hostname)||origin.hostname.endsWith('.localhost'))throw Error('STAGE_HTTPS_ORIGIN_REQUIRED');
  if(env.ADMIN_RP_ID!==origin.hostname)throw Error('STAGE_RP_ID_MISMATCH');
  const database=new URL(env.ADMIN_DATABASE_URL||'');
  if(!['postgres:','postgresql:'].includes(database.protocol)||decodeURIComponent(database.pathname.slice(1))!==STAGE_DATABASE||!database.username||!database.password||database.search)throw Error('DEDICATED_STAGE_DATABASE_REQUIRED');
  const privateNetwork=env.ADMIN_DATABASE_TRANSPORT==='render-private';
  if(privateNetwork&&(env.RENDER!=='true'||database.hostname!=='dpg-dbk9huuc6qcc73duefng-a'))throw Error('RENDER_PRIVATE_DATABASE_REQUIRED');
  if(env.ADMIN_DATABASE_TRANSPORT&&!privateNetwork&&env.ADMIN_DATABASE_TRANSPORT!=='verified-tls')throw Error('DATABASE_TRANSPORT_INVALID');
  const bootstrapHash=env.ADMIN_BOOTSTRAP_SHA256||'';
  if(!/^[a-f0-9]{64}$/.test(bootstrapHash))throw Error('STAGE_BOOTSTRAP_HASH_REQUIRED');
  const port=Number(env.PORT||10000);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('STAGE_PORT_INVALID');
  return {origin:origin.origin,rpID:origin.hostname,databaseUrl:database.href,privateNetwork,expectedDatabase:STAGE_DATABASE,bootstrapHash,port,androidRedirect:'kr.nightdesk.phone.lab.passkey.stage://oauth2/callback'};
}
