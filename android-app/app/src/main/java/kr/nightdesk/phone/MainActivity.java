package kr.nightdesk.phone;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.text.InputType;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.annotation.Nullable;
import androidx.core.content.FileProvider;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.time.Instant;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Minimal first-party Android companion. Tokens remain in Android Keystore. */
public final class MainActivity extends Activity {
    private static final int PICK_FOLDER = 2201;
    private static final int PICK_UPLOAD = 2203;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private ForegroundRefresh foregroundRefresh;
    private LinearLayout root;
    private LinearLayout recentJobs;
    private ScrollView scroll;
    private JSONArray displayedJobs = new JSONArray();
    private JSONObject displayedSession;
    private boolean resumed;
    private TextView status;
    private EditText urlField, codeField;
    private Button pairButton, syncButton, folderButton, disconnectButton, uploadPickButton, uploadSendButton, uploadCancelButton;
    private CheckBox autoReceive;
    private SecureStore secureStore;
    private volatile boolean busy;
    private int visibleSaved = 15;

    @Override protected void onCreate(@Nullable Bundle state) {
        super.onCreate(state);
        secureStore = new SecureStore(this);
        foregroundRefresh = new ForegroundRefresh(new ForegroundRefresh.Scheduler() {
            @Override public void post(Runnable task,long delayMs) { main.postDelayed(task,delayMs); }
            @Override public void remove(Runnable task) { main.removeCallbacks(task); }
        },()->busy,this::readUploadStatuses);
        Notifications.ensureChannel(this);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 2202);
        SyncScheduler.configure(this);
        draw();
    }

    @Override protected void onResume() { super.onResume(); resumed=true; if(foregroundRefresh!=null)foregroundRefresh.start(); }
    @Override protected void onPause() { resumed=false; if(foregroundRefresh!=null)foregroundRefresh.stop(); super.onPause(); }
    @Override protected void onDestroy() { if(foregroundRefresh!=null)foregroundRefresh.stop(); super.onDestroy(); worker.shutdownNow(); }

    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private TextView label(String value, int size, int color, boolean bold) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        view.setPadding(0, dp(7), 0, dp(7)); return view;
    }
    private void gap(int height) { View view = new View(this); root.addView(view, new LinearLayout.LayoutParams(1, dp(height))); }
    private Button button(String value) {
        return button(root,value);
    }
    private Button button(LinearLayout parent,String value) {
        Button button = new Button(this); button.setText(value); button.setAllCaps(false); button.setTextColor(Color.WHITE);
        button.setBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(52,89,230)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(52)); params.topMargin = dp(8); parent.addView(button, params); return button;
    }
    private EditText field(String hint, int inputType) {
        EditText field = new EditText(this); field.setSingleLine(true); field.setTextSize(15); field.setHint(hint); field.setInputType(inputType);
        field.setPadding(dp(14), 0, dp(14), 0); field.setBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(180,190,208)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(52)); params.topMargin = dp(6); root.addView(field, params); return field;
    }
    private void draw() {
        root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(dp(22), dp(20), dp(22), dp(28)); root.setBackgroundColor(Color.rgb(247,248,252));
        recentJobs=null;
        scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.addView(root); setContentView(scroll);
        root.addView(label("DIANA", 29, Color.rgb(23,38,60), true));
        root.addView(label("PC의 문서와 생성 결과를 갤럭시에서 받고, 휴대폰 파일을 PC로 보냅니다.", 15, Color.rgb(75,87,105), false));
        status = label("연결 상태를 확인하는 중…", 14, Color.rgb(52,89,230), true); root.addView(status);

        try {
            JSONObject session = secureStore.load();
            if (session == null) drawPairing();
            else drawConnected(session);
        } catch (Exception error) {
            secureStore.clear(); drawPairing(); showStatus("저장된 연결을 읽지 못해 다시 연결해야 합니다.", true);
        }
    }
    private void drawPairing() {
        root.addView(label("PC 연결", 20, Color.rgb(23,38,60), true));
        root.addView(label("PC의 제어 화면에서 만든 6자리 코드를 입력하세요. 인터넷에서 사용할 때는 HTTPS 주소를 입력합니다.", 14, Color.rgb(75,87,105), false));
        urlField = field("서버 주소 (예: https://example.com)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        codeField = field("6자리 연결 코드", InputType.TYPE_CLASS_NUMBER); codeField.setGravity(Gravity.CENTER); codeField.setTextSize(22); codeField.setLetterSpacing(0.3f); codeField.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(6)});
        pairButton = button("이 휴대폰 연결하기"); pairButton.setOnClickListener(v -> pair());
        root.addView(label("안내: PC와 같은 컴퓨터에서 로컬 주소를 쓰면 실제 휴대폰은 접속하지 못합니다. 외부 사용은 HTTPS 서버 주소가 필요합니다. 연결 코드는 5분 후 만료됩니다.", 13, Color.rgb(102,112,130), false));
    }
    private void drawConnected(JSONObject session) {
        String base = session.optString("baseUrl");
        root.addView(label("PC에 연결됨", 20, Color.rgb(23,38,60), true));
        root.addView(label(base, 13, Color.rgb(80,91,110), false));
        CheckBox folder = new CheckBox(this); folder.setText("선택한 폴더에도 결과 복사"); folder.setChecked(getPreferences(0).getString("export_tree", null) != null); folder.setEnabled(!busy); root.addView(folder);
        folderButton = button(folder.isChecked() ? "저장 폴더 변경" : "갤럭시 저장 폴더 선택");
        folderButton.setEnabled(!busy);
        folderButton.setOnClickListener(v -> chooseFolder());
        folder.setOnClickListener(v -> { if (folder.isChecked()) chooseFolder(); else clearFolder(); });
        autoReceive = new CheckBox(this); autoReceive.setText("백그라운드에서 새 결과 자동 확인"); autoReceive.setChecked(getPreferences(0).getBoolean("auto_receive", true)); autoReceive.setEnabled(!busy); root.addView(autoReceive);
        autoReceive.setOnCheckedChangeListener((v, checked) -> {
            getPreferences(0).edit().putBoolean("auto_receive", checked).apply(); SyncScheduler.configure(this);
            showStatus(checked ? "자동 확인을 켰습니다. 전원 절약 설정에 따라 늦어질 수 있습니다." : "백그라운드 자동 확인을 껐습니다.", false);
        });
        root.addView(label("검색 문서와 예약 결과를 앱 내부 저장소에 자동으로 내려받고 해시를 확인합니다. 폴더를 고르면 해당 폴더에도 복사합니다. 완료 표시는 실제 휴대폰 저장 확인 후 갱신됩니다.", 13, Color.rgb(102,112,130), false));
        String copyError=getPreferences(0).getString("export_error","");
        if(!copyError.isEmpty())root.addView(label("선택한 폴더 복사에 실패했습니다. 앱 내부 보관함에는 저장되어 있습니다.  "+copyError,13,Color.rgb(178,53,53),false));
        syncButton = button("지금 결과 확인"); syncButton.setOnClickListener(v -> syncNow());
        disconnectButton = button("연결 해제"); disconnectButton.setEnabled(!busy);
        disconnectButton.setOnClickListener(v -> { if (busy) return; foregroundRefresh.stop(); secureStore.clear(); SyncScheduler.configure(this); draw(); });
        drawUpload(session);
        gap(12); root.addView(label("최근 작업", 20, Color.rgb(23,38,60), true));
        recentJobs=new LinearLayout(this);recentJobs.setOrientation(LinearLayout.VERTICAL);root.addView(recentJobs);
        JSONArray cached=SyncEngine.cachedJobs(this);
        displayedJobs=sameSession(displayedSession,session)?mergeUploadStatuses(cached,displayedJobs):cached;
        displayedSession=session;drawRecentJobs();
        gap(12); root.addView(label("내 저장 파일", 20, Color.rgb(23,38,60), true));
        root.addView(label("최근 작업 목록에서 사라져도 갤럭시 앱에 보관된 문서는 이 목록에서 다시 열 수 있습니다.", 13, Color.rgb(102,112,130), false));
        JSONArray savedJobs = SyncEngine.cachedSaved(this);
        if (savedJobs.length() == 0) root.addView(label("아직 갤럭시에 저장한 파일이 없습니다.", 14, Color.rgb(75,87,105), false));
        for (int index=0; index<Math.min(savedJobs.length(),visibleSaved); index++) {
            JSONObject savedJob=savedJobs.optJSONObject(index);if(savedJob==null)continue;
            String jobId=savedJob.optString("id");
            root.addView(label(savedJob.optString("title","작업"),14,Color.rgb(35,47,67),true));
            JSONArray artifacts=savedJob.optJSONArray("artifacts");if(artifacts==null)continue;
            for (int item=0;item<artifacts.length();item++) {
                JSONObject artifact=artifacts.optJSONObject(item);if(artifact==null)continue;
                Button open=button("저장 파일 열기  ·  "+artifact.optString("filename"));
                open.setOnClickListener(v->openArtifact(jobId,artifact));
            }
        }
        if (savedJobs.length() > visibleSaved) {
            Button more=button("저장된 작업 더 보기  ·  "+(savedJobs.length()-visibleSaved)+"개 남음");
            more.setOnClickListener(v->{visibleSaved+=15;draw();});
        }
        showStatus(autoReceive.isChecked()?"연결됨 · 백그라운드는 기본 15분 주기이며 절전 설정에 따라 늦어질 수 있습니다.":"연결됨 · 백그라운드 자동 확인이 꺼져 있습니다.",false);
        syncButton.setEnabled(!busy);
    }
    private void drawRecentJobs() {
        if(recentJobs==null)return;
        recentJobs.removeAllViews();
        if(displayedJobs.length()==0)recentJobs.addView(label("작업 결과가 아직 없습니다. PC 제어 화면에서 요청해 주세요.",14,Color.rgb(75,87,105),false));
        for(int index=0;index<Math.min(displayedJobs.length(),15);index++) {
            JSONObject job=displayedJobs.optJSONObject(index);if(job==null)continue;
            boolean overnight="overnight".equals(job.optString("kind")),upload="upload".equals(job.optString("kind"));
            JSONObject request=job.optJSONObject("request");
            String title=request==null?"작업":request.optString(upload?"filename":overnight?"subject":"query","작업");
            String state=job.optString("state","대기"),saved=job.optString("phoneSavedAt","");
            String visibleState=upload?uploadState(state):"download_ready".equals(state)?(saved.isEmpty()?"갤럭시 저장 확인 대기":"갤럭시 저장 완료"):state;
            recentJobs.addView(label((upload?"PC로 보내기 · ":"")+title+"  ·  "+visibleState+(!upload&&!saved.isEmpty()?"  ·  저장 확인됨":""),15,Color.rgb(35,47,67),true));
            if(upload) {
                if("pc_saved".equals(state)&&!job.optString("pcSavedAt").isEmpty())recentJobs.addView(label("PC가 파일 저장과 해시 확인을 완료했습니다.",13,Color.rgb(75,87,105),false));
                if("failed".equals(state))recentJobs.addView(label(job.optString("error","PC에 저장하지 못했습니다. 파일을 다시 선택해 보내 주세요."),13,Color.rgb(178,53,53),false));
                continue;
            }
            JSONArray artifacts=job.optJSONArray("artifacts");if(artifacts==null)continue;
            for(int item=0;item<artifacts.length();item++) {
                JSONObject artifact=artifacts.optJSONObject(item);if(artifact==null)continue;
                Button open=button(recentJobs,"열기  ·  "+artifact.optString("filename"));open.setOnClickListener(v->openArtifact(job.optString("id"),artifact));
            }
        }
    }
    private static boolean sameSession(JSONObject left,JSONObject right) {
        return left!=null&&right!=null&&left.optString("baseUrl").equals(right.optString("baseUrl"))&&
            left.optString("phoneId").equals(right.optString("phoneId"))&&left.optString("phoneToken").equals(right.optString("phoneToken"));
    }
    private void readUploadStatuses(ForegroundRefresh.Completion completion) {
        final JSONObject session;
        try { session=secureStore.load(); }
        catch(Exception error){completion.finish(false,false,null);return;}
        if(session==null){completion.finish(false,false,null);return;}
        worker.execute(()->{
            try {
                JSONArray remote=Api.request(session,"/api/jobs",null).getJSONArray("jobs");
                boolean pending=false;
                for(int i=0;i<remote.length();i++) {
                    JSONObject job=remote.optJSONObject(i);
                    if(job!=null&&"upload".equals(job.optString("kind"))&&("waiting_pc".equals(job.optString("state"))||"receiving_pc".equals(job.optString("state"))))pending=true;
                }
                final boolean waiting=pending;
                main.post(()->completion.finish(waiting,false,()->applyUploadStatuses(session,remote)));
            }catch(Exception error){main.post(()->completion.finish(false,true,null));}
        });
    }
    private void applyUploadStatuses(JSONObject session,JSONArray remote) {
        try {
            if(!sameSession(session,secureStore.load())||recentJobs==null)return;
            JSONArray combined=mergeUploadStatuses(displayedJobs,remote);
            if(combined.toString().equals(displayedJobs.toString()))return;
            displayedJobs=combined;
            final ScrollView current=scroll;final int position=current.getScrollY();
            drawRecentJobs();
            current.post(()->{if(scroll==current&&!isFinishing()&&!isDestroyed())current.scrollTo(0,position);});
        }catch(Exception ignored){/* Keep the last visible state during a reconnect. */}
    }
    private static JSONArray mergeUploadStatuses(JSONArray base,JSONArray observed) {
        java.util.Map<String,JSONObject> uploads=new java.util.LinkedHashMap<>();
        for(int i=0;i<observed.length();i++){JSONObject job=observed.optJSONObject(i);if(job!=null&&"upload".equals(job.optString("kind")))uploads.put(job.optString("id"),job);}
        JSONArray updated=new JSONArray();java.util.Set<String> seen=new java.util.HashSet<>();
        for(int i=0;i<base.length();i++) {
            JSONObject old=base.optJSONObject(i);if(old==null)continue;
            String id=old.optString("id");seen.add(id);JSONObject fresh=uploads.get(id);
            updated.put(fresh!=null&&fresh.optString("updatedAt").compareTo(old.optString("updatedAt"))>=0?fresh:old);
        }
        JSONArray combined=new JSONArray();
        for(JSONObject job:uploads.values())if(!seen.contains(job.optString("id")))combined.put(job);
        for(int i=0;i<updated.length();i++)combined.put(updated.opt(i));
        return combined;
    }
    private void drawUpload(JSONObject session) {
        gap(12); root.addView(label("휴대폰 파일을 PC로 보내기",20,Color.rgb(23,38,60),true));
        root.addView(label("파일을 하나 선택한 뒤 이름과 크기를 확인하고 전송하세요. 최대 10MB이며, 휴대폰 원본은 유지됩니다. PC가 오프라인이면 연결될 때까지 서버에서 기다립니다.",13,Color.rgb(102,112,130),false));
        uploadPickButton=null;uploadSendButton=null;uploadCancelButton=null;
        UploadSender.Pending pending=null;boolean invalid=false;
        try { pending=UploadSender.load(this); }
        catch(Exception error) { invalid=true;root.addView(label("전송 대기 정보를 읽지 못했습니다. 대기를 취소한 뒤 파일을 다시 선택해 주세요.",13,Color.rgb(178,53,53),false)); }
        if(pending==null&&!invalid) {
            uploadPickButton=button("PC로 보낼 파일 선택");uploadPickButton.setEnabled(!busy);uploadPickButton.setOnClickListener(v->chooseUpload());
        } else {
            if(pending!=null) {
                root.addView(label(pending.filename+"  ·  "+UploadSender.describeBytes(pending.bytes),15,Color.rgb(35,47,67),true));
                boolean matching=pending.belongsTo(session);
                root.addView(label(matching?"이 파일의 복사본이 앱에 준비되어 있습니다. 전송이 끊겨도 같은 파일로 안전하게 재시도합니다.":"이전 PC 연결에서 준비한 파일입니다. 대기를 취소하고 다시 선택해 주세요.",13,Color.rgb(102,112,130),false));
                uploadSendButton=button("PC로 보내기 / 재시도");uploadSendButton.setEnabled(!busy&&matching);uploadSendButton.setOnClickListener(v->sendUpload());
            }
            uploadCancelButton=button("전송 대기 취소");uploadCancelButton.setEnabled(!busy);uploadCancelButton.setOnClickListener(v->confirmDiscardUpload());
        }
    }
    private static String uploadState(String state) {
        switch(state) {
            case "waiting_pc": return "PC 연결·저장 대기";
            case "receiving_pc": return "PC에 저장 중";
            case "pc_saved": return "PC 저장 완료";
            case "failed": return "PC 저장 실패";
            default: return "PC 전송 상태 확인 중";
        }
    }
    private void uploadBusy(boolean value) {
        busy=value;
        for(Button control:new Button[]{syncButton,disconnectButton,folderButton,uploadPickButton,uploadSendButton,uploadCancelButton})
            if(control!=null) control.setEnabled(!value);
        if(autoReceive!=null) autoReceive.setEnabled(!value);
    }
    private void uploadFinished(String message,boolean error) {
        runOnUiThread(()->{busy=false;if(isFinishing()||isDestroyed())return;draw();showStatus(message,error);foregroundRefresh.refresh();});
    }
    private void chooseUpload() {
        if(busy)return;
        try {
            if(UploadSender.load(this)!=null)return;
            Intent choose=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
            choose.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            uploadBusy(true);startActivityForResult(choose,PICK_UPLOAD);
        }catch(Exception error){uploadBusy(false);showStatus("파일 선택 화면을 열지 못했습니다.",true);}
    }
    private void prepareUpload(Uri uri) {
        uploadBusy(true);showStatus("파일의 크기와 해시를 확인하고 있습니다…",false);
        worker.execute(()->{
            try {
                JSONObject session=secureStore.load();if(session==null)throw new UploadSender.UploadException("휴대폰을 PC에 다시 연결해 주세요.");
                UploadSender.prepare(this,uri,session);
                uploadFinished("파일이 준비됐습니다. 이름과 크기를 확인한 뒤 ‘PC로 보내기 / 재시도’를 눌러 주세요.",false);
            }catch(Exception error){uploadFinished(error instanceof UploadSender.UploadException?error.getMessage():"선택한 파일을 준비하지 못했습니다. 다시 선택해 주세요.",true);}
        });
    }
    private void sendUpload() {
        if(busy)return;uploadBusy(true);showStatus("선택한 파일을 서버로 전송하고 있습니다…",false);
        worker.execute(()->{
            try {
                JSONObject session=secureStore.load();if(session==null)throw new UploadSender.UploadException("휴대폰을 PC에 다시 연결해 주세요.");
                JSONObject job=UploadSender.send(this,session);
                try {
                    JSONArray previous=SyncEngine.cachedJobs(this),jobs=new JSONArray().put(job);
                    for(int i=0;i<previous.length();i++){JSONObject old=previous.optJSONObject(i);if(old!=null&&!job.getString("id").equals(old.optString("id")))jobs.put(old);}
                    SyncEngine.cache(this,new JSONObject().put("jobs",jobs));
                }catch(Exception ignored){/* The server acknowledgement remains authoritative. */}
                boolean failed="failed".equals(job.optString("state"));
                uploadFinished(failed?job.optString("error","PC에 저장하지 못했습니다. 파일을 다시 선택해 보내 주세요."):"pc_saved".equals(job.optString("state"))?"PC가 파일을 저장하고 해시를 확인했습니다.":"서버가 파일을 받았습니다. 이 화면에서 PC 저장 상태를 자동으로 확인합니다.",failed);
            }catch(Exception error){uploadFinished(error instanceof UploadSender.UploadException||error instanceof Api.ApiException?error.getMessage():"파일 전송을 확인하지 못했습니다. 준비된 파일로 재시도해 주세요.",true);}
        });
    }
    private void confirmDiscardUpload() {
        if(busy)return;
        new AlertDialog.Builder(this).setTitle("전송 대기를 취소할까요?")
            .setMessage("앱의 전송 준비만 지웁니다. 휴대폰 원본은 유지되며, 이미 서버에 도착한 파일은 취소되지 않습니다.")
            .setNegativeButton("유지",null).setPositiveButton("대기 취소",(dialog,which)->{
                if(busy)return;uploadBusy(true);worker.execute(()->{try{UploadSender.discard(this);uploadFinished("전송 대기를 취소했습니다. 휴대폰 원본은 유지됩니다.",false);}catch(Exception error){uploadFinished("전송 준비를 정리하지 못했습니다. 다시 시도해 주세요.",true);}});
            }).show();
    }
    private void pair() {
        if (busy) return; String base=urlField.getText().toString().trim(), code=codeField.getText().toString().trim();
        if (!code.matches("[0-9]{6}")) { showStatus("6자리 코드를 확인하세요.",true);return; }
        pairButton.setEnabled(false); showStatus("안전하게 연결하는 중…",false); busy=true;
        worker.execute(()->{
            try {
                String safeBase=Api.validateBase(base,BuildConfig.DEBUG);
                JSONObject response=Api.request(safeBase,"/api/phone/pair",null,new JSONObject().put("code",code).put("deviceName",Build.MANUFACTURER+" "+Build.MODEL));
                JSONObject session=new JSONObject().put("baseUrl",safeBase).put("phoneToken",response.getString("phoneToken")).put("phoneId",response.getString("phoneId")).put("firebase",response.optJSONObject("firebase"));
                secureStore.save(session);PushSupport.initialize(this);SyncScheduler.configure(this);
                runOnUiThread(()->{busy=false;if(isFinishing()||isDestroyed())return;draw();showStatus("휴대폰을 연결했습니다.",false);if(resumed){foregroundRefresh.start();foregroundRefresh.refresh();}});
            } catch(Exception error){runOnUiThread(()->{busy=false;pairButton.setEnabled(true);showStatus(error.getMessage()==null?"연결에 실패했습니다.":error.getMessage(),true);});}
        });
    }
    private void syncNow() {
        if (busy) return;uploadBusy(true);showStatus("작업 결과를 확인하고 있습니다…",false);
        worker.execute(()->{
            try {
                int count=SyncEngine.sync(this,()->Thread.currentThread().isInterrupted());
                runOnUiThread(()->{busy=false;draw();showStatus(count>0?count+"개 결과를 갤럭시에 저장하고 검증했습니다.":"최근 작업 상태를 갱신했습니다. 저장한 결과는 아래에서 열 수 있습니다.",false);foregroundRefresh.refresh();});
            }catch(Exception error){runOnUiThread(()->{busy=false;draw();showStatus(error.getMessage()==null?"동기화에 실패했습니다.":error.getMessage(),true);foregroundRefresh.refresh();});}
        });
    }
    private void chooseFolder() {
        if(busy)return;
        Intent choose=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);choose.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);startActivityForResult(choose,PICK_FOLDER);
    }
    @Override protected void onActivityResult(int code,int result,@Nullable Intent data){
        super.onActivityResult(code,result,data);
        if(code==PICK_UPLOAD){
            if(result==Activity.RESULT_OK&&data!=null&&data.getData()!=null)prepareUpload(data.getData());
            else{busy=false;draw();showStatus("파일 선택을 취소했습니다.",false);}
        }else if(code==PICK_FOLDER&&result==Activity.RESULT_OK&&data!=null){Uri uri=data.getData();try{getContentResolver().takePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);getPreferences(0).edit().putString("export_tree",uri.toString()).apply();draw();showStatus("선택한 폴더에 결과를 복사합니다.",false);}catch(Exception error){showStatus("폴더 권한을 저장하지 못했습니다.",true);}}
    }
    private void clearFolder(){String previous=getPreferences(0).getString("export_tree",null);if(previous!=null){try{getContentResolver().releasePersistableUriPermission(Uri.parse(previous),Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);}catch(Exception ignored){}getPreferences(0).edit().remove("export_tree").apply();}draw();}
    private void openArtifact(String jobId,JSONObject artifact){try{File file=FileSafety.artifact(getFilesDir(),jobId,artifact.getString("id"),artifact.getString("filename"));if(!SyncEngine.verified(file,artifact))throw new Exception("파일 무결성 확인이 필요합니다. 다시 동기화해 주세요.");Uri uri=FileProvider.getUriForFile(this,getPackageName()+".files",file);Intent open=new Intent(Intent.ACTION_VIEW).setDataAndType(uri,artifact.optString("mime","application/octet-stream")).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);startActivity(Intent.createChooser(open,"파일을 열 앱 선택"));}catch(Exception error){showStatus(error.getMessage()==null?"파일을 열 수 없습니다.":error.getMessage(),true);}}
    private void showStatus(String message,boolean error){if(status!=null){status.setText(message);status.setTextColor(error?Color.rgb(178,53,53):Color.rgb(52,89,230));}}
}
