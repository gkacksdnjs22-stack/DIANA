package kr.nightdesk.phone;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/** Explicit document search/edit requests only. No shell commands or owner credentials. */
final class PcRequests {
    private static final Object REQUESTS = new Object(), DRAFT_FILE = new Object();
    private static final String DRAFT_NAME = "pending-pc-request.json";
    private static final int MAX_DRAFT_BYTES = 24 * 1024;
    private static final String SPACE = "[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";

    static final class RequestException extends IOException {
        RequestException(String message) { super(message); }
    }

    /** Immutable retry body plus a hash of public server/phone identifiers; no token. */
    static final class Pending {
        final String id, query, editInstruction;
        private final String binding;

        Pending(String id, String binding, String query, String editInstruction) throws RequestException {
            if (id == null || !FileSafety.UUID.matcher(id).matches() || binding == null || !binding.matches("[a-f0-9]{64}"))
                throw new RequestException("요청 대기 정보를 읽지 못했습니다. 최근 작업을 확인한 뒤 대기를 정리해 주세요.");
            String safeQuery = normalizeQuery(query), safeEdit = normalizeEdit(editInstruction);
            if (!safeQuery.equals(query) || !safeEdit.equals(editInstruction))
                throw new RequestException("요청 대기 정보를 읽지 못했습니다. 최근 작업을 확인한 뒤 대기를 정리해 주세요.");
            this.id = id; this.binding = binding; this.query = query; this.editInstruction = editInstruction;
        }
        boolean belongsTo(JSONObject session) {
            try { return binding.equals(sessionBinding(session)); }
            catch (Exception ignored) { return false; }
        }
        boolean matches(String query, String editInstruction) throws RequestException {
            return this.query.equals(normalizeQuery(query)) && this.editInstruction.equals(normalizeEdit(editInstruction));
        }
        Map<String,Object> wireFields() {
            Map<String,Object> body = new LinkedHashMap<>();
            body.put("requestId", id); body.put("query", query); body.put("delivery", "download");
            body.put("autoSend", false); body.put("editInstruction", editInstruction);
            return Collections.unmodifiableMap(body);
        }
        private JSONObject json() throws Exception {
            return new JSONObject().put("version", 1).put("id", id).put("binding", binding)
                .put("query", query).put("editInstruction", editInstruction);
        }
    }

