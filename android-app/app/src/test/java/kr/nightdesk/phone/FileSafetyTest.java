package kr.nightdesk.phone;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

public class FileSafetyTest {
    static final String JOB = "914558f4-c849-4edc-9a2a-07f938e33c2b";
    static final String ID = "a".repeat(64);
    @Test public void rejectsTraversalAndUnsafeNames() {
        for (String name : new String[]{"../report.pdf", "a/b.pptx", "a\\b.pdf", ".", "..", "a\n.pdf", "a:report.pdf"}) {
            try { FileSafety.validateName(name); fail(name); } catch (IOException expected) { }
        }
    }
    @Test public void preservesSafeKoreanNameAndBindsJobDirectory() throws Exception {
        File root = new File(System.getProperty("java.io.tmpdir"), "nightdesk-unit-test");
        File output = FileSafety.artifact(root, JOB, ID, "발표자료.pptx");
        assertTrue(output.getCanonicalPath().startsWith(new File(root, "results/" + JOB).getCanonicalPath() + File.separator));
        assertEquals("aaaaaaaaaaaa_발표자료.pptx", output.getName());
    }
    @Test public void rejectsInvalidIdentifiers() throws Exception {
        try { FileSafety.artifact(new File("."), "../job", ID, "a.pdf"); fail(); } catch (IOException expected) { }
        try { FileSafety.artifact(new File("."), JOB, "../artifact", "a.pdf"); fail(); } catch (IOException expected) { }
    }
    @Test public void hashesTheActualBytes() throws Exception {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", FileSafety.digest(new ByteArrayInputStream("abc".getBytes(StandardCharsets.UTF_8))));
    }
}
