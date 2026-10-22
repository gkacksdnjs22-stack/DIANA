package kr.nightdesk.phone;

import android.content.Context;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONObject;
import java.util.concurrent.Executors;

final class PushSupport {
    static void initialize(Context context) {
        try {
            JSONObject session = new SecureStore(context).load(); if (session == null) return;
            JSONObject config = session.optJSONObject("firebase");
            if (config == null || !config.optBoolean("enabled") || config.optString("applicationId").isEmpty() || config.optString("apiKey").isEmpty() || config.optString("projectId").isEmpty() || config.optString("senderId").isEmpty()) {
                context.getSharedPreferences("settings", 0).edit().putString("push_status", "미설정 · 주기 확인 사용").apply(); return;
            }
            if (FirebaseApp.getApps(context).isEmpty()) {
                FirebaseApp.initializeApp(context, new FirebaseOptions.Builder().setApplicationId(config.getString("applicationId"))
                    .setApiKey(config.getString("apiKey")).setProjectId(config.getString("projectId")).setGcmSenderId(config.getString("senderId")).build());
            }
            FirebaseMessaging.getInstance().setAutoInitEnabled(true);
            FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> register(context, token))
                .addOnFailureListener(error -> context.getSharedPreferences("settings", 0).edit().putString("push_status", "연결 대기 · 주기 확인 사용").apply());
        } catch (Exception ignored) { context.getSharedPreferences("settings", 0).edit().putString("push_status", "연결 실패 · 주기 확인 사용").apply(); }
    }
    static void register(Context context, String token) {
        if (token == null || token.isEmpty()) return;
        java.util.concurrent.ExecutorService executor = Executors.newSingleThreadExecutor();
        executor.execute(() -> {
            try {
                JSONObject session = new SecureStore(context).load(); if (session == null) return;
                Api.request(session, "/api/phone/token", new JSONObject().put("fcmToken", token));
                context.getSharedPreferences("settings", 0).edit().putString("push_status", "연결됨").apply();
            } catch (Exception ignored) { context.getSharedPreferences("settings", 0).edit().putString("push_status", "등록 대기 · 주기 확인 사용").apply(); }
            finally { executor.shutdown(); }
        });
    }
}
