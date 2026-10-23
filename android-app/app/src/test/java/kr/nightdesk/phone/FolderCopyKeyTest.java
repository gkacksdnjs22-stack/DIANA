package kr.nightdesk.phone;

import org.junit.Test;
import static org.junit.Assert.*;

public class FolderCopyKeyTest {
    private static final String FOLDER = "content://com.android.externalstorage.documents/tree/primary%3ADownload%2Fdiana";
    private static final String JOB = "11111111-2222-4333-8444-555555555555";
    private static final String ARTIFACT = "a".repeat(64);
    private static final String HASH = "b".repeat(64);

    @Test public void changingFolderNeverReusesThePreviouslyCompletedCopy() {
        String first = FolderCopyKey.of(FOLDER, JOB, ARTIFACT, HASH, 123);
        assertEquals(first, FolderCopyKey.of(FOLDER, JOB, ARTIFACT, HASH, 123));
        assertNotEquals(first, FolderCopyKey.of(FOLDER + "-new", JOB, ARTIFACT, HASH, 123));
        assertNotEquals(first, FolderCopyKey.of(FOLDER.replace("externalstorage", "anotherprovider"), JOB, ARTIFACT, HASH, 123));
    }
    @Test public void changedManifestOrJobNeedsItsOwnCompletedCopy() {
        String first = FolderCopyKey.of(FOLDER, JOB, ARTIFACT, HASH, 123);
        assertNotEquals(first, FolderCopyKey.of(FOLDER, JOB + "-new", ARTIFACT, HASH, 123));
        assertNotEquals(first, FolderCopyKey.of(FOLDER, JOB, "c".repeat(64), HASH, 123));
        assertNotEquals(first, FolderCopyKey.of(FOLDER, JOB, ARTIFACT, "c".repeat(64), 123));
        assertNotEquals(first, FolderCopyKey.of(FOLDER, JOB, ARTIFACT, HASH, 124));
    }
    @Test public void destinationIsNotStoredInThePreferenceKeyAndPartsCannotCollide() {
        assertTrue(FolderCopyKey.of(FOLDER, JOB, ARTIFACT, HASH, 0).matches("exported_v2_[a-f0-9]{64}"));
        assertNotEquals(FolderCopyKey.of("ab", "c", ARTIFACT, HASH, 0), FolderCopyKey.of("a", "bc", ARTIFACT, HASH, 0));
    }
    @Test public void refusesUnboundOrInvalidCopyRecords() {
        for (String[] parts : new String[][]{{null, JOB, ARTIFACT, HASH}, {"", JOB, ARTIFACT, HASH},
                {FOLDER, null, ARTIFACT, HASH}, {FOLDER, JOB, "", HASH}, {FOLDER, JOB, ARTIFACT, null}}) {
            try { FolderCopyKey.of(parts[0], parts[1], parts[2], parts[3], 0); fail("accepted an unbound copy record"); }
            catch (IllegalArgumentException expected) { }
        }
        try { FolderCopyKey.of(FOLDER, JOB, ARTIFACT, HASH, -1); fail("accepted a negative length"); }
        catch (IllegalArgumentException expected) { }
    }
}
