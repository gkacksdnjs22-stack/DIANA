package kr.nightdesk.phone;

import org.junit.Test;
import static org.junit.Assert.*;

public class PcChatDraftTest {
    @Test public void koreanMultilineAndEmojiArePreserved()throws Exception{
        assertEquals("보고서 검토해 줘\n근거도 확인해 줘 🔎",PcChatDraft.text("  보고서 검토해 줘\n근거도 확인해 줘 🔎  "));
    }
    @Test public void emptyOverlongAndMalformedTextAreRejected()throws Exception{
        for(String input:new String[]{" \u3000\n","x".repeat(2001),"문서\u0000검토","\uD800","\uDC00"}){
            try{PcChatDraft.text(input);fail("Invalid draft accepted");}catch(PcRequests.RequestException expected){ }
        }
        assertEquals(2000,PcChatDraft.text("가".repeat(2000)).length());
    }
    @Test public void draftsAreSeparatedByServerAndPhoneConnection()throws Exception{
        String first=PcChatDraft.preferenceKey("https://one.example","phone-one");
        assertEquals(first,PcChatDraft.preferenceKey("https://one.example","phone-one"));
        assertNotEquals(first,PcChatDraft.preferenceKey("https://two.example","phone-one"));
        assertNotEquals(first,PcChatDraft.preferenceKey("https://one.example","phone-two"));
        assertFalse(first.contains("one.example"));assertFalse(first.contains("phone-one"));
    }
}
