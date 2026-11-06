package kr.nightdesk.phone;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/** Shared byte transport for the Android foreground and background receivers. */
public final class PairedWire {
 public static final class Reply {
  public final String body;
  public final int status;
  Reply(int status,byte[] body){this.status=status;this.body=new String(body,StandardCharsets.UTF_8);}
 }
 public static byte[] read(InputStream source,int max)throws IOException{
  if(source==null)throw new IOException("파일을 열 수 없습니다.");
  try(InputStream in=source;ByteArrayOutputStream out=new ByteArrayOutputStream()){
   byte[] buffer=new byte[16384];int n;
   while((n=in.read(buffer))!=-1){if(out.size()+n>max)throw new IOException("파일 크기 한도를 넘었습니다.");out.write(buffer,0,n);}
   return out.toByteArray();
  }
 }
 public static String hash(byte[] bytes)throws Exception{
  StringBuilder hex=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))hex.append(String.format(Locale.ROOT,"%02x",b&255));return hex.toString();
 }
 public static void verify(byte[] bytes,int size,String hash)throws Exception{
  if(bytes.length!=size||!hash(bytes).equals(hash))throw new IOException("저장한 파일의 크기나 내용이 일치하지 않습니다.");
 }
 public static Reply post(String origin,String token,String json)throws Exception{
  URI uri=URI.create(origin);boolean usb="http".equals(uri.getScheme())&&"127.0.0.1".equals(uri.getHost());
  if(uri.getHost()==null||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null||!uri.getPath().isEmpty()||!usb&&!"https".equals(uri.getScheme()))throw new IOException("PC 보안 연결 주소를 확인하세요.");
  HttpURLConnection conn=(HttpURLConnection)new URL(origin+"/v1").openConnection();
  conn.setInstanceFollowRedirects(false);conn.setConnectTimeout(8000);conn.setReadTimeout(45000);conn.setRequestMethod("POST");conn.setDoOutput(true);
  conn.setRequestProperty("Content-Type","application/json");conn.setRequestProperty("Authorization","Bearer "+token);
  try{try(OutputStream out=conn.getOutputStream()){out.write(json.getBytes(StandardCharsets.UTF_8));}
   int status=conn.getResponseCode();return new Reply(status,read(status==200?conn.getInputStream():conn.getErrorStream(),16000000));
  }finally{conn.disconnect();}
 }
}

