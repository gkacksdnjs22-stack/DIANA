package kr.nightdesk.phone;

import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.spec.*;
import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.*;

/** P-256 ECDH, RFC 5869 HKDF-SHA256 and AES-256-GCM; interoperable with lib/e2ee.mjs. */
final class E2ee {
 static final int MAX_PLAIN=16*1024*1024,MAX_WIRE=23*1024*1024;
 static final byte[] MAGIC="DIANA-E2EE-1\n".getBytes(StandardCharsets.UTF_8);
 static final SecureRandom RANDOM=new SecureRandom();
 static IOException bad(){return new IOException("암호화 정보를 확인하지 못했습니다. 기기를 다시 연결하세요.");}
 static byte[] utf(String s){return s.getBytes(StandardCharsets.UTF_8);}
 static String b64(byte[] b){return Base64.getEncoder().encodeToString(b);}
 static byte[] un64(String s,int max)throws Exception{if(s.length()>((max+2)/3)*4)throw bad();byte[] b=Base64.getDecoder().decode(s);if(b.length>max||!b64(b).equals(s))throw bad();return b;}
 static String hash(byte[] b)throws Exception{return hex(MessageDigest.getInstance("SHA-256").digest(b));}
 static String hex(byte[] b){StringBuilder s=new StringBuilder();for(byte x:b)s.append(String.format(Locale.ROOT,"%02x",x&255));return s.toString();}
 static byte[] unhex(String s)throws Exception{if(!s.matches("[a-f0-9]{64}"))throw bad();byte[] b=new byte[32];for(int i=0;i<32;i++)b[i]=(byte)Integer.parseInt(s.substring(i*2,i*2+2),16);return b;}
 static byte[] random(int n){byte[] b=new byte[n];RANDOM.nextBytes(b);return b;}
 static byte[] hmac(byte[] key,byte[] data)throws Exception{Mac m=Mac.getInstance("HmacSHA256");m.init(new SecretKeySpec(key,"HmacSHA256"));return m.doFinal(data);}
 static JSONObject identity()throws Exception{KeyPairGenerator gen=KeyPairGenerator.getInstance("EC");gen.initialize(new ECGenParameterSpec("secp256r1"));KeyPair p=gen.generateKeyPair();return new JSONObject().put("publicKey",b64(p.getPublic().getEncoded())).put("privateKey",b64(p.getPrivate().getEncoded()));}
 static String accept(JSONObject identity,JSONObject reply,String id)throws Exception{
  PublicKey peer=KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(un64(reply.getString("publicKey"),128)));
  if(!(peer instanceof java.security.interfaces.ECPublicKey))throw bad();
  AlgorithmParameters parameters=AlgorithmParameters.getInstance("EC");parameters.init(new ECGenParameterSpec("secp256r1"));
  ECParameterSpec expected=parameters.getParameterSpec(ECParameterSpec.class),actual=((java.security.interfaces.ECPublicKey)peer).getParams();
  if(!actual.getCurve().equals(expected.getCurve())||!actual.getGenerator().equals(expected.getGenerator())||!actual.getOrder().equals(expected.getOrder())||actual.getCofactor()!=expected.getCofactor())throw bad();
  PrivateKey privateKey=KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(un64(identity.getString("privateKey"),256)));
  KeyAgreement agreement=KeyAgreement.getInstance("ECDH");agreement.init(privateKey);agreement.doPhase(peer,true);
  byte[] salt=MessageDigest.getInstance("SHA-256").digest(utf(id+"\n"+identity.getString("publicKey")+"\n"+reply.getString("publicKey")));
  byte[] info=utf("DIANA pairing key v1"),expand=Arrays.copyOf(info,info.length+1);expand[info.length]=1;
  byte[] key=hmac(hmac(salt,agreement.generateSecret()),expand);
  byte[] confirm=hmac(key,utf("DIANA pairing confirmation v1\n"+id));
  if(!MessageDigest.isEqual(confirm,unhex(reply.getString("confirm"))))throw bad();return hex(key);
 }
 static byte[] crypt(byte[] key,byte[] iv,byte[] data,String aad,boolean decrypt)throws Exception{
  if(key.length!=32||iv.length!=12)throw bad();Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(decrypt?Cipher.DECRYPT_MODE:Cipher.ENCRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,iv));c.updateAAD(utf(aad));return c.doFinal(data);
 }
 static String aad(JSONObject m)throws Exception{return "DIANA-E2EE-1\n"+m.getString("direction")+"\n"+m.getString("id")+"\n"+b64(utf(m.getString("filename")))+"\n"+m.getString("sha256")+"\n"+m.getInt("bytes");}
 static byte[] seal(byte[] plain,String keyHex,String id,String name,String direction)throws Exception{
  if(plain.length<1||plain.length>MAX_PLAIN)throw bad();byte[] key=unhex(keyHex),secret=random(32),iv=random(12),wrapIv=random(12);String kid=hash(key);
  JSONObject m=new JSONObject().put("id",id).put("filename",name).put("direction",direction).put("sha256",hash(plain)).put("bytes",plain.length);String auth=aad(m);
  JSONObject recipient=new JSONObject().put("kid",kid).put("iv",b64(wrapIv)).put("key",b64(crypt(key,wrapIv,secret,auth+"\n"+kid,false)));
  JSONObject v=new JSONObject().put("v",1).put("meta",m).put("iv",b64(iv)).put("data",b64(crypt(secret,iv,plain,auth,false))).put("recipients",new JSONArray().put(recipient));
  ByteArrayOutputStream out=new ByteArrayOutputStream();out.write(MAGIC);out.write(utf(v.toString()));return out.toByteArray();
 }
 static byte[] open(byte[] wire,String keyHex,String id,String name,String direction)throws Exception{
  try{
   if(wire.length>MAX_WIRE||wire.length<MAGIC.length||!Arrays.equals(MAGIC,Arrays.copyOf(wire,MAGIC.length)))throw bad();
   JSONObject v=new JSONObject(new String(wire,MAGIC.length,wire.length-MAGIC.length,StandardCharsets.UTF_8)),m=v.getJSONObject("meta");
   if(v.getInt("v")!=1||!m.getString("id").equals(id)||!m.getString("filename").equals(name)||!m.getString("direction").equals(direction)||m.getInt("bytes")<1||m.getInt("bytes")>MAX_PLAIN||!m.getString("sha256").matches("[a-f0-9]{64}"))throw bad();
   byte[] key=unhex(keyHex);String kid=hash(key);JSONArray recipients=v.getJSONArray("recipients");if(recipients.length()<1||recipients.length()>32)throw bad();JSONObject selected=null;Set<String> seen=new HashSet<>();
   for(int i=0;i<recipients.length();i++){JSONObject r=recipients.getJSONObject(i);String k=r.getString("kid");if(!k.matches("[a-f0-9]{64}")||!seen.add(k)||un64(r.getString("iv"),12).length!=12||un64(r.getString("key"),48).length!=48)throw bad();if(k.equals(kid))selected=r;}
   if(selected==null)throw bad();String auth=aad(m);
   byte[] secret=crypt(key,un64(selected.getString("iv"),12),un64(selected.getString("key"),48),auth+"\n"+kid,true);
   byte[] plain=crypt(secret,un64(v.getString("iv"),12),un64(v.getString("data"),MAX_PLAIN+16),auth,true);
   if(plain.length!=m.getInt("bytes")||!hash(plain).equals(m.getString("sha256")))throw bad();return plain;
  }catch(Exception e){throw bad();}
 }
 static byte[] read(InputStream in)throws Exception{ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] b=new byte[16384];int n;while((n=in.read(b))!=-1){if(Thread.currentThread().isInterrupted())throw new InterruptedIOException();if(out.size()+n>MAX_WIRE)throw bad();out.write(b,0,n);}return out.toByteArray();}
}
