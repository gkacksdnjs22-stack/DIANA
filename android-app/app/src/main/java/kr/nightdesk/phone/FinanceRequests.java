package kr.nightdesk.phone;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.UUID;

/** Separate metadata-only protocol. Never passed to SyncEngine or artifact UI. */
final class FinanceRequests {
    private static final Object LOCK=new Object();
    private static final String PREF="finance_request_v1";
    static void keys(JSONObject o,String... fields) throws Exception {
        HashSet<String> allowed=new HashSet<>(Arrays.asList(fields));
        if(o.length()!=allowed.size())throw new IOException();
        Iterator<String> it=o.keys();while(it.hasNext())if(!allowed.contains(it.next()))throw new IOException();
    }
    private static boolean uuid(String s){return s!=null&&s.matches("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}");}
    private static void task(JSONObject t) throws Exception {
        keys(t,"id","label","actions","formats");
        if(!uuid(t.getString("id"))||!t.getString("label").matches("[\\p{L}\\p{N} ()_-]{1,40}"))throw new IOException();
        choices(t.getJSONArray("actions"),new String[]{"checklist_review","patch","convert"});choices(t.getJSONArray("formats"),new String[]{"md","txt","json"});
    }
    private static void choices(JSONArray a,String[] allowed)throws Exception{
        if(a.length()==0||a.length()>allowed.length)throw new IOException();HashSet<String> seen=new HashSet<>();
        for(int i=0;i<a.length();i++)if(!Arrays.asList(allowed).contains(a.getString(i))||!seen.add(a.getString(i)))throw new IOException();
    }
    private static JSONObject job(JSONObject j)throws Exception{
        keys(j,"id","taskId","action","format","state","code","saved","reviewComplete","revision","createdAt","updatedAt","expiresAt");
        if(!uuid(j.getString("id"))||!uuid(j.getString("taskId"))||!FinanceState.known(j.getString("state"))||
            !Arrays.asList("checklist_review","patch","convert").contains(j.getString("action"))||!Arrays.asList("md","txt","json").contains(j.getString("format"))||
            !j.getString("code").matches("[A-Z_]{1,40}")||j.getLong("revision")<1||!(j.get("saved") instanceof Boolean)||!(j.get("reviewComplete") instanceof Boolean))throw new IOException();
        for(String k:new String[]{"createdAt","updatedAt","expiresAt"})java.time.Instant.parse(j.getString(k));
        if(j.getBoolean("saved")!= "LOCAL_SAVE_COMPLETED".equals(j.getString("state")))throw new IOException();
        return j;
    }
    static JSONObject fetch(JSONObject session)throws Exception{
        JSONObject tasks=Api.request(session,"/api/financial/tasks",null);keys(tasks,"supported","online","tasks","updatedAt");
        if(!tasks.getBoolean("supported"))throw new IOException();JSONArray list=tasks.getJSONArray("tasks");if(list.length()>20)throw new IOException();
        for(int i=0;i<list.length();i++)task(list.getJSONObject(i));
        JSONObject jobs=Api.request(session,"/api/financial/jobs",null);keys(jobs,"jobs");JSONArray items=jobs.getJSONArray("jobs");if(items.length()>50)throw new IOException();for(int i=0;i<items.length();i++)job(items.getJSONObject(i));
        return new JSONObject().put("catalog",tasks).put("jobs",items);
    }
    static JSONObject pending(Context c)throws Exception{String s=c.getSharedPreferences(PREF,0).getString("pending","");return s.isEmpty()?null:new JSONObject(s);}
    static void discard(Context c)throws Exception{synchronized(LOCK){if(!c.getSharedPreferences(PREF,0).edit().remove("pending").commit())throw new IOException();}}
    static JSONObject create(Context c,JSONObject session,String taskId,String action,String format)throws Exception{
        synchronized(LOCK){
            if(!uuid(taskId)||!Arrays.asList("checklist_review","patch","convert").contains(action)||!Arrays.asList("md","txt","json").contains(format))throw new IOException();
            String binding=PcRequests.fingerprint(session.getString("baseUrl"),session.getString("phoneId"));JSONObject p=pending(c);
            if(p==null){p=new JSONObject().put("binding",binding).put("body",new JSONObject().put("requestId",UUID.randomUUID().toString()).put("taskId",taskId).put("action",action).put("format",format));if(!c.getSharedPreferences(PREF,0).edit().putString("pending",p.toString()).commit())throw new IOException();}
            else if(!p.getString("binding").equals(binding)||!taskId.equals(p.getJSONObject("body").getString("taskId"))||!action.equals(p.getJSONObject("body").getString("action"))||!format.equals(p.getJSONObject("body").getString("format")))throw new IOException("접수 확인 중인 요청이 있습니다. 같은 요청을 재시도하거나 대기 기록을 정리해 주세요.");
            return submit(c,session,p);
        }
    }
    static JSONObject retry(Context c,JSONObject session)throws Exception{synchronized(LOCK){JSONObject p=pending(c);if(p==null||!p.getString("binding").equals(PcRequests.fingerprint(session.getString("baseUrl"),session.getString("phoneId"))))throw new IOException();return submit(c,session,p);}}
    private static JSONObject submit(Context c,JSONObject session,JSONObject p)throws Exception{
        keys(p,"binding","body");JSONObject b=p.getJSONObject("body");keys(b,"requestId","taskId","action","format");
        JSONObject r=Api.request(session,"/api/financial/jobs",b);keys(r,"job");JSONObject j=job(r.getJSONObject("job"));
        if(!j.getString("id").equals(b.getString("requestId"))||!j.getString("taskId").equals(b.getString("taskId"))||!j.getString("action").equals(b.getString("action"))||!j.getString("format").equals(b.getString("format")))throw new IOException();
        discard(c);return j;
    }
    static JSONObject cancel(JSONObject session,String id)throws Exception{
        if(!uuid(id))throw new IOException();JSONObject r=Api.request(session,"/api/financial/jobs/"+id+"/cancel",new JSONObject());keys(r,"job");JSONObject j=job(r.getJSONObject("job"));if(!id.equals(j.getString("id")))throw new IOException();return j;
    }
    static String error(Exception e){
        if(e instanceof Api.ApiException){int s=((Api.ApiException)e).status;if(s==401||s==403)return "휴대폰 인증이 만료되었습니다. 다시 연결해 주세요.";if(s==404)return "이 서버는 금융 문서 모드를 지원하지 않거나 작업을 찾을 수 없습니다. 서버 업데이트가 필요합니다.";if(s==409)return "요청 상태가 변경되었습니다. 최근 금융 작업을 확인해 주세요.";}
        return "금융 상태를 확인하지 못했습니다. 연결 또는 상태 지연을 확인하고 같은 요청으로 재시도해 주세요.";
    }
}
