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
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.MimeTypeMap;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
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
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** First-party companion. Connection credentials remain in Android Keystore. */
public final class MainActivity extends Activity {
    private static final int PICK_FOLDER=2201, PICK_UPLOAD=2203;
    private static final int HOME=0, FILES=1, SEND=2, RECENT=3, SETTINGS=4, FINANCE=5;
    private static final int BG=0xff080f1c, SURFACE=0xff111d30, BORDER=0xff24334b;
    private static final int TEXT=0xfff4f7ff, MUTED=0xff98abc3, CYAN=0xff4ce0d6, PURPLE=0xffae9bff, ERROR=0xffff9d9d;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final Handler main=new Handler(Looper.getMainLooper());
    private final Runnable revealFocusedInput=this::scrollFocusedInput;
    private final int[] pageScroll=new int[6];
    private JSONObject financeData, financeSession;
    private String financeMessage="상태를 확인하고 있습니다…";
    private ForegroundRefresh financeRefresh;
    private FinanceScreen financeScreen;
    private ForegroundRefresh foregroundRefresh;
    private SecureStore secureStore;
    private LinearLayout root, recentJobs, pageContent;
    private ScrollView scroll;
    private PopupWindow menuPopup;
    private TextView status, pushStatus;
    private EditText urlField, codeField, requestQueryField, requestEditField, requestChatField;
    private String requestChatKey="";
    private Button pairButton, syncButton, folderButton, disconnectButton, uploadPickButton, uploadSendButton, uploadCancelButton, requestSubmitButton, requestDiscardButton;
    private CheckBox autoReceive, folderCopy;
    private JSONArray displayedJobs=new JSONArray();
    private JSONObject displayedSession;
    private volatile boolean busy;
    private boolean resumed, renderQueued, statusError, drawerRefreshPending, showPhoneUpload, imeVisible, deferredInputRender;
    private int selectedTab=HOME, renderedTab=HOME, visibleSaved=15, visibleRecent=30, detailScroll;
    private String detailId="", renderedDetailId="", urlDraft="", codeDraft="", requestQueryDraft="", requestEditDraft="", statusMessage="";
    private final SharedPreferences.OnSharedPreferenceChangeListener settingsChanged=(preferences,key)->{
        // These preferences belong to file sync/settings, not the financial
        // status screen. A sync heartbeat must not replace its scroll view.
        if(!resumed||requestPage())return;
        if("push_status".equals(key)||"last_sync".equals(key)||"last_error".equals(key)||"export_error".equals(key)||"export_tree".equals(key)||"latest_receive_v1".equals(key))queueRender();
    };

