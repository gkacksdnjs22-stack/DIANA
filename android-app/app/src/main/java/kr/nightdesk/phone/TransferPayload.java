package kr.nightdesk.phone;

import java.io.IOException;
import java.util.Locale;
import org.json.JSONObject;

/** Public installers are explicit payloads; documents never fall back to plaintext. */
final class TransferPayload {
 static byte[] open(JSONObject session,String jobId,JSONObject artifact,byte[] wire)throws Exception{
  String name=artifact.getString("filename");byte[] plain;
  if("public-app-update".equals(artifact.optString("transferEncoding"))){
   if(!name.toLowerCase(Locale.ROOT).endsWith(".apk")||!"application/vnd.android.package-archive".equals(artifact.optString("mime"))||wire.length>10*1024*1024||wire.length<4||wire[0]!=80||wire[1]!=75||wire[2]!=3||wire[3]!=4)
    throw new IOException("공개 배포 APK를 확인하지 못했습니다.");
   plain=wire;
  }else{
   if(!session.has("fileKey"))throw new IOException("암호화 연결이 필요합니다. 기기를 다시 연결하세요.");
   plain=E2ee.open(wire,session.getString("fileKey"),jobId,name,"pc-phone");
  }
  if(plain.length!=artifact.getLong("bytes")||!E2ee.hash(plain).equals(artifact.getString("sha256")))throw new IOException("파일 무결성 검증에 실패했습니다.");
  return plain;
 }
}
