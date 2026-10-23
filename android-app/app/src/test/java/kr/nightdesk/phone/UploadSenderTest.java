package kr.nightdesk.phone;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

public class UploadSenderTest {
    @Test public void rejectsUnsafeWindowsAndUnicodeNames() {
        for (String name : new String[]{"", ".secret", "../report.txt", "a/b.txt", "a\\b.txt", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b", "a\n\nb", "a\u007fb", "a\u0085b", "a\u202eb.txt", "a\u2066b.txt", "a\u200fb.txt", "a\u061cb.txt", "CON", "con.txt", "PRN.md", "AUX", "NUL", "COM1.txt", "com9", "LPT1", "lpt9.pdf", "COM¹.txt", "COM²", "com³.md", "LPT¹", "lpt².pdf", "LPT³.txt", "CLOCK$", "clock$.txt", "CONIN$.txt", "conout$", "name.", "name ", "x".repeat(181), "a\ud800.txt", "a\udc00.txt"}) {
            try { UploadSender.validateFilename(name); fail("accepted unsafe filename"); } catch (IOException expected) { }
        }
        try { UploadSender.validateFilename(null); fail(); } catch (IOException expected) { }
    }
    @Test public void acceptsDocumentNamesAndUsesPercentEncodedUtf8Header() throws Exception {
        UploadSender.validateFilename("보고서 (1).pdf");
        UploadSender.validateFilename("CONTEST.txt");
        UploadSender.validateFilename("COM10.txt");
        UploadSender.validateFilename("x".repeat(180));
        UploadSender.validateFilename("📄 자료.txt");
        assertEquals("%EB%B3%B4%EA%B3%A0%EC%84%9C%20%281%29%2B.txt", UploadSender.encodedFilename("보고서 (1)+.txt"));
    }
    @Test public void copiesAndHashesTheSameBytes() throws Exception {
        byte[] original = "abc".getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        UploadSender.Copied copied = UploadSender.copyAndHash(new ByteArrayInputStream(original), output);
        assertArrayEquals(original, output.toByteArray());
        assertEquals(3, copied.bytes);
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", copied.sha256);
        assertEquals(copied.sha256, UploadSender.copyAndHash(new ByteArrayInputStream(original), null).sha256);
    }
    @Test public void rejectsEmptyFile() throws Exception {
        try { UploadSender.copyAndHash(new ByteArrayInputStream(new byte[0]), new ByteArrayOutputStream()); fail(); }
        catch (UploadSender.UploadException expected) { assertTrue(expected.getMessage().contains("빈 파일")); }
    }
    @Test public void unknownLengthStreamsCannotWritePastLimit() throws Exception {
        InputStream unknown = new InputStream() {
            long left = UploadSender.MAX_BYTES + 1;
            @Override public int read() { return left-- > 0 ? 65 : -1; }
            @Override public int read(byte[] bytes, int offset, int length) {
                if (left <= 0) return -1;
                int count = (int)Math.min(left, length); java.util.Arrays.fill(bytes, offset, offset + count, (byte)65); left -= count; return count;
            }
        };
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try { UploadSender.copyAndHash(unknown, output); fail(); }
        catch (UploadSender.UploadException expected) { assertTrue(output.size() <= UploadSender.MAX_BYTES); }
    }
    @Test public void allowsExactlyTenMegabytes() throws Exception {
        UploadSender.Copied copied = UploadSender.copyAndHash(new ByteArrayInputStream(new byte[(int)UploadSender.MAX_BYTES]), null);
        assertEquals(UploadSender.MAX_BYTES, copied.bytes);
        assertTrue(copied.sha256.matches("[a-f0-9]{64}"));
    }
    @Test public void interruptedPreparationStopsBeforeWriting() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        Thread.currentThread().interrupt();
        try { UploadSender.copyAndHash(new ByteArrayInputStream(new byte[]{1}), output); fail(); }
        catch (java.io.InterruptedIOException expected) { assertEquals(0, output.size()); }
        finally { Thread.interrupted(); }
    }
}
