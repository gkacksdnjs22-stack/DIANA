import {readFile,writeFile,cp,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const root=import.meta.dirname,repo=path.resolve(root,'../..'),generated=path.join(root,'generated/android'),project=path.join(generated,'android-app'),javaDir=path.join(project,'app/src/main/java/kr/nightdesk/phone');
await mkdir(path.dirname(generated),{recursive:true});
await mkdir(generated); // Refuse to overwrite a completed experiment.
await cp(path.join(repo,'android-app'),project,{recursive:true,filter:src=>!['build','.gradle','local.properties','google-services.json'].includes(path.basename(src))&&!/\.(?:keystore|jks)$/.test(src)});
const edit=async(file,fn)=>writeFile(file,fn(await readFile(file,'utf8')));
const patch=(s,from,to)=>{if(!s.includes(from))throw Error('LAB_SOURCE_ANCHOR_CHANGED');return s.replace(from,to);};
await writeFile(path.join(project,'settings.gradle'),`pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
rootProject.name='DianaPasskeyLab'
include ':app'
`);
await edit(path.join(project,'app/build.gradle'),s=>{
  s=patch(s,"applicationId 'kr.nightdesk.phone'","applicationId 'kr.nightdesk.phone.lab.passkey'").replace(/versionCode \d+/, 'versionCode 1').replace(/versionName '[^']+'/,"versionName '0.1.0-passkey-lab'");
  s=s.replace(/^\s*implementation 'com\.google\.firebase:firebase-messaging:[^']+'\s*$/m,'');
  return patch(s,'    buildTypes {',`    signingConfigs { passkeyLab { storeFile file('../../passkey-debug.keystore'); storePassword 'android'; keyAlias 'androiddebugkey'; keyPassword 'android' } }
    buildTypes { debug { signingConfig signingConfigs.passkeyLab }
`);
});
await edit(path.join(javaDir,'Api.java'),s=>patch(s,'if (host == null || uri.getUserInfo()', 'if (!local) throw new IOException("LAB_LOCAL_SERVER_ONLY");\n        if (host == null || uri.getUserInfo()'));
await edit(path.join(javaDir,'SecureStore.java'),s=>s.replaceAll('nightdesk-phone-session-v1','diana-passkey-lab-phone-v1').replaceAll('"encrypted_session"','"lab_encrypted_session"'));
await writeFile(path.join(javaDir,'PushSupport.java'),`package kr.nightdesk.phone;
import android.content.Context;
final class PushSupport {
 static void initialize(Context context) { }
 static boolean paired(Context context) { return false; }
 static void refreshBlocking(Context context) { }
 static void register(Context context,String token) { }
}
`);
await writeFile(path.join(javaDir,'NightDeskMessagingService.java'),`package kr.nightdesk.phone;
public final class NightDeskMessagingService extends android.app.Service {
 @Override public android.os.IBinder onBind(android.content.Intent intent) { return null; }
}
`);
for(const file of ['AdminPasskeyActivity.java','NativePkce.java'])await cp(path.join(root,'clients',file),path.join(javaDir,file));
await mkdir(path.join(project,'app/src/test/java/kr/nightdesk/phone'),{recursive:true});await cp(path.join(root,'clients/NativePkceTest.java'),path.join(project,'app/src/test/java/kr/nightdesk/phone/NativePkceTest.java'));
await mkdir(path.join(project,'app/src/androidTest/java/kr/nightdesk/phone'),{recursive:true});await cp(path.join(root,'clients/AdminPasskeyIntegrationTest.java'),path.join(project,'app/src/androidTest/java/kr/nightdesk/phone/AdminPasskeyIntegrationTest.java'));
await edit(path.join(javaDir,'MainActivity.java'),s=>patch(s,'title(pageContent,"설정","연결과 파일 저장 방식을 관리하세요.");','title(pageContent,"설정","연결과 파일 저장 방식을 관리하세요.");\n        Button adminPasskey=button(pageContent,"관리자 패스키 로그인",false);adminPasskey.setOnClickListener(v->startActivity(new Intent(this,AdminPasskeyActivity.class)));'));
await edit(path.join(project,'app/src/main/AndroidManifest.xml'),s=>{
  s=patch(s,'android:label="DIANA"','android:label="DIANA LAB PASSKEY"');
  s=s.replace(/\s*<service android:name="\.NightDeskMessagingService"[\s\S]*?<\/service>/,'');
  return patch(s,'        <provider',`        <activity android:name=".AdminPasskeyActivity" android:label="DIANA LAB 관리자 인증" android:exported="true" android:launchMode="singleTask">
            <intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>
            <intent-filter><action android:name="android.intent.action.VIEW"/><category android:name="android.intent.category.DEFAULT"/><category android:name="android.intent.category.BROWSABLE"/><data android:scheme="kr.nightdesk.phone.lab.passkey" android:host="oauth2" android:path="/callback"/></intent-filter>
        </activity>
        <provider`);
});
await mkdir(path.join(project,'app/src/debug/res/xml'),{recursive:true});await writeFile(path.join(project,'app/src/debug/res/xml/network_security_config.xml'),'<network-security-config><base-config cleartextTrafficPermitted="false"/><domain-config cleartextTrafficPermitted="true"><domain>localhost</domain><domain>127.0.0.1</domain><domain>10.0.2.2</domain></domain-config></network-security-config>');
const keytool=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'keytool.exe':'keytool'):'keytool';
await promisify(execFile)(keytool,['-genkeypair','-keystore',path.join(generated,'passkey-debug.keystore'),'-storepass','android','-keypass','android','-alias','androiddebugkey','-keyalg','RSA','-keysize','2048','-validity','3650','-dname','CN=DIANA Passkey Lab,O=Local Test,C=KR'],{windowsHide:true});
console.log('Generated isolated Android project; source app and production signing keys unchanged.');
