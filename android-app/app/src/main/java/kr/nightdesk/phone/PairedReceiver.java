package kr.nightdesk.phone;
import android.content.Context;
import androidx.work.*;
import org.json.*;
import java.util.concurrent.TimeUnit;

public final class PairedReceiver extends Worker {
 public PairedReceiver(Context context,WorkerParameters parameters){super(context,parameters);}
 static void schedule(Context context){
  Constraints network=new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
  PeriodicWorkRequest request=new PeriodicWorkRequest.Builder(PairedReceiver.class,15,TimeUnit.MINUTES).setConstraints(network).build();
  WorkManager.getInstance(context).enqueueUniquePeriodicWork("paired-receive",ExistingPeriodicWorkPolicy.KEEP,request);
 }
 @Override public Result doWork(){
  try{JSONObject s=new SecureStore(getApplicationContext()).load();if(s==null||s.optString("device").isEmpty())return Result.success();
   PairedFiles client=new PairedFiles(getApplicationContext(),s);int offset=0;
   while(!isStopped()){JSONObject state=client.call(PairedActivity.obj("op","state","offset",offset));JSONArray files=state.getJSONArray("files");
    for(int i=0;i<files.length()&&!isStopped();i++)client.receive(files.getJSONObject(i));if(!state.optBoolean("more"))break;offset+=20;}
   return Result.success();
  }catch(PairedFiles.AuthError e){return Result.failure();}catch(Exception e){return Result.retry();}
 }
}