    static String normalizeQuery(String value) throws RequestException { return normalize(value, 1000, false, "찾을 문서 설명"); }
    static String normalizeEdit(String value) throws RequestException { return normalize(value, 2000, true, "수정 요청"); }
    private static String normalize(String value, int max, boolean optional, String label) throws RequestException {
        if (value == null) value = "";
        if (value.length() > max) throw new RequestException(label + "은 " + max + "자 이내로 입력해 주세요.");
        for (int i = 0; i < value.length(); i++) {
            char item = value.charAt(i);
            if ((item < 32 && item != '\n' && item != '\r' && item != '\t') || item == 127)
                throw new RequestException(label + "에 사용할 수 없는 제어 문자가 있습니다.");
            if (Character.isHighSurrogate(item)) {
                if (++i >= value.length() || !Character.isLowSurrogate(value.charAt(i))) throw new RequestException(label + "의 문자를 확인해 주세요.");
            } else if (Character.isLowSurrogate(item)) throw new RequestException(label + "의 문자를 확인해 주세요.");
        }
        String trimmed = value.replaceAll("^" + SPACE + "+|" + SPACE + "+$", "");
        if (!optional && trimmed.isEmpty()) throw new RequestException("찾을 문서 설명을 입력해 주세요.");
        return trimmed;
    }
    static String fingerprint(String baseUrl, String phoneId) throws RequestException {
        if (baseUrl == null || baseUrl.isEmpty() || phoneId == null || phoneId.isEmpty())
            throw new RequestException("휴대폰을 PC에 다시 연결해 주세요.");
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (String part : new String[]{baseUrl, phoneId}) {
                byte[] bytes = part.getBytes(StandardCharsets.UTF_8);
                digest.update(new byte[]{(byte)(bytes.length >>> 24), (byte)(bytes.length >>> 16), (byte)(bytes.length >>> 8), (byte)bytes.length});
                digest.update(bytes);
            }
            return FileSafety.hex(digest.digest());
        } catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static String sessionBinding(JSONObject session) throws Exception {
        if (session == null || session.optString("phoneToken").isEmpty()) throw new RequestException("휴대폰을 PC에 다시 연결해 주세요.");
        return fingerprint(Api.validateBase(session.getString("baseUrl"), BuildConfig.DEBUG), session.getString("phoneId"));
    }
    private static File draftPath(Context c) { return new File(c.getFilesDir(), DRAFT_NAME); }
    private static AtomicFile draftFile(Context c) { return new AtomicFile(draftPath(c)); }
    static Pending load(Context c) throws Exception {
        // Never hold REQUESTS here: the UI can inspect the draft during a network request.
        synchronized (DRAFT_FILE) {
            try (InputStream input = draftFile(c).openRead()) {
                ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (bytes.size() + count > MAX_DRAFT_BYTES) throw new IOException();
                    bytes.write(buffer, 0, count);
                }
                JSONObject value = new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
                if (value.getInt("version") != 1) throw new IOException();
                return new Pending(value.getString("id"), value.getString("binding"), value.getString("query"), value.getString("editInstruction"));
            } catch (FileNotFoundException absent) {
                File path = draftPath(c);
                if (!path.exists() && !new File(path.getPath() + ".bak").exists() && !new File(path.getPath() + ".new").exists()) return null;
                throw new RequestException("요청 대기 정보를 읽지 못했습니다. 최근 작업을 확인한 뒤 대기를 정리해 주세요.");
            } catch (Exception error) {
                throw new RequestException("요청 대기 정보를 읽지 못했습니다. 최근 작업을 확인한 뒤 대기를 정리해 주세요.");
            }
        }
    }
    private static void remember(Context c, Pending pending) throws Exception {
        synchronized (DRAFT_FILE) {
            AtomicFile file = draftFile(c); FileOutputStream output = null;
            try {
                output = file.startWrite(); output.write(pending.json().toString().getBytes(StandardCharsets.UTF_8));
                file.finishWrite(output); output = null;
            } catch (Exception error) {
                if (output != null) file.failWrite(output);
                throw new RequestException("재시도할 요청을 저장하지 못했습니다. 저장 공간을 확인한 뒤 다시 시도해 주세요.");
            }
        }
    }
    /** Clears only local retry tracking. An already accepted server job is not cancelled. */
    static void discard(Context c) throws Exception {
        synchronized (REQUESTS) { synchronized (DRAFT_FILE) {
            draftFile(c).delete();
            if (draftPath(c).exists()) throw new RequestException("요청 대기를 정리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
        } }
    }
    static JSONObject create(Context c, JSONObject session, String query, String editInstruction) throws Exception {
        synchronized (REQUESTS) {
            String safeQuery = normalizeQuery(query), safeEdit = normalizeEdit(editInstruction);
            String binding = sessionBinding(session);
            Pending pending = load(c);
            if (pending == null) {
                pending = new Pending(UUID.randomUUID().toString(), binding, safeQuery, safeEdit);
                remember(c, pending); // Durable before the first HTTP request.
            } else if (!pending.binding.equals(binding) || !pending.matches(safeQuery, safeEdit)) {
                throw new RequestException("등록 상태를 확인할 요청이 남아 있습니다. 최근 작업을 확인하고 같은 요청을 재시도하거나 대기를 정리해 주세요.");
            }
            return submit(c, session, pending);
        }
    }
    static JSONObject retry(Context c, JSONObject session) throws Exception {
        synchronized (REQUESTS) {
            Pending pending = load(c);
            if (pending == null) throw new RequestException("재시도할 요청이 없습니다. 최근 작업을 확인해 주세요.");
            if (!pending.belongsTo(session)) throw new RequestException("이전 PC 연결에서 준비한 요청입니다. 최근 작업을 확인한 뒤 대기를 정리해 주세요.");
            return submit(c, session, pending);
        }
    }
    private static JSONObject submit(Context c, JSONObject session, Pending pending) throws Exception {
        try {
            JSONObject response = Api.request(session, "/api/jobs", new JSONObject(pending.wireFields()));
            JSONObject job = response.getJSONObject("job");
            validateSearchJob(job, pending.id);
            JSONObject request = job.getJSONObject("request");
            if (!pending.query.equals(request.getString("query")) || !pending.editInstruction.equals(request.optString("editInstruction", "")) ||
                !"download".equals(request.getString("delivery")) || request.getBoolean("autoSend") ||
                !request.optString("recipient", "").isEmpty() || !"요청하신 문서".equals(request.optString("subject", ""))) throw new IOException();
            synchronized (DRAFT_FILE) {
                Pending current = load(c);
                if (current != null && current.id.equals(pending.id) && current.binding.equals(pending.binding)) draftFile(c).delete();
            }
            return job;
        } catch (Exception error) {
            if (error instanceof Api.ApiException || error instanceof RequestException) throw error;
            throw new RequestException("서버 등록 여부를 확인하지 못했습니다. 최근 작업을 확인한 뒤 같은 요청으로 재시도해 주세요. 요청 번호는 유지됩니다.");
        }
    }
    private static void validateSearchJob(JSONObject job, String expectedId) throws Exception {
        String kind = job.optString("kind", ""); JSONObject request = job.getJSONObject("request");
        String delivery = request.optString("delivery");
        if (!expectedId.equals(job.getString("id")) || !(kind.isEmpty() || "search".equals(kind)) ||
            !("download".equals(delivery) || "email".equals(delivery) || "both".equals(delivery)) || job.optString("state").isEmpty()) throw new IOException();
    }
    private static JSONObject findJob(JSONObject session, String jobId) throws Exception {
        JSONArray jobs = Api.request(session, "/api/jobs", null).getJSONArray("jobs");
        for (int i = 0; i < jobs.length(); i++) {
            JSONObject job = jobs.optJSONObject(i);
            if (job != null && jobId.equals(job.optString("id"))) { validateSearchJob(job, jobId); return job; }
        }
        throw new RequestException("최근 작업에서 요청을 찾지 못했습니다. 작업 목록을 다시 확인해 주세요.");
    }
    static JSONObject select(Context c, JSONObject session, String jobId, String candidateId) throws Exception {
        synchronized (REQUESTS) {
            if (jobId == null || !FileSafety.UUID.matcher(jobId).matches() || candidateId == null || !candidateId.matches("[a-f0-9]{64}"))
                throw new RequestException("표시된 문서 후보에서 파일을 선택해 주세요.");
            sessionBinding(session);
            try {
                JSONObject before = findJob(session, jobId);
                if (candidateId.equals(before.optString("selectedId")) && !"needs_selection".equals(before.optString("state"))) return before;
                if (!"needs_selection".equals(before.optString("state")))
                    throw new RequestException("이미 처리 중이거나 선택을 마친 작업입니다. 최근 상태를 확인해 주세요.");
                boolean listed = false; JSONArray candidates = before.optJSONArray("candidates");
                if (candidates != null) for (int i = 0; i < candidates.length(); i++) {
                    JSONObject candidate = candidates.optJSONObject(i);
                    if (candidate != null && candidateId.equals(candidate.optString("id"))) listed = true;
                }
                if (!listed) throw new RequestException("표시된 문서 후보가 변경됐습니다. 최근 작업을 다시 확인해 주세요.");
                try {
                    JSONObject job = Api.request(session, "/api/jobs/" + jobId + "/selection", new JSONObject().put("candidateId", candidateId).put("approve", true)).getJSONObject("job");
                    validateSearchJob(job, jobId);
                    if (!candidateId.equals(job.optString("selectedId"))) throw new IOException();
                    return job;
                } catch (Exception uncertain) {
                    if (uncertain instanceof Api.ApiException && (((Api.ApiException)uncertain).status == 401 || ((Api.ApiException)uncertain).status == 403)) throw uncertain;
                    // Selection POST has no idempotency key. Confirm its accepted value
                    // rather than POSTing again after a lost response or HTTP 409.
                    try {
                        JSONObject current = findJob(session, jobId);
                        if (candidateId.equals(current.optString("selectedId")) && !"needs_selection".equals(current.optString("state"))) return current;
                    } catch (Exception ignored) { }
                    throw uncertain;
                }
            } catch (Exception error) {
                if (error instanceof Api.ApiException || error instanceof RequestException) throw error;
                throw new RequestException("파일 선택 결과를 확인하지 못했습니다. 최근 작업을 확인한 뒤 같은 파일로 다시 시도해 주세요.");
            }
        }
    }
}
