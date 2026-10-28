package kr.nightdesk.phone;

/** Local composer draft only. This type has no network or execution method. */
final class PcChatDraft {
    static final int MAX_LENGTH=2000;
    private PcChatDraft() { }
    static String text(String value)throws PcRequests.RequestException {
        String result=PcRequests.normalizeEdit(value);
        if(result.isEmpty())throw new PcRequests.RequestException("보관할 요청을 입력해 주세요.");
        return result;
    }
    static String preferenceKey(String baseUrl,String phoneId)throws PcRequests.RequestException {
        return "pc_chat_draft_v1_"+PcRequests.fingerprint(baseUrl,phoneId);
    }
}
