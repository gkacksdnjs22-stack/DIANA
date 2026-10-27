package kr.nightdesk.phone;

/** Fixed public text only; no core errors, document titles, quotes or paths. */
final class FinanceState {
    static String label(String state) {
        switch(state) {
            case "QUEUED": return "PC 처리 대기";
            case "PROCESSING": return "PC 검토 중";
            case "PC_REVIEW_REQUIRED": return "PC에서 확인·승인 필요";
            case "WAITING_FOR_INFORMATION": return "PC에서 추가 자료 확인 필요";
            case "LOCAL_SAVING": return "PC에 저장 중 · 취소 불가";
            case "LOCAL_SAVE_COMPLETED": return "PC 저장·재읽기 확인";
            case "REVIEW_COMPLETED": return "PC 검토 결과 확인 필요";
            case "CANCELLED": return "취소됨";
            case "BLOCKED": return "PC에서 작업 조건 확인 필요";
            case "FAILED": return "PC에서 실패 상태 확인 필요";
            case "UNCERTAIN": return "PC에서 실제 저장 기록 확인 필요";
            default: return "지원하지 않는 상태";
        }
    }
    static boolean cancellable(String state) { return "QUEUED".equals(state)||"PROCESSING".equals(state)||"PC_REVIEW_REQUIRED".equals(state); }
    static boolean known(String state) { return !"지원하지 않는 상태".equals(label(state)); }
    static String action(String action) { switch(action){case "checklist_review":return "검토";case "patch":return "보완";case "convert":return "변환";default:return "지원하지 않는 작업";} }
}
