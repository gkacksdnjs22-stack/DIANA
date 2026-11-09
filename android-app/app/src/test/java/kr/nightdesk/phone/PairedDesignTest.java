package kr.nightdesk.phone;
import android.graphics.*;
import android.view.*;
import android.widget.*;
import java.io.*;
import java.lang.reflect.*;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(application=android.app.Application.class,sdk=34,qualifiers="w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class PairedDesignTest {
 private PairedActivity activity() {return Robolectric.buildActivity(PairedActivity.class).create().get();}
 private void setupWork(PairedActivity a)throws Exception{Field f=PairedActivity.class.getDeclaredField("session");f.setAccessible(true);f.set(a,new JSONObject().put("device","00000000-0000-4000-8000-000000000001").put("origin","https://example.invalid").put("token","test-only"));a.work();}
 private void image(PairedActivity a,String name,int width,int height)throws Exception{View root=a.findViewById(android.R.id.content);root.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.EXACTLY));root.layout(0,0,width,height);Bitmap b=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);root.draw(new Canvas(b));File folder=new File("build/design-preview");folder.mkdirs();try(FileOutputStream out=new FileOutputStream(new File(folder,name+".png"))){assertTrue(b.compress(Bitmap.CompressFormat.PNG,100,out));}b.recycle();}
 private boolean text(View root,String value){if(root instanceof TextView&&((TextView)root).getText().toString().equals(value))return true;if(root instanceof ViewGroup)for(int i=0;i<((ViewGroup)root).getChildCount();i++)if(text(((ViewGroup)root).getChildAt(i),value))return true;return false;}
 @Test public void pairingHasNoAddressOrAccountAndRenders()throws Exception{PairedActivity a=activity();View root=a.findViewById(android.R.id.content);assertTrue(text(root,"내 PC를 연결하세요"));assertFalse(text(root,"로그인"));assertFalse(text(root,"회원가입"));image(a,"pair-360",360,800);a.finish();}
 @Test public void workAndFilesAndSettingsAreDistinctScreens()throws Exception{PairedActivity a=activity();setupWork(a);View root=a.findViewById(android.R.id.content);assertTrue(text(root,"무엇을 만들까요?"));assertTrue(text(root,"작업"));assertTrue(text(root,"파일"));assertTrue(text(root,"설정"));image(a,"work-360",360,800);a.archive();image(a,"files-empty-360",360,800);a.settings();image(a,"settings-360",360,800);a.finish();}
 @Test public void fileRowsAndNarrowScreensDoNotCrash()throws Exception{PairedActivity a=activity();setupWork(a);a.getSharedPreferences("paired-00000000-0000-4000-8000-000000000001",0).edit().putString("file-00000000-0000-4000-8000-000000000002",new JSONObject().put("name","프로젝트 핵심 요약 보고서.pdf").put("uri","content://example.invalid/result").toString()).commit();a.archive();image(a,"files-360",360,800);a.work();image(a,"work-320",320,640);image(a,"work-600",600,900);a.finish();}
 @Test public void switchingTabsPreservesUnsentRequest()throws Exception{PairedActivity a=activity();setupWork(a);Field f=PairedActivity.class.getDeclaredField("editor");f.setAccessible(true);((EditText)f.get(a)).setText("문서 두 개를 요약해줘");a.settings();a.archive();a.work();assertEquals("문서 두 개를 요약해줘",((EditText)f.get(a)).getText().toString());a.finish();}
 @Test public void onlyApprovableJobsOfferAPhonePreview()throws Exception{
  PairedActivity a=activity();
  LinearLayout pcOnly=a.column();
  a.renderJob(pcOnly,new JSONObject().put("status","approval"));
  assertTrue(text(pcOnly,"PC에서 확인을 기다려요"));
  assertFalse(text(pcOnly,"미리보기"));
  LinearLayout mobile=a.column();
  a.renderJob(mobile,new JSONObject().put("status","approval").put("canApprove",true));
  assertTrue(text(mobile,"미리보기"));
  assertFalse(text(mobile,"승인 후 저장"));
  LinearLayout saving=a.column();
  a.renderJob(saving,new JSONObject().put("status","saving"));
  assertFalse(text(saving,"저장 다시 시도"));
  LinearLayout retry=a.column();
  a.renderJob(retry,new JSONObject().put("status","saving").put("canApprove",true));
  assertTrue(text(retry,"저장 다시 시도"));
  a.finish();
 }
}
