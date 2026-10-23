package kr.nightdesk.phone;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

/** One explicitly selected, durable upload. User documents are never modified. */
final class UploadSender {
    static final long MAX_BYTES = 10L * 1024 * 1024;
    private static final Object MUTATIONS = new Object();
    private static final int MAX_METADATA_BYTES = 8192;
    private static final int MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
    private static final Pattern UNSAFE_NAME = Pattern.compile("[\\\\/\\x00-\\x1f\\x7f-\\x9f:*?\"<>|\\u202a-\\u202e\\u2066-\\u2069\\u200e\\u200f\\u061c]");

    static final class UploadException extends IOException {
        UploadException(String message) { super(message); }
    }
    static final class Pending {
        final String id, filename, sha256, baseUrl, phoneId;
        final long bytes;
        Pending(String id, String filename, String sha256, long bytes, String baseUrl, String phoneId) throws Exception {
            if (!FileSafety.UUID.matcher(id).matches() || !sha256.matches("[a-f0-9]{64}") || bytes < 1 || bytes > MAX_BYTES || phoneId.isEmpty())
                throw new UploadException("전송 대기 정보를 읽지 못했습니다. 대기를 취소하고 파일을 다시 선택해 주세요.");
            validateFilename(filename);
            this.id = id; this.filename = filename; this.sha256 = sha256; this.bytes = bytes;
            this.baseUrl = Api.validateBase(baseUrl, BuildConfig.DEBUG); this.phoneId = phoneId;
        }
        JSONObject json() throws Exception {
            return new JSONObject().put("version", 1).put("id", id).put("filename", filename).put("sha256", sha256)
                .put("bytes", bytes).put("baseUrl", baseUrl).put("phoneId", phoneId);
        }
        boolean belongsTo(JSONObject session) {
            return session != null && baseUrl.equals(session.optString("baseUrl")) && phoneId.equals(session.optString("phoneId"));
        }
    }
    static final class Copied {
        final long bytes; final String sha256;
        Copied(long bytes, String sha256) { this.bytes = bytes; this.sha256 = sha256; }
    }

