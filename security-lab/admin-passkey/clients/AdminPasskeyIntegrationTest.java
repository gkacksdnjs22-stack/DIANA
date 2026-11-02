package kr.nightdesk.phone;
import android.app.Instrumentation;
import android.content.Intent;
import android.net.Uri;
import android.widget.TextView;
import android.view.View;
import android.view.ViewGroup;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ExecutorService;
import static org.junit.Assert.*;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.matcher.ViewMatchers.withText;
import static androidx.test.espresso.action.ViewActions.click;

@RunWith(AndroidJUnit4.class)
public class AdminPasskeyIntegrationTest {
    private static final String PREFS="diana-lab-passkey-admin-v1";
    private JSONObject fixture(String path,JSONObject body)throws Exception{
        HttpURLConnection c=(HttpURLConnection)new URL("http://localhost:43871/__fixture/"+path).openConnection();c.setConnectTimeout(8000);c.setReadTimeout(8000);c.setRequestMethod("POST");c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");
        try{try(java.io.OutputStream o=c.getOutputStream()){o.write(body.toString().getBytes(StandardCharsets.UTF_8));}assertEquals(200,c.getResponseCode());try(java.io.InputStream in=c.getInputStream();java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream()){byte[] b=new byte[4096];int n;while((n=in.read(b))!=-1)out.write(b,0,n);return new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8));}}finally{c.disconnect();}
    }
    private static String text(View v){StringBuilder b=new StringBuilder();if(v instanceof TextView)b.append(((TextView)v).getText());if(v instanceof ViewGroup)for(int i=0;i<((ViewGroup)v).getChildCount();i++)b.append(text(((ViewGroup)v).getChildAt(i)));return b.toString();}
    private void waitText(ActivityScenario<AdminPasskeyActivity> scenario,String expected)throws Exception{for(int i=0;i<60;i++){AtomicReference<String> t=new AtomicReference<>();scenario.onActivity(a->t.set(text(a.getWindow().getDecorView())));if(t.get().contains(expected))return;Thread.sleep(100);}fail("Expected state missing: "+expected);}
    @Test public void browserPkceReturnEncryptedSessionRestorationAndRevocation()throws Exception{
        Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();android.content.Context context=instrumentation.getTargetContext();context.getSharedPreferences(PREFS,0).edit().clear().commit();
        AtomicReference<String> authorize=new AtomicReference<>();
        Instrumentation.ActivityMonitor monitor=new Instrumentation.ActivityMonitor(){@Override public Instrumentation.ActivityResult onStartActivity(Intent intent){if(Intent.ACTION_VIEW.equals(intent.getAction())&&intent.getData()!=null&&intent.getData().toString().startsWith("http://localhost:43871/authorize?")){authorize.set(intent.getData().toString());return new Instrumentation.ActivityResult(0,null);}return null;}};
        instrumentation.addMonitor(monitor);
        try(ActivityScenario<AdminPasskeyActivity> scenario=ActivityScenario.launch(AdminPasskeyActivity.class)){
            onView(withText("관리자 패스키로 로그인")).perform(click());for(int i=0;i<80&&authorize.get()==null;i++)Thread.sleep(100);assertNotNull("System browser authorization intent",authorize.get());
            String pending=context.getSharedPreferences(PREFS,0).getString("pending","");assertFalse(pending.isEmpty());assertFalse(pending.contains("verifier"));assertFalse(pending.contains("state"));
            scenario.recreate();String callback=fixture("authorize",new JSONObject().put("url",authorize.get())).getString("redirect");
            Intent intent=new Intent(context,AdminPasskeyActivity.class).setAction(Intent.ACTION_VIEW).setData(Uri.parse(callback)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);context.startActivity(intent);
            waitText(scenario,"관리자 인증 완료: owner");String saved=context.getSharedPreferences(PREFS,0).getString("session","");assertFalse(saved.isEmpty());assertFalse(saved.contains("access_token"));assertFalse(saved.contains("Bearer"));
            scenario.recreate();onView(withText("현재 관리자 권한 확인")).perform(click());waitText(scenario,"관리자 인증 확인: owner");
            fixture("revoke",new JSONObject());onView(withText("현재 관리자 권한 확인")).perform(click());waitText(scenario,"인증 거부·취소 또는 연결 실패");
            assertEquals("General pairing store untouched",false,context.getSharedPreferences("lab_encrypted_session",0).contains("session"));
        }finally{instrumentation.removeMonitor(monitor);}
    }
    @Test public void callbackWithoutPendingLoginIsRejected()throws Exception{
        android.content.Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();context.getSharedPreferences(PREFS,0).edit().clear().commit();
        Intent intent=new Intent(context,AdminPasskeyActivity.class).setAction(Intent.ACTION_VIEW).setData(Uri.parse(NativePkce.REDIRECT+"?code="+NativePkce.random()+"&state="+NativePkce.random())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try(ActivityScenario<AdminPasskeyActivity> scenario=ActivityScenario.launch(intent)){waitText(scenario,"인증 반환을 확인하지 못했습니다");assertFalse(context.getSharedPreferences(PREFS,0).contains("session"));}
    }
    @Test public void queuedCallbackSurvivesRecreationAndDuplicateDelivery()throws Exception{
        Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();android.content.Context context=instrumentation.getTargetContext();context.getSharedPreferences(PREFS,0).edit().clear().commit();
        AtomicReference<String> authorize=new AtomicReference<>();
        Instrumentation.ActivityMonitor monitor=new Instrumentation.ActivityMonitor(){@Override public Instrumentation.ActivityResult onStartActivity(Intent intent){if(Intent.ACTION_VIEW.equals(intent.getAction())&&intent.getData()!=null&&intent.getData().toString().startsWith("http://localhost:43871/authorize?")){authorize.set(intent.getData().toString());return new Instrumentation.ActivityResult(0,null);}return null;}};
        instrumentation.addMonitor(monitor);CountDownLatch blocked=new CountDownLatch(1),release=new CountDownLatch(1);
        try(ActivityScenario<AdminPasskeyActivity> scenario=ActivityScenario.launch(AdminPasskeyActivity.class)){
            onView(withText("관리자 패스키로 로그인")).perform(click());for(int i=0;i<80&&authorize.get()==null;i++)Thread.sleep(100);assertNotNull(authorize.get());
            String callback=fixture("authorize",new JSONObject().put("url",authorize.get())).getString("redirect");
            int before=fixture("counts",new JSONObject()).getInt("tokenExchanges");
            AtomicReference<ExecutorService> queue=new AtomicReference<>();scenario.onActivity(a->{try{java.lang.reflect.Field field=AdminPasskeyController.class.getDeclaredField("worker");field.setAccessible(true);queue.set((ExecutorService)field.get(AdminPasskeyController.get(a)));}catch(Exception e){throw new AssertionError(e);}});
            queue.get().execute(()->{blocked.countDown();try{release.await(15,TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();}});assertTrue(blocked.await(5,TimeUnit.SECONDS));
            Intent intent=new Intent(context,AdminPasskeyActivity.class).setAction(Intent.ACTION_VIEW).setData(Uri.parse(callback)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);context.startActivity(intent);instrumentation.waitForIdleSync();
            scenario.recreate();context.startActivity(new Intent(intent));instrumentation.waitForIdleSync();release.countDown();
            waitText(scenario,"관리자 인증 완료: owner");assertTrue(context.getSharedPreferences(PREFS,0).contains("session"));
            assertEquals(before+1,fixture("counts",new JSONObject()).getInt("tokenExchanges"));
            context.startActivity(new Intent(intent));instrumentation.waitForIdleSync();
            assertEquals(before+1,fixture("counts",new JSONObject()).getInt("tokenExchanges"));waitText(scenario,"관리자 인증 완료: owner");
        }finally{release.countDown();instrumentation.removeMonitor(monitor);}
    }
}
