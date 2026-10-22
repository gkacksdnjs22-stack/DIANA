package kr.nightdesk.phone;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
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
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private LinearLayout root;
    private TextView status;
    private EditText urlField, codeField;
    private Button pairButton, syncButton, folderButton;
    private CheckBox autoReceive;
    private SecureStore secureStore;
    private volatile boolean busy;

    @Override protected void onCreate(@Nullable Bundle state) {
        super.onCreate(state);
        secureStore = new SecureStore(this);
        Notifications.ensureChannel(this);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 2202);
        SyncScheduler.configure(this);
        draw();
    }

    @Override protected void onDestroy() { super.onDestroy(); worker.shutdownNow(); }

    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private TextView label(String value, int size, int color, boolean bold) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        view.setPadding(0, dp(7), 0, dp(7)); return view;
    }
    private void gap(int height) { View view = new View(this); root.addView(view, new LinearLayout.LayoutParams(1, dp(height))); }
    private Button button(String value) {
        Button button = new Button(this); button.setText(value); button.setAllCaps(false); button.setTextColor(Color.WHITE);
        button.setBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(52,89,230)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(52)); params.topMargin = dp(8); root.addView(button, params); return button;
    }
    private EditText field(String hint, int inputType) {
        EditText field = new EditText(this); field.setSingleLine(true); field.setTextSize(15); field.setHint(hint); field.setInputType(inputType);
        field.setPadding(dp(14), 0, dp(14), 0); field.setBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(180,190,208)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(52)); params.topMargin = dp(6); root.addView(field, params); return field;
    }
    private void draw() {
        root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(dp(22), dp(20), dp(22), dp(28)); root.setBackgroundColor(Color.rgb(247,248,252));
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.addView(root); setContentView(scroll);
        root.addView(label("DIANA", 29, Color.rgb(23,38,60), true));
        root.addView(label("PC에서 완성된 보고서와 발표자료를 갤럭시에 안전하게 받습니다.", 15, Color.rgb(75,87,105), false));
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
        CheckBox folder = new CheckBox(this); folder.setText("선택한 폴더에도 결과 복사"); folder.setChecked(getPreferences(0).getString("export_tree", null) != null); root.addView(folder);
        folderButton = button(folder.isChecked() ? "저장 폴더 변경" : "갤럭시 저장 폴더 선택");
        folderButton.setOnClickListener(v -> chooseFolder());
        folder.setOnClickListener(v -> { if (folder.isChecked()) chooseFolder(); else clearFolder(); });
        autoReceive = new CheckBox(this); autoReceive.setText("백그라운드에서 새 결과 자동 확인"); autoReceive.setChecked(getPreferences(0).getBoolean("auto_receive", true)); root.addView(autoReceive);
        autoReceive.setOnCheckedChangeListener((v, checked) -> {
            getPreferences(0).edit().putBoolean("auto_receive", checked).apply(); SyncScheduler.configure(this);
            showStatus(checked ? "자동 확인을 켰습니다. 전원 절약 설정에 따라 늦어질 수 있습니다." : "백그라운드 자동 확인을 껐습니다.", false);
        });
        root.addView(label("예약 결과는 앱 내부 저장소에 내려받고 해시를 확인합니다. 폴더를 고르면 해당 폴더에도 복사합니다. 완료 표시는 휴대폰 저장 확인 후 갱신됩니다.", 13, Color.rgb(102,112,130), false));
        String copyError=getPreferences(0).getString("export_error","");
        if(!copyError.isEmpty())root.addView(label("선택한 폴더 복사에 실패했습니다. 앱 내부 보관함에는 저장되어 있습니다.  "+copyError,13,Color.rgb(178,53,53),false));
        syncButton = button("지금 결과 확인"); syncButton.setOnClickListener(v -> syncNow());
        button("연결 해제").setOnClickListener(v -> { secureStore.clear(); SyncScheduler.configure(this); draw(); });
        gap(12); root.addView(label("최근 작업", 20, Color.rgb(23,38,60), true));
        JSONArray jobs = SyncEngine.cachedJobs(this);
        if (jobs.length() == 0) root.addView(label("작업 결과가 아직 없습니다. PC 제어 화면에서 파일과 완료 시각을 정해 예약하세요.", 14, Color.rgb(75,87,105), false));
        for (int index=0; index<Math.min(jobs.length(),15); index++) {
            JSONObject job=jobs.optJSONObject(index); if(job==null) continue;
            String title=job.optJSONObject("request") == null ? "작업" : job.optJSONObject("request").optString("subject","작업");
            String state=job.optString("state","대기");String saved=job.optString("phoneSavedAt","");
            root.addView(label(title+"  ·  "+state+(saved.isEmpty()?"":"  ·  저장 확인됨"),15,Color.rgb(35,47,67),true));
            JSONArray artifacts=job.optJSONArray("artifacts");if(artifacts==null) continue;
            for(int item=0;item<artifacts.length();item++){
                JSONObject artifact=artifacts.optJSONObject(item);if(artifact==null) continue;
                String filename=artifact.optString("filename");
                Button open=button("열기  ·  "+filename);open.setOnClickListener(v->openArtifact(job.optString("id"),artifact));
            }
        }
        showStatus(autoReceive.isChecked()?"연결됨 · 백그라운드에서 최대 15분 간격으로 확인합니다.":"연결됨 · 백그라운드 자동 확인이 꺼져 있습니다.",false);
        syncButton.setEnabled(!busy);
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
                runOnUiThread(()->{busy=false;draw();showStatus("휴대폰을 연결했습니다.",false);});
            } catch(Exception error){runOnUiThread(()->{busy=false;pairButton.setEnabled(true);showStatus(error.getMessage()==null?"연결에 실패했습니다.":error.getMessage(),true);});}
        });
    }
    private void syncNow() {
        if (busy) return;busy=true;syncButton.setEnabled(false);showStatus("작업 결과를 확인하고 있습니다…",false);
        worker.execute(()->{
            try {
                int count=SyncEngine.sync(this,()->Thread.currentThread().isInterrupted());
                runOnUiThread(()->{busy=false;draw();showStatus(count>0?count+"개 결과를 갤럭시에 저장하고 검증했습니다.":"새 결과가 없습니다. 저장한 파일은 최근 작업에서 열 수 있습니다.",false);});
            }catch(Exception error){runOnUiThread(()->{busy=false;draw();showStatus(error.getMessage()==null?"동기화에 실패했습니다.":error.getMessage(),true);});}
        });
    }
    private void chooseFolder() {
        Intent choose=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);choose.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);startActivityForResult(choose,PICK_FOLDER);
    }
    @Override protected void onActivityResult(int code,int result,@Nullable Intent data){super.onActivityResult(code,result,data);if(code==PICK_FOLDER&&result==Activity.RESULT_OK&&data!=null){Uri uri=data.getData();try{getContentResolver().takePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);getPreferences(0).edit().putString("export_tree",uri.toString()).apply();draw();showStatus("선택한 폴더에 결과를 복사합니다.",false);}catch(Exception error){showStatus("폴더 권한을 저장하지 못했습니다.",true);}}}
    private void clearFolder(){String previous=getPreferences(0).getString("export_tree",null);if(previous!=null){try{getContentResolver().releasePersistableUriPermission(Uri.parse(previous),Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);}catch(Exception ignored){}getPreferences(0).edit().remove("export_tree").apply();}draw();}
    private void openArtifact(String jobId,JSONObject artifact){try{File file=FileSafety.artifact(getFilesDir(),jobId,artifact.getString("id"),artifact.getString("filename"));if(!SyncEngine.verified(file,artifact))throw new Exception("파일 무결성 확인이 필요합니다. 다시 동기화해 주세요.");Uri uri=FileProvider.getUriForFile(this,getPackageName()+".files",file);Intent open=new Intent(Intent.ACTION_VIEW).setDataAndType(uri,artifact.optString("mime","application/octet-stream")).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);startActivity(Intent.createChooser(open,"파일을 열 앱 선택"));}catch(Exception error){showStatus(error.getMessage()==null?"파일을 열 수 없습니다.":error.getMessage(),true);}}
    private void showStatus(String message,boolean error){if(status!=null){status.setText(message);status.setTextColor(error?Color.rgb(178,53,53):Color.rgb(52,89,230));}}
}
