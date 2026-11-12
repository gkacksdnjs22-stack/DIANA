package kr.nightdesk.phone;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import android.view.WindowManager;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(application=android.app.Application.class,sdk=34)
public class E2eeTest {
 private JSONObject node(JSONObject input)throws Exception{
  File root=new File(System.getProperty("user.dir"));while(root!=null&&!new File(root,"tests/helpers/e2ee-peer.mjs").isFile())root=root.getParentFile();assertNotNull(root);
  Process p=new ProcessBuilder("node",new File(root,"tests/helpers/e2ee-peer.mjs").getAbsolutePath()).start();
  try(OutputStream out=p.getOutputStream()){out.write(input.toString().getBytes(StandardCharsets.UTF_8));}
  byte[] result=p.getInputStream().readAllBytes();assertEquals(new String(p.getErrorStream().readAllBytes(),StandardCharsets.UTF_8),0,p.waitFor());return new JSONObject(new String(result,StandardCharsets.UTF_8));
 }
 @Test public void nodeAndAndroidAgreeAndExchangeBothDirections()throws Exception{
  JSONObject identity=E2ee.identity();String id=UUID.randomUUID().toString();JSONObject offer=node(new JSONObject().put("op","offer").put("publicKey",identity.getString("publicKey")).put("id",id));
  String key=E2ee.accept(identity,offer.getJSONObject("reply"),id);assertEquals(offer.getString("key"),key);
  byte[] plain="교차 언어 암호화 문서 👋".getBytes(StandardCharsets.UTF_8);String name="문서.txt";
  JSONObject meta=new JSONObject().put("id",id).put("filename",name).put("direction","phone-pc");
  byte[] wire=E2ee.seal(plain,key,id,name,"phone-pc");JSONObject opened=node(new JSONObject().put("op","open").put("key",key).put("wire",E2ee.b64(wire)).put("meta",meta));assertArrayEquals(plain,E2ee.un64(opened.getString("plain"),E2ee.MAX_PLAIN));
  meta.put("direction","pc-phone");JSONObject sealed=node(new JSONObject().put("op","seal").put("key",key).put("plain",E2ee.b64(plain)).put("meta",meta));
  byte[] remote=E2ee.un64(sealed.getString("wire"),E2ee.MAX_WIRE);assertArrayEquals(plain,E2ee.open(remote,key,id,name,"pc-phone"));
  try{E2ee.open(remote,key,id,"other.txt","pc-phone");fail("name substitution");}catch(IOException expected){}
  try{E2ee.open(remote,key,id,name,"phone-pc");fail("reflection");}catch(IOException expected){}
  try{E2ee.open(plain,key,id,name,"pc-phone");fail("plaintext downgrade");}catch(IOException expected){}
 }
 @Test public void documentWindowsAreSecureBeforeTheyAreShown(){
  try(var controller=Robolectric.buildActivity(MainActivity.class).create()){
   assertNotEquals(0,controller.get().getWindow().getAttributes().flags&WindowManager.LayoutParams.FLAG_SECURE);
  }
  try(var controller=Robolectric.buildActivity(PairedActivity.class).create()){
   PairedActivity a=controller.get();assertNotEquals(0,a.getWindow().getAttributes().flags&WindowManager.LayoutParams.FLAG_SECURE);
   android.app.AlertDialog dialog=new SecureDialogBuilder(a).setMessage("synthetic private preview").create();
   assertNotEquals(0,dialog.getWindow().getAttributes().flags&WindowManager.LayoutParams.FLAG_SECURE);dialog.dismiss();
  }
 }
}