    @Override protected void onCreate(@Nullable Bundle state) {
        super.onCreate(state);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        requestQueryDraft=getPreferences(0).getString("pc_query_draft","");requestEditDraft=getPreferences(0).getString("pc_edit_draft","");
        if(state!=null){
            boolean oldTabs=state.getInt("routeVersion",1)<2;
            selectedTab=Math.max(HOME,Math.min(FINANCE,state.getInt("tab",oldTabs?-1:HOME)+(oldTabs?1:0)));
            detailId=state.getString("detail","");urlDraft=state.getString("url","");codeDraft=state.getString("code","");
            requestQueryDraft=state.getString("pcQuery",requestQueryDraft);requestEditDraft=state.getString("pcEdit",requestEditDraft);showPhoneUpload=state.getBoolean("showPhoneUpload",false);
            visibleSaved=state.getInt("visibleSaved",15);visibleRecent=state.getInt("visibleRecent",30);
            detailScroll=state.getInt("detailScroll",0);int[] positions=state.getIntArray("pageScroll");
            if(positions!=null)System.arraycopy(positions,0,pageScroll,oldTabs?1:0,Math.min(positions.length,oldTabs?4:6));
        }
        if(selectedTab==FINANCE)selectedTab=SEND;
        secureStore=new SecureStore(this);
        foregroundRefresh=new ForegroundRefresh(new ForegroundRefresh.Scheduler(){
            @Override public void post(Runnable task,long delay){main.postDelayed(task,delay);}
            @Override public void remove(Runnable task){main.removeCallbacks(task);}
        },()->busy,this::readJobStatuses);
        financeRefresh=new ForegroundRefresh(new ForegroundRefresh.Scheduler(){public void post(Runnable r,long d){main.postDelayed(r,d);}public void remove(Runnable r){main.removeCallbacks(r);}},()->busy,this::readFinanceStatuses);
        Notifications.ensureChannel(this);
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},2202);
        SyncScheduler.configure(this);draw();
    }
    @Override protected void onSaveInstanceState(Bundle state){
        rememberViewState();state.putInt("routeVersion",2);state.putInt("tab",selectedTab);state.putString("detail",detailId);
        state.putString("url",urlDraft);state.putString("code",codeDraft);state.putIntArray("pageScroll",pageScroll);
        state.putString("pcQuery",requestQueryDraft);state.putString("pcEdit",requestEditDraft);state.putBoolean("showPhoneUpload",showPhoneUpload);
        state.putInt("detailScroll",detailScroll);state.putInt("visibleSaved",visibleSaved);state.putInt("visibleRecent",visibleRecent);
        super.onSaveInstanceState(state);
    }
    @Override protected void onResume(){
        super.onResume();resumed=true;
        getSharedPreferences("settings",0).registerOnSharedPreferenceChangeListener(settingsChanged);
        getPreferences(0).registerOnSharedPreferenceChangeListener(settingsChanged);
        PushSupport.initialize(this);if(!busy)draw();if(foregroundRefresh!=null)foregroundRefresh.start();
        if(requestPage())financeRefresh.start();
    }
    @Override protected void onPause(){
        rememberViewState();resumed=false;dismissMenu();
        getSharedPreferences("settings",0).unregisterOnSharedPreferenceChangeListener(settingsChanged);
        getPreferences(0).unregisterOnSharedPreferenceChangeListener(settingsChanged);
        if(foregroundRefresh!=null)foregroundRefresh.stop();if(financeRefresh!=null)financeRefresh.stop();super.onPause();
    }
    @Override protected void onDestroy(){dismissMenu();if(foregroundRefresh!=null)foregroundRefresh.stop();if(financeRefresh!=null)financeRefresh.stop();main.removeCallbacksAndMessages(null);worker.shutdownNow();super.onDestroy();}
    @Override public void onBackPressed(){
        if(menuPopup!=null&&menuPopup.isShowing()){dismissMenu();return;}
        if(busy)return;
        if(!detailId.isEmpty()){rememberViewState();detailId="";draw();}
        else if(selectedTab!=HOME){navigate(HOME);}
        else super.onBackPressed();
    }
    private boolean alive(){return !isFinishing()&&!isDestroyed();}
    private int dp(float value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private void revealFocusedInputSoon(){main.removeCallbacks(revealFocusedInput);main.post(revealFocusedInput);}
    private void scrollFocusedInput(){
        if(!alive()||scroll==null||!scroll.isAttachedToWindow())return;
        View focused=getCurrentFocus();if(!(focused instanceof EditText)||!focused.isShown())return;
        EditText input=(EditText)focused;int margin=dp(12);Rect visible=new Rect(0,-margin,input.getWidth(),input.getHeight()+margin);
        if(visible.height()>scroll.getHeight()&&input.getLayout()!=null){
            int offset=Math.max(0,Math.min(input.getSelectionEnd(),input.length()));int line=input.getLayout().getLineForOffset(offset);
            visible.top=input.getTotalPaddingTop()+input.getLayout().getLineTop(line)-margin;
            visible.bottom=input.getTotalPaddingTop()+input.getLayout().getLineBottom(line)+margin;
        }
        input.requestRectangleOnScreen(visible,true);
    }
    private void rememberViewState(){
        if(urlField!=null)urlDraft=urlField.getText().toString();if(codeField!=null)codeDraft=codeField.getText().toString();
        if(requestChatField!=null&&!requestChatKey.isEmpty())getPreferences(0).edit().putString(requestChatKey,requestChatField.getText().toString()).apply();
        if(requestQueryField!=null){requestQueryDraft=requestQueryField.getText().toString();requestEditDraft=requestEditField==null?"":requestEditField.getText().toString();getPreferences(0).edit().putString("pc_query_draft",requestQueryDraft).putString("pc_edit_draft",requestEditDraft).apply();}
        if(scroll!=null){if(renderedDetailId.isEmpty())pageScroll[renderedTab]=scroll.getScrollY();else detailScroll=scroll.getScrollY();}
    }
    private void queueRender(){
        if(renderQueued)return;renderQueued=true;main.post(()->{renderQueued=false;if(resumed&&!busy&&alive())renderAutomatically();});
    }
    private boolean editingRequestWithKeyboard(){View focus=getCurrentFocus();return selectedTab==SEND&&detailId.isEmpty()&&focus!=null&&focus.hasFocus()&&(focus==requestQueryField||focus==requestEditField||focus==requestChatField)&&imeVisible;}
    private void renderAutomatically(){if(editingRequestWithKeyboard()){deferredInputRender=true;return;}draw();}
    private void resumeDeferredInputRender(){if(deferredInputRender&&!editingRequestWithKeyboard())queueRender();}
    private void resetViews(){
        financeScreen=null;
        root=null;recentJobs=null;pageContent=null;scroll=null;status=null;pushStatus=null;urlField=null;codeField=null;requestQueryField=null;requestEditField=null;requestChatField=null;requestChatKey="";
        pairButton=null;syncButton=null;folderButton=null;disconnectButton=null;uploadPickButton=null;uploadSendButton=null;uploadCancelButton=null;requestSubmitButton=null;requestDiscardButton=null;autoReceive=null;folderCopy=null;
    }
    private void draw(){
        if(menuPopup!=null&&menuPopup.isShowing()){drawerRefreshPending=true;return;}
        if(!alive())return;deferredInputRender=false;rememberViewState();resetViews();
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
            if(Build.VERSION.SDK_INT>=30){android.graphics.Insets safe=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout());int imeBottom=insets.getInsets(WindowInsets.Type.ime()).bottom;imeVisible=insets.isVisible(WindowInsets.Type.ime())&&imeBottom>0;int bottom=Math.max(safe.bottom,imeBottom);v.setPadding(safe.left,safe.top,safe.right,bottom);}
            else{v.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());Rect frame=new Rect();getWindow().getDecorView().getWindowVisibleDisplayFrame(frame);imeVisible=getResources().getDisplayMetrics().heightPixels-frame.bottom>dp(160);}
            v.post(()->{if(v.isAttachedToWindow()){revealFocusedInputSoon();resumeDeferredInputRender();}});
            return insets;
        });
        LinearLayout header=row();header.setPadding(dp(14),dp(10),dp(20),dp(8));header.setGravity(Gravity.CENTER_VERTICAL);header.setBaselineAligned(false);header.setMinimumHeight(dp(64));
        TextView menu=label("≡",30,TEXT,false);menu.setPadding(0,0,0,0);menu.setGravity(Gravity.CENTER);menu.setTag("menu_toggle");menu.setContentDescription("메뉴 열기");menu.setBackground(ripple(SURFACE,14,BORDER));menu.setFocusable(true);menu.setEnabled(session!=null);menu.setOnClickListener(v->showMenu(v));header.addView(menu,new LinearLayout.LayoutParams(dp(48),dp(48)));
        ImageView logo=new ImageView(this);logo.setImageResource(R.mipmap.ic_launcher);logo.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams logoParams=new LinearLayout.LayoutParams(dp(36),dp(36));logoParams.leftMargin=dp(10);header.addView(logo,logoParams);
        LinearLayout brand=column();LinearLayout.LayoutParams brandParams=new LinearLayout.LayoutParams(0,-2,1);brandParams.leftMargin=dp(8);header.addView(brand,brandParams);
        brand.addView(label("DIANA",20,TEXT,true));
        TextView badge=label(session==null?"연결 전":"●  연결됨",11,session==null?MUTED:CYAN,true);badge.setPadding(dp(10),dp(7),dp(10),dp(7));badge.setBackground(shape(session==null?SURFACE:0xff102e35,20,0));header.addView(badge);
        shell.addView(header,new LinearLayout.LayoutParams(-1,-2));
        scroll=new ScrollView(this);scroll.setFillViewport(true);scroll.setClipToPadding(false);scroll.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        scroll.addOnLayoutChangeListener((v,left,top,right,bottom,oldLeft,oldTop,oldRight,oldBottom)->{if(bottom-top!=oldBottom-oldTop||right-left!=oldRight-oldLeft)revealFocusedInputSoon();});
        root=column();root.setPadding(dp(20),dp(10),dp(20),dp(26));scroll.addView(root);shell.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        status=label(statusMessage,13,statusError?ERROR:CYAN,false);status.setVisibility(statusMessage.isEmpty()?View.GONE:View.VISIBLE);
        status.setPadding(dp(14),dp(10),dp(14),dp(10));status.setBackground(shape(SURFACE,12,BORDER));root.addView(status);
        pageContent=column();root.addView(pageContent);
        setContentView(shell);shell.requestApplyInsets();renderedTab=selectedTab;renderedDetailId=detailId;final ScrollView current=scroll;
        final int position=detailId.isEmpty()?pageScroll[selectedTab]:detailScroll;current.post(()->{if(alive()&&scroll==current)current.scrollTo(0,position);});
    }
    private void showMenu(View anchor){
        if(busy||!alive())return;if(menuPopup!=null&&menuPopup.isShowing()){dismissMenu();return;}
        LinearLayout drawer=column();drawer.setTag("app_drawer");drawer.setPadding(dp(12),dp(10),dp(12),dp(12));drawer.setBackground(techPanel(0xff1b2c46,0xff0b1527,0xff405779,false));drawer.addView(label("메뉴",17,TEXT,true));divider(drawer);
        String[] titles={"홈","보관 파일","PC에 요청하기","최근 작업","설정"};String[] tags={"menu_home","menu_files","menu_pc_sync","menu_recent","menu_settings"};
        int[] icons={R.drawable.ic_ui_home,R.drawable.ic_ui_folder,R.drawable.ic_ui_refresh,R.drawable.ic_ui_inbox,R.drawable.ic_ui_settings};
        for(int index=0;index<titles.length;index++){
            final int tab=index;boolean active=selectedTab==index;LinearLayout item=row();item.setGravity(Gravity.CENTER_VERTICAL);item.setPadding(dp(12),dp(10),dp(12),dp(10));item.setMinimumHeight(dp(50));item.setTag(tags[index]);item.setContentDescription(titles[index]);item.setSelected(active);item.setFocusable(true);item.setBackground(ripple(active?0xff132d38:SURFACE,12,0));
            ImageView symbol=icon(icons[index],active?CYAN:MUTED);symbol.setPadding(dp(7),dp(7),dp(7),dp(7));symbol.setBackground(shape(active?0xff16434b:0xff14233b,10,active?0xff2c6973:0xff293c59));item.addView(symbol,new LinearLayout.LayoutParams(dp(34),dp(34)));TextView title=label(titles[index],15,active?CYAN:TEXT,active);LinearLayout.LayoutParams titleParams=new LinearLayout.LayoutParams(0,-2,1);titleParams.leftMargin=dp(12);item.addView(title,titleParams);item.setOnClickListener(v->navigate(tab));drawer.addView(item,new LinearLayout.LayoutParams(-1,-2));
        }
        int width=Math.min(dp(280),getResources().getDisplayMetrics().widthPixels-dp(28));PopupWindow popup=new PopupWindow(drawer,width,-2,true);menuPopup=popup;popup.setOutsideTouchable(true);popup.setBackgroundDrawable(shape(SURFACE,20,BORDER));popup.setElevation(dp(16));popup.setOnDismissListener(()->{if(menuPopup==popup)menuPopup=null;if(drawerRefreshPending){drawerRefreshPending=false;if(resumed)queueRender();}});popup.showAsDropDown(anchor,0,dp(8));
    }
    private void dismissMenu(){PopupWindow popup=menuPopup;if(popup!=null)popup.dismiss();}
    private boolean requestPage(){return selectedTab==SEND||selectedTab==FINANCE;}
    private void navigate(int tab){if(tab==FINANCE)tab=SEND;if(busy)return;dismissMenu();rememberViewState();selectedTab=tab;detailId="";draw();if(financeRefresh!=null){if(tab==SEND){financeRefresh.start();financeRefresh.refresh();}else financeRefresh.stop();}}
    private void drawConnected(JSONObject session)throws Exception{
        JSONArray cached=SyncEngine.cachedJobs(this);displayedJobs=sameSession(displayedSession,session)?mergeJobStatuses(cached,displayedJobs):cached;displayedSession=session;
        String[] tags={"screen_home","screen_files","screen_pc_sync","screen_recent","screen_settings","screen_finance"};pageContent.setTag(tags[selectedTab]);
        if(selectedTab==HOME)drawHome();else if(selectedTab==FILES)drawFiles();else if(selectedTab==SEND)drawPcRequest(session);else if(selectedTab==RECENT){recentJobs=column();pageContent.addView(recentJobs);drawRecentJobs();}else if(selectedTab==FINANCE)drawFinance(session);else drawSettings(session);
    }
    private void drawFinance(JSONObject session)throws Exception{
        financeScreen=new FinanceScreen();
        section(pageContent,"등록 문서 검토","PC에서 등록한 문서의 검토·보완·변환을 요청해요.");
        LinearLayout notice=card(pageContent);notice.addView(label("원문·근거·수정안·Diff는 PC에서 확인",15,TEXT,true));notice.addView(label("결과 파일은 PC 내부에 저장하며 휴대폰으로 전달하지 않습니다. 작업 요청과 최소 상태 정보는 기존 서버를 통해 전달됩니다.",13,MUTED,false));
        financeScreen.message=label(financeMessage,13,CYAN,false);notice.addView(financeScreen.message);Button refresh=button(notice,"상태 새로 확인",false);refresh.setTag("finance_refresh");refresh.setEnabled(!busy);refresh.setOnClickListener(v->financeRefresh.refresh());
        JSONObject pending;try{pending=FinanceRequests.pending(this);}catch(Exception damaged){pending=new JSONObject();}
        if(pending!=null){LinearLayout retry=card(pageContent);retry.addView(label("접수 여부를 확인할 요청이 있습니다",15,TEXT,true));Button b=button(retry,"같은 요청으로 재시도",true);b.setEnabled(!busy);b.setOnClickListener(v->financeSubmit(session,null,null,null,true));Button clear=button(retry,"이 기기의 재시도 기록 정리",false);clear.setEnabled(!busy);clear.setOnClickListener(v->new AlertDialog.Builder(this).setMessage("서버에 접수된 작업은 취소되지 않습니다. 목록에서 상태를 먼저 확인해 주세요.").setNegativeButton("유지",null).setPositiveButton("기록 정리",(d,w)->{try{FinanceRequests.discard(this);draw();}catch(Exception e){showStatus("기록을 정리하지 못했습니다.",true);}}).show());}
        financeScreen.body=column();pageContent.addView(financeScreen.body);bindFinance(session);
    }
    /** Polling retains the shell, scroll view, rows and active dialogs. */
    private static final class FinanceScreen {
        TextView message,online,seen,emptyTasks;
        LinearLayout body,tasks,jobs;
        final Map<String,Button> taskRows=new LinkedHashMap<>();
        final Map<String,FinanceJobRow> jobRows=new LinkedHashMap<>();
    }
    private static final class FinanceJobRow {
        LinearLayout view;TextView action,state,updated,storage;Button cancel;
    }
    private static void textIfChanged(TextView view,String text){if(!TextUtils.equals(view.getText(),text))view.setText(text);}
    private static void placeRow(LinearLayout parent,View row,int index){
        if(parent.getChildAt(index)==row)return;
        if(row.getParent()==parent)parent.removeView(row);
        parent.addView(row,index);
    }
    private void bindFinance(JSONObject session)throws Exception{
        FinanceScreen screen=financeScreen;if(screen==null||!requestPage())return;
        textIfChanged(screen.message,financeMessage);
        if(!sameSession(financeSession,session)||financeData==null)return;
        if(screen.tasks==null){
            LinearLayout heading=row();heading.setGravity(Gravity.CENTER_VERTICAL);heading.setPadding(0,dp(16),0,dp(2));heading.addView(label("PC 등록 작업",17,TEXT,true),new LinearLayout.LayoutParams(0,-2,1));
            screen.online=label("",13,PURPLE,true);heading.addView(screen.online);screen.body.addView(heading);
            screen.seen=label("",12,MUTED,false);screen.body.addView(screen.seen);
            screen.emptyTasks=label("PC 프로그램에서 문서와 작업을 등록해 주세요.",14,MUTED,false);screen.body.addView(screen.emptyTasks);
            screen.tasks=column();screen.body.addView(screen.tasks);section(screen.body,"문서 작업 상태","");screen.jobs=column();screen.body.addView(screen.jobs);
        }
        JSONObject catalog=financeData.getJSONObject("catalog");
        textIfChanged(screen.online,catalog.getBoolean("online")?"PC 연결됨":"PC 오프라인·연결 지연");
        textIfChanged(screen.seen,"마지막 PC 연결  "+time(catalog.optString("updatedAt","")));
        JSONArray tasks=catalog.getJSONArray("tasks");screen.emptyTasks.setVisibility(tasks.length()==0?View.VISIBLE:View.GONE);
        Set<String> taskIds=new HashSet<>();
        for(int i=0;i<tasks.length();i++){
            JSONObject task=tasks.getJSONObject(i);String id=task.getString("id");taskIds.add(id);Button choose=screen.taskRows.get(id);
            if(choose==null){choose=button(screen.tasks,"",false);choose.setTag("finance_task_"+id);screen.taskRows.put(id,choose);}
            textIfChanged(choose,task.getString("label"));choose.setEnabled(!busy);choose.setOnClickListener(v->financeChoose(session,task));placeRow(screen.tasks,choose,i);
        }
        java.util.Iterator<Map.Entry<String,Button>> taskRows=screen.taskRows.entrySet().iterator();while(taskRows.hasNext()){Map.Entry<String,Button> entry=taskRows.next();if(!taskIds.contains(entry.getKey())){screen.tasks.removeView(entry.getValue());taskRows.remove();}}
        JSONArray jobs=financeData.getJSONArray("jobs");Set<String> jobIds=new HashSet<>();
        for(int i=0;i<jobs.length();i++){
            JSONObject job=jobs.getJSONObject(i);String id=job.getString("id");jobIds.add(id);FinanceJobRow item=screen.jobRows.get(id);
            if(item==null){
                item=new FinanceJobRow();item.view=card(screen.jobs);item.view.setTag("finance_job_"+id);
                item.action=label("",16,TEXT,true);item.state=label("",14,CYAN,true);item.updated=label("",12,MUTED,false);item.storage=label("",13,MUTED,false);
                item.view.addView(item.action);item.view.addView(item.state);item.view.addView(item.updated);item.view.addView(item.storage);
                item.cancel=button(item.view,"저장 시작 전 취소 요청",false);item.cancel.setTag("finance_cancel");
                item.cancel.setOnClickListener(v->new AlertDialog.Builder(this).setMessage("이 요청을 취소할까요? 이미 저장이 시작됐다면 실제 상태가 표시됩니다.").setNegativeButton("유지",null).setPositiveButton("취소 요청",(d,w)->financeCancel(session,id)).show());screen.jobRows.put(id,item);
            }
            textIfChanged(item.action,FinanceState.action(job.getString("action"))+" · "+job.getString("format").toUpperCase(Locale.ROOT));
            textIfChanged(item.state,FinanceState.label(job.getString("state")));
            textIfChanged(item.updated,"요청 번호  "+id+"\n갱신  "+time(job.getString("updatedAt")));
            textIfChanged(item.storage,"PC 저장 확인: "+(job.getBoolean("saved")?"완료":"미확인")+"\n전체 검토: "+(job.getBoolean("reviewComplete")?"충족 확인":"미완료 또는 추가 확인 필요"));
            item.cancel.setVisibility(FinanceState.cancellable(job.getString("state"))?View.VISIBLE:View.GONE);item.cancel.setEnabled(!busy);placeRow(screen.jobs,item.view,i);
        }
        java.util.Iterator<Map.Entry<String,FinanceJobRow>> jobRows=screen.jobRows.entrySet().iterator();while(jobRows.hasNext()){Map.Entry<String,FinanceJobRow> entry=jobRows.next();if(!jobIds.contains(entry.getKey())){screen.jobs.removeView(entry.getValue().view);jobRows.remove();}}
    }
    private void applyFinanceStatuses(JSONObject session,JSONObject data){
        try{if(!alive()||!requestPage()||!sameSession(session,secureStore.load()))return;
            financeData=data;financeSession=session;financeMessage=data.getJSONObject("catalog").getBoolean("online")?"PC 문서 작업 연결됨":"PC 오프라인 또는 연결 지연 · 요청은 대기열에 보관됩니다";bindFinance(session);
        }catch(Exception ignored){/* Retain the last authenticated screen. */}
    }
    private void financeChoose(JSONObject session,JSONObject task){
        try{JSONArray actions=task.getJSONArray("actions");String[] labels=new String[actions.length()];for(int i=0;i<labels.length;i++)labels[i]=FinanceState.action(actions.getString(i));
            new AlertDialog.Builder(this).setTitle("작업 선택").setItems(labels,(d,index)->{try{String action=actions.getString(index);JSONArray formats=task.getJSONArray("formats");String[] names=new String[formats.length()];for(int i=0;i<names.length;i++)names[i]=formats.getString(i);new AlertDialog.Builder(this).setTitle("PC 저장 형식").setItems(names,(f,n)->new AlertDialog.Builder(this).setTitle("문서 작업 요청 확인").setMessage(task.optString("label")+" · "+FinanceState.action(action)+" · "+names[n]+"\n문서 내용 확인과 최종 승인은 PC에서 진행합니다.").setNegativeButton("닫기",null).setPositiveButton("요청",(x,w)->financeSubmit(session,task.optString("id"),action,names[n],false)).show()).show();}catch(Exception ignored){}}).show();
        }catch(Exception e){showStatus("등록 작업을 다시 확인해 주세요.",true);}
    }
    private void financeSubmit(JSONObject session,String taskId,String action,String format,boolean retry){
        if(busy)return;busy=true;draw();worker.execute(()->{try{if(!sameSession(session,secureStore.load()))throw new java.io.IOException();if(retry)FinanceRequests.retry(this,session);else FinanceRequests.create(this,session,taskId,action,format);financeFinish(session,"요청했습니다. 문서 확인과 최종 승인은 PC에서 진행해 주세요.");}catch(Exception e){financeFinish(session,FinanceRequests.error(e));}});
    }
    private void financeCancel(JSONObject session,String id){
        if(busy)return;busy=true;draw();worker.execute(()->{try{if(!sameSession(session,secureStore.load()))throw new java.io.IOException();JSONObject j=FinanceRequests.cancel(session,id);financeFinish(session,FinanceState.label(j.getString("state")));}catch(Exception e){financeFinish(session,FinanceRequests.error(e));}});
    }
    private void financeFinish(JSONObject session,String text){main.post(()->{if(!alive())return;busy=false;try{if(sameSession(session,secureStore.load()))financeMessage=text;}catch(Exception ignored){}draw();financeRefresh.refresh();});}
    private void readFinanceStatuses(ForegroundRefresh.Completion completion){
        final JSONObject session;try{session=secureStore.load();}catch(Exception e){completion.finish(false,true,null);return;}if(session==null){completion.finish(false,false,null);return;}
        try{worker.execute(()->{try{JSONObject data=FinanceRequests.fetch(session);main.post(()->completion.finish(true,false,()->applyFinanceStatuses(session,data)));}catch(Exception e){main.post(()->completion.finish(true,true,()->{try{if(alive()&&requestPage()&&sameSession(session,secureStore.load())){financeMessage=FinanceRequests.error(e);if(financeScreen!=null)textIfChanged(financeScreen.message,financeMessage);}}catch(Exception ignored){}}));}});}catch(RejectedExecutionException e){completion.finish(false,true,null);}
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
    private void drawHome(){
        title(pageContent,"동기화","새 파일 확인과 저장 폴더를 관리하세요.");
        LinearLayout hero=card(pageContent);hero.setPadding(dp(18),dp(18),dp(18),dp(18));hero.setBackground(techPanel(0xff15394a,0xff16203c,0xff3e7488,true));hero.setElevation(dp(8));
        LinearLayout module=row();module.setGravity(Gravity.CENTER_VERTICAL);ImageView syncIcon=icon(R.drawable.ic_ui_refresh,CYAN);syncIcon.setPadding(dp(9),dp(9),dp(9),dp(9));syncIcon.setBackground(shape(0xff103d46,14,0xff3b8290));module.addView(syncIcon,new LinearLayout.LayoutParams(dp(40),dp(40)));TextView moduleTitle=label("휴대폰으로 받기",18,TEXT,true);LinearLayout.LayoutParams moduleTitleParams=new LinearLayout.LayoutParams(0,-2,1);moduleTitleParams.leftMargin=dp(12);module.addView(moduleTitle,moduleTitleParams);hero.addView(module);
        hero.addView(label("마지막 동기화  "+time(getPreferences(0).getString("last_sync","")),12,MUTED,false));
        pushStatus=label("빠른 수신  ·  "+getSharedPreferences("settings",0).getString("push_status","연결 확인 중"),12,CYAN,false);hero.addView(pushStatus);
        syncButton=button(hero,"지금 동기화",true);syncButton.setTag("home_sync");syncButton.setContentDescription("지금 결과 확인");syncButton.setEnabled(!busy);syncButton.setOnClickListener(v->syncNow());
        try{drawLatestReceive(hero,SyncEngine.latestReceiveLog(this,displayedSession));}catch(Exception ignored){/* A missing log must not hide the sync controls. */}
        String lastError=getPreferences(0).getString("last_error","");if(!lastError.isEmpty())hero.addView(label("동기화 확인 필요 · "+lastError,12,ERROR,false));
        drawFolderCard(pageContent,false);
    }
    private void drawFiles(){
        title(pageContent,"보관 파일","앱에 저장한 파일을 확인하고 열어보세요.");
        JSONArray saved=SyncEngine.cachedSaved(this);int count=0;
        for(int i=0;i<saved.length();i++){JSONObject job=saved.optJSONObject(i);if(job!=null&&job.optJSONArray("artifacts")!=null)count+=job.optJSONArray("artifacts").length();}
        section(pageContent,"보관 중인 파일",count==0?"":String.valueOf(count));
        if(count==0)empty(pageContent,R.drawable.ic_ui_folder,"아직 받은 파일이 없어요","PC에서 파일을 보내면 이곳에 모아둘게요.");
        for(int i=0;i<Math.min(saved.length(),visibleSaved);i++){
            JSONObject job=saved.optJSONObject(i);if(job==null)continue;JSONArray artifacts=job.optJSONArray("artifacts");if(artifacts==null)continue;
            for(int j=0;j<artifacts.length();j++){JSONObject artifact=artifacts.optJSONObject(j);if(artifact!=null)drawArtifact(pageContent,job.optString("id"),artifact);}
        }
        if(saved.length()>visibleSaved)button(pageContent,"파일 더 보기",false).setOnClickListener(v->{visibleSaved+=15;draw();});
    }
    private void drawLatestReceive(LinearLayout parent,JSONObject received){
        if(received==null)return;String filename=received.optString("filename","");if(filename.isEmpty())return;
        LinearLayout log=column();log.setTag("home_receive_log");LinearLayout.LayoutParams logParams=new LinearLayout.LayoutParams(-1,-2);logParams.topMargin=dp(12);parent.addView(log,logParams);
        View separator=new View(this);separator.setBackgroundColor(0xff36556b);log.addView(separator,new LinearLayout.LayoutParams(-1,dp(1)));
        LinearLayout header=row();header.setGravity(Gravity.CENTER_VERTICAL);header.addView(label("최근 수신",11,PURPLE,true),new LinearLayout.LayoutParams(0,-2,1));header.addView(label(time(received.optString("receivedAt","")),11,MUTED,false));log.addView(header);
        LinearLayout names=row();names.setGravity(Gravity.CENTER_VERTICAL);TextView name=label(filename,12,TEXT,false);name.setMaxLines(2);name.setEllipsize(android.text.TextUtils.TruncateAt.END);names.addView(name,new LinearLayout.LayoutParams(0,-2,1));
        int extra=received.optInt("count",1)-1;if(extra>0){TextView count=label("외 "+extra+"개",11,CYAN,false);LinearLayout.LayoutParams countParams=new LinearLayout.LayoutParams(-2,-2);countParams.leftMargin=dp(8);names.addView(count,countParams);}log.addView(names);
    }
    private void drawFolderCard(LinearLayout parent,boolean controls){
        boolean selected=getPreferences(0).getString("export_tree",null)!=null;
        if(!controls){
            LinearLayout compact=card(parent);compact.setPadding(dp(14),dp(14),dp(14),dp(14));compact.setBackground(techPanel(0xff22213b,0xff111a2d,0xff44486d,false));
            boolean stacked=getResources().getConfiguration().fontScale>=1.2f||getResources().getConfiguration().screenWidthDp<380;
            LinearLayout line=stacked?column():row();line.setGravity(Gravity.CENTER_VERTICAL);line.setBaselineAligned(false);
            LinearLayout description=column();line.addView(description,stacked?new LinearLayout.LayoutParams(-1,-2):new LinearLayout.LayoutParams(0,-2,1));
            TextView heading=label(selected?"실제 휴대폰 폴더":"실제 폴더 저장 꺼짐",selected?11:14,selected?MUTED:TEXT,!selected);heading.setPadding(0,0,0,0);description.addView(heading);
            TextView destination=label(selected?SyncEngine.selectedFolderLabel(this):"앱 안에만 보관 중이에요.",selected?14:11,selected?PURPLE:MUTED,selected);destination.setPadding(0,dp(4),0,0);description.addView(destination);
            folderButton=button(line,selected?"변경":"폴더 선택",false);folderButton.setTag("home_folder");LinearLayout.LayoutParams actionParams=new LinearLayout.LayoutParams(stacked?-1:dp(selected?72:100),-2);if(stacked)actionParams.topMargin=dp(10);else actionParams.leftMargin=dp(10);folderButton.setLayoutParams(actionParams);folderButton.setContentDescription(selected?"갤럭시 저장 폴더 변경":"갤럭시 저장 폴더 선택");folderButton.setEnabled(!busy);folderButton.setOnClickListener(v->chooseFolder());compact.addView(line);
            if(selected){TextView note=label("폴더 복사 표시는 마지막 확인 기준이에요.",11,MUTED,false);note.setPadding(0,dp(6),0,0);compact.addView(note);}
            String problem=getPreferences(0).getString("export_error","");if(!problem.isEmpty())compact.addView(label("폴더 복사 확인 필요 · 설정에서 확인해 주세요.",11,ERROR,false));
            return;
        }
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
        drawCandidates(parent,job);
        JSONObject request=job.optJSONObject("request");
        if(request!=null){LinearLayout requestCard=card(parent);requestCard.addView(label("요청 내용",16,TEXT,true));
            String[] keys={"instruction","editInstruction","goal","query","filename","startAt","deadlineAt"};String[] labels={"수정 목표","수정 요청","원하는 결과","검색 요청","파일","시작 시각","완료 기한"};
            for(int i=0;i<keys.length;i++){String value=request.optString(keys[i],"");if(!value.isEmpty())requestCard.addView(label(labels[i]+"\n"+(("startAt".equals(keys[i])||"deadlineAt".equals(keys[i]))?time(value):value),13,MUTED,false));}
            JSONObject source=job.optJSONObject("source");if(source!=null){String sourceName=source.optString("filename",source.optString("name",""));if(!sourceName.isEmpty())requestCard.addView(label("원본\n"+sourceName,13,MUTED,false));}
            JSONArray criteria=request.optJSONArray("criteria");if(criteria!=null&&criteria.length()>0){requestCard.addView(label("검토 기준",13,TEXT,true));for(int i=0;i<criteria.length();i++)requestCard.addView(label("• "+criteria.optString(i),13,MUTED,false));}
        }
        JSONArray events=job.optJSONArray("events");if(events!=null&&events.length()>0){section(parent,"진행 기록","");LinearLayout timeline=card(parent);for(int i=0;i<events.length();i++){JSONObject event=events.optJSONObject(i);if(event==null)continue;timeline.addView(label(time(event.optString("at")),11,PURPLE,false));timeline.addView(label(event.optString("text",""),13,TEXT,false));if(i<events.length()-1)divider(timeline);}}
        JSONArray artifacts=null;try{artifacts=SyncEngine.availableArtifacts(job);}catch(Exception ignored){/* An incomplete manifest is not an openable result. */}if(artifacts!=null&&artifacts.length()>0){section(parent,"결과 파일",String.valueOf(artifacts.length()));for(int i=0;i<artifacts.length();i++){JSONObject artifact=artifacts.optJSONObject(i);if(artifact!=null)drawArtifact(parent,job.optString("id"),artifact);}}
    }
    private void drawCandidates(LinearLayout parent,JSONObject job){
        JSONArray candidates=job.optJSONArray("candidates");if(candidates==null||candidates.length()==0||!"needs_selection".equals(job.optString("state")))return;
        JSONObject request=job.optJSONObject("request");String kind=job.optString("kind"),delivery=request==null?"":request.optString("delivery","");boolean canSelect=request!=null&&(kind.isEmpty()||"search".equals(kind))&&("download".equals(delivery)||"both".equals(delivery)||"email".equals(delivery));
        section(parent,"찾은 문서 선택",String.valueOf(candidates.length()));
        if(!canSelect)parent.addView(label("이 작업의 문서 선택은 PC 제어 화면에서 진행해 주세요.",13,MUTED,false));
        for(int i=0;i<candidates.length();i++){
            JSONObject candidate=candidates.optJSONObject(i);if(candidate==null)continue;LinearLayout card=card(parent);card.addView(label(candidate.optString("filename","문서"),16,TEXT,true));
            card.addView(label(UploadSender.describeBytes(candidate.optLong("bytes",0))+"  ·  "+time(candidate.optString("modifiedAt")),12,MUTED,false));
            String excerpt=candidate.optString("excerpt","");if(!excerpt.isEmpty())card.addView(label(excerpt.length()>280?excerpt.substring(0,280)+"…":excerpt,13,MUTED,false));
            if(canSelect){String action="download".equals(delivery)?"이 파일로 진행하고 휴대폰으로 받기":"both".equals(delivery)?"이 파일로 진행 · 이메일과 휴대폰":"이 파일로 진행 · 이메일로 보내기";Button choose=button(card,action,true);choose.setTag("select_candidate_"+candidate.optString("id"));choose.setEnabled(!busy);choose.setOnClickListener(v->confirmPcCandidate(job,candidate));}
        }
    }
    private void drawPcRequest(JSONObject session)throws Exception{
        title(pageContent,"PC에 요청하기","문서 작업과 파일 보내기를 한 곳에서 이용해요.");
        drawConversationDraft(session);
        section(pageContent,"지금 사용할 수 있는 작업","파일 찾기·수정 요청과 등록 문서 검토를 바로 이용할 수 있어요.");
        LinearLayout card=card(pageContent);card.addView(label("어떤 문서가 필요한가요?",18,TEXT,true));card.addView(label("찾을 내용을 보내면 PC가 문서 후보를 찾아요. 최근 작업에서 받을 문서를 선택해 주세요.",13,MUTED,false));
        PcRequests.Pending pending=null;boolean unreadable=false;
        try{pending=PcRequests.load(this);}catch(Exception error){unreadable=true;card.addView(label("대기 중인 요청을 읽지 못했습니다. 최근 작업을 먼저 확인한 뒤 새 요청을 작성해 주세요.",13,ERROR,false));}
        boolean locked=pending!=null||unreadable;
        card.addView(label("찾을 파일 / 원하는 문서",13,TEXT,true));requestQueryField=field(card,"예: 지난달 매출 보고서",InputType.TYPE_CLASS_TEXT);requestQueryField.setTag("pc_query");requestQueryField.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(1000)});requestQueryField.setText(pending==null?requestQueryDraft:pending.query);requestQueryField.setEnabled(!busy&&!locked);
        card.addView(label("수정 요청 (선택)",13,TEXT,true));requestEditField=field(card,"예: 핵심 내용을 정리하고 오탈자를 수정해 줘",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE);requestEditField.setTag("pc_edit_instruction");requestEditField.setSingleLine(false);requestEditField.setHorizontallyScrolling(false);requestEditField.setMinLines(3);requestEditField.setMaxLines(6);requestEditField.setGravity(Gravity.TOP|Gravity.START);requestEditField.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(2000)});requestEditField.setText(pending==null?requestEditDraft:pending.editInstruction);requestEditField.setEnabled(!busy&&!locked);
        if(!locked){requestSubmitButton=button(card,"PC에 요청 보내기",true);requestSubmitButton.setTag("pc_submit");requestSubmitButton.setEnabled(!busy);requestSubmitButton.setOnClickListener(v->submitPcRequest(false));}
        else{
            if(pending!=null){boolean matching=pending.belongsTo(session);card.addView(label(matching?"접수 여부를 확인하지 못한 요청이 있어요. 같은 요청을 재시도하면 중복 등록을 줄일 수 있어요.":"이전 PC 연결에서 작성한 요청입니다. 최근 작업을 확인한 뒤 새 요청을 작성해 주세요.",13,MUTED,false));requestSubmitButton=button(card,"같은 요청 다시 확인",true);requestSubmitButton.setTag("pc_submit");requestSubmitButton.setEnabled(!busy&&matching);requestSubmitButton.setOnClickListener(v->submitPcRequest(true));}
            requestDiscardButton=button(card,"새 요청 작성",false);requestDiscardButton.setEnabled(!busy);requestDiscardButton.setOnClickListener(v->confirmDiscardPcRequest());
        }
        Button history=button(pageContent,"최근 작업 확인",false);history.setOnClickListener(v->navigate(RECENT));
        Button transfer=button(pageContent,showPhoneUpload?"휴대폰 파일 보내기 접기":"휴대폰 파일 보내기",false);transfer.setOnClickListener(v->{if(busy)return;rememberViewState();showPhoneUpload=!showPhoneUpload;draw();});
        if(showPhoneUpload)drawUpload(session);
        drawFinance(session);
    }
    private void drawConversationDraft(JSONObject session)throws Exception{
        requestChatKey=PcChatDraft.preferenceKey(session.getString("baseUrl"),session.getString("phoneId"));
        String draft=getPreferences(0).getString(requestChatKey,"");
        LinearLayout chat=column();chat.setTag("pc_chat_composer");chat.setPadding(dp(18),dp(18),dp(18),dp(18));
        chat.setBackground(techPanel(0xff1c304b,0xff101b30,0xff466380,true));chat.setElevation(dp(7));
        LinearLayout.LayoutParams panel=new LinearLayout.LayoutParams(-1,-2);panel.topMargin=dp(10);panel.bottomMargin=dp(18);pageContent.addView(chat,panel);
        LinearLayout heading=row();heading.setGravity(Gravity.CENTER_VERTICAL);heading.addView(label("DIANA 대화",18,TEXT,true),new LinearLayout.LayoutParams(0,-2,1));heading.addView(label("AI 연결 준비 중",12,PURPLE,true));chat.addView(heading);
        TextView assistant=label("어떤 문서 작업을 하고 싶은지 적어 주세요. 지금은 이 휴대폰에 초안으로 보관할 수 있어요.",14,TEXT,false);
        assistant.setPadding(dp(14),dp(12),dp(14),dp(12));assistant.setBackground(shape(0xff1b2946,16,0xff354a70));
        LinearLayout.LayoutParams reply=new LinearLayout.LayoutParams(-1,-2);reply.topMargin=dp(14);reply.rightMargin=dp(22);chat.addView(assistant,reply);
        TextView saved=label(draft,14,TEXT,false);saved.setTag("pc_chat_draft_bubble");saved.setPadding(dp(14),dp(12),dp(14),dp(12));saved.setBackground(shape(0xff16414a,16,0xff328b91));saved.setTextIsSelectable(true);saved.setVisibility(draft.isEmpty()?View.GONE:View.VISIBLE);
        LinearLayout.LayoutParams bubble=new LinearLayout.LayoutParams(-1,-2);bubble.topMargin=dp(12);bubble.leftMargin=dp(22);chat.addView(saved,bubble);
        requestChatField=field(chat,"예: 이 검토서를 실사 자료와 지침에 맞춰 검토해 줘",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        requestChatField.setTag("pc_chat_input");requestChatField.setSingleLine(false);requestChatField.setHorizontallyScrolling(false);requestChatField.setMinLines(3);requestChatField.setMaxLines(6);requestChatField.setGravity(Gravity.TOP|Gravity.START);
        requestChatField.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(PcChatDraft.MAX_LENGTH)});requestChatField.setText(draft);requestChatField.setEnabled(!busy);
        TextView note=label("초안은 휴대폰에만 보관됩니다. PC 전송과 AI 실행은 연결 후 사용할 수 있어요.",12,MUTED,false);note.setTag("pc_chat_notice");chat.addView(note);
        Button keep=button(chat,"대화 초안 보관",false);keep.setTag("pc_chat_keep");keep.setEnabled(!busy);
        keep.setOnClickListener(v->{try{
            String text=PcChatDraft.text(requestChatField.getText().toString());
            if(!getPreferences(0).edit().putString(requestChatKey,text).commit())throw new java.io.IOException();
            textIfChanged(saved,text);saved.setVisibility(View.VISIBLE);textIfChanged(note,"이 휴대폰에 초안을 보관했어요. PC에 전송하거나 작업을 실행하지 않았어요.");
        }catch(PcRequests.RequestException error){textIfChanged(note,error.getMessage());}catch(Exception error){textIfChanged(note,"초안을 보관하지 못했어요. 저장 공간을 확인해 주세요.");}});
        Button send=button(chat,"AI 연결 후 요청 가능",true);send.setTag("pc_chat_send");send.setEnabled(false);
    }
    private void drawUpload(JSONObject session){
        section(pageContent,"휴대폰 파일 보내기","");LinearLayout card=card(pageContent);
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
        disconnectButton=button(connection,"연결 해제",false);disconnectButton.setEnabled(!busy);disconnectButton.setOnClickListener(v->{if(busy)return;new AlertDialog.Builder(this).setTitle("PC 연결을 해제할까요?").setMessage("앱에 저장한 파일은 유지됩니다. 다시 연결하려면 새 연결 코드가 필요해요.").setNegativeButton("유지",null).setPositiveButton("연결 해제",(dialog,which)->{if(busy)return;foregroundRefresh.stop();secureStore.clear();displayedSession=null;displayedJobs=new JSONArray();detailId="";selectedTab=HOME;SyncScheduler.configure(this);draw();}).show();});
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
    private LinearLayout card(LinearLayout parent){LinearLayout card=column();card.setPadding(dp(16),dp(14),dp(16),dp(14));card.setBackground(techPanel(0xff182941,0xff0f192b,0xff30435f,false));card.setElevation(dp(3));LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.topMargin=dp(14);parent.addView(card,params);return card;}
    private GradientDrawable shape(int fill,int radius,int stroke){GradientDrawable drawable=new GradientDrawable();drawable.setColor(fill);drawable.setCornerRadius(dp(radius));if(stroke!=0)drawable.setStroke(dp(1),stroke);return drawable;}
    private LayerDrawable techPanel(int start,int end,int edge,boolean glow){
        GradientDrawable base=new GradientDrawable(GradientDrawable.Orientation.TL_BR,new int[]{start,end});base.setCornerRadius(dp(20));base.setStroke(dp(1),edge);
        GradientDrawable top=new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,new int[]{0x004ce0d6,glow?0xaa7af5ec:0x556b85b5,0x00ae9bff});top.setCornerRadius(dp(1));
        if(!glow){LayerDrawable panel=new LayerDrawable(new android.graphics.drawable.Drawable[]{base,top});panel.setLayerInset(1,dp(20),0,dp(20),0);panel.setLayerHeight(1,dp(1));panel.setLayerGravity(1,Gravity.TOP);return panel;}
        GradientDrawable cyan=new GradientDrawable();cyan.setGradientType(GradientDrawable.RADIAL_GRADIENT);cyan.setColors(new int[]{0x344ce0d6,0x004ce0d6});cyan.setGradientCenter(.05f,.05f);cyan.setGradientRadius(dp(220));cyan.setCornerRadius(dp(20));
        GradientDrawable purple=new GradientDrawable();purple.setGradientType(GradientDrawable.RADIAL_GRADIENT);purple.setColors(new int[]{0x3aae9bff,0x00ae9bff});purple.setGradientCenter(1f,1f);purple.setGradientRadius(dp(170));purple.setCornerRadius(dp(20));
        LayerDrawable panel=new LayerDrawable(new android.graphics.drawable.Drawable[]{base,cyan,purple,top});panel.setLayerInset(3,dp(20),0,dp(20),0);panel.setLayerHeight(3,dp(1));panel.setLayerGravity(3,Gravity.TOP);return panel;
    }
    private LayerDrawable buttonFace(boolean primary){
        GradientDrawable shadow=shape(primary?0xff0b7079:0xff050c18,14,0);
        GradientDrawable face=new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,primary?new int[]{0xff79f8e9,0xff35c9c7}:new int[]{0xff2a405c,0xff18283f});face.setCornerRadius(dp(14));face.setStroke(dp(1),primary?0xff9bfff2:0xff405a78);
        GradientDrawable glint=new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,new int[]{0x00ffffff,primary?0xaaffffff:0x557e9dc6,0x00ffffff});
        LayerDrawable layers=new LayerDrawable(new android.graphics.drawable.Drawable[]{shadow,face,glint});layers.setLayerInset(0,0,dp(3),0,0);layers.setLayerInset(1,0,0,0,dp(3));layers.setLayerInset(2,dp(18),dp(1),dp(18),0);layers.setLayerHeight(2,dp(1));layers.setLayerGravity(2,Gravity.TOP);return layers;
    }
    private StateListDrawable inputFace(){
        GradientDrawable normal=new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,new int[]{0xff050c18,0xff132139});normal.setCornerRadius(dp(12));normal.setStroke(dp(1),0xff2d4362);
        GradientDrawable focused=new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,new int[]{0xff071924,0xff12293a});focused.setCornerRadius(dp(12));focused.setStroke(dp(1),CYAN);
        StateListDrawable states=new StateListDrawable();states.addState(new int[]{android.R.attr.state_focused},focused);states.addState(new int[]{},normal);return states;
    }
    private RippleDrawable ripple(int fill,int radius,int stroke){return new RippleDrawable(ColorStateList.valueOf(0x244ce0d6),shape(fill,radius,stroke),shape(Color.WHITE,radius,0));}
    private android.graphics.drawable.Drawable tinted(int resource,int color){android.graphics.drawable.Drawable drawable=getDrawable(resource).mutate();drawable.setTint(color);return drawable;}
    private ImageView icon(int resource,int color){ImageView image=new ImageView(this);image.setImageResource(resource);image.setImageTintList(ColorStateList.valueOf(color));image.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);return image;}
    private Button button(LinearLayout parent,String text,boolean primary){Button view=new Button(this);view.setText(text);view.setTextSize(14);view.setAllCaps(false);view.setTextColor(primary?0xff072a2c:TEXT);view.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));view.setGravity(Gravity.CENTER);view.setPadding(dp(16),dp(10),dp(16),dp(12));view.setMinHeight(dp(50));view.setMinimumHeight(dp(50));view.setBackgroundTintList(null);view.setBackground(new RippleDrawable(ColorStateList.valueOf(primary?0x40ffffff:0x284ce0d6),buttonFace(primary),shape(Color.WHITE,14,0)));view.setElevation(dp(primary?5:2));LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.topMargin=dp(10);parent.addView(view,params);return view;}
    private EditText field(LinearLayout parent,String hint,int type){EditText field=new EditText(this);field.setTextSize(15);field.setSingleLine(true);field.setHint(hint);field.setInputType(type);field.setTextColor(TEXT);field.setHintTextColor(MUTED);field.setPadding(dp(14),dp(12),dp(14),dp(12));field.setMinHeight(dp(54));field.setBackgroundTintList(null);field.setBackground(inputFace());field.setOnFocusChangeListener((v,focused)->{if(focused)revealFocusedInputSoon();else main.post(this::resumeDeferredInputRender);});LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.topMargin=dp(12);parent.addView(field,params);return field;}
    private void divider(LinearLayout parent){View line=new View(this);line.setBackgroundColor(BORDER);LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,dp(1));params.topMargin=dp(8);params.bottomMargin=dp(8);parent.addView(line,params);}
    private void empty(LinearLayout parent,int icon,String heading,String copy){LinearLayout card=card(parent);ImageView image=icon(icon,PURPLE);card.addView(image,new LinearLayout.LayoutParams(dp(30),dp(30)));card.addView(label(heading,17,TEXT,true));card.addView(label(copy,13,MUTED,false));}
    private static String time(String value){if(value==null||value.isEmpty())return "아직 없음";try{return DateTimeFormatter.ofPattern("M. d. HH:mm",Locale.KOREA).withZone(ZoneId.systemDefault()).format(Instant.parse(value));}catch(Exception ignored){return value;}}
    private static String jobTitle(JSONObject job){JSONObject request=job.optJSONObject("request");if(request==null)return job.optString("title","작업");String kind=job.optString("kind");return request.optString("upload".equals(kind)?"filename":"overnight".equals(kind)?"subject":"query",job.optString("title","작업"));}
    private static String stateLabel(JSONObject job){String state=job.optString("state");if("upload".equals(job.optString("kind")))return uploadState(state);switch(state){case "scheduled":return "예약됨";case "waiting_pc":return "PC 연결 대기";case "searching":return "문서 찾는 중";case "needs_selection":return "문서 선택 필요";case "ready_to_send":return "전달 준비 완료";case "sending":return "파일 전달 중";case "processing":return "작업 중";case "needs_attention":return "확인이 필요합니다";case "awaiting_phone":return "결과 수신 대기";case "download_ready":return job.optString("phoneSavedAt").isEmpty()?"결과 준비 완료":"휴대폰 수신 기록 있음";case "failed":return "작업 실패";case "deadline_exceeded":return "완료 기한 지남";case "submitted":return "전달 요청됨";case "send_unknown":return "전달 상태 확인 필요";case "dry_run":return "준비 완료";default:return "작업 상태 확인 중";}}
    private static String uploadState(String state){switch(state){case "waiting_pc":return "PC 연결·저장 대기";case "receiving_pc":return "PC에 저장 중";case "pc_saved":return "PC 저장 완료";case "failed":return "PC 저장 실패";default:return "PC 전송 상태 확인 중";}}
    private static boolean sameSession(JSONObject left,JSONObject right){return left!=null&&right!=null&&left.optString("baseUrl").equals(right.optString("baseUrl"))&&left.optString("phoneId").equals(right.optString("phoneId"))&&left.optString("phoneToken").equals(right.optString("phoneToken"));}
    private void readJobStatuses(ForegroundRefresh.Completion completion){
        final JSONObject session;try{session=secureStore.load();}catch(Exception error){completion.finish(false,false,null);return;}if(session==null){completion.finish(false,false,null);return;}
        try{worker.execute(()->{try{JSONArray remote=Api.request(session,"/api/jobs",null).getJSONArray("jobs");boolean pending=false;for(int i=0;i<remote.length();i++){JSONObject job=remote.optJSONObject(i);if(job==null)continue;String state=job.optString("state");boolean upload="upload".equals(job.optString("kind"));if(upload?("waiting_pc".equals(state)||"receiving_pc".equals(state)):("waiting_pc".equals(state)||"searching".equals(state)||"ready_to_send".equals(state)||"sending".equals(state)))pending=true;}final boolean waiting=pending;main.post(()->{if(alive())completion.finish(waiting,false,()->applyJobStatuses(session,remote));});}catch(Exception error){main.post(()->{if(alive())completion.finish(false,true,null);});}});}catch(RejectedExecutionException ignored){completion.finish(false,false,null);}
    }
    private void applyJobStatuses(JSONObject session,JSONArray remote){
        try{if(!alive()||!sameSession(session,secureStore.load()))return;JSONArray combined=mergeJobStatuses(displayedJobs,remote);if(combined.toString().equals(displayedJobs.toString()))return;displayedJobs=combined;if(!busy&&selectedTab==RECENT)renderAutomatically();}catch(Exception ignored){/* Keep the last authenticated visible state. */}
    }
    private static JSONArray mergeJobStatuses(JSONArray base,JSONArray observed){
        java.util.Map<String,JSONObject> changes=new java.util.LinkedHashMap<>();for(int i=0;i<observed.length();i++){JSONObject job=observed.optJSONObject(i);if(job!=null)changes.put(job.optString("id"),job);}
        JSONArray updated=new JSONArray();java.util.Set<String> seen=new java.util.HashSet<>();for(int i=0;i<base.length();i++){JSONObject old=base.optJSONObject(i);if(old==null)continue;String id=old.optString("id");seen.add(id);JSONObject fresh=changes.get(id);boolean newer=fresh!=null&&fresh.optString("updatedAt").compareTo(old.optString("updatedAt"))>=0;if(newer&&fresh.optString("updatedAt").equals(old.optString("updatedAt"))&&fresh.optString("phoneSavedAt").isEmpty()&&!old.optString("phoneSavedAt").isEmpty()){try{fresh.put("phoneSavedAt",old.optString("phoneSavedAt"));}catch(Exception ignored){}}updated.put(newer?fresh:old);}
        JSONArray combined=new JSONArray();for(JSONObject job:changes.values())if(!seen.contains(job.optString("id")))combined.put(job);for(int i=0;i<updated.length();i++)combined.put(updated.opt(i));return combined;
    }
    private void submitPcRequest(boolean retry){
        if(busy)return;rememberViewState();final String query=requestQueryDraft.trim(),instruction=requestEditDraft.trim();
        if(!retry&&query.isEmpty()){showStatus("찾을 파일이나 원하는 문서를 입력해 주세요.",true);return;}
        uploadBusy(true);showStatus(retry?"같은 요청의 접수 상태를 확인하고 있습니다…":"PC에 요청을 보내고 있습니다…",false);
        worker.execute(()->{try{JSONObject session=secureStore.load();if(session==null)throw new PcRequests.RequestException("휴대폰을 PC에 다시 연결해 주세요.");JSONObject job=retry?PcRequests.retry(this,session):PcRequests.create(this,session,query,instruction);finishPcRequest(session,job,"PC에 요청했습니다. 문서 후보가 도착하면 받을 파일을 골라주세요.",true);}catch(Exception error){finishPcError(error);}});
    }
    private void selectPcCandidate(String jobId,String candidateId){
        if(busy)return;uploadBusy(true);showStatus("선택한 문서를 PC에 요청하고 있습니다…",false);
        worker.execute(()->{try{JSONObject session=secureStore.load();if(session==null)throw new PcRequests.RequestException("휴대폰을 PC에 다시 연결해 주세요.");JSONObject job=PcRequests.select(this,session,jobId,candidateId);JSONObject request=job.optJSONObject("request");String delivery=request==null?"download":request.optString("delivery","download");String result="email".equals(delivery)?"이메일로 전달합니다.":"both".equals(delivery)?"이메일과 휴대폰으로 받아요.":"휴대폰으로 받아요.";finishPcRequest(session,job,"문서를 선택했습니다. PC가 준비한 결과를 "+result,false);}catch(Exception error){finishPcError(error);}});
    }
    private void confirmPcCandidate(JSONObject job,JSONObject candidate){
        if(busy)return;JSONObject request=job.optJSONObject("request");if(request==null)return;String delivery=request.optString("delivery","");
        if("download".equals(delivery)){selectPcCandidate(job.optString("id"),candidate.optString("id"));return;}
        String destination="이메일 받는 사람: "+request.optString("recipient","확인 필요")+("both".equals(delivery)?"\n이 휴대폰으로도 결과를 받습니다.":"");
        String instruction=request.optString("editInstruction","");new AlertDialog.Builder(this).setTitle("이 문서로 진행할까요?").setMessage(candidate.optString("filename","문서")+"\n\n"+destination+(instruction.isEmpty()?"":"\n\n수정 요청을 적용한 결과를 전달합니다.")).setNegativeButton("취소",null).setPositiveButton("선택하고 진행",(dialog,which)->selectPcCandidate(job.optString("id"),candidate.optString("id"))).show();
    }
    private void cachePcJob(JSONObject job){
        try{JSONArray previous=SyncEngine.cachedJobs(this),jobs=new JSONArray().put(job);for(int i=0;i<previous.length();i++){JSONObject old=previous.optJSONObject(i);if(old!=null&&!job.optString("id").equals(old.optString("id")))jobs.put(old);}SyncEngine.cache(this,new JSONObject().put("jobs",jobs));}catch(Exception ignored){/* The authenticated server reply remains authoritative. */}
    }
    private void finishPcRequest(JSONObject session,JSONObject job,String message,boolean clearDraft){
        main.post(()->{busy=false;if(!alive())return;try{if(!sameSession(session,secureStore.load())){draw();showStatus("PC 연결이 변경됐습니다. 최근 작업에서 요청을 확인해 주세요.",true);return;}}catch(Exception ignored){draw();return;}
            // This short local cache write shares the UI thread with pairing/disconnect actions.
            // A destroyed activity or a reply from a different session never reaches it.
            cachePcJob(job);
            if(clearDraft){requestQueryField=null;requestEditField=null;requestQueryDraft="";requestEditDraft="";getPreferences(0).edit().remove("pc_query_draft").remove("pc_edit_draft").apply();}
            selectedTab=RECENT;detailId=job.optString("id");detailScroll=0;displayedJobs=mergeJobStatuses(displayedJobs,new JSONArray().put(job));draw();showStatus(message,false);if(resumed)foregroundRefresh.refresh();});
    }
    private void finishPcError(Exception error){String message=error instanceof PcRequests.RequestException||error instanceof Api.ApiException?error.getMessage():"요청 상태를 확인하지 못했습니다. 최근 작업을 확인한 뒤 같은 요청으로 다시 시도해 주세요.";uploadFinished(message,true);}
    private void confirmDiscardPcRequest(){
        if(busy)return;new AlertDialog.Builder(this).setTitle("새 요청을 작성할까요?").setMessage("서버에 이미 등록된 작업은 취소되지 않습니다. 최근 작업부터 확인해 주세요. 이 휴대폰의 재시도 대기 정보만 지웁니다.").setNegativeButton("유지",null).setPositiveButton("새 요청 작성",(dialog,which)->{if(busy)return;uploadBusy(true);worker.execute(()->{try{PcRequests.discard(this);uploadFinished("재시도 대기를 정리했습니다. 최근 작업을 확인한 뒤 요청해 주세요.",false);}catch(Exception error){finishPcError(error);}});}).show();
    }
    private void uploadBusy(boolean value){busy=value;for(Button control:new Button[]{pairButton,syncButton,disconnectButton,folderButton,uploadPickButton,uploadSendButton,uploadCancelButton,requestSubmitButton,requestDiscardButton})if(control!=null)control.setEnabled(!value);if(autoReceive!=null)autoReceive.setEnabled(!value);if(folderCopy!=null)folderCopy.setEnabled(!value);if(requestQueryField!=null)requestQueryField.setEnabled(!value);if(requestEditField!=null)requestEditField.setEnabled(!value);}
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
