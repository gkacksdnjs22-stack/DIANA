package kr.nightdesk.phone;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.Map;

public class PcRequestsTest {
    private static final String ID = "11111111-1111-4111-8111-111111111111";
    private static final String BINDING;
    static {
        try { BINDING = PcRequests.fingerprint("https://diana.example", "test-phone"); }
        catch (Exception unexpected) { throw new AssertionError(unexpected); }
    }
    @Test public void immutableRetryBodyKeepsItsOriginalIdAndScope() throws Exception {
        PcRequests.Pending pending = new PcRequests.Pending(ID, BINDING, "분기 보고서", "수치를 원문 근거로 정리해 줘");
        Map<String,Object> initial = pending.wireFields();
        assertEquals(initial, pending.wireFields());
        assertEquals(ID, initial.get("requestId"));
        assertEquals("분기 보고서", initial.get("query"));
        assertEquals("download", initial.get("delivery"));
        assertEquals(false, initial.get("autoSend"));
        assertEquals("수치를 원문 근거로 정리해 줘", initial.get("editInstruction"));
        assertEquals(5, initial.size());
        assertFalse(initial.containsKey("phoneToken"));
        assertFalse(initial.containsKey("recipient"));
        assertFalse(initial.containsKey("command"));
        try { initial.put("query", "다른 요청"); fail("retry body was mutable"); }
        catch (UnsupportedOperationException expected) { }
    }
    @Test public void changedFormDoesNotMatchTheAmbiguousOriginalRequest() throws Exception {
        PcRequests.Pending pending = new PcRequests.Pending(ID, BINDING, "보고서", "정리해 줘");
        assertTrue(pending.matches(" 보고서 ", "정리해 줘\n"));
        assertFalse(pending.matches("다른 보고서", "정리해 줘"));
        assertFalse(pending.matches("보고서", "다른 수정"));
        assertEquals("보고서", pending.wireFields().get("query"));
    }
    @Test public void retryBindingChangesForServerOrPhoneWithoutPersistingTheirValues() throws Exception {
        assertEquals(BINDING, PcRequests.fingerprint("https://diana.example", "test-phone"));
        assertTrue(BINDING.matches("[a-f0-9]{64}"));
        assertFalse(BINDING.contains("test-phone"));
        assertNotEquals(BINDING, PcRequests.fingerprint("https://other.example", "test-phone"));
        assertNotEquals(BINDING, PcRequests.fingerprint("https://diana.example", "other-phone"));
        assertNotEquals(PcRequests.fingerprint("ab", "c"), PcRequests.fingerprint("a", "bc"));
    }
    @Test public void queryAndOptionalEditUseCanonicalServerCompatibleWhitespace() throws Exception {
        assertEquals("분기\n보고서", PcRequests.normalizeQuery("\ufeff\u00a0 분기\n보고서 \u3000"));
        assertEquals("", PcRequests.normalizeEdit(null));
        assertEquals("", PcRequests.normalizeEdit(" \n\t\u00a0"));
        assertEquals("제목\n본문\t정리", PcRequests.normalizeEdit(" 제목\n본문\t정리 "));
        for (String value : new String[]{null, "", "\ufeff\u00a0\t\n"}) {
            try { PcRequests.normalizeQuery(value); fail("accepted blank query"); }
            catch (PcRequests.RequestException expected) { }
        }
    }
    @Test public void enforcesUtf16LengthsAndRejectsMalformedOrHiddenControlCharacters() throws Exception {
        assertEquals(1000, PcRequests.normalizeQuery("가".repeat(1000)).length());
        assertEquals(2000, PcRequests.normalizeEdit("📄".repeat(1000)).length());
        for (String value : new String[]{"x".repeat(1001), "x\u0000y", "x\u001fy", "x\u007fy", "x\ud800", "x\udc00"}) {
            try { PcRequests.normalizeQuery(value); fail("accepted invalid query"); }
            catch (PcRequests.RequestException expected) { }
        }
        try { PcRequests.normalizeEdit("x".repeat(2001)); fail("accepted overlong edit"); }
        catch (PcRequests.RequestException expected) { }
    }
    @Test public void invalidPersistedRetryInformationIsNeverRewrittenAsANewRequest() throws Exception {
        for (String[] value : new String[][]{{"invalid", BINDING, "보고서", ""}, {ID, "", "보고서", ""},
            {ID, BINDING, " 보고서 ", ""}, {ID, BINDING, "보고서", " 정리 "}}) {
            try { new PcRequests.Pending(value[0], value[1], value[2], value[3]); fail("accepted invalid retry snapshot"); }
            catch (PcRequests.RequestException expected) { }
        }
    }
}
