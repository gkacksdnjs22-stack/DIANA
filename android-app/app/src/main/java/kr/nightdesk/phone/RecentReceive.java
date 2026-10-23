package kr.nightdesk.phone;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;

/** One latest receive batch; cached files, failed transfers and receipt retries add nothing. */
final class RecentReceive {
    static final class Event {
        final String filename, receivedAt;
        final int count;
        Event(String filename, int count, String receivedAt) throws IOException {
            FileSafety.validateName(filename);
            if (count < 1 || count > 1500) throw new IOException("최근 수신 파일 수가 올바르지 않습니다.");
            try { Instant.parse(receivedAt); }
            catch (Exception error) { throw new IOException("최근 수신 시각이 올바르지 않습니다."); }
            this.filename = filename; this.count = count; this.receivedAt = receivedAt;
        }
    }
    static final class Batch {
        private String firstFilename;
        private int count;

        // true is returned only by a newly completed, hash-verified download.
        Event afterTransfer(boolean newlyVerified, String filename, String receivedAt) throws IOException {
            if (!newlyVerified) return null;
            Event event = new Event(count == 0 ? filename : firstFilename, count + 1, receivedAt);
            if (count == 0) firstFilename = filename;
            count = event.count;
            return event;
        }
        int count() { return count; }
    }
    static String binding(String baseUrl, String phoneId) throws IOException {
        if (baseUrl == null || baseUrl.isEmpty() || phoneId == null || phoneId.isEmpty()) throw new IOException("휴대폰 연결을 확인해 주세요.");
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
}
