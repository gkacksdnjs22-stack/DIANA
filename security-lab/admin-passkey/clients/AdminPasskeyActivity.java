package kr.nightdesk.phone;
import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.net.Uri;
import android.widget.Button;
import android.widget.TextView;
import android.widget.LinearLayout;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class AdminPasskeyActivity extends Activity {
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private TextView status;
    private String handledCallback="";
    private static final String ALIAS="diana-lab-passkey-admin-v1";
    @Override public void onCreate(Bundle b){super.onCreate(b);if(b!=null)handledCallback=b.getString("handledCallback","");
        LinearLayout root=new LinearLayout(this);root.setOrientation(1);root.setPadding(24,36,24,24);setContentView(root);
        TextView title=new TextView(this);title.setText("DIANA LAB 관리자 패스키");title.setTextSize(24);root.addView(title);
        TextView note=new TextView(this);note.setText("시험용 관리자 인증입니다. 일반 휴대폰 연결 및 PC 문서 접근·최종 승인과 별개입니다.");root.addView(note);
        status=new TextView(this);status.setText("로그인 후 서버에서 권한을 확인하세요.");root.addView(status);
        add(root,"관리자 패스키로 로그인",()->{
            String state=NativePkce.random(),verifier=NativePkce.random();
            save("pending",new JSONObject().put("state",state).put("verifier",verifier).put("at",System.currentTimeMillis()));
            Intent intent=new Intent(Intent.ACTION_VIEW,Uri.parse(NativePkce.authorize(state,verifier)));intent.addCategory(Intent.CATEGORY_BROWSABLE);startActivity(intent);return "브라우저에서 인증 후 이 앱으로 돌아옵니다.";
        });
        add(root,"현재 관리자 권한 확인",()->{JSONObject s=load("session");JSONObject r=post("native/status",new JSONObject(),s.getString("access_token"));if(r.getBoolean("documentAccess"))throw new Exception();return "관리자 인증 확인: "+r.getString("role")+" · PC 문서 권한 없음";});
        add(root,"관리자 로그아웃",()->{JSONObject s=load("session");post("logout",new JSONObject(),s.getString("access_token"));getSharedPreferences(ALIAS,0).edit().remove("session").commit();return "관리자 세션을 종료했습니다.";});
        callback(getIntent());
    }
    interface Work{String run()throws Exception;}
    private void add(LinearLayout root,String label,Work work){Button b=new Button(this);b.setText(label);root.addView(b);b.setOnClickListener(v->{b.setEnabled(false);worker.execute(()->{String result;try{result=work.run();}catch(Exception e){result="인증 거부·취소 또는 연결 실패. 인증을 다시 시작하세요.";}final String text=result;runOnUiThread(()->{status.setText(text);b.setEnabled(true);});});});}
    @Override public void onNewIntent(Intent intent){super.onNewIntent(intent);callback(intent);}
    @Override public void onSaveInstanceState(Bundle out){out.putString("handledCallback",handledCallback);super.onSaveInstanceState(out);}
    private void callback(Intent intent){if(intent==null||intent.getData()==null)return;final String uri=intent.getData().toString();try{String digest=NativePkce.challenge(uri);if(digest.equals(handledCallback))return;handledCallback=digest;}catch(Exception e){return;}worker.execute(()->{
        String message;try{
            JSONObject pending=load("pending");long age=System.currentTimeMillis()-pending.getLong("at");if(age<0||age>120000)throw new Exception();
            String code=NativePkce.code(uri,pending.getString("state"));getSharedPreferences(ALIAS,0).edit().remove("pending").commit();
            JSONObject result=post("native/token",new JSONObject().put("grant_type","authorization_code").put("client_id","diana-lab-android").put("redirect_uri",NativePkce.REDIRECT).put("code",code).put("code_verifier",pending.getString("verifier")),null);
            if(!result.getString("access_token").matches("[A-Za-z0-9_-]{43}"))throw new Exception();save("session",result);
            JSONObject verified=post("native/status",new JSONObject(),result.getString("access_token"));if(verified.getBoolean("documentAccess"))throw new Exception();
            message="관리자 인증 완료: "+verified.getString("role")+" · PC 문서는 별도 승인 필요";
        }catch(Exception e){message="인증 반환을 확인하지 못했습니다. 앱에서 다시 시작하세요.";}
        final String text=message;runOnUiThread(()->status.setText(text));
    });}
    private SecretKey key()throws Exception{KeyStore k=KeyStore.getInstance("AndroidKeyStore");k.load(null);if(!k.containsAlias(ALIAS)){KeyGenerator g=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");g.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());g.generateKey();}return (SecretKey)k.getKey(ALIAS,null);}
    private synchronized void save(String name,JSONObject value)throws Exception{Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());String data=Base64.encodeToString(c.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(c.doFinal(value.toString().getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);if(!getSharedPreferences(ALIAS,0).edit().putString(name,data).commit())throw new Exception();}
    private synchronized JSONObject load(String name)throws Exception{String[] p=getSharedPreferences(ALIAS,0).getString(name,"").split(":",2);if(p.length!=2)throw new Exception();Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(p[0],Base64.NO_WRAP)));return new JSONObject(new String(c.doFinal(Base64.decode(p[1],Base64.NO_WRAP)),StandardCharsets.UTF_8));}
    private JSONObject post(String path,JSONObject body,String token)throws Exception{
        HttpURLConnection c=(HttpURLConnection)new URL(NativePkce.ORIGIN+"/api/"+path).openConnection();c.setInstanceFollowRedirects(false);c.setConnectTimeout(8000);c.setReadTimeout(8000);c.setRequestMethod("POST");c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");c.setRequestProperty("Origin",NativePkce.ORIGIN);if(token!=null)c.setRequestProperty("Authorization","Bearer "+token);
        try{try(java.io.OutputStream out=c.getOutputStream()){out.write(body.toString().getBytes(StandardCharsets.UTF_8));}if(c.getResponseCode()!=200)throw new Exception();try(java.io.InputStream in=c.getInputStream();java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream()){byte[] chunk=new byte[4096];int count;while((count=in.read(chunk))!=-1){out.write(chunk,0,count);if(out.size()>32768)throw new Exception();}return new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8));}}finally{c.disconnect();}
    }
    @Override public void onDestroy(){worker.shutdownNow();super.onDestroy();}
}
