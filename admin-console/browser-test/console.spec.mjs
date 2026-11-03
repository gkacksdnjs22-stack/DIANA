import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
async function connected(page,{role='owner',credentialId='public-credential'}={}){
  const calls=[];let scope,expired=false,offlineLogout=false;
  await page.route('**/admin/config.json',route=>route.fulfill({json:{configured:true,basePath:'/admin/',origin:'https://admin-console.example',rpID:'admin-console.example',documentAccess:false}}));
  await page.route('**/admin/browser.js',route=>route.fulfill({contentType:'text/javascript',body:'window.SimpleWebAuthnBrowser={startAuthentication:async()=>({id:"fixture-auth",signature:"private-signature"}),startRegistration:async()=>({id:"fixture-key"})};'}));
  await page.route('**/admin/api/**',async route=>{
    const action=new URL(route.request().url()).pathname.slice('/admin/api/'.length),body=route.request().postDataJSON();calls.push({action,body});
    if(action==='logout'&&offlineLogout)return route.abort();
    if(action==='list'&&expired)return route.fulfill({status:403,json:{code:'DENIED'}});
    const values={
      'login/begin':()=>{scope=body.scope;return{ceremonyId:'private-ceremony',options:{}};},
      'login/finish':()=>scope?{grant:'private-grant'}:{sessionToken:'S'.repeat(43),expiresIn:900},
      list:()=>({me:{id:owner,role},users:role==='owner'?[{id:owner,role:'owner',state:'active'},{id:other,role:'admin',state:'active'}]:[],credentials:[{id:credentialId,user_id:owner,state:'active',device_type:'multiDevice'}],sessions:[{hash:'a'.repeat(64),expires:Date.now()+600000,revoked:0}]}),
      invite:()=>({userId:other,enrollmentTicket:'T'.repeat(43)}),
      'recovery/codes':()=>({recoveryCodes:['private-recovery-one','private-recovery-two']}),
      logout:()=>({loggedOut:true}),
    };
    if(!values[action])throw Error('Unexpected fixture API '+action);
    await route.fulfill({json:values[action]()});
  });
  await page.goto('/admin/');await expect(page.getByRole('button',{name:'패스키로 로그인'})).toBeEnabled();await page.getByRole('button',{name:'패스키로 로그인'}).click();await expect(page.locator('#myRole')).toHaveText(role);
  return{calls,expire:()=>expired=true,offlineLogout:()=>offlineLogout=true};
}
test('preview is visibly disconnected, read only and responsive',async({page})=>{
  await page.goto('/admin/');await expect(page.locator('#connection')).toHaveText('로컬 미리보기');await expect(page.locator('#login')).toBeDisabled();await expect(page.locator('#invite')).toBeDisabled();
  await expect(page.locator('#notice')).toContainText('인증 연결은 꺼져');await mkdir('generated',{recursive:true});await page.screenshot({path:'generated/preview-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await expect(page.locator('#login')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'generated/preview-mobile.png',fullPage:true});
});
test('auditor controls remain read only while own credential actions are available',async({page})=>{
  await connected(page,{role:'auditor'});await expect(page.locator('#invite')).toBeDisabled();await expect(page.locator('#inviteRole')).toBeDisabled();await expect(page.locator('#accountRows')).toBeEmpty();await expect(page.locator('#addKey')).toBeEnabled();
});
test('invitation exports require manage verification and do not expose capabilities in the page',async({page})=>{
  const f=await connected(page);await page.locator('#invite').click();await expect(page.locator('#downloadPanel')).toBeVisible();
  expect(f.calls.find(x=>x.action==='login/begin'&&x.body.scope==='manage')).toBeTruthy();expect(f.calls.find(x=>x.action==='invite').body).toEqual({role:'admin',grant:'private-grant'});
  const visible=await page.locator('body').innerText();expect(visible).not.toContain('T'.repeat(43));expect(visible).not.toContain('S'.repeat(43));expect(visible).not.toContain('private-grant');
  const downloaded=page.waitForEvent('download');await page.locator('#saveFile').click();expect((await downloaded).suggestedFilename()).toBe('DIANA-admin-invitation-'+other+'.json');
  expect(await page.evaluate(()=>Object.keys(localStorage))).toEqual([]);expect(await page.context().cookies()).toEqual([]);
});
test('a failed recovery file download can be retried without reissuing or invalidating codes again',async({page})=>{
  const f=await connected(page);await page.locator('#codes').click();await expect(page.locator('#downloadPanel')).toBeVisible();expect(await page.locator('body').innerText()).not.toContain('private-recovery');
  await page.evaluate(()=>{window.originalObjectURL=URL.createObjectURL;URL.createObjectURL=()=>{throw Error('private-error');};});await page.locator('#saveFile').click();await expect(page.locator('#notice')).toContainText('같은 버튼으로 다시');
  await page.evaluate(()=>URL.createObjectURL=window.originalObjectURL);const downloaded=page.waitForEvent('download');await page.locator('#saveFile').click();expect((await downloaded).suggestedFilename()).toBe('DIANA-recovery-'+owner+'.json');expect(f.calls.filter(x=>x.action==='recovery/codes')).toHaveLength(1);
});
test('server rejection clears role controls and pending capability downloads',async({page})=>{
  const f=await connected(page);await page.locator('#codes').click();await expect(page.locator('#downloadPanel')).toBeVisible();f.expire();await page.locator('#refresh').click();await expect(page.locator('#loginPanel')).toBeVisible();await expect(page.locator('#dashboard')).toBeHidden();await expect(page.locator('#downloadPanel')).toBeHidden();await expect(page.locator('#accountRows')).toBeEmpty();
  let download=false;page.on('download',()=>download=true);await page.evaluate(()=>document.getElementById('saveFile').click());expect(download).toBe(false);
});
test('local signout clears the console even when remote logout cannot be confirmed',async({page})=>{
  const f=await connected(page);f.offlineLogout();await page.locator('#logout').click();await expect(page.locator('#dashboard')).toBeHidden();await expect(page.locator('#notice')).toContainText('서버 세션 종료는 연결 후 확인');
});
test('credential metadata is rendered as text rather than active markup',async({page})=>{
  await connected(page,{credentialId:'"><img src=x onerror="window.pwned=1">'});expect(await page.locator('img').count()).toBe(0);expect(await page.evaluate(()=>window.pwned)).toBeUndefined();
});
