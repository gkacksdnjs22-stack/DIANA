package kr.nightdesk.phone;
import org.junit.Test;
import static org.junit.Assert.*;
public class FinanceStateTest {
    @Test public void cancellationStopsAtSaveGate(){assertTrue(FinanceState.cancellable("PC_REVIEW_REQUIRED"));for(String s:new String[]{"LOCAL_SAVING","LOCAL_SAVE_COMPLETED","UNCERTAIN","FAILED","unknown"})assertFalse(FinanceState.cancellable(s));}
    @Test public void savingDoesNotClaimReviewComplete(){assertEquals("PC 저장·재읽기 확인",FinanceState.label("LOCAL_SAVE_COMPLETED"));assertFalse(FinanceState.label("LOCAL_SAVE_COMPLETED").contains("검토 완료"));assertFalse(FinanceState.known("approve"));}
}
