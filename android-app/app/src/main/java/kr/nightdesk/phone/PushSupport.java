package kr.nightdesk.phone;

import android.content.Context;
import android.os.SystemClock;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

final class PushSupport {
    private static final ExecutorService executor = Executors.newSingleThreadExecutor();
    private static final AtomicBoolean initializing = new AtomicBoolean();
    private static final Object refreshLock = new Object();
    private static final Object sdkLock = new Object();
    private static final String PUBLIC_CACHE = "firebase_public_config";
    private static volatile JSONObject activeSession;
    private static JSONObject refreshedSession;
    private static long refreshedAt;

    static void initialize(Context context) {
        Context app = context.getApplicationContext();
        // Firebase's receiver can start a cold process. Restore only public,
        // session-bound options before Application.onCreate returns; no HTTP here.
        try {
            JSONObject expected = new SecureStore(app).load();
            PushConfig cached = cachedConfig(app, expected);
            if (cached.enabled) bootstrap(app, expected, cached);
        } catch (Exception ignored) { /* The asynchronous authenticated refresh can repair the cache. */ }
        if (!initializing.compareAndSet(false, true)) return;
        executor.execute(() -> {
            try { refreshBlocking(app); }
            finally { initializing.set(false); }
        });
    }
    private static void status(Context c, String value) {
        c.getSharedPreferences("settings", 0).edit().putString("push_status", value).apply();
    }
    static boolean paired(Context context) {
        try { return new SecureStore(context).load() != null; }
        catch (Exception ignored) { return false; }
    }
    private static boolean sameSession(JSONObject expected, JSONObject actual) {
        return expected != null && actual != null && PushConfig.sameSession(expected.optString("baseUrl"), expected.optString("phoneId"), expected.optString("phoneToken"),
            actual.optString("baseUrl"), actual.optString("phoneId"), actual.optString("phoneToken"));
    }
    private static PushConfig configOf(JSONObject value) {
        if (value == null) return PushConfig.disabled();
        return PushConfig.of(value.optBoolean("enabled"), value.optString("applicationId"), value.optString("apiKey"), value.optString("projectId"), value.optString("senderId"));
    }
    private static String fingerprint(JSONObject session) {
        return PushConfig.sessionFingerprint(session.optString("baseUrl"), session.optString("phoneId"), session.optString("phoneToken"));
    }
    private static PushConfig cachedConfig(Context context, JSONObject expected) {
        if (expected == null) return PushConfig.disabled();
        try {
            String stored = context.getSharedPreferences("settings", 0).getString(PUBLIC_CACHE, null);
            if (stored == null) return PushConfig.disabled();
            JSONObject cached = new JSONObject(stored);
            return fingerprint(expected).equals(cached.optString("sessionHash")) ? configOf(cached) : PushConfig.disabled();
        } catch (Exception ignored) { return PushConfig.disabled(); }
    }
    private static void cache(Context context, JSONObject expected, PushConfig config) throws Exception {
        if (!sameSession(expected, new SecureStore(context).load())) return;
        if (!config.enabled) { context.getSharedPreferences("settings", 0).edit().remove(PUBLIC_CACHE).apply(); return; }
        JSONObject publicConfig = new JSONObject().put("sessionHash", fingerprint(expected)).put("enabled", true)
            .put("applicationId", config.applicationId).put("apiKey", config.apiKey).put("projectId", config.projectId).put("senderId", config.senderId);
        // Public SDK identifiers and an irreversible session hash only. Never
        // persist the phone token, service-account JSON or push registration token.
        context.getSharedPreferences("settings", 0).edit().putString(PUBLIC_CACHE, publicConfig.toString()).apply();
    }
    private static void bootstrap(Context context, JSONObject expected, PushConfig config) throws Exception {
        synchronized (sdkLock) {
            if (!config.enabled || !sameSession(expected, new SecureStore(context).load())) return;
            FirebaseApp app;
            if (FirebaseApp.getApps(context).isEmpty()) {
                app = FirebaseApp.initializeApp(context, new FirebaseOptions.Builder().setApplicationId(config.applicationId)
                    .setApiKey(config.apiKey).setProjectId(config.projectId).setGcmSenderId(config.senderId).build());
            } else app = FirebaseApp.getInstance();
            FirebaseOptions options = app.getOptions();
            if (!config.applicationId.equals(options.getApplicationId()) || !config.apiKey.equals(options.getApiKey()) ||
                !config.projectId.equals(options.getProjectId()) || !config.senderId.equals(options.getGcmSenderId())) {
                activeSession = null;
                status(context, "설정 변경 · 앱을 다시 시작해 주세요");
                return;
            }
            if (!sameSession(expected, new SecureStore(context).load())) return;
            activeSession = expected;
            FirebaseMessaging messaging = FirebaseMessaging.getInstance();
            messaging.setAutoInitEnabled(true);
            messaging.getToken().addOnSuccessListener(token -> registerFor(context, expected, token))
                .addOnFailureListener(error -> {
                    try { if (sameSession(expected, new SecureStore(context).load())) status(context, "연결 대기 · 주기 확인 사용"); }
                    catch (Exception ignored) { }
                });
        }
    }
    /** Called from the initialization executor or a Worker, never the main thread. */
    static void refreshBlocking(Context context) {
        synchronized (refreshLock) {
            JSONObject expected = null;
            try {
                SecureStore store = new SecureStore(context);
                expected = store.load();
                if (expected == null) { activeSession = null; return; }
                long elapsed = SystemClock.elapsedRealtime();
                if (sameSession(expected, refreshedSession) && elapsed - refreshedAt < 30_000) return;
                PushConfig config;
                try {
                    JSONObject response = Api.request(expected, "/api/phone/config", null);
                    if (response.has("phoneId") && !expected.optString("phoneId").equals(response.optString("phoneId"))) throw new IllegalArgumentException("알림 연결 응답을 확인해 주세요.");
                    if (!response.has("firebase")) throw new IllegalArgumentException("알림 연결 응답을 확인해 주세요.");
                    config = configOf(response.getJSONObject("firebase"));
                } catch (Api.ApiException error) {
                    // Old servers and old pairing sessions remain fully usable by polling.
                    if (error.status != 404) throw error;
                    config = PushConfig.disabled();
                }
                if (!sameSession(expected, store.load())) return;
                cache(context, expected, config);
                if (!config.enabled) {
                    synchronized (sdkLock) {
                        if (!sameSession(expected, store.load())) return;
                        activeSession = null;
                        if (!FirebaseApp.getApps(context).isEmpty()) FirebaseMessaging.getInstance().setAutoInitEnabled(false);
                    }
                    status(context, "미설정 · 주기 확인 사용");
                    refreshedSession = expected; refreshedAt = elapsed;
                    return;
                }
                if (!sameSession(expected, store.load())) return;
                refreshedSession = expected; refreshedAt = elapsed;
                bootstrap(context, expected, config);
            } catch (Exception ignored) {
                try { if (sameSession(expected, new SecureStore(context).load())) status(context, "연결 대기 · 주기 확인 사용"); }
                catch (Exception ignoredAgain) { }
            }
        }
    }
    private static void registerFor(Context context, JSONObject expected, String token) {
        if (token == null || token.isEmpty()) return;
        executor.execute(() -> {
            try {
                // A late Firebase callback must not register with a replacement/disconnected session.
                if (!sameSession(expected, activeSession) || !sameSession(expected, new SecureStore(context).load())) return;
                Api.request(expected, "/api/phone/token", new JSONObject().put("fcmToken", token));
                if (sameSession(expected, new SecureStore(context).load())) status(context, "연결됨 · 파일 도착 시 자동 저장");
            } catch (Exception ignored) {
                try { if (sameSession(expected, new SecureStore(context).load())) status(context, "등록 대기 · 주기 확인 사용"); }
                catch (Exception ignoredAgain) { }
            }
        });
    }
    static void register(Context context, String token) {
        JSONObject expected = activeSession;
        if (expected == null) initialize(context);
        else registerFor(context.getApplicationContext(), expected, token);
    }
}
