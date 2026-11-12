package kr.nightdesk.phone;

import android.content.Context;
import android.os.Build;
import org.json.JSONObject;
import java.io.IOException;

/** Durable high-entropy claim, distinct from a connected phone session. */
final class PhonePairing {
    static JSONObject connect(Context context,String base,String code,Runnable waiting)throws Exception {
        SecureStore store=new SecureStore(context,"encrypted_pending_pair");
        JSONObject pending;
        synchronized(SecureStore.LOCK){pending=store.load();
        if(pending==null||!pending.has("identity")||!base.equals(pending.optString("base"))||!code.equals(pending.optString("code"))) {
            pending=new JSONObject().put("base",base).put("code",code).put("requestId",PairedLink.requestId()).put("pairKey",PairedLink.pairKey()).put("deviceName",Build.MANUFACTURER+" "+Build.MODEL);
            pending.put("identity",E2ee.identity());store.save(pending);
        }
        }
        long deadline=System.currentTimeMillis()+300000;
        while(!Thread.currentThread().isInterrupted()&&System.currentTimeMillis()<deadline) {
            JSONObject result;
            JSONObject wire=new JSONObject().put("code",code).put("requestId",pending.getString("requestId")).put("pairKey",pending.getString("pairKey")).put("deviceName",pending.getString("deviceName")).put("publicKey",pending.getJSONObject("identity").getString("publicKey"));
            try { result=Api.request(base,"/api/phone/pair",null,wire); }
            catch(Api.ApiException e) { if(e.status==400||e.status==401||e.status==403)store.clearPending(pending.getString("requestId"));throw e; }
            if(!result.optBoolean("pending")){result.put("fileKey",E2ee.accept(pending.getJSONObject("identity"),result.getJSONObject("e2ee"),pending.getString("requestId"))).put("localRequestId",pending.getString("requestId"));return result;}
            waiting.run();
            Thread.sleep(10000);
        }
        throw new IOException("PC 승인을 확인하지 못했습니다. 같은 코드로 다시 시도하거나 새 코드를 받으세요.");
    }
    static void commit(Context context,JSONObject response,JSONObject session)throws Exception{
        synchronized(SecureStore.LOCK){SecureStore pendingStore=new SecureStore(context,"encrypted_pending_pair"),sessionStore=new SecureStore(context);JSONObject pending=pendingStore.load();
            if(pending==null||!response.getString("localRequestId").equals(pending.optString("requestId"))){JSONObject existing=sessionStore.load();if(existing!=null&&existing.optString("phoneToken").equals(session.getString("phoneToken")))return;throw new IOException("연결 요청이 바뀌었습니다. 다시 확인하세요.");}
            sessionStore.save(session);pendingStore.clear();
        }
    }
}
