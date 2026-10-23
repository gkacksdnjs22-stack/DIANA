package kr.nightdesk.phone;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.MimeTypeMap;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.annotation.Nullable;
import androidx.core.content.FileProvider;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** First-party companion. Connection credentials remain in Android Keystore. */
public final class MainActivity extends Activity {
    private static final int PICK_FOLDER=2201, PICK_UPLOAD=2203;
    private static final int FILES=0, SEND=1, RECENT=2, SETTINGS=3;
    private static final int BG=0xff080f1c, SURFACE=0xff111d30, BORDER=0xff24334b;
    private static final int TEXT=0xfff4f7ff, MUTED=0xff98abc3, CYAN=0xff4ce0d6, PURPLE=0xffae9bff, ERROR=0xffff9d9d;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final Handler main=new Handler(Looper.getMainLooper());
    private final int[] pageScroll=new int[4];
    private ForegroundRefresh foregroundRefresh;
    private SecureStore secureStore;
    private LinearLayout root, recentJobs, pageContent;
    private ScrollView scroll;
    private TextView status, pushStatus;
    private EditText urlField, codeField;
    private Button pairButton, syncButton, folderButton, disconnectButton, uploadPickButton, uploadSendButton, uploadCancelButton;
    private CheckBox autoReceive, folderCopy;
    private JSONArray displayedJobs=new JSONArray();
    private JSONObject displayedSession;
    private volatile boolean busy;
    private boolean resumed, renderQueued, statusError;
    private int selectedTab=FILES, renderedTab=FILES, visibleSaved=15, visibleRecent=30, detailScroll;
    private String detailId="", renderedDetailId="", urlDraft="", codeDraft="", statusMessage="";
    private final SharedPreferences.OnSharedPreferenceChangeListener settingsChanged=(preferences,key)->{
        if(!resumed)return;
        if("push_status".equals(key)||"last_sync".equals(key)||"last_error".equals(key)||"export_error".equals(key)||"export_tree".equals(key))queueRender();
    };

