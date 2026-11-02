package kr.nightdesk.phone;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Process-owned authentication work. No Activity, View or lifecycle-owned executor. */
final class AdminPasskeyController {
    private static AdminPasskeyController instance;
    static synchronized AdminPasskeyController get(Context context){if(instance==null)instance=new AdminPasskeyController(context.getApplicationContext());return instance;}
    private static final String ALIAS="diana-lab-passkey-admin-v1";
    private final Context context;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final Handler main=new Handler(Looper.getMainLooper());
    private final Set<Runnable> listeners=new CopyOnWriteArraySet<>();
    private final Set<String> inFlight=new LinkedHashSet<>(),completed=new LinkedHashSet<>();
    private String message="로그인 후 서버에서 권한을 확인하세요.",browserUrl;
    private AdminPasskeyController(Context context){this.context=context;}
    void observe(Runnable listener){listeners.add(listener);listener.run();}
    void unobserve(Runnable listener){listeners.remove(listener);}
    synchronized String message(){return message;}
    synchronized String takeBrowserUrl(){String url=browserUrl;browserUrl=null;return url;}
    private void notifyUi(){main.post(()->{for(Runnable listener:listeners)listener.run();});}
    private synchronized void publish(String value){message=value;notifyUi();}
    interface Work{String run()throws Exception;}
    private void submit(Work work){worker.execute(()->{try{publish(work.run());}catch(Exception e){publish("인증 거부·취소 또는 연결 실패. 인증을 다시 시작하세요.");}});}
    void login(){submit(()->{
        String state=NativePkce.random(),verifier=NativePkce.random();save("pending",new JSONObject().put("state",state).put("verifier",verifier).put("at",System.currentTimeMillis()));
        synchronized(this){browserUrl=NativePkce.authorize(state,verifier);}return "브라우저에서 인증 후 이 앱으로 돌아옵니다.";
    });}
    void status(){submit(()->{JSONObject s=load("session"),r=post("native/status",new JSONObject(),s.getString("access_token"));if(r.getBoolean("documentAccess"))throw new Exception();return "관리자 인증 확인: "+r.getString("role")+" · PC 문서 권한 없음";});}
    void logout(){submit(()->{JSONObject s=load("session");post("logout",new JSONObject(),s.getString("access_token"));if(!context.getSharedPreferences(ALIAS,0).edit().remove("session").commit())throw new Exception();return "관리자 세션을 종료했습니다.";});}
    void callback(String uri){
        final String digest;try{digest=NativePkce.challenge(uri);}catch(Exception e){publish("인증 반환을 확인하지 못했습니다. 앱에서 다시 시작하세요.");return;}
        synchronized(this){if(inFlight.contains(digest)||completed.contains(digest))return;inFlight.add(digest);}
        worker.execute(()->{
            boolean stored=false;
            try{
                JSONObject pending=load("pending");long age=System.currentTimeMillis()-pending.getLong("at");if(age<0||age>120000)throw new Exception();
                String code=NativePkce.code(uri,pending.getString("state"));
                JSONObject result=post("native/token",new JSONObject().put("grant_type","authorization_code").put("client_id","diana-lab-android").put("redirect_uri",NativePkce.REDIRECT).put("code",code).put("code_verifier",pending.getString("verifier")),null);
                if(!result.getString("access_token").matches("[A-Za-z0-9_-]{43}"))throw new Exception();save("session",result);stored=true;
                context.getSharedPreferences(ALIAS,0).edit().remove("pending").commit();
                JSONObject verified=post("native/status",new JSONObject(),result.getString("access_token"));if(verified.getBoolean("documentAccess"))throw new Exception();
                publish("관리자 인증 완료: "+verified.getString("role")+" · PC 문서는 별도 승인 필요");
            }catch(Exception e){publish("인증 반환을 확인하지 못했습니다. 앱에서 다시 시작하세요.");}
            finally{synchronized(this){inFlight.remove(digest);if(stored){completed.add(digest);if(completed.size()>64)completed.remove(completed.iterator().next());}}}
        });
    }
    private SecretKey key()throws Exception{KeyStore k=KeyStore.getInstance("AndroidKeyStore");k.load(null);if(!k.containsAlias(ALIAS)){KeyGenerator g=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");g.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());g.generateKey();}return (SecretKey)k.getKey(ALIAS,null);}
    private synchronized void save(String name,JSONObject value)throws Exception{Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());String data=Base64.encodeToString(c.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(c.doFinal(value.toString().getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);if(!context.getSharedPreferences(ALIAS,0).edit().putString(name,data).commit())throw new Exception();}
    private synchronized JSONObject load(String name)throws Exception{String[] p=context.getSharedPreferences(ALIAS,0).getString(name,"").split(":",2);if(p.length!=2)throw new Exception();Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(p[0],Base64.NO_WRAP)));return new JSONObject(new String(c.doFinal(Base64.decode(p[1],Base64.NO_WRAP)),StandardCharsets.UTF_8));}
    private JSONObject post(String path,JSONObject body,String token)throws Exception{
        HttpURLConnection c=(HttpURLConnection)new URL(NativePkce.ORIGIN+"/api/"+path).openConnection();c.setInstanceFollowRedirects(false);c.setConnectTimeout(8000);c.setReadTimeout(8000);c.setRequestMethod("POST");c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");c.setRequestProperty("Origin",NativePkce.ORIGIN);if(token!=null)c.setRequestProperty("Authorization","Bearer "+token);
        try{try(java.io.OutputStream out=c.getOutputStream()){out.write(body.toString().getBytes(StandardCharsets.UTF_8));}if(c.getResponseCode()!=200)throw new Exception();try(java.io.InputStream in=c.getInputStream();java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream()){byte[] chunk=new byte[4096];int count;while((count=in.read(chunk))!=-1){out.write(chunk,0,count);if(out.size()>32768)throw new Exception();}return new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8));}}finally{c.disconnect();}
    }
}
