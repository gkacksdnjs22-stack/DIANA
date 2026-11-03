import {test} from 'node:test';
import assert from 'node:assert/strict';
import {productionAdminConfig,inspectProductionAdminConfig} from '../production-config.mjs';
const valid = () => ({DIANA_ADMIN_ENABLED:'true',DIANA_ADMIN_ORIGIN:'https://admin.diana.company',
  DIANA_ADMIN_RP_ID:'admin.diana.company',DIANA_ADMIN_DATABASE_NAME:'diana_admin_production',
  DIANA_ADMIN_DATABASE_SCHEMA:'diana_admin_prod_v1',
  DIANA_ADMIN_DATABASE_URL:'postgresql://admin:fixture-private-password@db.diana.company/diana_admin_production',
  DIANA_ADMIN_DATABASE_TRANSPORT:'verified-tls',DIANA_ADMIN_TRUSTED_PROXY_IPS:'192.0.2.10'});
test('default and explicit disabled configuration do not read database or legacy application credentials',()=>{
  assert.deepEqual(productionAdminConfig(),{enabled:false});
  const env={DIANA_ADMIN_ENABLED:'false',get DATABASE_URL(){throw Error('MUST_NOT_READ');},get DIANA_ADMIN_DATABASE_URL(){throw Error('MUST_NOT_READ');}};
  assert.deepEqual(productionAdminConfig(env),{enabled:false});
});
test('valid configuration is immutable, uses distinct paths and does not declare deployment readiness',()=>{
  const c=productionAdminConfig(valid());assert.equal(c.origin,'https://admin.diana.company');assert.equal(c.apiBasePath,'/admin/api/');
  assert.equal(c.schema,'diana_admin_prod_v1');assert.equal(c.nativeEnabled,false);assert.ok(Object.isFrozen(c));assert.ok(Object.isFrozen(c.trustedProxyIPs));
  assert.equal(inspectProductionAdminConfig(valid()).deploymentReady,false);
});
test('enabling requires an exact explicit value',()=>{
  for(const value of ['1','TRUE','yes',true])assert.throws(()=>productionAdminConfig({...valid(),DIANA_ADMIN_ENABLED:value}));
});
test('rejects staging, localhost, non-HTTPS, URL suffixes and embedded credentials as production origins',()=>{
  for(const origin of ['https://diana-admin-passkey-stage.onrender.com','http://admin.diana.company','https://localhost','https://127.0.0.1','https://admin.diana.invalid','https://admin..company','https://admin.-diana.company','https://admin.diana.company/','https://admin.diana.company:444','https://secret:private@admin.diana.company','https://admin.diana.company?token=private']){
    assert.throws(()=>productionAdminConfig({...valid(),DIANA_ADMIN_ORIGIN:origin,DIANA_ADMIN_RP_ID:new URL(origin).hostname}));
  }
  assert.throws(()=>productionAdminConfig({...valid(),DIANA_ADMIN_RP_ID:'diana.company'}));
});
test('rejects test database and schema or reusing the application credentials',()=>{
  for(const patch of [{DIANA_ADMIN_DATABASE_NAME:'diana_admin_stage'},{DIANA_ADMIN_DATABASE_SCHEMA:'diana_admin_stage_v1'},{DIANA_ADMIN_DATABASE_SCHEMA:'public'},
    {DIANA_ADMIN_DATABASE_URL:'postgresql://u:p@dpg-dbk9huuc6qcc73duefng-a/diana_admin_production'},
    {DIANA_ADMIN_DATABASE_URL:'postgresql://u:p@dpg-dbk9huuc6qcc73duefng-a.singapore-postgres.render.com/diana_admin_production'},
    {DATABASE_URL:valid().DIANA_ADMIN_DATABASE_URL},
    {DATABASE_URL:'postgres://admin:changed@db.diana.company:5432/other_database'},
    {DATABASE_URL:'postgres://%61dmin:changed@db.diana.company:5432/other_database'}])assert.throws(()=>productionAdminConfig({...valid(),...patch}));
});
test('rejects mismatched DB names, missing credentials and TLS query overrides',()=>{
  for(const url of ['postgresql://u:p@db.diana.company/other','postgresql://u@db.diana.company/diana_admin_production',valid().DIANA_ADMIN_DATABASE_URL+'?sslmode=no-verify',valid().DIANA_ADMIN_DATABASE_URL+'#private','postgresql://u:p@localhost/diana_admin_production'])assert.throws(()=>productionAdminConfig({...valid(),DIANA_ADMIN_DATABASE_URL:url}));
  for(const mode of [undefined,'','insecure'])assert.throws(()=>productionAdminConfig({...valid(),DIANA_ADMIN_DATABASE_TRANSPORT:mode}));
});

