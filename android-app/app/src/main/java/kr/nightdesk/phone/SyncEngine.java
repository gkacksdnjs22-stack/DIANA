package kr.nightdesk.phone;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.AtomicFile;
import androidx.documentfile.provider.DocumentFile;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HashSet;
import java.util.ArrayList;
import java.util.Locale;
import java.util.Set;
import java.util.function.BooleanSupplier;

final class SyncEngine {
    private static final int MAX_SAVED_JOBS = 1000;
    private static final SyncGate SYNC_GATE = new SyncGate();
    private static final Object CACHE_LOCK = new Object();
    private static final String LATEST_RECEIVE = "latest_receive_v1";
    enum ExternalCopyState { NOT_SELECTED, PENDING, COPIED, FAILED }

    private static String receiveBinding(JSONObject session) throws Exception {
        return RecentReceive.binding(Api.validateBase(session.getString("baseUrl"), BuildConfig.DEBUG), session.getString("phoneId"));
    }
    static JSONObject latestReceiveLog(Context c, JSONObject session) {
        if (session == null) return null;
        try {
            String stored = c.getSharedPreferences("MainActivity", 0).getString(LATEST_RECEIVE, "");
            if (stored.isEmpty()) return null;
            JSONObject value = new JSONObject(stored);
            if (value.getInt("version") != 1 || !receiveBinding(session).equals(value.getString("binding"))) return null;
            RecentReceive.Event event = new RecentReceive.Event(value.getString("filename"), value.getInt("count"), value.getString("receivedAt"));
            return new JSONObject().put("filename", event.filename).put("count", event.count).put("receivedAt", event.receivedAt);
        } catch (Exception ignored) { return null; }
    }
    // Package-only writer also lets native fixtures seed the exact production format.
    static void recordLatestReceive(Context c, JSONObject session, String filename, int count, String receivedAt) throws Exception {
        RecentReceive.Event event = new RecentReceive.Event(filename, count, receivedAt);
        JSONObject value = new JSONObject().put("version", 1).put("binding", receiveBinding(session))
            .put("filename", event.filename).put("count", event.count).put("receivedAt", event.receivedAt);
        if (!c.getSharedPreferences("MainActivity", 0).edit().putString(LATEST_RECEIVE, value.toString()).commit())
            throw new IOException("최근 수신 기록을 저장하지 못했습니다.");
    }

    // UI-only presence check. Actual opening, receipts and folder copies still hash the file.
    static boolean hasLocalArtifact(Context c, String jobId, JSONObject artifact) {
        try {
            validateManifest(artifact);
            File target = FileSafety.artifact(c.getFilesDir(), jobId, artifact.getString("id"), artifact.getString("filename"));
            return target.isFile() && target.length() == artifact.getLong("bytes");
        } catch (Exception ignored) { return false; }
    }
    static String selectedFolderLabel(Context c) {
        String selected = c.getSharedPreferences("MainActivity", 0).getString("export_tree", null);
        if (selected == null || selected.isEmpty()) return "";
        // Decode the tree ID locally. Querying a document provider can block the UI.
        try {
            String documentId = Uri.parse(selected).getLastPathSegment();
            if (documentId == null || documentId.isEmpty()) return "선택한 폴더";
            int separator = documentId.indexOf(':');
            String path = separator >= 0 ? documentId.substring(separator + 1) : documentId;
            if (path.isEmpty()) return "내장 저장공간";
            path = path.replace("/", " › ").replaceAll("[\\p{Cntrl}]", "");
            if (path.isEmpty()) return "선택한 폴더";
            return path.length() > 96 ? "…" + path.substring(path.length() - 95) : path;
        } catch (Exception ignored) { return "선택한 폴더"; }
    }
    private static String externalCopyKey(String selected, String jobId, JSONObject artifact) throws Exception {
        validateManifest(artifact);
        if (!FileSafety.UUID.matcher(jobId).matches()) throw new IOException("작업 정보를 확인해 주세요.");
        return FolderCopyKey.of(selected, jobId, artifact.getString("id"), artifact.getString("sha256"), artifact.getLong("bytes"));
    }
    static ExternalCopyState externalCopyState(Context c, String jobId, JSONObject artifact) {
        SharedPreferences settings = c.getSharedPreferences("MainActivity", 0);
        String selected = settings.getString("export_tree", null);
        if (selected == null || selected.isEmpty()) return ExternalCopyState.NOT_SELECTED;
        try {
            String key = externalCopyKey(selected, jobId, artifact);
            if (!settings.getString(key + "_error", "").isEmpty()) return ExternalCopyState.FAILED;
            // A cached, previously hash-verified copy; no provider I/O or hashing on the UI thread.
            return settings.getString(key, "").isEmpty() ? ExternalCopyState.PENDING : ExternalCopyState.COPIED;
        } catch (Exception ignored) { return ExternalCopyState.PENDING; }
    }
    static String externalCopyError(Context c, String jobId, JSONObject artifact) {
        SharedPreferences settings = c.getSharedPreferences("MainActivity", 0);
        String selected = settings.getString("export_tree", null);
        if (selected == null || selected.isEmpty()) return "";
        try { return settings.getString(externalCopyKey(selected, jobId, artifact) + "_error", ""); }
        catch (Exception ignored) { return ""; }
    }

