package kr.nightdesk.phone;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Only Android Keystore encrypted credentials are persisted; backups are disabled. */
final class SecureStore {
    static final Object LOCK=new Object();
    private static final String ALIAS = "nightdesk-phone-session-v1";
    private final SharedPreferences prefs;
    SecureStore(Context context) { this(context,"encrypted_session"); }
    SecureStore(Context context,String name) { prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setUserAuthenticationRequired(false).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }
    void save(JSONObject session) throws Exception {
      synchronized(LOCK){
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] encrypted = cipher.doFinal(session.toString().getBytes(StandardCharsets.UTF_8));
        String payload = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP);
        if (!prefs.edit().putString("session", payload).commit()) throw new Exception("연결 정보를 저장하지 못했습니다.");
      }
    }
    JSONObject load() throws Exception {
      synchronized(LOCK){
        String payload = prefs.getString("session", null); if (payload == null) return null;
        String[] pieces = payload.split(":", 2); if (pieces.length != 2) throw new Exception("연결 정보를 다시 등록해 주세요.");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(pieces[0], Base64.NO_WRAP)));
        return new JSONObject(new String(cipher.doFinal(Base64.decode(pieces[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
      }
    }
    void replacePending(String id,JSONObject session)throws Exception{ synchronized(LOCK){JSONObject current=load();if(current!=null&&session.optString("token").equals(current.optString("token"))&&session.optString("device").equals(current.optString("device")))return;if(current==null||!id.equals(current.optString("requestId")))throw new Exception("연결 요청이 바뀌었습니다. 다시 확인하세요.");save(session);} }
    void clearPending(String id)throws Exception{synchronized(LOCK){JSONObject current=load();if(current!=null&&id.equals(current.optString("requestId")))clear();}}
    void clear() { synchronized(LOCK){prefs.edit().clear().commit();} }
}
