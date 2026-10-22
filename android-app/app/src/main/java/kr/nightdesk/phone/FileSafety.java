package kr.nightdesk.phone;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.regex.Pattern;

final class FileSafety {
    static final long MAX_BYTES = 50L * 1024 * 1024;
    static final Pattern UUID = Pattern.compile("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}");
    static final Pattern HASH = Pattern.compile("[a-fA-F0-9]{64}");
    static void validateName(String value) throws IOException {
        if (value == null || value.isEmpty() || value.getBytes(StandardCharsets.UTF_8).length > 200 ||
            value.equals(".") || value.equals("..") || value.matches(".*[\\\\/\\x00-\\x1f<>:\"|?*].*") || value.endsWith(".") || value.endsWith(" ")) {
            throw new IOException("안전하지 않은 결과 파일 이름입니다.");
        }
    }
    static File artifact(File filesRoot, String jobId, String artifactId, String filename) throws IOException {
        if (!UUID.matcher(jobId).matches() || !HASH.matcher(artifactId).matches()) throw new IOException("올바르지 않은 작업 또는 파일 ID입니다.");
        validateName(filename);
        File root = new File(filesRoot, "results").getCanonicalFile();
        File result = new File(new File(root, jobId), artifactId.substring(0, 12) + "_" + filename).getCanonicalFile();
        if (!result.getPath().startsWith(root.getPath() + File.separator)) throw new IOException("결과 저장 경로를 벗어났습니다.");
        return result;
    }
    static String digest(InputStream stream) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256"); byte[] buffer = new byte[8192]; int count; long total = 0;
        while ((count = stream.read(buffer)) != -1) { total += count; if (total > MAX_BYTES) throw new IOException("파일 크기 제한을 넘었습니다."); digest.update(buffer, 0, count); }
        return hex(digest.digest());
    }
    static String hex(byte[] bytes) { StringBuilder text = new StringBuilder(); for (byte value : bytes) text.append(String.format(java.util.Locale.ROOT, "%02x", value & 255)); return text.toString(); }
}