    static void validateFilename(String name) throws IOException {
        if (name == null || name.isEmpty() || name.length() > 180 || name.startsWith(".") || name.endsWith(".") || name.endsWith(" ") ||
            UNSAFE_NAME.matcher(name).find() ||
            name.matches("(?i)^(CON|PRN|AUX|NUL|CLOCK\\$|CONIN\\$|CONOUT\\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\\..*)?$")) {
            throw new UploadException("PC에서 사용할 수 없는 파일 이름입니다. 이름을 바꾼 뒤 다시 선택해 주세요.");
        }
        // Reject unpaired UTF-16 surrogates rather than encoding a different filename.
        for (int i = 0; i < name.length(); i++) {
            char current = name.charAt(i);
            if (Character.isHighSurrogate(current)) {
                if (++i >= name.length() || !Character.isLowSurrogate(name.charAt(i))) throw new UploadException("파일 이름을 확인해 주세요.");
            } else if (Character.isLowSurrogate(current)) throw new UploadException("파일 이름을 확인해 주세요.");
        }
    }
    static String encodedFilename(String filename) throws Exception {
        validateFilename(filename);
        return URLEncoder.encode(filename, StandardCharsets.UTF_8.name()).replace("+", "%20");
    }
    static Copied copyAndHash(InputStream input, OutputStream output) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[16384]; long total = 0; int count;
        while ((count = input.read(buffer)) != -1) {
            if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("파일 준비를 중단했습니다.");
            total += count;
            if (total > MAX_BYTES) throw new UploadException("파일은 10MB까지 보낼 수 있습니다.");
            digest.update(buffer, 0, count); if (output != null) output.write(buffer, 0, count);
        }
        if (total == 0) throw new UploadException("빈 파일은 보낼 수 없습니다.");
        return new Copied(total, FileSafety.hex(digest.digest()));
    }
    private static File directory(Context context) { return new File(context.getFilesDir(), "outgoing-upload"); }
    private static AtomicFile metadata(Context context) { return new AtomicFile(new File(directory(context), "pending.json")); }
    private static File staged(Context context, String id) { return new File(directory(context), id + ".bin"); }
    private static byte[] readBounded(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream result = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
        while ((count = input.read(buffer)) != -1) {
            if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException();
            if (result.size() + count > limit) throw new UploadException("서버 응답 또는 전송 대기 정보가 너무 큽니다.");
            result.write(buffer, 0, count);
        }
        return result.toByteArray();
    }
    static Pending load(Context context) throws Exception {
        try (InputStream input = metadata(context).openRead()) {
            JSONObject value = new JSONObject(new String(readBounded(input, MAX_METADATA_BYTES), StandardCharsets.UTF_8));
            if (value.getInt("version") != 1) throw new IOException();
            Pending pending = new Pending(value.getString("id"), value.getString("filename"), value.getString("sha256"),
                value.getLong("bytes"), value.getString("baseUrl"), value.getString("phoneId"));
            File file = staged(context, pending.id);
            if (!file.isFile() || file.length() != pending.bytes) throw new IOException();
            return pending;
        } catch (FileNotFoundException missing) {
            File base = new File(directory(context), "pending.json");
            if (!base.exists() && !new File(directory(context), "pending.json.bak").exists()) return null;
            throw new UploadException("전송 대기 정보를 읽지 못했습니다. 대기를 취소하고 파일을 다시 선택해 주세요.");
        } catch (Exception error) {
            throw new UploadException("전송 대기 정보를 읽지 못했습니다. 대기를 취소하고 파일을 다시 선택해 주세요.");
        }
    }
    private static void cleanStaging(Context context) throws IOException {
        File[] files = directory(context).listFiles(); if (files == null) return;
        for (File file : files) {
            String name = file.getName();
            if (name.matches("[a-f0-9-]{36}\\.(bin|part)") && file.isFile() && !file.delete())
                throw new UploadException("앱의 전송 임시 파일을 정리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
        }
    }
    static Pending prepare(Context context, Uri uri, JSONObject session) throws Exception {
        synchronized (MUTATIONS) {
            if (load(context) != null) throw new UploadException("먼저 준비된 파일을 보내거나 전송 대기를 취소해 주세요.");
            File partial = null, complete = null;
            try {
                if (uri == null || !"content".equalsIgnoreCase(uri.getScheme())) throw new UploadException("파일 선택 화면에서 문서를 선택해 주세요.");
                String filename = null; long declared = -1;
                try (Cursor cursor = context.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME), sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE);
                        if (nameColumn >= 0 && !cursor.isNull(nameColumn)) filename = cursor.getString(nameColumn);
                        if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) declared = cursor.getLong(sizeColumn);
                    }
                }
                validateFilename(filename);
                if (declared > MAX_BYTES) throw new UploadException("파일은 10MB까지 보낼 수 있습니다.");
                File directory = directory(context);
                if (!directory.isDirectory() && !directory.mkdirs()) throw new UploadException("앱의 전송 준비 폴더를 만들지 못했습니다.");
                cleanStaging(context);
                String id = UUID.randomUUID().toString();
                partial = new File(directory, id + ".part"); complete = staged(context, id);
                if (!partial.createNewFile()) throw new IOException();
                Copied copied;
                try (InputStream input = context.getContentResolver().openInputStream(uri); FileOutputStream output = new FileOutputStream(partial)) {
                    if (input == null) throw new IOException();
                    copied = copyAndHash(input, output); output.getFD().sync();
                }
                if (!partial.renameTo(complete)) throw new IOException();
                Pending pending = new Pending(id, filename, copied.sha256, copied.bytes, session.getString("baseUrl"), session.getString("phoneId"));
                AtomicFile metadata = metadata(context); FileOutputStream output = null;
                try {
                    output = metadata.startWrite(); output.write(pending.json().toString().getBytes(StandardCharsets.UTF_8));
                    metadata.finishWrite(output); output = null;
                } finally { if (output != null) metadata.failWrite(output); }
                return pending;
            } catch (Exception error) {
                if (partial != null) partial.delete(); if (complete != null) complete.delete();
                if (error instanceof UploadException) throw error;
                throw new UploadException("선택한 파일을 준비하지 못했습니다. 파일을 다시 선택해 주세요.");
            }
        }
    }
    static void discard(Context context) throws Exception {
        synchronized (MUTATIONS) { metadata(context).delete(); cleanStaging(context); }
    }
    static JSONObject send(Context context, JSONObject session) throws Exception {
        synchronized (MUTATIONS) {
            Pending pending = load(context);
            if (pending == null) throw new UploadException("전송 대기 중인 파일이 없습니다. 최근 작업을 확인해 주세요.");
            if (!pending.belongsTo(session)) throw new UploadException("이 파일은 이전 PC 연결에서 준비했습니다. 대기를 취소하고 다시 선택해 주세요.");
            HttpURLConnection connection = null;
            try {
                File source = staged(context, pending.id);
                Copied verified;
                try (InputStream input = new FileInputStream(source)) { verified = copyAndHash(input, null); }
                if (verified.bytes != pending.bytes || !verified.sha256.equals(pending.sha256))
                    throw new UploadException("전송 준비 파일의 무결성을 확인하지 못했습니다. 대기를 취소하고 다시 선택해 주세요.");
                connection = Api.connect(session.getString("baseUrl"), "/api/uploads/" + pending.id, session.getString("phoneToken"), "POST");
                connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/octet-stream");
                connection.setRequestProperty("X-File-Name", encodedFilename(pending.filename));
                connection.setRequestProperty("X-File-SHA256", pending.sha256); connection.setFixedLengthStreamingMode(pending.bytes);
                try (InputStream input = new FileInputStream(source); OutputStream output = connection.getOutputStream()) {
                    Copied sent = copyAndHash(input, output);
                    if (sent.bytes != pending.bytes || !sent.sha256.equals(pending.sha256)) throw new IOException();
                }
                int status = connection.getResponseCode();
                if (status != 200 && status != 201) {
                    if (status == 401 || status == 403) throw new Api.ApiException(status);
                    if (status == 413) throw new UploadException("파일은 10MB까지 보낼 수 있습니다.");
                    if (status == 409) throw new UploadException("같은 전송 번호의 정보를 확인하지 못했습니다. 최근 작업을 확인한 뒤 전송 대기를 취소해 주세요.");
                    if (status == 429) throw new UploadException("잠시 후 같은 파일로 다시 시도해 주세요. 전송 준비는 보관되어 있습니다.");
                    throw new UploadException("서버가 파일을 받지 못했습니다. 잠시 후 같은 파일로 재시도해 주세요.");
                }
                JSONObject response;
                try (InputStream input = connection.getInputStream()) {
                    response = new JSONObject(new String(readBounded(input, MAX_RESPONSE_BYTES), StandardCharsets.UTF_8));
                }
                JSONObject job = response.getJSONObject("job"), request = job.getJSONObject("request");
                if (!pending.id.equals(job.getString("id")) || !"upload".equals(job.getString("kind")) ||
                    !pending.filename.equals(request.getString("filename")) || !pending.sha256.equals(request.getString("sha256")) ||
                    pending.bytes != request.getLong("bytes")) throw new IOException();
                metadata(context).delete();
                source.delete(); // An orphan is also removed before preparing the next file.
                return job;
            } catch (Exception error) {
                if (error instanceof UploadException || error instanceof Api.ApiException) throw error;
                throw new UploadException("서버 수신을 확인하지 못했습니다. 준비된 파일로 재시도해 주세요. 같은 전송 번호를 사용해 중복 저장을 막습니다.");
            } finally { if (connection != null) connection.disconnect(); }
        }
    }
    static String describeBytes(long bytes) {
        return bytes >= 1024 * 1024 ? String.format(Locale.KOREA, "%.1f MB", bytes / (1024.0 * 1024)) :
            bytes >= 1024 ? String.format(Locale.KOREA, "%.1f KB", bytes / 1024.0) : bytes + "바이트";
    }
}
