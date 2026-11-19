package kr.nightdesk.phone;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.json.JSONObject;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(application=android.app.Application.class,sdk=34)
public class TransferPayloadTest {
 private final byte[] apk={80,75,3,4,1,2,3,4};
 private JSONObject artifact()throws Exception{return new JSONObject().put("filename","DIANA-next.apk").put("mime","application/vnd.android.package-archive").put("transferEncoding","public-app-update").put("bytes",apk.length).put("sha256",E2ee.hash(apk));}
 @Test public void keylessInstallationReceivesExplicitPublicInstaller()throws Exception{assertArrayEquals(apk,TransferPayload.open(new JSONObject(),"fixture",artifact(),apk));}
 @Test public void publicMarkerDoesNotEnableOrdinaryPlaintextOrCorruptInstallers()throws Exception{
  for(String change:new String[]{"unmarked","document","mime","hash","size"}){JSONObject a=artifact();if(change.equals("unmarked"))a.remove("transferEncoding");if(change.equals("document"))a.put("filename","private.txt");if(change.equals("mime"))a.put("mime","text/plain");if(change.equals("hash"))a.put("sha256","0".repeat(64));if(change.equals("size"))a.put("bytes",99);
   try{TransferPayload.open(new JSONObject(),"fixture",a,apk);fail(change);}catch(java.io.IOException expected){}
  }
  byte[] document="ordinary document".getBytes(java.nio.charset.StandardCharsets.UTF_8);JSONObject a=artifact().put("sha256",E2ee.hash(document)).put("bytes",document.length);try{TransferPayload.open(new JSONObject(),"fixture",a,document);fail();}catch(java.io.IOException expected){}
 }
}
