import {test,expect,chromium} from '@playwright/test';
import {readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {connectedFixture} from '../test-support/connected.mjs';

test.describe.serial('real WebAuthn signatures against a connected test database',()=>{
  let fixture,browser,ownerContext,adminContext,ownerPage,adminPage,ownerId,invitation;
  async function pageWithAuthenticator(){
    const context=await browser.newContext();const page=await context.newPage();
    const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
    page.on('dialog',d=>d.accept());return{context,page};
  }
  async function login(page,role){await page.locator('#login').click();await expect(page.locator('#myRole')).toHaveText(role);}
  async function enroll(page,ticket){await page.goto(fixture.origin+'/admin/');await expect(page.locator('#enroll')).toBeEnabled();await page.locator('#ticket').fill(ticket);await page.locator('#enroll').click();await expect(page.locator('#notice')).toContainText('패스키 등록을 완료');}
  async function downloaded(page){const pending=page.waitForEvent('download');await page.locator('#saveFile').click();return JSON.parse(await readFile(await(await pending).path(),'utf8'));}
  const accountRow=id=>ownerPage.locator('#accountRows tr').filter({has:ownerPage.locator('td[title="'+id+'"]')});
  async function role(id,value){const row=accountRow(id);await row.getByRole('combobox').selectOption(value);await row.getByRole('button',{name:'변경',exact:true}).click();await expect(row.getByRole('combobox')).toHaveValue(value);await expect(ownerPage.locator('#notice')).toContainText('권한을 변경');}
  test.beforeAll(async()=>{
    fixture=await connectedFixture();
    // Only this disposable browser trusts the one ephemeral leaf key. No OS CA or
    // global HTTPS validation setting is changed; all real service checks remain strict.
    browser=await chromium.launch({headless:true,...(process.env.ADMIN_TEST_CHROME_PATH?{executablePath:process.env.ADMIN_TEST_CHROME_PATH}:{}),args:['--host-resolver-rules=MAP admin-console.test 127.0.0.1','--ignore-certificate-errors-spki-list='+fixture.certificatePin,'--no-proxy-server']});
    const o=await pageWithAuthenticator();ownerContext=o.context;ownerPage=o.page;
  });
  test.afterAll(async()=>{await adminContext?.close();await ownerContext?.close();await browser?.close();await fixture?.dispose();});
  test('registers and logs in with verified signatures, then retains the session after DB reopen',async()=>{
    test.setTimeout(120000);await enroll(ownerPage,fixture.enrollmentTicket);await login(ownerPage,'owner');
    ownerId=(await fixture.auth.get("SELECT id FROM users WHERE role='owner' AND state='active'")).id;
    expect(await ownerPage.evaluate(()=>isSecureContext)).toBe(true);
    await fixture.restart();await ownerPage.locator('#refresh').click();await expect(ownerPage.locator('#myRole')).toHaveText('owner');await expect(ownerPage.locator('#notice')).toContainText('현재 권한');
    expect((await fixture.auth.get("SELECT COUNT(*) n FROM credentials WHERE user_id=? AND state='active'",ownerId)).n).toBe(1);
  });
  test('enrolls a separate admin and enforces role changes and unauthorized promotion rejection',async()=>{
    test.setTimeout(120000);await ownerPage.locator('#inviteRole').selectOption('admin');await ownerPage.locator('#invite').click();await expect(ownerPage.locator('#downloadPanel')).toBeVisible();invitation=await downloaded(ownerPage);
    expect(invitation.kind==='diana-admin-invitation-v1'&&invitation.origin===fixture.origin&&invitation.role==='admin'&&invitation.userId!==ownerId).toBe(true);
    const a=await pageWithAuthenticator();adminContext=a.context;adminPage=a.page;await enroll(adminPage,invitation.enrollmentTicket);await login(adminPage,'admin');
    await ownerPage.locator('#refresh').click();await role(invitation.userId,'auditor');await adminPage.locator('#refresh').click();await expect(adminPage.locator('#loginPanel')).toBeVisible();await expect(adminPage.locator('#dashboard')).toBeHidden();
    await login(adminPage,'auditor');await expect(adminPage.locator('#invite')).toBeDisabled();
    const denied=await adminPage.evaluate(async()=>{try{await mutate('invite','manage',{role:'owner'});return false;}catch{return true;}});expect(denied).toBe(true);
    expect((await fixture.auth.get("SELECT COUNT(*) n FROM users WHERE role='owner'")).n).toBe(1);
    await role(invitation.userId,'admin');await login(adminPage,'admin');
  });
  test('revokes the test key and old session, preserves owner and exports recovery codes without exposing them',async()=>{
    test.setTimeout(120000);const key=await fixture.auth.get("SELECT id FROM credentials WHERE user_id=? AND state='active'",invitation.userId);
    await ownerPage.locator('#refresh').click();const keyRow=ownerPage.locator('#credentialRows tr').filter({has:ownerPage.locator('td[title="'+key.id+'"]')});await keyRow.getByRole('button',{name:'등록 폐기'}).click();await expect(keyRow).toContainText('폐기됨');
    await adminPage.locator('#refresh').click();await expect(adminPage.locator('#dashboard')).toBeHidden();await adminPage.locator('#login').click();await expect(adminPage.locator('#notice')).toContainText('권한을 확인');await expect(adminPage.locator('#dashboard')).toBeHidden();
    expect((await fixture.auth.get('SELECT COUNT(*) n FROM sessions WHERE user_id=? AND revoked=0',invitation.userId)).n).toBe(0);
    await ownerPage.locator('#refresh').click();await expect(ownerPage.locator('#myRole')).toHaveText('owner');await ownerPage.locator('#codes').click();await expect(ownerPage.locator('#downloadTitle')).toHaveText('복구 코드 파일');const codes=await downloaded(ownerPage);
    expect(Array.isArray(codes.recoveryCodes)&&codes.recoveryCodes.length===2).toBe(true);const hashes=await fixture.auth.all('SELECT hash FROM recovery WHERE user_id=?',ownerId);
    expect(codes.recoveryCodes.every(code=>hashes.some(h=>h.hash===createHash('sha256').update(code).digest('hex')))).toBe(true);
    const visible=await ownerPage.locator('body').innerText(),audit=JSON.stringify(await fixture.auth.all('SELECT at,operation,success FROM audit'));
    expect(codes.recoveryCodes.every(code=>!visible.includes(code)&&!audit.includes(code))).toBe(true);
    await mkdir('generated',{recursive:true});await ownerPage.evaluate(()=>scrollTo(0,0));await ownerPage.screenshot({path:'generated/connected-owner.png',fullPage:true});
    await ownerPage.setViewportSize({width:390,height:844});expect(await ownerPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await ownerPage.evaluate(()=>scrollTo(0,0));await ownerPage.screenshot({path:'generated/connected-mobile.png',fullPage:true});
  });
});