    @Override protected void onCreate(@Nullable Bundle state) {
        super.onCreate(state);
        if(state!=null){
            selectedTab=Math.max(FILES,Math.min(SETTINGS,state.getInt("tab",FILES)));
            detailId=state.getString("detail","");urlDraft=state.getString("url","");codeDraft=state.getString("code","");
            visibleSaved=state.getInt("visibleSaved",15);visibleRecent=state.getInt("visibleRecent",30);
            detailScroll=state.getInt("detailScroll",0);int[] positions=state.getIntArray("pageScroll");
            if(positions!=null)System.arraycopy(positions,0,pageScroll,0,Math.min(positions.length,4));
        }
        secureStore=new SecureStore(this);
        foregroundRefresh=new ForegroundRefresh(new ForegroundRefresh.Scheduler(){
            @Override public void post(Runnable task,long delay){main.postDelayed(task,delay);}
            @Override public void remove(Runnable task){main.removeCallbacks(task);}
        },()->busy,this::readUploadStatuses);
        Notifications.ensureChannel(this);
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},2202);
        SyncScheduler.configure(this);draw();
    }
    @Override protected void onSaveInstanceState(Bundle state){
        rememberViewState();state.putInt("tab",selectedTab);state.putString("detail",detailId);
        state.putString("url",urlDraft);state.putString("code",codeDraft);state.putIntArray("pageScroll",pageScroll);
        state.putInt("detailScroll",detailScroll);state.putInt("visibleSaved",visibleSaved);state.putInt("visibleRecent",visibleRecent);
        super.onSaveInstanceState(state);
    }
    @Override protected void onResume(){
        super.onResume();resumed=true;
        getSharedPreferences("settings",0).registerOnSharedPreferenceChangeListener(settingsChanged);
        getPreferences(0).registerOnSharedPreferenceChangeListener(settingsChanged);
        PushSupport.initialize(this);if(!busy)draw();if(foregroundRefresh!=null)foregroundRefresh.start();
    }
    @Override protected void onPause(){
        rememberViewState();resumed=false;
        getSharedPreferences("settings",0).unregisterOnSharedPreferenceChangeListener(settingsChanged);
        getPreferences(0).unregisterOnSharedPreferenceChangeListener(settingsChanged);
        if(foregroundRefresh!=null)foregroundRefresh.stop();super.onPause();
    }
    @Override protected void onDestroy(){if(foregroundRefresh!=null)foregroundRefresh.stop();main.removeCallbacksAndMessages(null);worker.shutdownNow();super.onDestroy();}
    @Override public void onBackPressed(){
        if(busy)return;
        if(!detailId.isEmpty()){rememberViewState();detailId="";draw();}
        else if(selectedTab!=FILES){navigate(FILES);}
        else super.onBackPressed();
    }
    private boolean alive(){return !isFinishing()&&!isDestroyed();}
    private int dp(float value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private void rememberViewState(){
        if(urlField!=null)urlDraft=urlField.getText().toString();if(codeField!=null)codeDraft=codeField.getText().toString();
        if(scroll!=null){if(renderedDetailId.isEmpty())pageScroll[renderedTab]=scroll.getScrollY();else detailScroll=scroll.getScrollY();}
    }
    private void queueRender(){
        if(renderQueued)return;renderQueued=true;main.post(()->{renderQueued=false;if(resumed&&!busy&&alive())draw();});
    }
    private void resetViews(){
        root=null;recentJobs=null;pageContent=null;scroll=null;status=null;pushStatus=null;urlField=null;codeField=null;
        pairButton=null;syncButton=null;folderButton=null;disconnectButton=null;uploadPickButton=null;uploadSendButton=null;uploadCancelButton=null;autoReceive=null;folderCopy=null;
    }
    private void draw(){
        if(!alive())return;rememberViewState();resetViews();
        JSONObject session=null;boolean connectionError=false;
        try{session=secureStore.load();}catch(Exception error){connectionError=true;}
        // Rendering failures must never erase a valid pairing credential.
        try{drawShell(session);if(session==null)drawPairing(connectionError);else drawConnected(session);}
        catch(Exception error){
            if(root!=null){root.removeAllViews();root.addView(label("화면을 불러오지 못했습니다.",18,TEXT,true));
                root.addView(label("연결 정보는 유지됩니다. 다시 불러오기를 눌러 주세요.",14,MUTED,false));
                button(root,"다시 불러오기",false).setOnClickListener(v->draw());}
        }
    }
    private void drawShell(JSONObject session){
        LinearLayout shell=column();shell.setBackgroundColor(BG);
        if(Build.VERSION.SDK_INT>=30)getWindow().setDecorFitsSystemWindows(false);
        shell.setOnApplyWindowInsetsListener((v,insets)->{
            if(Build.VERSION.SDK_INT>=30){android.graphics.Insets safe=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout());v.setPadding(safe.left,safe.top,safe.right,safe.bottom);}
            else v.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());
            return insets;
        });
        LinearLayout header=row();header.setPadding(dp(20),dp(10),dp(20),dp(8));header.setGravity(Gravity.CENTER_VERTICAL);
        ImageView logo=new ImageView(this);logo.setImageResource(R.mipmap.ic_launcher);logo.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        header.addView(logo,new LinearLayout.LayoutParams(dp(42),dp(42)));
        LinearLayout brand=column();LinearLayout.LayoutParams brandParams=new LinearLayout.LayoutParams(0,-2,1);brandParams.leftMargin=dp(10);header.addView(brand,brandParams);
        brand.addView(label("DIANA",20,TEXT,true));TextView subtitle=label("내 PC와 이어지는 공간",11,MUTED,false);subtitle.setPadding(0,0,0,0);brand.addView(subtitle);
        TextView badge=label(session==null?"연결 전":"●  연결됨",11,session==null?MUTED:CYAN,true);badge.setPadding(dp(10),dp(7),dp(10),dp(7));badge.setBackground(shape(session==null?SURFACE:0xff102e35,20,0));header.addView(badge);
        shell.addView(header);
        scroll=new ScrollView(this);scroll.setFillViewport(true);scroll.setClipToPadding(false);scroll.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        root=column();root.setPadding(dp(20),dp(10),dp(20),dp(26));scroll.addView(root);shell.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        status=label(statusMessage,13,statusError?ERROR:CYAN,false);status.setVisibility(statusMessage.isEmpty()?View.GONE:View.VISIBLE);
        status.setPadding(dp(14),dp(10),dp(14),dp(10));status.setBackground(shape(SURFACE,12,BORDER));root.addView(status);
        pageContent=column();root.addView(pageContent);
        if(session!=null)drawNavigation(shell);
        setContentView(shell);shell.requestApplyInsets();renderedTab=selectedTab;renderedDetailId=detailId;final ScrollView current=scroll;
        final int position=detailId.isEmpty()?pageScroll[selectedTab]:detailScroll;current.post(()->{if(alive()&&scroll==current)current.scrollTo(0,position);});
    }
    private void drawNavigation(LinearLayout shell){
        View line=new View(this);line.setBackgroundColor(BORDER);shell.addView(line,new LinearLayout.LayoutParams(-1,dp(1)));
        LinearLayout bar=row();bar.setPadding(dp(8),dp(8),dp(8),dp(8));bar.setBackgroundColor(BG);
        String[] titles={"내 파일","PC로 보내기","최근 작업","설정"};String[] tags={"nav_files","nav_send","nav_recent","nav_settings"};
        int[] icons={R.drawable.ic_ui_folder,R.drawable.ic_ui_send,R.drawable.ic_ui_inbox,R.drawable.ic_ui_settings};
        for(int index=0;index<4;index++){
            final int tab=index;boolean active=selectedTab==index;LinearLayout item=column();item.setGravity(Gravity.CENTER);item.setPadding(dp(2),dp(8),dp(2),dp(8));item.setMinimumHeight(dp(64));item.setTag(tags[index]);item.setContentDescription(titles[index]);item.setSelected(active);
            item.setBackground(ripple(active?0xff132d38:BG,14,0));item.setFocusable(true);item.setOnClickListener(v->navigate(tab));
            ImageView icon=icon(icons[index],active?CYAN:MUTED);item.addView(icon,new LinearLayout.LayoutParams(dp(22),dp(22)));
            TextView text=label(titles[index],11,active?CYAN:MUTED,active);text.setGravity(Gravity.CENTER);text.setPadding(0,dp(5),0,0);item.addView(text,new LinearLayout.LayoutParams(-1,-2));
            bar.addView(item,new LinearLayout.LayoutParams(0,-1,1));
        }
        shell.addView(bar,new LinearLayout.LayoutParams(-1,dp(80)));
    }
    private void navigate(int tab){if(busy)return;rememberViewState();selectedTab=tab;detailId="";draw();}
    private void drawConnected(JSONObject session){
        JSONArray cached=SyncEngine.cachedJobs(this);displayedJobs=sameSession(displayedSession,session)?mergeUploadStatuses(cached,displayedJobs):cached;displayedSession=session;
        if(selectedTab==FILES)drawFiles();else if(selectedTab==SEND)drawUpload(session);else if(selectedTab==RECENT){recentJobs=column();pageContent.addView(recentJobs);drawRecentJobs();}else drawSettings(session);
    }
    private void drawPairing(boolean unreadable){
        title(pageContent,"내 PC와 연결하기","파일을 주고받을 PC를 한 번 연결해 주세요.");
        LinearLayout card=card(pageContent);card.addView(label("안전한 휴대폰 연결",18,TEXT,true));
        card.addView(label(unreadable?"저장된 연결을 읽지 못했습니다. PC에서 새 코드를 발급해 다시 연결할 수 있습니다.":"PC 제어 화면의 서버 주소와 6자리 연결 코드를 입력하세요.",14,MUTED,false));
        urlField=field(card,"서버 주소 (https://…)",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI);urlField.setText(urlDraft);
        codeField=field(card,"6자리 연결 코드",InputType.TYPE_CLASS_NUMBER);codeField.setGravity(Gravity.CENTER);codeField.setTextSize(22);codeField.setLetterSpacing(.3f);codeField.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(6)});codeField.setText(codeDraft);
        pairButton=button(card,"이 휴대폰 연결하기",true);pairButton.setEnabled(!busy);pairButton.setOnClickListener(v->pair());
        card.addView(label("연결 코드는 5분 동안 유효해요. 외부에서는 HTTPS 서버 주소를 사용해 주세요.",12,MUTED,false));
    }
    private void drawFiles(){
        title(pageContent,"내 저장파일","받은 파일을 한곳에서 확인하고 열어보세요.");
        JSONArray saved=SyncEngine.cachedSaved(this);int count=0;
        for(int i=0;i<saved.length();i++){JSONObject job=saved.optJSONObject(i);if(job!=null&&job.optJSONArray("artifacts")!=null)count+=job.optJSONArray("artifacts").length();}
        LinearLayout hero=card(pageContent);hero.setBackground(shape(0xff122536,22,0xff214657));
        LinearLayout number=row();TextView large=label(String.valueOf(count),38,TEXT,true);number.addView(large);TextView caption=label("개의 파일",14,MUTED,false);LinearLayout.LayoutParams cp=new LinearLayout.LayoutParams(-2,-2);cp.leftMargin=dp(10);cp.gravity=Gravity.BOTTOM;cp.bottomMargin=dp(12);number.addView(caption,cp);hero.addView(number);
        hero.addView(label("마지막 동기화  "+time(getPreferences(0).getString("last_sync","")),12,MUTED,false));
        pushStatus=label("빠른 수신  ·  "+getSharedPreferences("settings",0).getString("push_status","연결 확인 중"),12,CYAN,false);hero.addView(pushStatus);
        syncButton=button(hero,"지금 결과 확인",true);syncButton.setEnabled(!busy);syncButton.setCompoundDrawablesWithIntrinsicBounds(tinted(R.drawable.ic_ui_refresh,0xff072a2c),null,null,null);syncButton.setCompoundDrawablePadding(dp(8));syncButton.setOnClickListener(v->syncNow());
        drawFolderCard(pageContent,false);
        section(pageContent,"보관 중인 파일",count==0?"":String.valueOf(count));
        if(count==0)empty(pageContent,R.drawable.ic_ui_folder,"아직 받은 파일이 없어요","PC에서 파일을 보내면 이곳에 모아둘게요.");
        for(int i=0;i<Math.min(saved.length(),visibleSaved);i++){
            JSONObject job=saved.optJSONObject(i);if(job==null)continue;JSONArray artifacts=job.optJSONArray("artifacts");if(artifacts==null)continue;
            for(int j=0;j<artifacts.length();j++){JSONObject artifact=artifacts.optJSONObject(j);if(artifact!=null)drawArtifact(pageContent,job.optString("id"),artifact);}
        }
        if(saved.length()>visibleSaved)button(pageContent,"파일 더 보기",false).setOnClickListener(v->{visibleSaved+=15;draw();});
    }
    private void drawFolderCard(LinearLayout parent,boolean controls){
        boolean selected=getPreferences(0).getString("export_tree",null)!=null;
        LinearLayout card=card(parent);LinearLayout heading=row();heading.setGravity(Gravity.CENTER_VERTICAL);heading.addView(icon(R.drawable.ic_ui_folder,PURPLE),new LinearLayout.LayoutParams(dp(22),dp(22)));
        TextView text=label("실제 휴대폰 폴더",15,TEXT,true);LinearLayout.LayoutParams textParams=new LinearLayout.LayoutParams(0,-2,1);textParams.leftMargin=dp(9);heading.addView(text,textParams);card.addView(heading);
        card.addView(label(selected?SyncEngine.selectedFolderLabel(this):"저장 폴더를 아직 선택하지 않았어요.",14,selected?PURPLE:MUTED,false));
        card.addView(label(selected?"앱 내부 저장과 별도로 이 폴더에도 복사해요. 복사 표시는 마지막 확인 기준입니다.":"지금은 앱 안에만 보관돼요. ‘내 파일’에서도 보려면 폴더를 선택해 주세요.",12,MUTED,false));
        if(controls){folderCopy=new CheckBox(this);folderCopy.setText("선택한 폴더에도 결과 복사");folderCopy.setTextColor(TEXT);folderCopy.setTextSize(14);folderCopy.setMinHeight(dp(48));folderCopy.setChecked(selected);folderCopy.setEnabled(!busy);card.addView(folderCopy);folderCopy.setOnClickListener(v->{if(busy)return;if(folderCopy.isChecked())chooseFolder();else clearFolder();});}
        folderButton=button(card,selected?"저장 폴더 변경":"갤럭시 저장 폴더 선택",false);folderButton.setEnabled(!busy);folderButton.setOnClickListener(v->chooseFolder());
        String exportError=getPreferences(0).getString("export_error","");if(!exportError.isEmpty())card.addView(label("폴더 복사 확인 필요 · "+exportError,12,ERROR,false));
    }
    private void drawArtifact(LinearLayout parent,String jobId,JSONObject artifact){
        String filename=artifact.optString("filename","파일");boolean present=SyncEngine.hasLocalArtifact(this,jobId,artifact);boolean apk=ApkInstaller.isApk(filename);
        LinearLayout card=card(parent);LinearLayout line=row();line.setGravity(Gravity.CENTER_VERTICAL);
        ImageView symbol=icon(apk?R.drawable.ic_ui_apk:R.drawable.ic_ui_file,apk?PURPLE:CYAN);symbol.setPadding(dp(10),dp(10),dp(10),dp(10));symbol.setBackground(shape(0xff1a2a41,14,0));line.addView(symbol,new LinearLayout.LayoutParams(dp(44),dp(44)));
        LinearLayout names=column();LinearLayout.LayoutParams namesParams=new LinearLayout.LayoutParams(0,-2,1);namesParams.leftMargin=dp(12);line.addView(names,namesParams);names.addView(label(filename,15,TEXT,true));
        names.addView(label(UploadSender.describeBytes(artifact.optLong("bytes",0)),12,MUTED,false));card.addView(line);
        card.addView(label(present?"●  앱 내부 저장 완료":"○  앱 내부 파일 확인 필요",12,present?CYAN:ERROR,false));
        SyncEngine.ExternalCopyState copy=SyncEngine.externalCopyState(this,jobId,artifact);
        String copyText;int copyColor=MUTED;
        switch(copy){case COPIED:copyText="●  선택 폴더 복사 확인됨";copyColor=PURPLE;break;case FAILED:copyText="!  폴더 복사 실패 · "+SyncEngine.externalCopyError(this,jobId,artifact);copyColor=ERROR;break;case PENDING:copyText="○  선택 폴더 복사 대기";break;default:copyText="○  실제 폴더 저장 꺼짐";}
        card.addView(label(copyText,12,copyColor,false));
        Button open=button(card,apk?"APK 설치":"파일 열기",false);open.setEnabled(!busy&&present);open.setOnClickListener(v->openArtifact(jobId,artifact));
    }
    private void drawRecentJobs(){
        if(recentJobs==null)return;recentJobs.removeAllViews();
        if(!detailId.isEmpty()){drawJobDetail(recentJobs);return;}
        title(recentJobs,"최근 작업","작업을 눌러 진행 내용과 결과를 확인하세요.");
        if(displayedJobs.length()==0){empty(recentJobs,R.drawable.ic_ui_inbox,"최근 작업이 없어요","PC에서 요청한 작업이 이곳에 표시돼요.");return;}
        for(int i=0;i<Math.min(displayedJobs.length(),visibleRecent);i++){
            JSONObject job=displayedJobs.optJSONObject(i);if(job==null)continue;
            LinearLayout row=row();row.setGravity(Gravity.CENTER_VERTICAL);row.setPadding(dp(16),dp(12),dp(12),dp(12));row.setMinimumHeight(dp(72));row.setBackground(ripple(SURFACE,18,BORDER));row.setTag("recent_job_"+job.optString("id"));row.setFocusable(true);
            TextView title=label(jobTitle(job),16,TEXT,true);row.addView(title,new LinearLayout.LayoutParams(0,-2,1));LinearLayout.LayoutParams arrowParams=new LinearLayout.LayoutParams(dp(20),dp(20));arrowParams.leftMargin=dp(12);row.addView(icon(R.drawable.ic_ui_chevron,MUTED),arrowParams);
            row.setOnClickListener(v->{if(busy)return;rememberViewState();detailId=job.optString("id");detailScroll=0;draw();});
            LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.topMargin=dp(10);recentJobs.addView(row,params);
        }
        if(displayedJobs.length()>visibleRecent)button(recentJobs,"작업 더 보기",false).setOnClickListener(v->{visibleRecent+=30;draw();});
    }
    private void drawJobDetail(LinearLayout parent){
        parent.setTag("job_detail");Button back=button(parent,"‹  최근 작업",false);back.setContentDescription("돌아가기");back.setOnClickListener(v->{if(busy)return;rememberViewState();detailId="";draw();});
        JSONObject job=null;for(int i=0;i<displayedJobs.length();i++){JSONObject candidate=displayedJobs.optJSONObject(i);if(candidate!=null&&detailId.equals(candidate.optString("id"))){job=candidate;break;}}
        if(job==null){empty(parent,R.drawable.ic_ui_inbox,"작업을 찾을 수 없어요","최근 작업 목록을 다시 확인해 주세요.");return;}
        title(parent,jobTitle(job),time(job.optString("createdAt")));
        LinearLayout stateCard=card(parent);stateCard.addView(label(stateLabel(job),16,CYAN,true));String error=job.optString("error","");if(!error.isEmpty())stateCard.addView(label(error,13,ERROR,false));
        JSONObject request=job.optJSONObject("request");
        if(request!=null){LinearLayout requestCard=card(parent);requestCard.addView(label("요청 내용",16,TEXT,true));
            String[] keys={"instruction","editInstruction","goal","query","filename","startAt","deadlineAt"};String[] labels={"수정 목표","수정 요청","원하는 결과","검색 요청","파일","시작 시각","완료 기한"};
            for(int i=0;i<keys.length;i++){String value=request.optString(keys[i],"");if(!value.isEmpty())requestCard.addView(label(labels[i]+"\n"+(("startAt".equals(keys[i])||"deadlineAt".equals(keys[i]))?time(value):value),13,MUTED,false));}
            JSONObject source=job.optJSONObject("source");if(source!=null){String sourceName=source.optString("filename",source.optString("name",""));if(!sourceName.isEmpty())requestCard.addView(label("원본\n"+sourceName,13,MUTED,false));}
            JSONArray criteria=request.optJSONArray("criteria");if(criteria!=null&&criteria.length()>0){requestCard.addView(label("검토 기준",13,TEXT,true));for(int i=0;i<criteria.length();i++)requestCard.addView(label("• "+criteria.optString(i),13,MUTED,false));}
        }
        JSONArray events=job.optJSONArray("events");if(events!=null&&events.length()>0){section(parent,"진행 기록","");LinearLayout timeline=card(parent);for(int i=0;i<events.length();i++){JSONObject event=events.optJSONObject(i);if(event==null)continue;timeline.addView(label(time(event.optString("at")),11,PURPLE,false));timeline.addView(label(event.optString("text",""),13,TEXT,false));if(i<events.length()-1)divider(timeline);}}
        JSONArray artifacts=job.optJSONArray("artifacts");if(artifacts!=null&&artifacts.length()>0){section(parent,"결과 파일",String.valueOf(artifacts.length()));for(int i=0;i<artifacts.length();i++){JSONObject artifact=artifacts.optJSONObject(i);if(artifact!=null)drawArtifact(parent,job.optString("id"),artifact);}}
    }
    private void drawUpload(JSONObject session){
        title(pageContent,"PC로 보내기","휴대폰에 있는 파일을 내 PC로 옮겨보세요.");LinearLayout card=card(pageContent);
        LinearLayout visual=row();visual.setGravity(Gravity.CENTER);ImageView send=icon(R.drawable.ic_ui_send,CYAN);send.setPadding(dp(18),dp(18),dp(18),dp(18));send.setBackground(shape(0xff123339,24,0));visual.addView(send,new LinearLayout.LayoutParams(dp(72),dp(72)));card.addView(visual);
        card.addView(label("보낼 파일을 선택해 주세요",18,TEXT,true));card.addView(label("최대 10MB · 휴대폰 원본은 그대로 유지해요. PC가 꺼져 있으면 서버에서 기다렸다가 연결 후 저장해요.",13,MUTED,false));
        UploadSender.Pending pending=null;boolean invalid=false;
        try{pending=UploadSender.load(this);}catch(Exception error){invalid=true;card.addView(label("전송 준비 정보를 읽지 못했습니다. 대기를 취소한 뒤 다시 선택해 주세요.",13,ERROR,false));}
        if(pending==null&&!invalid){uploadPickButton=button(card,"PC로 보낼 파일 선택",true);uploadPickButton.setEnabled(!busy);uploadPickButton.setOnClickListener(v->chooseUpload());}
        else{
            if(pending!=null){divider(card);card.addView(label(pending.filename,16,TEXT,true));card.addView(label(UploadSender.describeBytes(pending.bytes),13,PURPLE,false));boolean matching=pending.belongsTo(session);
                card.addView(label(matching?"전송할 복사본이 준비됐어요. 이름과 크기를 확인한 뒤 보내주세요.":"이전 PC 연결에서 준비한 파일입니다. 대기를 취소하고 다시 선택해 주세요.",13,MUTED,false));
                uploadSendButton=button(card,"PC로 보내기 / 재시도",true);uploadSendButton.setEnabled(!busy&&matching);uploadSendButton.setOnClickListener(v->sendUpload());}
            uploadCancelButton=button(card,"전송 대기 취소",false);uploadCancelButton.setEnabled(!busy);uploadCancelButton.setOnClickListener(v->confirmDiscardUpload());
        }
        section(pageContent,"최근 보낸 파일","");int count=0;
        for(int i=0;i<displayedJobs.length()&&count<5;i++){JSONObject job=displayedJobs.optJSONObject(i);if(job==null||!"upload".equals(job.optString("kind")))continue;count++;LinearLayout item=card(pageContent);item.addView(label(jobTitle(job),14,TEXT,true));item.addView(label(uploadState(job.optString("state")),13,"failed".equals(job.optString("state"))?ERROR:CYAN,false));if("pc_saved".equals(job.optString("state")))item.addView(label("PC 파일 저장과 무결성 확인 완료",12,MUTED,false));if("failed".equals(job.optString("state")))item.addView(label(job.optString("error","파일을 다시 선택해 보내 주세요."),12,ERROR,false));}
        if(count==0)pageContent.addView(label("아직 PC로 보낸 파일이 없어요.",13,MUTED,false));
    }
    private void drawSettings(JSONObject session){
        title(pageContent,"설정","연결과 파일 저장 방식을 관리하세요.");
        LinearLayout connection=card(pageContent);connection.addView(label("PC 연결",16,TEXT,true));connection.addView(label(session.optString("baseUrl"),13,MUTED,false));
        disconnectButton=button(connection,"연결 해제",false);disconnectButton.setEnabled(!busy);disconnectButton.setOnClickListener(v->{if(busy)return;new AlertDialog.Builder(this).setTitle("PC 연결을 해제할까요?").setMessage("앱에 저장한 파일은 유지됩니다. 다시 연결하려면 새 연결 코드가 필요해요.").setNegativeButton("유지",null).setPositiveButton("연결 해제",(dialog,which)->{if(busy)return;foregroundRefresh.stop();secureStore.clear();displayedSession=null;displayedJobs=new JSONArray();detailId="";selectedTab=FILES;SyncScheduler.configure(this);draw();}).show();});
        LinearLayout automatic=card(pageContent);automatic.addView(label("자동 수신",16,TEXT,true));autoReceive=new CheckBox(this);autoReceive.setText("앱을 닫아도 새 파일 자동 받기");autoReceive.setTextColor(TEXT);autoReceive.setTextSize(14);autoReceive.setMinHeight(dp(48));autoReceive.setChecked(getPreferences(0).getBoolean("auto_receive",true));autoReceive.setEnabled(!busy);automatic.addView(autoReceive);
        autoReceive.setOnCheckedChangeListener((v,checked)->{getPreferences(0).edit().putBoolean("auto_receive",checked).apply();SyncScheduler.configure(this);showStatus(checked?"자동 수신을 켰습니다.":"백그라운드 자동 수신을 껐습니다.",false);});
        pushStatus=label("빠른 수신  ·  "+getSharedPreferences("settings",0).getString("push_status","연결 확인 중"),12,CYAN,false);automatic.addView(pushStatus);automatic.addView(label("알림을 받으면 파일 저장을 시작해요. 네트워크와 휴대폰 절전 설정에 따라 완료 시점이 달라질 수 있어요.",12,MUTED,false));
        drawFolderCard(pageContent,true);
        LinearLayout health=card(pageContent);health.addView(label("동기화 상태",16,TEXT,true));health.addView(label("마지막 동기화\n"+time(getPreferences(0).getString("last_sync","")),13,MUTED,false));
        String lastError=getPreferences(0).getString("last_error","");health.addView(label(lastError.isEmpty()?"최근 동기화 오류 없음":"동기화 확인 필요\n"+lastError,12,lastError.isEmpty()?CYAN:ERROR,false));
        String copyError=getPreferences(0).getString("export_error","");if(!copyError.isEmpty())health.addView(label("실제 폴더 복사 오류\n"+copyError,12,ERROR,false));
        TextView version=label("DIANA  "+BuildConfig.VERSION_NAME,12,MUTED,false);version.setGravity(Gravity.CENTER);pageContent.addView(version);
    }
    private LinearLayout column(){LinearLayout layout=new LinearLayout(this);layout.setOrientation(LinearLayout.VERTICAL);return layout;}
    private LinearLayout row(){LinearLayout layout=new LinearLayout(this);layout.setOrientation(LinearLayout.HORIZONTAL);return layout;}
    private TextView label(String value,int size,int color,boolean bold){TextView view=new TextView(this);view.setText(value);view.setTextSize(size);view.setTextColor(color);view.setPadding(0,dp(5),0,dp(5));view.setLineSpacing(dp(2),1);if(bold)view.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));return view;}
    private void title(LinearLayout parent,String title,String subtitle){TextView heading=label(title,27,TEXT,true);heading.setPadding(0,dp(12),0,dp(3));parent.addView(heading);if(!subtitle.isEmpty())parent.addView(label(subtitle,13,MUTED,false));}
    private void section(LinearLayout parent,String name,String count){LinearLayout line=row();line.setGravity(Gravity.CENTER_VERTICAL);line.setPadding(0,dp(16),0,dp(2));line.addView(label(name,17,TEXT,true),new LinearLayout.LayoutParams(0,-2,1));if(!count.isEmpty())line.addView(label(count,13,PURPLE,true));parent.addView(line);}
    private LinearLayout card(LinearLayout parent){LinearLayout card=column();card.setPadding(dp(16),dp(14),dp(16),dp(14));card.setBackground(shape(SURFACE,20,BORDER));LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.topMargin=dp(12);parent.addView(card,params);return card;}
    private GradientDrawable shape(int fill,int radius,int stroke){GradientDrawable drawable=new GradientDrawable();drawable.setColor(fill);drawable.setCornerRadius(dp(radius));if(stroke!=0)drawable.setStroke(dp(1),stroke);return drawable;}
    private RippleDrawable ripple(int fill,int radius,int stroke){return new RippleDrawable(ColorStateList.valueOf(0x244ce0d6),shape(fill,radius,stroke),shape(Color.WHITE,radius,0));}
    private android.graphics.drawable.Drawable tinted(int resource,int color){android.graphics.drawable.Drawable drawable=getDrawable(resource).mutate();drawable.setTint(color);return drawable;}
    private ImageView icon(int resource,int color){ImageView image=new ImageView(this);image.setImageResource(resource);image.setImageTintList(ColorStateList.valueOf(color));image.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);return image;}
    private Button button(LinearLayout parent,String text,boolean primary){Button view=new Button(this);view.setText(text);view.setTextSize(14);view.setAllCaps(false);view.setTextColor(primary?0xff072a2c:TEXT);view.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));view.setGravity(Gravity.CENTER);view.setPadding(dp(16),dp(10),dp(16),dp(10));view.setMinHeight(dp(50));view.setMinimumHeight(dp(50));view.setBackgroundTintList(null);view.setBackground(ripple(primary?CYAN:0xff1b2b42,14,primary?0:BORDER));LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.topMargin=dp(10);parent.addView(view,params);return view;}
    private EditText field(LinearLayout parent,String hint,int type){EditText field=new EditText(this);field.setTextSize(15);field.setSingleLine(true);field.setHint(hint);field.setInputType(type);field.setTextColor(TEXT);field.setHintTextColor(MUTED);field.setPadding(dp(14),dp(12),dp(14),dp(12));field.setMinHeight(dp(54));field.setBackgroundTintList(null);field.setBackground(shape(BG,12,BORDER));LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.topMargin=dp(12);parent.addView(field,params);return field;}
    private void divider(LinearLayout parent){View line=new View(this);line.setBackgroundColor(BORDER);LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,dp(1));params.topMargin=dp(8);params.bottomMargin=dp(8);parent.addView(line,params);}
    private void empty(LinearLayout parent,int icon,String heading,String copy){LinearLayout card=card(parent);ImageView image=icon(icon,PURPLE);card.addView(image,new LinearLayout.LayoutParams(dp(30),dp(30)));card.addView(label(heading,17,TEXT,true));card.addView(label(copy,13,MUTED,false));}
    private static String time(String value){if(value==null||value.isEmpty())return "아직 없음";try{return DateTimeFormatter.ofPattern("M. d. HH:mm",Locale.KOREA).withZone(ZoneId.systemDefault()).format(Instant.parse(value));}catch(Exception ignored){return value;}}
    private static String jobTitle(JSONObject job){JSONObject request=job.optJSONObject("request");if(request==null)return job.optString("title","작업");String kind=job.optString("kind");return request.optString("upload".equals(kind)?"filename":"overnight".equals(kind)?"subject":"query",job.optString("title","작업"));}
    private static String stateLabel(JSONObject job){String state=job.optString("state");if("upload".equals(job.optString("kind")))return uploadState(state);switch(state){case "scheduled":return "예약됨";case "processing":return "작업 중";case "needs_attention":return "확인이 필요합니다";case "awaiting_phone":return "결과 수신 대기";case "download_ready":return job.optString("phoneSavedAt").isEmpty()?"결과 준비 완료":"휴대폰 수신 기록 있음";case "failed":return "작업 실패";case "deadline_exceeded":return "완료 기한 지남";case "submitted":return "전달 요청됨";case "send_unknown":return "전달 상태 확인 필요";case "dry_run":return "준비 완료";default:return state.isEmpty()?"상태 확인 중":state;}}
    private static String uploadState(String state){switch(state){case "waiting_pc":return "PC 연결·저장 대기";case "receiving_pc":return "PC에 저장 중";case "pc_saved":return "PC 저장 완료";case "failed":return "PC 저장 실패";default:return "PC 전송 상태 확인 중";}}
    private static boolean sameSession(JSONObject left,JSONObject right){return left!=null&&right!=null&&left.optString("baseUrl").equals(right.optString("baseUrl"))&&left.optString("phoneId").equals(right.optString("phoneId"))&&left.optString("phoneToken").equals(right.optString("phoneToken"));}
    private void readUploadStatuses(ForegroundRefresh.Completion completion){
        final JSONObject session;try{session=secureStore.load();}catch(Exception error){completion.finish(false,false,null);return;}if(session==null){completion.finish(false,false,null);return;}
        try{worker.execute(()->{try{JSONArray remote=Api.request(session,"/api/jobs",null).getJSONArray("jobs");boolean pending=false;for(int i=0;i<remote.length();i++){JSONObject job=remote.optJSONObject(i);if(job!=null&&"upload".equals(job.optString("kind"))&&("waiting_pc".equals(job.optString("state"))||"receiving_pc".equals(job.optString("state"))))pending=true;}final boolean waiting=pending;main.post(()->{if(alive())completion.finish(waiting,false,()->applyUploadStatuses(session,remote));});}catch(Exception error){main.post(()->{if(alive())completion.finish(false,true,null);});}});}catch(RejectedExecutionException ignored){completion.finish(false,false,null);}
    }
    private void applyUploadStatuses(JSONObject session,JSONArray remote){
        try{if(!alive()||!sameSession(session,secureStore.load()))return;JSONArray combined=mergeUploadStatuses(displayedJobs,remote);if(combined.toString().equals(displayedJobs.toString()))return;displayedJobs=combined;if(!busy&&(selectedTab==SEND||selectedTab==RECENT))draw();}catch(Exception ignored){/* Keep the last authenticated visible state. */}
    }
    private static JSONArray mergeUploadStatuses(JSONArray base,JSONArray observed){
        java.util.Map<String,JSONObject> uploads=new java.util.LinkedHashMap<>();for(int i=0;i<observed.length();i++){JSONObject job=observed.optJSONObject(i);if(job!=null&&"upload".equals(job.optString("kind")))uploads.put(job.optString("id"),job);}
        JSONArray updated=new JSONArray();java.util.Set<String> seen=new java.util.HashSet<>();for(int i=0;i<base.length();i++){JSONObject old=base.optJSONObject(i);if(old==null)continue;String id=old.optString("id");seen.add(id);JSONObject fresh=uploads.get(id);updated.put(fresh!=null&&fresh.optString("updatedAt").compareTo(old.optString("updatedAt"))>=0?fresh:old);}
        JSONArray combined=new JSONArray();for(JSONObject job:uploads.values())if(!seen.contains(job.optString("id")))combined.put(job);for(int i=0;i<updated.length();i++)combined.put(updated.opt(i));return combined;
    }
    private void uploadBusy(boolean value){busy=value;for(Button control:new Button[]{pairButton,syncButton,disconnectButton,folderButton,uploadPickButton,uploadSendButton,uploadCancelButton})if(control!=null)control.setEnabled(!value);if(autoReceive!=null)autoReceive.setEnabled(!value);if(folderCopy!=null)folderCopy.setEnabled(!value);}
    private void uploadFinished(String message,boolean error){main.post(()->{busy=false;if(!alive())return;draw();showStatus(message,error);if(resumed)foregroundRefresh.refresh();});}
    private void chooseUpload(){if(busy)return;try{if(UploadSender.load(this)!=null)return;Intent choose=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);uploadBusy(true);startActivityForResult(choose,PICK_UPLOAD);}catch(Exception error){uploadBusy(false);showStatus("파일 선택 화면을 열지 못했습니다.",true);}}
    private void prepareUpload(Uri uri){uploadBusy(true);showStatus("파일의 크기와 해시를 확인하고 있습니다…",false);worker.execute(()->{try{JSONObject session=secureStore.load();if(session==null)throw new UploadSender.UploadException("휴대폰을 PC에 다시 연결해 주세요.");UploadSender.prepare(this,uri,session);uploadFinished("파일이 준비됐습니다. 이름과 크기를 확인한 뒤 보내주세요.",false);}catch(Exception error){uploadFinished(error instanceof UploadSender.UploadException?error.getMessage():"선택한 파일을 준비하지 못했습니다. 다시 선택해 주세요.",true);}});}
    private void sendUpload(){if(busy)return;uploadBusy(true);showStatus("선택한 파일을 서버로 전송하고 있습니다…",false);worker.execute(()->{try{JSONObject session=secureStore.load();if(session==null)throw new UploadSender.UploadException("휴대폰을 PC에 다시 연결해 주세요.");JSONObject job=UploadSender.send(this,session);try{JSONArray previous=SyncEngine.cachedJobs(this),jobs=new JSONArray().put(job);for(int i=0;i<previous.length();i++){JSONObject old=previous.optJSONObject(i);if(old!=null&&!job.getString("id").equals(old.optString("id")))jobs.put(old);}SyncEngine.cache(this,new JSONObject().put("jobs",jobs));}catch(Exception ignored){}boolean failed="failed".equals(job.optString("state"));uploadFinished(failed?job.optString("error","PC에 저장하지 못했습니다. 다시 보내 주세요."):"pc_saved".equals(job.optString("state"))?"PC 파일 저장과 무결성 확인을 완료했습니다.":"서버가 파일을 받았습니다. PC 저장 상태를 자동으로 확인합니다.",failed);}catch(Exception error){uploadFinished(error instanceof UploadSender.UploadException||error instanceof Api.ApiException?error.getMessage():"파일 전송을 확인하지 못했습니다. 준비된 파일로 재시도해 주세요.",true);}});}
    private void confirmDiscardUpload(){if(busy)return;new AlertDialog.Builder(this).setTitle("전송 대기를 취소할까요?").setMessage("앱의 전송 준비만 지웁니다. 휴대폰 원본은 유지되며, 이미 서버에 도착한 파일은 취소되지 않습니다.").setNegativeButton("유지",null).setPositiveButton("대기 취소",(dialog,which)->{if(busy)return;uploadBusy(true);worker.execute(()->{try{UploadSender.discard(this);uploadFinished("전송 대기를 취소했습니다.",false);}catch(Exception error){uploadFinished("전송 준비를 정리하지 못했습니다. 다시 시도해 주세요.",true);}});}).show();}
    private void pair(){
        if(busy||urlField==null||codeField==null)return;String base=urlField.getText().toString().trim(),code=codeField.getText().toString().trim();rememberViewState();
        if(!code.matches("[0-9]{6}")){showStatus("6자리 코드를 확인하세요.",true);return;}uploadBusy(true);showStatus("안전하게 연결하는 중…",false);
        worker.execute(()->{try{String safeBase=Api.validateBase(base,BuildConfig.DEBUG);JSONObject response=Api.request(safeBase,"/api/phone/pair",null,new JSONObject().put("code",code).put("deviceName",Build.MANUFACTURER+" "+Build.MODEL));JSONObject session=new JSONObject().put("baseUrl",safeBase).put("phoneToken",response.getString("phoneToken")).put("phoneId",response.getString("phoneId")).put("firebase",response.optJSONObject("firebase"));secureStore.save(session);PushSupport.initialize(this);SyncScheduler.configure(this);main.post(()->{busy=false;if(!alive())return;codeDraft="";codeField=null;draw();showStatus("휴대폰을 연결했습니다.",false);if(resumed){foregroundRefresh.start();foregroundRefresh.refresh();}});}catch(Exception error){main.post(()->{busy=false;if(!alive())return;draw();showStatus(error.getMessage()==null?"연결에 실패했습니다.":error.getMessage(),true);});}});
    }
    private void syncNow(){if(busy)return;uploadBusy(true);showStatus("작업 결과를 확인하고 있습니다…",false);worker.execute(()->{try{int count=SyncEngine.sync(this,()->Thread.currentThread().isInterrupted());uploadFinished(count>0?count+"개 결과를 앱에 저장하고 검증했습니다.":"작업 상태와 저장 폴더를 확인했습니다.",false);}catch(Exception error){uploadFinished(error.getMessage()==null?"동기화에 실패했습니다.":error.getMessage(),true);}});}
    private void chooseFolder(){if(busy)return;try{Intent choose=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);startActivityForResult(choose,PICK_FOLDER);}catch(Exception error){showStatus("저장 폴더 선택 화면을 열지 못했습니다.",true);}}
    @Override protected void onActivityResult(int code,int result,@Nullable Intent data){
        super.onActivityResult(code,result,data);
        if(code==PICK_UPLOAD){if(result==Activity.RESULT_OK&&data!=null&&data.getData()!=null)prepareUpload(data.getData());else{busy=false;draw();showStatus("파일 선택을 취소했습니다.",false);}}
        else if(code==PICK_FOLDER){if(result==Activity.RESULT_OK&&data!=null&&data.getData()!=null){Uri uri=data.getData();try{int flags=data.getFlags()&(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);if((flags&Intent.FLAG_GRANT_WRITE_URI_PERMISSION)==0)throw new SecurityException();getContentResolver().takePersistableUriPermission(uri,flags);getPreferences(0).edit().putString("export_tree",uri.toString()).remove("export_error").apply();draw();syncNow();}catch(Exception error){draw();showStatus("폴더 권한을 저장하지 못했습니다. 쓰기 가능한 폴더를 다시 선택해 주세요.",true);}}else draw();}
    }
    private void clearFolder(){if(busy)return;String previous=getPreferences(0).getString("export_tree",null);if(previous!=null){try{getContentResolver().releasePersistableUriPermission(Uri.parse(previous),Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);}catch(Exception ignored){}getPreferences(0).edit().remove("export_tree").remove("export_error").apply();}draw();showStatus("실제 폴더 복사를 껐습니다. 앱 내부 파일은 유지됩니다.",false);}
    private void openArtifact(String jobId,JSONObject artifact){
        if(busy)return;try{File file=FileSafety.artifact(getFilesDir(),jobId,artifact.getString("id"),artifact.getString("filename"));if(!SyncEngine.verified(file,artifact))throw new Exception("파일 무결성 확인이 필요합니다. 다시 동기화해 주세요.");if(ApkInstaller.isApk(artifact.getString("filename"))){ApkInstaller.open(this,file);return;}Uri uri=FileProvider.getUriForFile(this,getPackageName()+".files",file);String mime=artifact.optString("mime","");if(mime.isEmpty()||"application/octet-stream".equals(mime)){String extension=MimeTypeMap.getFileExtensionFromUrl(Uri.encode(artifact.optString("filename"))).toLowerCase(Locale.ROOT);String guessed=MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);mime=guessed==null?"application/octet-stream":guessed;}Intent open=new Intent(Intent.ACTION_VIEW).setDataAndType(uri,mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);startActivity(Intent.createChooser(open,"파일을 열 앱 선택"));}catch(Exception error){showStatus(error.getMessage()==null?"파일을 열 수 없습니다. 파일을 열 앱을 확인해 주세요.":error.getMessage(),true);}
    }
    private void showStatus(String message,boolean error){if(!alive())return;statusMessage=message==null?"":message;statusError=error;if(status!=null){status.setText(statusMessage);status.setTextColor(error?ERROR:CYAN);status.setVisibility(statusMessage.isEmpty()?View.GONE:View.VISIBLE);}}
}
