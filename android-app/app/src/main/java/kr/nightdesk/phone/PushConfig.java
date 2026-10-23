package kr.nightdesk.phone;

import java.util.Map;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Public Firebase identifiers only; push messages are hints to read the authenticated API. */
final class PushConfig {
    final boolean enabled;
    final String applicationId, apiKey, projectId, senderId;

    private PushConfig(boolean enabled, String applicationId, String apiKey, String projectId, String senderId) {
        this.enabled = enabled; this.applicationId = applicationId; this.apiKey = apiKey;
        this.projectId = projectId; this.senderId = senderId;
    }
    static PushConfig disabled() { return new PushConfig(false, "", "", "", ""); }
    static PushConfig of(boolean enabled, String applicationId, String apiKey, String projectId, String senderId) {
        if (!enabled) return disabled();
        if (applicationId == null || apiKey == null || projectId == null || senderId == null ||
            !senderId.matches("[1-9][0-9]{0,29}") ||
            !applicationId.matches("1:[1-9][0-9]{0,29}:android:[A-Fa-f0-9]{1,128}") ||
            !applicationId.startsWith("1:" + senderId + ":android:") ||
            !apiKey.matches("[A-Za-z0-9_-]{20,256}") ||
            !projectId.matches("[a-z][a-z0-9-]{4,28}[a-z0-9]")) {
            throw new IllegalArgumentException("알림 연결 설정을 확인해 주세요.");
        }
        return new PushConfig(true, applicationId, apiKey, projectId, senderId);
    }
    static boolean filesReady(Map<String, String> data) {
        // No URL, filename, command, path or credentials from the push are ever used.
        return data != null && "files_ready".equals(data.get("type"));
    }
    static boolean sameSession(String base, String phoneId, String token, String otherBase, String otherId, String otherToken) {
        return base != null && !base.isEmpty() && phoneId != null && !phoneId.isEmpty() && token != null && !token.isEmpty() &&
            base.equals(otherBase) && phoneId.equals(otherId) && token.equals(otherToken);
    }
    static String sessionFingerprint(String base, String phoneId, String token) {
        if (!sameSession(base, phoneId, token, base, phoneId, token)) throw new IllegalArgumentException("휴대폰 연결을 확인해 주세요.");
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (String part : new String[]{base, phoneId, token}) {
                byte[] bytes = part.getBytes(StandardCharsets.UTF_8);
                digest.update(new byte[]{(byte)(bytes.length >>> 24), (byte)(bytes.length >>> 16), (byte)(bytes.length >>> 8), (byte)bytes.length});
                digest.update(bytes);
            }
            StringBuilder hex = new StringBuilder();
            for (byte item : digest.digest()) { hex.append(Character.forDigit((item & 255) >>> 4, 16)); hex.append(Character.forDigit(item & 15, 16)); }
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
}
