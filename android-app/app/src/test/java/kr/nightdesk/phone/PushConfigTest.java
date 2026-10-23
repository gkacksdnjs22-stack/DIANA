package kr.nightdesk.phone;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.HashMap;
import java.util.Map;

public class PushConfigTest {
    private static final String APP = "1:123456789012:android:abcdef0123456789";
    private static final String KEY = "AIza00000000000000000000000000000000000";
    private static final String PROJECT = "diana-test";
    private static final String SENDER = "123456789012";

    @Test public void acceptsOnlyCompleteAndroidConfigurationAndKeepsPublicIdentifiers() {
        PushConfig config = PushConfig.of(true, APP, KEY, PROJECT, SENDER);
        assertTrue(config.enabled);
        assertEquals(APP, config.applicationId);
        assertEquals(KEY, config.apiKey);
        assertEquals(PROJECT, config.projectId);
        assertEquals(SENDER, config.senderId);
    }
    @Test public void disabledConfigurationDoesNotKeepAnyOldIdentifiers() {
        PushConfig disabled = PushConfig.of(false, APP, KEY, PROJECT, SENDER);
        assertFalse(disabled.enabled);
        assertEquals("", disabled.applicationId);
        assertEquals("", disabled.apiKey);
        assertEquals("", disabled.projectId);
        assertEquals("", disabled.senderId);
        assertFalse(PushConfig.of(false, null, null, null, null).enabled);
    }
    @Test public void rejectsMissingMalformedOrMismatchedEnabledConfiguration() {
        for (String[] fields : new String[][]{
            {null,KEY,PROJECT,SENDER}, {APP,null,PROJECT,SENDER}, {APP,KEY,null,SENDER}, {APP,KEY,PROJECT,null},
            {"",KEY,PROJECT,SENDER}, {APP,"",PROJECT,SENDER}, {APP,KEY,"",SENDER}, {APP,KEY,PROJECT,""},
            {APP,KEY,PROJECT,"234567890123"}, {"1:123456789012:web:abcdef",KEY,PROJECT,SENDER},
            {APP,KEY,PROJECT + "\n",SENDER}, {APP,KEY + "\n",PROJECT,SENDER},
            {APP,KEY,"../diana",SENDER}, {APP,KEY,"DIANA-test",SENDER}, {APP,KEY,PROJECT,"123\n"},
            {" " + APP,KEY,PROJECT,SENDER}, {APP,KEY,"a".repeat(31),SENDER},
            {"1:0:android:abcdef",KEY,PROJECT,"0"}, {"1:" + SENDER + ":android:nothex",KEY,PROJECT,SENDER}
        }) {
            try { PushConfig.of(true, fields[0],fields[1],fields[2],fields[3]); fail("accepted invalid push configuration"); }
            catch (IllegalArgumentException expected) { }
        }
    }
    @Test public void acceptsOnlyTheFileReadyHintWithoutInterpretingOtherPayloadValues() {
        assertFalse(PushConfig.filesReady(null));
        assertFalse(PushConfig.filesReady(Map.of()));
        for (String type : new String[]{"", "FILES_READY", "files_ready ", "download", "execute", "upload", "files_ready\n"}) assertFalse(PushConfig.filesReady(Map.of("type", type)));
        Map<String,String> hint = new HashMap<>(); hint.put("type", "files_ready");
        assertTrue(PushConfig.filesReady(hint));
        hint.put("url", "file:///untrusted"); hint.put("command", "unused"); hint.put("filename", "../../unused");
        assertTrue(PushConfig.filesReady(hint));
    }
    @Test public void callbacksRemainBoundToTheExactServerPhoneAndCredential() {
        assertTrue(PushConfig.sameSession("https://diana.example", "phone-one", "token-one", "https://diana.example", "phone-one", "token-one"));
        assertFalse(PushConfig.sameSession("https://diana.example", "phone-one", "token-one", null, null, null));
        assertFalse(PushConfig.sameSession("https://diana.example", "phone-one", "token-one", "https://other.example", "phone-one", "token-one"));
        assertFalse(PushConfig.sameSession("https://diana.example", "phone-one", "token-one", "https://diana.example", "phone-two", "token-one"));
        assertFalse(PushConfig.sameSession("https://diana.example", "phone-one", "token-one", "https://diana.example", "phone-one", "token-two"));
        assertFalse(PushConfig.sameSession("", "", "", "", "", ""));
        assertFalse(PushConfig.sameSession(null, "phone-one", "token-one", null, "phone-one", "token-one"));
    }
    @Test public void publicCacheFingerprintIsStableAndChangesForEveryPartOfThePrivateBinding() {
        String original = PushConfig.sessionFingerprint("https://diana.example", "phone-one", "token-one");
        assertTrue(original.matches("[a-f0-9]{64}"));
        assertEquals(original, PushConfig.sessionFingerprint("https://diana.example", "phone-one", "token-one"));
        assertNotEquals(original, PushConfig.sessionFingerprint("https://other.example", "phone-one", "token-one"));
        assertNotEquals(original, PushConfig.sessionFingerprint("https://diana.example", "phone-two", "token-one"));
        assertNotEquals(original, PushConfig.sessionFingerprint("https://diana.example", "phone-one", "token-two"));
        assertNotEquals(PushConfig.sessionFingerprint("ab", "c", "d"), PushConfig.sessionFingerprint("a", "bc", "d"));
        assertFalse(original.contains("token-one"));
        try { PushConfig.sessionFingerprint(null, "phone-one", "token-one"); fail(); } catch (IllegalArgumentException expected) { }
    }
}
