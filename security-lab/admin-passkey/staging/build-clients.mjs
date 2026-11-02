import {readFile,writeFile,mkdir,cp,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),exec=promisify(execFile);
const profile=JSON.parse(await readFile(new URL('profile.json',import.meta.url),'utf8'));
const origin=new URL(profile.origin);
if(origin.protocol!=='https:'||origin.origin!==profile.origin||origin.hostname!==profile.rpID||!/^diana-admin-passkey-stage(?:-[a-z0-9]+)?\.onrender\.com$/.test(origin.hostname)||profile.androidPackage!=='kr.nightdesk.phone.lab.passkey.stage'||profile.androidRedirect!==profile.androidPackage+'://oauth2/callback')throw Error('STAGE_PROFILE_INVALID');
const edit=async(file,fn)=>writeFile(file,fn(await readFile(file,'utf8')));
if(process.argv[2]==='android'){
  await exec(process.execPath,[path.join(root,'build-android.mjs')],{windowsHide:true});
  const project=path.join(root,'generated/android/android-app'),java=path.join(project,'app/src/main/java/kr/nightdesk/phone');
  await edit(path.join(java,'NativePkce.java'),s=>s.replaceAll('http://localhost:43871',profile.origin).replaceAll('kr.nightdesk.phone.lab.passkey',profile.androidPackage));
  await edit(path.join(java,'AdminPasskeyController.java'),s=>s.replaceAll('diana-lab-passkey-admin-v1','diana-stage-passkey-admin-v1').replace('setConnectTimeout(8000)','setConnectTimeout(60000)').replace('setReadTimeout(8000)','setReadTimeout(60000)'));
  await edit(path.join(project,'app/src/test/java/kr/nightdesk/phone/NativePkceTest.java'),s=>s.replaceAll('http://localhost:43871',profile.origin));
  await edit(path.join(project,'app/build.gradle'),s=>s.replace("applicationId 'kr.nightdesk.phone.lab.passkey'",`applicationId '${profile.androidPackage}'`).replace("versionCode 1","versionCode 2").replace("versionName '0.1.0-passkey-lab'","versionName '0.2.0-passkey-stage'"));
  await edit(path.join(project,'app/src/main/AndroidManifest.xml'),s=>s.replaceAll('kr.nightdesk.phone.lab.passkey',profile.androidPackage).replaceAll('DIANA LAB','DIANA HTTPS STAGE').replace(/<activity android:name="\.MainActivity"[^>]*>[\s\S]*?<\/activity>/,'<activity android:name=".MainActivity" android:exported="false"/>'));
  await writeFile(path.join(project,'app/src/debug/res/xml/network_security_config.xml'),'<network-security-config><base-config cleartextTrafficPermitted="false"/></network-security-config>');
  console.log('Generated HTTPS staging Android project. Run Gradle testDebugUnitTest assembleDebug.');
}else if(process.argv[2]==='windows'){
  if(process.platform!=='win32')throw Error('WINDOWS_REQUIRED');
  const out=path.join(root,'generated/stage-windows');await mkdir(out); // Never overwrite a user's installed app.
  for(const file of ['AdminPasskeyClient.cs','AdminPasskeyForm.cs'])await cp(path.join(root,'clients',file),path.join(out,file));
  await edit(path.join(out,'AdminPasskeyClient.cs'),s=>s.replaceAll('http://localhost:43871',profile.origin).replace('TimeSpan.FromSeconds(8)','TimeSpan.FromSeconds(60)'));
  await edit(path.join(out,'AdminPasskeyForm.cs'),s=>s.replace('DIANA LAB PASSKEY','DIANA HTTPS STAGE'));
  await writeFile(path.join(out,'Program.cs'),`using System; using System.IO; using System.Net; using System.Windows.Forms;\nclass StageProgram { [STAThread] static void Main(){ ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12; Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new Diana.Lab.Passkey.AdminPasskeyForm(new Diana.Lab.Passkey.AdminPasskeyClient(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"DIANA-HTTPS-STAGE","admin-session.dpapi")))); } }\n`);
  const compiler=path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');await access(compiler);
  const common=['/nologo','/platform:x64','/optimize+','/utf8output','/reference:System.Web.Extensions.dll','/reference:System.Net.Http.dll','/reference:System.Security.dll'];
  await exec(compiler,[...common,'/target:winexe','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/out:'+path.join(out,'DIANA-HTTPS-STAGE.exe'),...['Program.cs','AdminPasskeyClient.cs','AdminPasskeyForm.cs'].map(x=>path.join(out,x))],{windowsHide:true});
  await exec(compiler,[...common,'/target:exe','/out:'+path.join(out,'NativeProbe.exe'),path.join(out,'AdminPasskeyClient.cs'),path.join(root,'test/NativeProbe.cs')],{windowsHide:true});
  await writeFile(path.join(out,'profile.json'),JSON.stringify(profile,null,2));
  console.log('Built isolated HTTPS staging administrator EXE and probe.');
}else throw Error('USAGE: node staging/build-clients.mjs android|windows');
