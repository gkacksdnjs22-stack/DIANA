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
    static JSONArray cachedJobs(Context c) {
        try (InputStream input = new AtomicFile(new File(c.getFilesDir(), "jobs.json")).openRead()) {
            byte[] bytes = input.readAllBytes(); if (bytes.length > 2 * 1024 * 1024) return new JSONArray();
            JSONArray jobs = new JSONObject(new String(bytes, StandardCharsets.UTF_8)).optJSONArray("jobs");
            return jobs == null ? new JSONArray() : jobs;
        } catch (Exception ignored) { return new JSONArray(); }
    }
    static void cache(Context c, JSONObject jobs) throws Exception {
        AtomicFile file = new AtomicFile(new File(c.getFilesDir(), "jobs.json")); FileOutputStream output = null;
        try { output = file.startWrite(); output.write(jobs.toString().getBytes(StandardCharsets.UTF_8)); file.finishWrite(output); }
        catch (Exception error) { if (output != null) file.failWrite(output); throw error; }
    }
    static JSONArray cachedSaved(Context c) {
        try (InputStream input = new AtomicFile(new File(c.getFilesDir(), "saved-jobs.json")).openRead()) {
            byte[] bytes = input.readAllBytes(); if (bytes.length > 8 * 1024 * 1024) return new JSONArray();
            JSONArray saved = new JSONObject(new String(bytes, StandardCharsets.UTF_8)).optJSONArray("jobs");
            return saved == null ? new JSONArray() : saved;
        } catch (Exception ignored) { return new JSONArray(); }
    }
    private static void cacheSaved(Context c, JSONArray jobs) throws Exception {
        AtomicFile file = new AtomicFile(new File(c.getFilesDir(), "saved-jobs.json")); FileOutputStream output = null;
        try { output = file.startWrite(); output.write(new JSONObject().put("jobs", jobs).toString().getBytes(StandardCharsets.UTF_8)); file.finishWrite(output); }
        catch (Exception error) { if (output != null) file.failWrite(output); throw error; }
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
    private static JSONArray availableArtifacts(JSONObject job) throws Exception {
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
    private static void download(JSONObject session, String jobId, JSONObject artifact, File target, boolean singleFile, BooleanSupplier stopped) throws Exception {
        if (verified(target, artifact)) return;
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
    }
    private static void exportCopy(Context c, String jobId, JSONObject artifact, File source) throws Exception {
        SharedPreferences settings = c.getSharedPreferences("MainActivity", 0); String selected = settings.getString("export_tree", null); if (selected == null) return;
        String key = "exported_" + jobId + "_" + artifact.getString("id");
        String previous = settings.getString(key, null);
        if (previous != null) {
            try (InputStream input = c.getContentResolver().openInputStream(Uri.parse(previous))) {
                if (input != null && FileSafety.digest(input).equalsIgnoreCase(artifact.getString("sha256"))) return;
            } catch (Exception ignored) { /* Recreate a missing copy without overwriting other files. */ }
        }
        DocumentFile directory = DocumentFile.fromTreeUri(c, Uri.parse(selected));
        if (directory == null || !directory.canWrite()) throw new IOException("선택한 저장 폴더 권한을 다시 허용해 주세요.");
        DocumentFile document = directory.createFile(artifact.optString("mime", "application/octet-stream"), jobId.substring(0, 8) + "_" + artifact.getString("filename"));
        if (document == null) throw new IOException("선택한 폴더에 복사하지 못했습니다.");
        try {
            try (InputStream input = new FileInputStream(source); OutputStream output = c.getContentResolver().openOutputStream(document.getUri(), "w")) {
                if (output == null) throw new IOException("복사할 파일을 열지 못했습니다.");
                byte[] bytes = new byte[16384]; int count; while ((count = input.read(bytes)) != -1) output.write(bytes, 0, count);
            }
            try (InputStream input = c.getContentResolver().openInputStream(document.getUri())) {
                if (input == null || !FileSafety.digest(input).equalsIgnoreCase(artifact.getString("sha256"))) throw new IOException("폴더 복사본을 검증하지 못했습니다.");
            }
            settings.edit().putString(key, document.getUri().toString()).apply();
        } catch (Exception error) { document.delete(); throw error; }
    }
    static int sync(Context c, BooleanSupplier stopped) throws Exception {
        JSONObject session = new SecureStore(c).load(); if (session == null) return 0;
        JSONObject listing = Api.request(session, "/api/jobs", null); JSONArray jobs = listing.optJSONArray("jobs");
        if (jobs == null) throw new IOException("작업 목록 응답이 올바르지 않습니다.");
        int received = 0; String firstError = null; String exportError = null;
        JSONArray savedHistory = cachedSaved(c); boolean historyChanged = false;
        for (int index = 0; index < jobs.length(); index++) {
            if (stopped.getAsBoolean()) throw new InterruptedIOException("동기화가 중단되었습니다.");
            JSONObject job = jobs.getJSONObject(index); JSONArray artifacts;
            try {
                artifacts = availableArtifacts(job);
                if (artifacts == null || artifacts.length() == 0) continue;
                boolean singleFile = !"overnight".equals(job.optString("kind"));
                String jobId = job.getString("id"); if (!FileSafety.UUID.matcher(jobId).matches() || artifacts.length() > 30) throw new IOException("작업 파일 목록을 확인해 주세요.");
                Set<String> ids = new HashSet<>(); JSONArray receipt = new JSONArray();
                boolean newlySaved = false;
                for (int item = 0; item < artifacts.length(); item++) {
                    JSONObject artifact = artifacts.getJSONObject(item); validateManifest(artifact);
                    if (!ids.add(artifact.getString("id"))) throw new IOException("중복된 결과 파일 ID입니다.");
                    File target = FileSafety.artifact(c.getFilesDir(), jobId, artifact.getString("id"), artifact.getString("filename"));
                    if (!verified(target, artifact)) newlySaved = true;
                    download(session, jobId, artifact, target, singleFile, stopped);
                    receipt.put(new JSONObject().put("id", artifact.getString("id")).put("sha256", artifact.getString("sha256")));
                    try { exportCopy(c, jobId, artifact, target); } catch (Exception error) { exportError = error.getMessage(); }
                }
                // Reverify every artifact immediately before acknowledging the whole job.
                for (int item = 0; item < artifacts.length(); item++) {
                    JSONObject artifact = artifacts.getJSONObject(item);
                    if (!verified(FileSafety.artifact(c.getFilesDir(), jobId, artifact.getString("id"), artifact.getString("filename")), artifact)) throw new IOException("전송 확인 전 파일 검증에 실패했습니다.");
                }
                if (stopped.getAsBoolean()) throw new InterruptedIOException("동기화가 중단되었습니다.");
                String savedAt = Instant.now().toString();
                JSONObject acknowledgement = Api.request(session, "/api/phone/jobs/" + jobId + "/received", new JSONObject().put("artifacts", receipt).put("savedAt", savedAt));
                job.put("phoneSavedAt", acknowledgement.optString("phoneSavedAt", savedAt));
                if (!singleFile) job.put("state", acknowledgement.optBoolean("onTime") ? "download_ready" : "deadline_exceeded");
                savedHistory = rememberSaved(savedHistory, job, artifacts); historyChanged = true;
                if (newlySaved) received += artifacts.length();
            } catch (Exception error) { if (firstError == null) firstError = error.getMessage(); }
        }
        cache(c, listing);
        if (historyChanged) cacheSaved(c, savedHistory);
        SharedPreferences.Editor update = c.getSharedPreferences("MainActivity", 0).edit().putString("last_sync", Instant.now().toString()).putString("last_error", firstError == null ? "" : firstError).putString("export_error", exportError == null ? "" : exportError);
        update.apply();
        if (received > 0) Notifications.received(c, received);
        if (firstError != null) throw new IOException(firstError);
        return received;
    }
}