test('normalizes both DB hosts before rejecting reuse of the application role',()=>{
  const hosts=['db.diana.company','DB.DIANA.COMPANY','%64b.diana.company','db.diana.company.','%44B.DIANA.COMPANY.'];
  for(const adminHost of hosts)for(const applicationHost of hosts){
    assert.throws(()=>productionAdminConfig({...valid(),
      DIANA_ADMIN_DATABASE_URL:`postgresql://admin:p@${adminHost}/diana_admin_production`,
      DATABASE_URL:`postgres://%61dmin:changed@${applicationHost}:5432/other_database`}),
    {message:'ADMIN_SEPARATE_DATABASE_CREDENTIALS_REQUIRED'},`${adminHost} / ${applicationHost}`);
  }
  assert.throws(()=>productionAdminConfig({...valid(),
    DIANA_ADMIN_DATABASE_URL:'postgresql://admin:p@[2001:db8::1]/diana_admin_production',
    DATABASE_URL:'postgresql://admin:p@[2001:0db8:0:0:0:0:0:1]:5432/app'}),
  {message:'ADMIN_SEPARATE_DATABASE_CREDENTIALS_REQUIRED'});
  for(const DATABASE_URL of ['postgres://different:p@DB.DIANA.COMPANY/app','postgres://admin:p@other.diana.company/app']){
    assert.equal(productionAdminConfig({...valid(),DATABASE_URL}).enabled,true);
  }
});

test('staging and loopback exclusions use the same normalized database host',()=>{
  for(const host of ['DPG-DBK9HUUC6QCC73DUEFNG-A','%64pg-dbk9huuc6qcc73duefng-a',
    'dpg-dbk9huuc6qcc73duefng-a.','DPG-DBK9HUUC6QCC73DUEFNG-A.SINGAPORE-POSTGRES.RENDER.COM.',
    'LOCALHOST','%6cocalhost','localhost.','127.1','0x7f000001','[0:0:0:0:0:0:0:1]']){
    assert.throws(()=>productionAdminConfig({...valid(),DIANA_ADMIN_DATABASE_URL:`postgresql://u:p@${host}/diana_admin_production`}),
    {message:'ADMIN_PRODUCTION_DATABASE_URL_INVALID'},host);
  }
});

test('host normalization rejects malformed escapes and applies to private-host matching',()=>{
  for(const host of ['%ZZ.diana.company','db%2fdiana.company','db%40diana.company']){
    assert.throws(()=>productionAdminConfig({...valid(),DIANA_ADMIN_DATABASE_URL:`postgresql://u:p@${host}/diana_admin_production`}),
    {message:'ADMIN_PRODUCTION_DATABASE_URL_INVALID'});
    assert.throws(()=>productionAdminConfig({...valid(),DATABASE_URL:`postgresql://u:p@${host}/app`}),
    {message:'ADMIN_APPLICATION_DATABASE_URL_INVALID'});
  }
  assert.equal(productionAdminConfig({...valid(),RENDER:'true',DIANA_ADMIN_DATABASE_TRANSPORT:'render-private',
    DIANA_ADMIN_PRIVATE_DATABASE_HOST:'dpg-prod-fixture-a',
    DIANA_ADMIN_DATABASE_URL:'postgresql://u:p@DPG-PROD-FIXTURE-A./diana_admin_production'}).privateNetwork,true);
});
test('private transport needs explicit Render context and matching production host',()=>{
  const env={...valid(),RENDER:'true',DIANA_ADMIN_DATABASE_TRANSPORT:'render-private',DIANA_ADMIN_PRIVATE_DATABASE_HOST:'dpg-prod-fixture-a',DIANA_ADMIN_DATABASE_URL:'postgresql://u:p@dpg-prod-fixture-a/diana_admin_production'};
  assert.equal(productionAdminConfig(env).privateNetwork,true);
  for(const patch of [{RENDER:'false'},{DIANA_ADMIN_PRIVATE_DATABASE_HOST:'dpg-other-a'},{DIANA_ADMIN_PRIVATE_DATABASE_HOST:''}])assert.throws(()=>productionAdminConfig({...env,...patch}));
});
test('proxy trust cannot be empty, wildcard, CIDR, duplicate or oversized',()=>{
  for(const ips of ['',undefined,'*','0.0.0.0/0','not-an-ip','192.0.2.10,192.0.2.10',Array.from({length:33},(_,i)=>'192.0.2.'+(i+1)).join(',')])assert.throws(()=>productionAdminConfig({...valid(),DIANA_ADMIN_TRUSTED_PROXY_IPS:ips}));
});
test('inspection excludes secrets and error input while staying not ready for deployment',()=>{
  for(const env of [valid(),{...valid(),DIANA_ADMIN_ORIGIN:'https://secret:private-secret@admin.diana.company'},{...valid(),DIANA_ADMIN_DATABASE_URL:'private-secret'}]){
    const r=inspectProductionAdminConfig(env),text=JSON.stringify(r);assert.equal(r.deploymentReady,false);
    for(const secret of ['fixture-private-password','private-secret','postgresql://'])assert.ok(!text.includes(secret));
  }
});