    private static byte[] readCache(Context c, String name, int limit) throws Exception {
        // AtomicFile is not thread-safe. Only local I/O holds this short lock;
        // UI reads never wait for the network/download gate.
        synchronized (CACHE_LOCK) {
            try (InputStream input = new AtomicFile(new File(c.getFilesDir(), name)).openRead()) {
                byte[] bytes = input.readAllBytes();
                if (bytes.length > limit) throw new IOException("작업 기록이 너무 큽니다.");
                return bytes;
            }
        }
    }
    private static void writeCache(Context c, String name, byte[] bytes) throws Exception {
        synchronized (CACHE_LOCK) {
            AtomicFile file = new AtomicFile(new File(c.getFilesDir(), name)); FileOutputStream output = null;
            try { output = file.startWrite(); output.write(bytes); file.finishWrite(output); }
            catch (Exception error) { if (output != null) file.failWrite(output); throw error; }
        }
    }
    static JSONArray cachedJobs(Context c) {
        try {
            byte[] bytes = readCache(c, "jobs.json", 2 * 1024 * 1024);
            JSONArray jobs = new JSONObject(new String(bytes, StandardCharsets.UTF_8)).optJSONArray("jobs");
            return jobs == null ? new JSONArray() : jobs;
        } catch (Exception ignored) { return new JSONArray(); }
    }
    static void cache(Context c, JSONObject jobs) throws Exception {
        writeCache(c, "jobs.json", jobs.toString().getBytes(StandardCharsets.UTF_8));
    }
    static JSONArray cachedSaved(Context c) {
        try {
            byte[] bytes = readCache(c, "saved-jobs.json", 8 * 1024 * 1024);
            JSONArray saved = new JSONObject(new String(bytes, StandardCharsets.UTF_8)).optJSONArray("jobs");
            return saved == null ? new JSONArray() : saved;
        } catch (Exception ignored) { return new JSONArray(); }
    }
    private static void cacheSaved(Context c, JSONArray jobs) throws Exception {
        writeCache(c, "saved-jobs.json", new JSONObject().put("jobs", jobs).toString().getBytes(StandardCharsets.UTF_8));
    }
    private static JSONArray rememberSaved(JSONArray history, JSONObject job, JSONArray artifacts) throws Exception {
        JSONObject request = job.optJSONObject("request");
        String title = request == null ? "작업" : request.optString("overnight".equals(job.optString("kind")) ? "subject" : "query", "작업");
        JSONObject record = new JSONObject().put("id", job.getString("id")).put("title", title)
            .put("createdAt", job.optString("createdAt")).put("phoneSavedAt", job.optString("phoneSavedAt"))
            .put("artifacts", new JSONArray(artifacts.toString()));
        ArrayList<JSONObject> entries = new ArrayList<>(); entries.add(record);
        for (int i = 0; i < history.length(); i++) {
            JSONObject previous = history.optJSONObject(i);
            if (previous != null && !job.getString("id").equals(previous.optString("id"))) entries.add(previous);
        }
        entries.sort((a, b) -> b.optString("createdAt").compareTo(a.optString("createdAt")));
        JSONArray saved = new JSONArray();
        for (int i = 0; i < Math.min(entries.size(), MAX_SAVED_JOBS); i++) saved.put(entries.get(i));
        return saved;
    }
    static boolean verified(File file, JSONObject artifact) throws Exception {
        if (!file.isFile() || file.length() != artifact.getLong("bytes")) return false;
        try (InputStream input = new FileInputStream(file)) { return FileSafety.digest(input).equalsIgnoreCase(artifact.getString("sha256")); }
    }
    private static void validateManifest(JSONObject artifact) throws Exception {
        if (!FileSafety.HASH.matcher(artifact.getString("id")).matches() || !FileSafety.HASH.matcher(artifact.getString("sha256")).matches() ||
            artifact.getLong("bytes") < 0 || artifact.getLong("bytes") > FileSafety.MAX_BYTES) throw new IOException("결과 파일 명세가 올바르지 않습니다.");
        FileSafety.validateName(artifact.getString("filename"));
    }
    private static String mimeOf(String filename) {
        String lower = filename.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".pdf")) return "application/pdf";
        if (lower.endsWith(".txt") || lower.endsWith(".py") || lower.endsWith(".js") || lower.endsWith(".ts") || lower.endsWith(".csv")) return "text/plain";
        if (lower.endsWith(".md")) return "text/markdown";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (lower.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        if (lower.endsWith(".apk")) return "application/vnd.android.package-archive";
        if (lower.endsWith(".hwpx")) return "application/vnd.hancom.hwpx";
        return "application/octet-stream";
    }
    // Metadata only; the foreground detail view also normalizes legacy single-file jobs.
    static JSONArray availableArtifacts(JSONObject job) throws Exception {
        JSONArray artifacts = job.optJSONArray("artifacts");
        if (artifacts != null && artifacts.length() > 0) return artifacts;
        JSONObject single = job.optJSONObject("artifact");
        JSONObject request = job.optJSONObject("request");
        String state = job.optString("state");
        if ("overnight".equals(job.optString("kind")) || single == null || request == null ||
            !("download".equals(request.optString("delivery")) || "both".equals(request.optString("delivery"))) ||
            !("download_ready".equals(state) || "dry_run".equals(state) || "submitted".equals(state) || "send_unknown".equals(state))) return null;
        String filename = single.getString("filename");
        String digest = single.getString("sha256");
        JSONObject normalized = new JSONObject().put("id", digest).put("sha256", digest)
            .put("bytes", single.getLong("bytes")).put("filename", filename).put("mime", mimeOf(filename));
        artifacts = new JSONArray().put(normalized);
        job.put("artifacts", artifacts); // The recent-jobs screen can open the verified local file.
        return artifacts;
    }
    private static boolean download(JSONObject session, String jobId, JSONObject artifact, File target, boolean singleFile, BooleanSupplier stopped) throws Exception {
        if (verified(target, artifact)) return false;
        File directory = target.getParentFile(); if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("앱 저장 폴더를 만들지 못했습니다.");
        String route = "/api/jobs/" + jobId + (singleFile ? "/file" : "/artifacts/" + artifact.getString("id"));
        HttpURLConnection connection = Api.connect(session.getString("baseUrl"), route, session.getString("phoneToken"), "GET");
        AtomicFile file = new AtomicFile(target); FileOutputStream output = null;
        try {
            int status = connection.getResponseCode(); if (status < 200 || status >= 300) throw new Api.ApiException(status);
            long expected = artifact.getLong("bytes"); long declared = connection.getContentLengthLong();
            if (declared >= 0 && declared != expected) throw new IOException("서버의 파일 크기가 명세와 다릅니다.");
            MessageDigest digest = MessageDigest.getInstance("SHA-256"); long total = 0;
            output = file.startWrite();
            try (InputStream input = connection.getInputStream()) {
                byte[] bytes = new byte[16384]; int count;
                while ((count = input.read(bytes)) != -1) {
                    if (stopped.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("동기화가 중단되었습니다.");
                    total += count; if (total > expected || total > FileSafety.MAX_BYTES) throw new IOException("파일 크기가 명세를 벗어났습니다.");
                    digest.update(bytes, 0, count); output.write(bytes, 0, count);
                }
            }
            if (total != expected || !FileSafety.hex(digest.digest()).equalsIgnoreCase(artifact.getString("sha256"))) throw new IOException("파일 무결성 검증에 실패했습니다. 다시 동기화해 주세요.");
            file.finishWrite(output); output = null;
            if (!verified(target, artifact)) throw new IOException("저장된 파일을 다시 검증하지 못했습니다.");
        } catch (Exception error) { if (output != null) file.failWrite(output); throw error; }
        finally { connection.disconnect(); }
        return true;
    }
    private static void exportCopy(Context c, String jobId, JSONObject artifact, File source) throws Exception {
        SharedPreferences settings = c.getSharedPreferences("MainActivity", 0);
        String selected = settings.getString("export_tree", null); if (selected == null || selected.isEmpty()) return;
        String key = externalCopyKey(selected, jobId, artifact);
        String legacyKey = "exported_" + jobId + "_" + artifact.getString("id");
        DocumentFile document = null;
        try {
            String previous = settings.getString(key, null);
            if (previous != null) {
                try (InputStream input = c.getContentResolver().openInputStream(Uri.parse(previous))) {
                    if (input != null && FileSafety.digest(input).equalsIgnoreCase(artifact.getString("sha256"))) {
                        settings.edit().remove(key + "_error").remove(legacyKey).apply();
                        return;
                    }
                } catch (Exception ignored) { /* Recreate a missing copy without overwriting other files. */ }
                settings.edit().remove(key).apply();
            }
            // Legacy exported_* entries do not identify their destination. Never let one
            // skip a copy to a newly selected folder; preserve the old file itself.
            DocumentFile directory = DocumentFile.fromTreeUri(c, Uri.parse(selected));
            if (directory == null || !directory.canWrite()) throw new IOException("선택한 저장 폴더 권한을 다시 허용해 주세요.");
            String filename = jobId.substring(0, 8) + "_" + artifact.getString("filename");
            if (settings.contains(legacyKey)) {
                // Adopt a legacy copy only by finding and verifying it INSIDE the
                // current tree, never by trusting the unbound legacy URI.
                try {
                    DocumentFile existing = directory.findFile(filename);
                    if (existing != null && existing.isFile()) {
                        try (InputStream input = c.getContentResolver().openInputStream(existing.getUri())) {
                            if (input != null && FileSafety.digest(input).equalsIgnoreCase(artifact.getString("sha256"))) {
                                settings.edit().putString(key, existing.getUri().toString()).remove(key + "_error").remove(legacyKey).apply();
                                return;
                            }
                        }
                    }
                } catch (Exception ignored) { /* Create a fresh copy without replacing another file. */ }
            }
            document = directory.createFile(artifact.optString("mime", "application/octet-stream"), filename);
            if (document == null) throw new IOException("선택한 폴더에 복사하지 못했습니다.");
            try (InputStream input = new FileInputStream(source); OutputStream output = c.getContentResolver().openOutputStream(document.getUri(), "w")) {
                if (output == null) throw new IOException("복사할 파일을 열지 못했습니다.");
                byte[] bytes = new byte[16384]; int count; while ((count = input.read(bytes)) != -1) output.write(bytes, 0, count);
            }
            try (InputStream input = c.getContentResolver().openInputStream(document.getUri())) {
                if (input == null || !FileSafety.digest(input).equalsIgnoreCase(artifact.getString("sha256"))) throw new IOException("폴더 복사본을 검증하지 못했습니다.");
            }
            settings.edit().putString(key, document.getUri().toString()).remove(key + "_error").remove(legacyKey).apply();
        } catch (Exception error) {
            settings.edit().remove(key).putString(key + "_error", "폴더 저장에 실패했습니다. 폴더 권한을 확인한 뒤 다시 동기화해 주세요.").apply();
            if (document != null) { try { document.delete(); } catch (Exception ignored) { } }
            throw error;
        }
    }
    static int sync(Context c, BooleanSupplier stopped) throws Exception {
        return SYNC_GATE.run(stopped, () -> syncLocked(c, stopped));
    }
    private static int syncLocked(Context c, BooleanSupplier stopped) throws Exception {
        JSONObject session = new SecureStore(c).load(); if (session == null) return 0;
        JSONObject listing = Api.request(session, "/api/jobs", null); JSONArray jobs = listing.optJSONArray("jobs");
        if (jobs == null) throw new IOException("작업 목록 응답이 올바르지 않습니다.");
        RecentReceive.Batch received = new RecentReceive.Batch(); String firstError = null; String exportError = null;
        JSONArray savedHistory = cachedSaved(c); boolean historyChanged = false;
        for (int index = 0; index < jobs.length(); index++) {
            if (stopped.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("동기화가 중단되었습니다.");
            JSONObject job = jobs.getJSONObject(index); JSONArray artifacts;
            try {
                artifacts = availableArtifacts(job);
                if (artifacts == null || artifacts.length() == 0) continue;
                boolean singleFile = !"overnight".equals(job.optString("kind"));
                String jobId = job.getString("id"); if (!FileSafety.UUID.matcher(jobId).matches() || artifacts.length() > 30) throw new IOException("작업 파일 목록을 확인해 주세요.");
                Set<String> ids = new HashSet<>(); JSONArray receipt = new JSONArray();
                for (int item = 0; item < artifacts.length(); item++) {
                    JSONObject artifact = artifacts.getJSONObject(item); validateManifest(artifact);
                    if (!ids.add(artifact.getString("id"))) throw new IOException("중복된 결과 파일 ID입니다.");
                    File target = FileSafety.artifact(c.getFilesDir(), jobId, artifact.getString("id"), artifact.getString("filename"));
                    boolean newlyVerified = download(session, jobId, artifact, target, singleFile, stopped);
                    RecentReceive.Event latest = received.afterTransfer(newlyVerified, artifact.getString("filename"), Instant.now().toString());
                    if (latest != null) {
                        // The verified private file is received even if a later folder
                        // copy or server acknowledgement fails. No-new runs never write.
                        try { recordLatestReceive(c, session, latest.filename, latest.count, latest.receivedAt); }
                        catch (Exception ignored) { /* This display record never blocks a verified file receipt. */ }
                    }
                    receipt.put(new JSONObject().put("id", artifact.getString("id")).put("sha256", artifact.getString("sha256")));
                    try { exportCopy(c, jobId, artifact, target); } catch (Exception error) { exportError = error.getMessage(); }
                }
                // Reverify every artifact immediately before acknowledging the whole job.
                for (int item = 0; item < artifacts.length(); item++) {
                    JSONObject artifact = artifacts.getJSONObject(item);
                    if (!verified(FileSafety.artifact(c.getFilesDir(), jobId, artifact.getString("id"), artifact.getString("filename")), artifact)) throw new IOException("전송 확인 전 파일 검증에 실패했습니다.");
                }
                if (stopped.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("동기화가 중단되었습니다.");
                String savedAt = Instant.now().toString();
                JSONObject acknowledgement = Api.request(session, "/api/phone/jobs/" + jobId + "/received", new JSONObject().put("artifacts", receipt).put("savedAt", savedAt));
                job.put("phoneSavedAt", acknowledgement.optString("phoneSavedAt", savedAt));
                if (!singleFile) job.put("state", acknowledgement.optBoolean("onTime") ? "download_ready" : "deadline_exceeded");
                savedHistory = rememberSaved(savedHistory, job, artifacts); historyChanged = true;
            } catch (Exception error) { if (firstError == null) firstError = error.getMessage(); }
        }
        cache(c, listing);
        if (historyChanged) cacheSaved(c, savedHistory);
        SharedPreferences.Editor update = c.getSharedPreferences("MainActivity", 0).edit().putString("last_sync", Instant.now().toString()).putString("last_error", firstError == null ? "" : firstError).putString("export_error", exportError == null ? "" : exportError);
        update.apply();
        if (received.count() > 0) Notifications.received(c, received.count());
        if (firstError != null) throw new IOException(firstError);
        return received.count();
    }
}
