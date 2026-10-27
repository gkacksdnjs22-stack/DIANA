package kr.nightdesk.phone;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Android JSON implementation, no network and no real financial documents. */
@RunWith(AndroidJUnit4.class)
public class FinanceContractTest {
    @Test public void unknownDocumentAndApprovalFieldsAreRejected()throws Exception{
        JSONObject p=new JSONObject().put("id","public-task").put("label","가상 검토");
        FinanceRequests.keys(p,"id","label");
        for(String field:new String[]{"expected_body","unified_diff","plan_hash","approval_id","confirmed","outputFile"}){
            JSONObject leaked=new JSONObject(p.toString()).put(field,"PRIVATE_CANARY");
            try{FinanceRequests.keys(leaked,"id","label");fail("unknown field accepted");}catch(java.io.IOException expected){}
        }
    }
    @Test public void unsupportedServerAndExpiredAuthAreDistinct(){
        assertTrue(FinanceRequests.error(new Api.ApiException(404)).contains("지원하지"));
        assertTrue(FinanceRequests.error(new Api.ApiException(401)).contains("인증"));
        assertFalse(FinanceRequests.error(new java.io.IOException("PRIVATE_CANARY")).contains("PRIVATE_CANARY"));
    }
}
