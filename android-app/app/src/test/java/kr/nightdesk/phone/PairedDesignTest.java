package kr.nightdesk.phone;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.graphics.*;
import android.net.Uri;
import android.os.Looper;
import android.view.*;
import android.widget.*;
import java.io.*;
import java.lang.reflect.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.shadows.ShadowContentResolver;
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
 private void tapTab(View root,String name){
  java.util.ArrayList<View> matches=new java.util.ArrayList<>();
  root.findViewsWithText(matches,name,View.FIND_VIEWS_WITH_CONTENT_DESCRIPTION);
  assertEquals(1,matches.size());
  assertTrue(matches.get(0).performClick());
 }
 @Test public void tabsRespondWhileBackgroundFileReceiveIsBlocked()throws Exception{
  var controller=Robolectric.buildActivity(PairedActivity.class).create();
  PairedActivity a=controller.get();
  setupWork(a);
  Field editorField=PairedActivity.class.getDeclaredField("editor");
  editorField.setAccessible(true);
  ((EditText)editorField.get(a)).setText("작성 중인 요청");
  Field ioField=PairedActivity.class.getDeclaredField("io");
  ioField.setAccessible(true);
  ExecutorService io=(ExecutorService)ioField.get(a);
  CountDownLatch started=new CountDownLatch(1);
  CountDownLatch finishReceive=new CountDownLatch(1);
  String name="새로 받은 파일.txt";
  a.async(()->{
   started.countDown();
   if(!finishReceive.await(10,TimeUnit.SECONDS))throw new IOException("Test receive timed out");
   a.getSharedPreferences("paired-00000000-0000-4000-8000-000000000001",0).edit()
    .putString("file-00000000-0000-4000-8000-000000000002",
      new JSONObject().put("name",name).put("uri","content://example.invalid/result").toString())
    .commit();
  });
  try {
   assertTrue(started.await(5,TimeUnit.SECONDS));
   View root=a.findViewById(android.R.id.content);
   tapTab(root,"파일");
   assertTrue(text(root,"보관 파일"));
   tapTab(root,"설정");
   assertTrue(text(root,"내 PC 연결"));
   tapTab(root,"작업");
   assertEquals("작성 중인 요청",((EditText)editorField.get(a)).getText().toString());
   tapTab(root,"파일");
   assertFalse(text(root,name));
   finishReceive.countDown();
   io.submit(()->{}).get(5,TimeUnit.SECONDS);
   Shadows.shadowOf(Looper.getMainLooper()).idle();
   assertTrue(text(root,"보관 파일"));
   assertTrue(text(root,name));
  } finally {
   finishReceive.countDown();
   controller.destroy();
  }
 }
 @Test public void deletingACopyWhileReceiptIsInProgressKeepsItRemoved()throws Exception{
  var controller=Robolectric.buildActivity(PairedActivity.class).create();
  PairedActivity a=controller.get();
  setupWork(a);
  String id="00000000-0000-4000-8000-000000000002",name="수신 확인 중.txt";
  String device="00000000-0000-4000-8000-000000000001";
  File dir=new File(a.getFilesDir(),"results/"+device);
  assertTrue(dir.mkdirs()||dir.isDirectory());
  File copy=new File(dir,name);
  try(FileOutputStream output=new FileOutputStream(copy)){output.write(1);}
  var uri=Uri.parse("content://paired.test.copy/result");
  ShadowContentResolver.registerProviderInternal(uri.getAuthority(),new ContentProvider(){
   @Override public boolean onCreate(){return true;}
   @Override public Cursor query(Uri u,String[] p,String s,String[] a,String o){throw new UnsupportedOperationException();}
   @Override public String getType(Uri u){return "text/plain";}
   @Override public Uri insert(Uri u,ContentValues v){throw new UnsupportedOperationException();}
   @Override public int update(Uri u,ContentValues v,String s,String[] a){throw new UnsupportedOperationException();}
   @Override public int delete(Uri u,String s,String[] a){return copy.delete()?1:0;}
  });
  var preferences=a.getSharedPreferences("paired-"+device,0);
  String metadata=new JSONObject().put("name",name).put("uri",uri.toString()).toString();
  assertTrue(preferences.edit().putString("file-"+id,metadata).commit());
  a.archive();

  CountDownLatch receiptStarted=new CountDownLatch(1),finishReceipt=new CountDownLatch(1);
  ExecutorService receiver=Executors.newSingleThreadExecutor();
  var receipt=receiver.submit(()->{
   synchronized(PairedFiles.lock){
    receiptStarted.countDown();
    if(!finishReceipt.await(10,TimeUnit.SECONDS))throw new IOException("Receipt test timed out");
    assertTrue(preferences.edit().putString("file-"+id,metadata).commit());
   }
   return null;
  });
  try{
   assertTrue(receiptStarted.await(5,TimeUnit.SECONDS));
   a.deleteArchivedFile(id);
   Field ioField=PairedActivity.class.getDeclaredField("io");
   ioField.setAccessible(true);
   var deletionFinished=((ExecutorService)ioField.get(a)).submit(()->{});
   View root=a.findViewById(android.R.id.content);
   tapTab(root,"설정");
   assertTrue(text(root,"내 PC 연결"));
   tapTab(root,"파일");
   assertThrows(TimeoutException.class,()->deletionFinished.get(250,TimeUnit.MILLISECONDS));
   assertTrue(copy.exists());
   finishReceipt.countDown();
   receipt.get(5,TimeUnit.SECONDS);
   deletionFinished.get(5,TimeUnit.SECONDS);
   Shadows.shadowOf(Looper.getMainLooper()).idle();
   assertFalse(copy.exists());
   assertFalse(preferences.contains("file-"+id));
   assertTrue(preferences.getBoolean("removed-"+id,false));
   PairedFiles files=new PairedFiles(a,new JSONObject().put("device",device));
   files.receive(new JSONObject().put("id",id).put("name",name).put("sha256","unused"));
   assertFalse(preferences.contains("file-"+id));
   assertFalse(text(root,name));
  }finally{
   finishReceipt.countDown();
   receiver.shutdown();
   controller.destroy();
  }
 }
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
  LinearLayout pdf=a.column();
  a.renderJob(pdf,new JSONObject().put("status","approval").put("canApprove",true).put("pdfPages",2));
  assertTrue(text(pdf,"PDF 내용 보기"));
  assertFalse(text(pdf,"승인 후 저장"));
  LinearLayout saving=a.column();
  a.renderJob(saving,new JSONObject().put("status","saving"));
  assertFalse(text(saving,"저장 다시 시도"));
  LinearLayout retry=a.column();
  a.renderJob(retry,new JSONObject().put("status","saving").put("canApprove",true));
  assertTrue(text(retry,"저장 다시 시도"));
  LinearLayout choose=a.column();
  a.renderJob(choose,new JSONObject().put("status","choose").put("canChoose",true));
  assertTrue(text(choose,"파일 고르기"));
  assertFalse(text(choose,"승인 후 저장"));
  LinearLayout needsPermission=a.column();
  a.renderJob(needsPermission,new JSONObject().put("status","approval").put("mobileApprovalNeeded",true));
  assertTrue(text(needsPermission,"모바일 승인을 켜 주세요"));
  assertFalse(text(needsPermission,"미리보기"));
  a.finish();
 }
 @Test public void pdfDialogDisplaysPageControlsAndBlocksNetworkLoads()throws Exception{
  PairedActivity a=activity();
  setupWork(a);
  Bitmap bitmap=Bitmap.createBitmap(16,20,Bitmap.Config.ARGB_8888);
  ByteArrayOutputStream bytes=new ByteArrayOutputStream();
  assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG,85,bytes));bitmap.recycle();
  JSONObject page=new JSONObject().put("page",1).put("pages",2)
    .put("image",android.util.Base64.encodeToString(bytes.toByteArray(),android.util.Base64.NO_WRAP));
  Class<?> type=Class.forName(PairedActivity.class.getName()+"$PdfPreview");
  Constructor<?> constructor=type.getDeclaredConstructor(PairedActivity.class,String.class,String.class,String.class,boolean.class,JSONObject.class);
  constructor.setAccessible(true);
  Object preview=constructor.newInstance(a,"job","nonce","가상 PDF",false,page);
  Method show=type.getDeclaredMethod("show");show.setAccessible(true);show.invoke(preview);
  Field dialogField=type.getDeclaredField("dialog");dialogField.setAccessible(true);
  android.app.AlertDialog dialog=(android.app.AlertDialog)dialogField.get(preview);
  View content=dialog.getWindow().getDecorView();
  assertTrue(text(content,"1 / 2쪽"));
  assertTrue(text(content,"이전 쪽"));
  assertTrue(text(content,"다음 쪽"));
  assertTrue(text(content,"승인 후 저장"));
  Field viewerField=type.getDeclaredField("viewer");viewerField.setAccessible(true);
  android.webkit.WebView viewer=(android.webkit.WebView)viewerField.get(preview);
  assertTrue(viewer.getSettings().getBlockNetworkLoads());
  assertFalse(viewer.getSettings().getAllowFileAccess());
  Field active=PairedActivity.class.getDeclaredField("active");
  active.setAccessible(true);
  Field pending=PairedActivity.class.getDeclaredField("pending");
  pending.setAccessible(true);
  active.setBoolean(a,true);
  try {
   a.tick.run();
   assertFalse("A preview pauses background polling",pending.getBoolean(a));
   pending.setBoolean(a,true);
   assertTrue(dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).performClick());
   assertTrue("An approval click must keep the preview open while busy",dialog.isShowing());
  } finally {
   active.setBoolean(a,false);
   pending.setBoolean(a,false);
   dialog.dismiss();a.finish();
  }
 }
}
