package kr.nightdesk.phone;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Binds a cached folder copy to its exact destination and file manifest. */
final class FolderCopyKey {
    static String of(String folderUri, String jobId, String artifactId, String sha256, long bytes) {
        if (folderUri == null || folderUri.isEmpty() || jobId == null || jobId.isEmpty() ||
            artifactId == null || artifactId.isEmpty() || sha256 == null || sha256.isEmpty() || bytes < 0) {
            throw new IllegalArgumentException("저장 폴더 또는 파일 정보가 올바르지 않습니다.");
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (String part : new String[]{folderUri, jobId, artifactId, sha256, Long.toString(bytes)}) {
                byte[] value = part.getBytes(StandardCharsets.UTF_8);
                digest.update(new byte[]{(byte)(value.length >>> 24), (byte)(value.length >>> 16), (byte)(value.length >>> 8), (byte)value.length});
                digest.update(value);
            }
            return "exported_v2_" + FileSafety.hex(digest.digest());
        } catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
}
