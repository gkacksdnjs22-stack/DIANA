package kr.nightdesk.phone;
import java.io.IOException;
import java.security.SecureRandom;
import java.util.UUID;

/** Code-only enrollment. The public service address is part of the app, not user input. */
public final class PairedLink {
 public static final String ORIGIN="https://diana-device-link.onrender.com";
 public static String requestId(){return UUID.randomUUID().toString();}
 public static String pairKey(){byte[] b=new byte[32];new SecureRandom().nextBytes(b);StringBuilder s=new StringBuilder();for(byte x:b)s.append(String.format(java.util.Locale.ROOT,"%02x",x&255));return s.toString();}
 public static PairedWire.Reply pair(String origin,String code,String id,String key)throws Exception{
  if(!code.matches("[0-9]{6}")||!id.matches("[a-f0-9-]{36}")||!key.matches("[a-f0-9]{64}"))throw new IOException("PC에 표시된 6자리 코드를 입력하세요.");
  return PairedWire.post(origin,"","{\"op\":\"pair-code\",\"code\":\""+code+"\",\"requestId\":\""+id+"\",\"pairKey\":\""+key+"\"}");
 }
}
