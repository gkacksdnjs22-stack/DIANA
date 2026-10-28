package kr.nightdesk.phone;

import android.content.Context;
import android.view.View;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import static org.junit.Assert.*;

/** Regression: repeated heartbeats previously replaced the scroll view and
 * briefly displayed the top of the page before restoring its old position. */
@RunWith(AndroidJUnit4.class)
public final class FinanceUiRefreshTest {
    private static final String TASK="11111111-2222-4333-8444-555555555555";
    private static final String JOB="66666666-7777-4888-8999-aaaaaaaaaaaa";
    private ActivityScenario<MainActivity> scenario;
    private JSONObject session;

    @Before public void openFinancialScreen()throws Exception{
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        context.getSharedPreferences("MainActivity",0).edit().clear().putBoolean("auto_receive",false).commit();
        context.getSharedPreferences("finance_request_v1",0).edit().clear().commit();
        session=new JSONObject().put("baseUrl","https://diana-ui.invalid")
            .put("phoneId","bbbbbbbb-cccc-4ddd-8eee-ffffffffffff")
            .put("phoneToken","ui-refresh-test-only-no-real-credentials-00000000")
            .put("firebase",new JSONObject().put("enabled",false));
        new SecureStore(context).save(session);
        scenario=ActivityScenario.launch(MainActivity.class);
        scenario.onActivity(activity->{try{
            field("selectedTab").setInt(activity,2);
            method("draw").invoke(activity);
            apply(activity,data("2026-10-28T02:00:00Z","QUEUED",false));
        }catch(Exception error){throw new AssertionError(error);}});
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
    }
    @After public void close(){if(scenario!=null)scenario.close();}
    private static Field field(String name)throws Exception{Field field=MainActivity.class.getDeclaredField(name);field.setAccessible(true);return field;}
    private static Method method(String name,Class<?>... types)throws Exception{Method method=MainActivity.class.getDeclaredMethod(name,types);method.setAccessible(true);return method;}
    private void apply(MainActivity activity,JSONObject data)throws Exception{method("applyFinanceStatuses",JSONObject.class,JSONObject.class).invoke(activity,session,data);}
    private static JSONObject task(String id,String label)throws Exception{return new JSONObject().put("id",id).put("label",label).put("actions",new JSONArray().put("patch")).put("formats",new JSONArray().put("txt"));}
    private static JSONObject job(String id,String state,boolean saved)throws Exception{return new JSONObject().put("id",id).put("taskId",TASK).put("action","patch").put("format","txt").put("state",state).put("code","PC_CHECK_REQUIRED").put("saved",saved).put("reviewComplete",false).put("revision",saved?2:1).put("createdAt","2026-10-28T01:00:00Z").put("updatedAt","2026-10-28T02:00:00Z").put("expiresAt","2026-10-29T01:00:00Z");}
    private static JSONObject data(String heartbeat,String state,boolean saved)throws Exception{
        JSONArray jobs=new JSONArray().put(job(JOB,state,saved));
        for(int i=0;i<10;i++)jobs.put(job(String.format(java.util.Locale.ROOT,"%08d-7777-4888-8999-aaaaaaaaaaaa",i+1),"REVIEW_COMPLETED",false));
        return new JSONObject().put("catalog",new JSONObject().put("supported",true).put("online",true).put("updatedAt",heartbeat).put("tasks",new JSONArray().put(task(TASK,"가상 검토")))).put("jobs",jobs);
    }
    @Test public void heartbeatAndJobUpdatesKeepTheSameScrollViewAndRows(){
        scenario.onActivity(activity->{try{
            ScrollView scroll=(ScrollView)field("scroll").get(activity);View content=scroll.getChildAt(0);
            View task=content.findViewWithTag("finance_task_"+TASK),job=content.findViewWithTag("finance_job_"+JOB);
            assertNotNull(task);assertNotNull(job);scroll.scrollTo(0,400);int position=scroll.getScrollY();assertTrue(position>0);
            for(int i=1;i<=25;i++)apply(activity,data(String.format(java.util.Locale.ROOT,"2026-10-28T02:%02d:00Z",i),"QUEUED",false));
            assertSame(scroll,field("scroll").get(activity));assertSame(content,scroll.getChildAt(0));assertSame(task,content.findViewWithTag("finance_task_"+TASK));assertSame(job,content.findViewWithTag("finance_job_"+JOB));assertEquals(position,scroll.getScrollY());
            apply(activity,data("2026-10-28T02:26:00Z","LOCAL_SAVE_COMPLETED",true));
            assertSame(job,content.findViewWithTag("finance_job_"+JOB));assertEquals(View.GONE,job.findViewWithTag("finance_cancel").getVisibility());
            assertTrue(((TextView)((android.view.ViewGroup)job).getChildAt(1)).getText().toString().contains("저장"));
            assertTrue(((TextView)((android.view.ViewGroup)job).getChildAt(3)).getText().toString().contains("PC 저장 확인: 완료"));
            assertEquals(position,scroll.getScrollY());
        }catch(Exception error){throw new AssertionError(error);}});
    }
    @Test public void unifiedRequestMenuHasNoSeparateFinanceEntry(){
        scenario.onActivity(activity->{try{
            View anchor=activity.findViewById(android.R.id.content).findViewWithTag("menu_toggle");
            assertNotNull(anchor);method("showMenu",View.class).invoke(activity,anchor);
            android.widget.PopupWindow popup=(android.widget.PopupWindow)field("menuPopup").get(activity);
            assertNotNull(popup);assertTrue(popup.isShowing());
            View menu=popup.getContentView();
            for(String tag:new String[]{"menu_home","menu_files","menu_pc_sync","menu_recent","menu_settings"})assertNotNull(menu.findViewWithTag(tag));
            assertNull(menu.findViewWithTag("menu_finance"));
            popup.dismiss();
        }catch(Exception error){throw new AssertionError(error);}});
    }
    @Test public void conversationDraftSurvivesRecreationWithoutCreatingARequest()throws Exception{
        String request="가상 검토서를 실사 자료와 지침으로 검토해 줘 🔎";
        scenario.onActivity(activity->{try{
            View content=activity.findViewById(android.R.id.content);
            android.widget.EditText input=content.findViewWithTag("pc_chat_input");
            assertNotNull(input);assertFalse(content.findViewWithTag("pc_chat_send").isEnabled());
            input.setText(request);content.findViewWithTag("pc_chat_keep").performClick();
            assertEquals(request,activity.getPreferences(0).getString(PcChatDraft.preferenceKey(session.getString("baseUrl"),session.getString("phoneId")),""));
            assertNull(PcRequests.load(activity));assertNull(FinanceRequests.pending(activity));
            assertTrue(((TextView)content.findViewWithTag("pc_chat_notice")).getText().toString().contains("PC에 전송하거나 작업을 실행하지 않았어요"));
            for(int i=0;i<5;i++)apply(activity,data("2026-10-28T03:00:00Z","QUEUED",false));
            assertSame(input,activity.findViewById(android.R.id.content).findViewWithTag("pc_chat_input"));
        }catch(Exception error){throw new AssertionError(error);}});
        scenario.recreate();
        scenario.onActivity(activity->{try{
            android.widget.EditText input=activity.findViewById(android.R.id.content).findViewWithTag("pc_chat_input");
            assertNotNull(input);assertEquals(request,input.getText().toString());
            assertNull(PcRequests.load(activity));assertNull(FinanceRequests.pending(activity));
        }catch(Exception error){throw new AssertionError(error);}});
    }
    @Test public void catalogChangesReuseExistingRowsAndRemoveOnlyMissingItems(){
        scenario.onActivity(activity->{try{
            ScrollView scroll=(ScrollView)field("scroll").get(activity);View content=scroll.getChildAt(0);View original=content.findViewWithTag("finance_task_"+TASK);
            String added="cccccccc-dddd-4eee-8fff-111111111111";
            JSONObject updated=data("2026-10-28T03:00:00Z","QUEUED",false);
            updated.getJSONObject("catalog").put("tasks",new JSONArray().put(task(added,"새 작업")).put(task(TASK,"이름을 바꾼 검토")));
            apply(activity,updated);assertSame(original,content.findViewWithTag("finance_task_"+TASK));assertEquals("이름을 바꾼 검토",((TextView)original).getText().toString());assertNotNull(content.findViewWithTag("finance_task_"+added));
            updated.getJSONObject("catalog").put("tasks",new JSONArray().put(task(TASK,"가상 검토")));updated.put("jobs",new JSONArray());apply(activity,updated);
            assertNull(content.findViewWithTag("finance_task_"+added));assertNull(content.findViewWithTag("finance_job_"+JOB));assertSame(scroll,field("scroll").get(activity));
        }catch(Exception error){throw new AssertionError(error);}});
    }
    @Test public void unrelatedFileSyncPreferencesDoNotReplaceTheFinancialScreen(){
        final View[] before=new View[2];
        scenario.onActivity(activity->{try{
            before[0]=(View)field("scroll").get(activity);before[1]=((ScrollView)before[0]).getChildAt(0);
            activity.getSharedPreferences("MainActivity",0).edit().putString("last_sync","2026-10-28T04:00:00Z").commit();
            activity.getSharedPreferences("settings",0).edit().putString("push_status","test-only-refresh").commit();
        }catch(Exception error){throw new AssertionError(error);}});
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        scenario.onActivity(activity->{try{assertSame(before[0],field("scroll").get(activity));assertSame(before[1],((ScrollView)before[0]).getChildAt(0));}catch(Exception error){throw new AssertionError(error);}});
    }
}
