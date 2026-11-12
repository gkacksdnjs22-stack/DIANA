package kr.nightdesk.phone;
import android.app.*;
import android.os.*;
import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.graphics.Color;
import android.view.View;
import android.widget.*;
import androidx.core.content.FileProvider;
import androidx.documentfile.provider.DocumentFile;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;

import static kr.nightdesk.phone.PairedActivity.*;
final class PairedFiles {
 static final Object lock=new Object();
 static final class AuthError extends IOException{AuthError(String message){super(message);}}
 final Context ctx;final JSONObject session;final SharedPreferences local;
 PairedFiles(Context context,JSONObject value){ctx=context.getApplicationContext();session=value;local=ctx.getSharedPreferences("paired-"+value.optString("device"),0);}
 JSONObject call(JSONObject b)throws Exception{
  if(!session.has("fileKey"))throw new AuthError("암호화 연결이 필요합니다. 기기를 다시 연결하세요.");
  String id=UUID.randomUUID().toString();
  byte[] wire=E2ee.seal(obj("at",System.currentTimeMillis(),"body",b).toString().getBytes(StandardCharsets.UTF_8),session.getString("fileKey"),id,"request.json","phone-pc");
  PairedWire.Reply reply=PairedWire.post(session.getString("origin"),session.optString("token"),obj("op","encrypted","id",id,"data",E2ee.b64(wire)).toString());
  JSONObject r=new JSONObject(reply.body);
  if(reply.status!=200){if(reply.status==401||reply.status==403)throw new AuthError("암호화 연결이 만료됐거나 해제되었습니다. 다시 연결하세요.");throw new IOException("암호화 응답을 받지 못했습니다.");}
  JSONObject decoded=new JSONObject(new String(E2ee.open(E2ee.un64(r.getString("encrypted"),E2ee.MAX_WIRE),session.getString("fileKey"),id,"reply.json","pc-phone"),StandardCharsets.UTF_8));
  JSONObject answer=decoded.getJSONObject("body");int status=decoded.getInt("status");
  if(status!=200){String msg=answer.optString("error","요청을 처리하지 못했습니다.");if(status==401||status==403&&(msg.contains("만료")||msg.contains("해제")))throw new AuthError(msg);throw new IOException(msg);}return answer;}

 void receive(JSONObject f)throws Exception{synchronized(lock){receiveLocked(f);}}
 void deleteLocalCopy(String id)throws Exception{
  synchronized(lock){
   String key="file-"+id;
   String stored=local.getString(key,null);
   if(stored==null)return;
   Uri uri=Uri.parse(new JSONObject(stored).getString("uri"));
   if(ctx.getContentResolver().delete(uri,null,null)!=1)
    throw new IOException("파일을 삭제하지 못했습니다.");
   if(!local.edit().remove(key).putBoolean("removed-"+id,true).commit())
    throw new IOException("삭제 기록을 저장하지 못했습니다.");
  }
 }
 void receiveLocked(JSONObject f)throws Exception{String id=f.getString("id"),hash=f.getString("sha256"),name=f.getString("name");if(!UUID.fromString(id).toString().equals(id)||name.contains("/")||name.contains("\\"))throw new IOException("파일 이름을 확인하세요.");if(local.contains("removed-"+id))return;
 String stored=local.getString("file-"+id,null);if(stored!=null&&f.optBoolean("received"))return;Uri uri;byte[] saved;
 if(stored==null){JSONObject d=call(obj("op","file","id",id));byte[] bytes=android.util.Base64.decode(d.getString("data"),android.util.Base64.DEFAULT);PairedWire.verify(bytes,f.getInt("bytes"),hash);
 String target=local.getString("tree","");String locator=local.getString("writing-"+id,null);
 if(locator!=null)uri=Uri.parse(locator);else if(target.isEmpty()){File folder=new File(ctx.getFilesDir(),"results/"+session.getString("device"));if(!folder.isDirectory()&&!folder.mkdirs())throw new IOException("받을 폴더를 만들지 못했습니다.");File file=new File(folder,name);if(file.exists())throw new IOException("같은 이름의 파일이 있습니다. 저장 위치를 확인하세요.");uri=FileProvider.getUriForFile(ctx,ctx.getPackageName()+".files",file);}
 else{DocumentFile tree=DocumentFile.fromTreeUri(ctx,Uri.parse(target));DocumentFile out=tree.createFile("application/octet-stream",name);if(out==null)throw new IOException("받을 파일을 만들 수 없습니다.");uri=out.getUri();}
 if(!local.edit().putString("writing-"+id,uri.toString()).commit())throw new IOException("수신 상태를 저장하지 못했습니다.");
 try(OutputStream out=ctx.getContentResolver().openOutputStream(uri,"wt")){out.write(bytes);}saved=read(ctx.getContentResolver().openInputStream(uri),12000000);}
 else{uri=Uri.parse(new JSONObject(stored).getString("uri"));saved=read(ctx.getContentResolver().openInputStream(uri),12000000);}
 PairedWire.verify(saved,f.getInt("bytes"),hash);
 if(!local.edit().putString("file-"+id,obj("name",name,"uri",uri.toString(),"hash",hash).toString()).remove("writing-"+id).commit())throw new IOException("수신 기록을 저장하지 못했습니다.");call(obj("op","receipt","id",id,"bytes",saved.length,"hash",hash));}
}
