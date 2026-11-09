package kr.nightdesk.phone;
import android.app.*;
import android.os.*;
import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.*;
import android.content.res.ColorStateList;
import android.view.Gravity;
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

/** Native client for an authenticated PC. Only the system picker grants document access. */
public final class PairedActivity extends Activity {
 private final ExecutorService io=Executors.newSingleThreadExecutor(); private final Handler clock=new Handler(Looper.getMainLooper());
 private LinearLayout page,rows,dock; private TextView note,connection; private EditText editor; private SecureStore store;
 private JSONObject session;private SharedPreferences local;private String screen="",signature="";private boolean pending=false,active=false;private TextView pairWait;private CountDownTimer pairingTimer;
 interface Work {void run() throws Exception;}
 static JSONObject obj(Object... pairs)throws JSONException{JSONObject o=new JSONObject();for(int i=0;i<pairs.length;i+=2)o.put((String)pairs[i],pairs[i+1]);return o;}
 static String sha(byte[] b)throws Exception{return PairedWire.hash(b);}
 static byte[] read(InputStream stream,int max)throws IOException{return PairedWire.read(stream,max);}
 protected void onCreate(Bundle b){super.onCreate(b);store=new SecureStore(this);try{session=store.load();}catch(Exception e){session=null;}if(session!=null&&!session.optString("device").isEmpty())getSharedPreferences("pairing",MODE_PRIVATE).edit().putString("previousDevice",session.optString("device")).commit();if(session!=null&&!session.optString("device").isEmpty()&&session.optString("token").startsWith("v1.")&&PairedLink.ORIGIN.equals(session.optString("origin")))work();else login();}
 protected void onResume(){super.onResume();active=true;clock.post(tick);}protected void onPause(){active=false;clock.removeCallbacks(tick);super.onPause();}
 protected void onDestroy(){if(pairingTimer!=null)pairingTimer.cancel();io.shutdown();super.onDestroy();}
 final Runnable tick=new Runnable(){public void run(){if(!active)return;if(screen.equals("work")&&!pending)async(()->refresh());clock.postDelayed(this,3500);}};
 void async(Work task){if(pending){note.setText("현재 요청을 처리 중입니다. 잠시 뒤 다시 시도하세요.");return;}pending=true;io.execute(()->{try{task.run();}catch(Exception e){runOnUiThread(()->{if(!isDestroyed())note.setText(e instanceof IOException&&e.getMessage()!=null&&e.getMessage().matches(".*[가-힣].*")?e.getMessage():"연결이나 저장 위치를 확인하고 다시 시도하세요.");});}finally{runOnUiThread(()->pending=false);}});}
 JSONObject call(JSONObject b)throws Exception{
  try{return new PairedFiles(this,session).call(b);}catch(PairedFiles.AuthError e){store.clear();runOnUiThread(()->{login();note.setText(e.getMessage());});throw e;}}

 static final int CYAN=0xff6ee5d7,INK=0xffeaf3f9,MUTED=0xffa5b9ca,CANVAS=0xff0c1420;
 static final int SURFACE=0xff162433,FRAME=0xff101c2a,EDGE=0xff33495c,ACTIVE=0xff193940;
 int dp(int value){return Math.round(getResources().getDisplayMetrics().density*value);}
 LinearLayout column(){LinearLayout result=new LinearLayout(this);result.setOrientation(LinearLayout.VERTICAL);return result;}
 LinearLayout line(LinearLayout parent){LinearLayout row=new LinearLayout(this);row.setGravity(Gravity.CENTER_VERTICAL);parent.addView(row,new LinearLayout.LayoutParams(-1,-2));return row;}
    private GradientDrawable shape(int fill,int radius,int stroke){GradientDrawable drawable=new GradientDrawable();drawable.setColor(fill);drawable.setCornerRadius(dp(radius));if(stroke!=0)drawable.setStroke(dp(1),stroke);return drawable;}
    private LayerDrawable techPanel(int start,int end,int edge,boolean glow){
        GradientDrawable base=new GradientDrawable(GradientDrawable.Orientation.TL_BR,new int[]{start,end});base.setCornerRadius(dp(20));base.setStroke(dp(1),edge);
        GradientDrawable top=new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,new int[]{0x004ce0d6,glow?0xaa7af5ec:0x556b85b5,0x00ae9bff});top.setCornerRadius(dp(1));
        if(!glow){LayerDrawable panel=new LayerDrawable(new android.graphics.drawable.Drawable[]{base,top});panel.setLayerInset(1,dp(20),0,dp(20),0);panel.setLayerHeight(1,dp(1));panel.setLayerGravity(1,Gravity.TOP);return panel;}
        GradientDrawable cyan=new GradientDrawable();cyan.setGradientType(GradientDrawable.RADIAL_GRADIENT);cyan.setColors(new int[]{0x344ce0d6,0x004ce0d6});cyan.setGradientCenter(.05f,.05f);cyan.setGradientRadius(dp(220));cyan.setCornerRadius(dp(20));
        GradientDrawable purple=new GradientDrawable();purple.setGradientType(GradientDrawable.RADIAL_GRADIENT);purple.setColors(new int[]{0x3aae9bff,0x00ae9bff});purple.setGradientCenter(1f,1f);purple.setGradientRadius(dp(170));purple.setCornerRadius(dp(20));
        LayerDrawable panel=new LayerDrawable(new android.graphics.drawable.Drawable[]{base,cyan,purple,top});panel.setLayerInset(3,dp(20),0,dp(20),0);panel.setLayerHeight(3,dp(1));panel.setLayerGravity(3,Gravity.TOP);return panel;
    }
    private LayerDrawable buttonFace(boolean primary){return new LayerDrawable(new android.graphics.drawable.Drawable[]{shape(primary?CYAN:FRAME,12,primary?0:EDGE)});}
    private StateListDrawable inputFace(){
        GradientDrawable normal=shape(CANVAS,12,EDGE);
        GradientDrawable focused=shape(CANVAS,12,CYAN);
        StateListDrawable states=new StateListDrawable();states.addState(new int[]{android.R.attr.state_focused},focused);states.addState(new int[]{},normal);return states;
    }

 void page(String id,String title){
  if(pairingTimer!=null)pairingTimer.cancel();pairWait=null;screen=id;signature="";
  LinearLayout shell=column();shell.setBackgroundColor(CANVAS);setContentView(shell);
  LinearLayout head=line(shell);head.setPadding(dp(20),dp(12),dp(20),dp(12));
  ImageView logo=new ImageView(this);logo.setImageResource(R.drawable.diana_brand);logo.setScaleType(ImageView.ScaleType.FIT_CENTER);logo.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);head.addView(logo,new LinearLayout.LayoutParams(dp(38),dp(38)));
  LinearLayout brand=column();brand.setPadding(dp(11),0,0,0);head.addView(brand,new LinearLayout.LayoutParams(0,-2,1));TextView mark=label(brand,"DIANA");mark.setTextSize(20);mark.setTypeface(Typeface.create("sans-serif-medium",0));mark.setLetterSpacing(.05f);
  connection=label(brand,id.equals("pair")?"코드로 내 PC 연결":"연결된 PC에서 문서 작업");connection.setTextSize(11);connection.setTextColor(MUTED);
  View rule=new View(this);rule.setBackgroundColor(EDGE);shell.addView(rule,new LinearLayout.LayoutParams(-1,dp(1)));
  ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);scroll.setClipToPadding(false);shell.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));page=column();page.setPadding(dp(20),dp(20),dp(20),dp(24));scroll.addView(page);
  if(!id.equals("work")&&!id.equals("pair")){TextView heading=label(page,id.equals("archive")?"보관 파일":"설정");heading.setTextSize(25);heading.setTypeface(Typeface.DEFAULT_BOLD);heading.setPadding(0,0,0,dp(16));}
  note=label(page,"");final TextView status=note;status.setTextColor(CYAN);status.setTextSize(13);status.setVisibility(View.GONE);status.setPadding(0,dp(6),0,dp(12));status.addTextChangedListener(new android.text.TextWatcher(){public void beforeTextChanged(CharSequence x,int a,int c,int f){}public void onTextChanged(CharSequence x,int a,int b,int c){status.setVisibility(x.length()>0?View.VISIBLE:View.GONE);}public void afterTextChanged(android.text.Editable e){}});
  dock=new LinearLayout(this);dock.setPadding(dp(12),dp(6),dp(12),dp(6));dock.setBackgroundColor(FRAME);
  if(!id.equals("pair")){shell.addView(dock,new LinearLayout.LayoutParams(-1,dp(68)));tab("작업",R.drawable.ic_ui_home,id.equals("work"),()->work());tab("파일",R.drawable.ic_ui_inbox,id.equals("archive"),()->archive());tab("설정",R.drawable.ic_ui_settings,id.equals("settings"),()->settings());}
  shell.setOnApplyWindowInsetsListener((v,in)->{int left,top,right,bottom;boolean keyboard=false;if(Build.VERSION.SDK_INT>=30){android.graphics.Insets safe=in.getInsets(android.view.WindowInsets.Type.systemBars()|android.view.WindowInsets.Type.displayCutout());int ime=in.getInsets(android.view.WindowInsets.Type.ime()).bottom;keyboard=in.isVisible(android.view.WindowInsets.Type.ime());left=safe.left;top=safe.top;right=safe.right;bottom=Math.max(safe.bottom,ime);}else{left=in.getSystemWindowInsetLeft();top=in.getSystemWindowInsetTop();right=in.getSystemWindowInsetRight();bottom=in.getSystemWindowInsetBottom();}v.setPadding(left,top,right,bottom);if(!id.equals("pair"))dock.setVisibility(keyboard?View.GONE:View.VISIBLE);return in;});shell.requestApplyInsets();
 }
 void tab(String name,int icon,boolean selected,Runnable action){LinearLayout item=column();item.setGravity(Gravity.CENTER);item.setBackground(shape(selected?ACTIVE:FRAME,12,selected?EDGE:0));item.setContentDescription(name);item.setSelected(selected);item.setFocusable(true);item.setClickable(true);LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(0,-1,1);lp.setMargins(dp(4),0,dp(4),0);dock.addView(item,lp);ImageView image=new ImageView(this);image.setImageResource(icon);image.setColorFilter(selected?CYAN:MUTED);item.addView(image,new LinearLayout.LayoutParams(dp(21),dp(21)));TextView label=label(item,name);label.setTextSize(12);label.setLayoutParams(new LinearLayout.LayoutParams(-1,-2));label.setGravity(Gravity.CENTER);label.setTextAlignment(View.TEXT_ALIGNMENT_CENTER);label.setTextColor(selected?CYAN:MUTED);item.setOnClickListener(v->{if(!pending)action.run();});}
 LinearLayout card(LinearLayout parent){LinearLayout box=column();box.setPadding(dp(16),dp(14),dp(16),dp(14));box.setBackground(shape(SURFACE,16,EDGE));LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.bottomMargin=dp(12);parent.addView(box,lp);return box;}
 TextView caption(LinearLayout parent,String text){TextView t=label(parent,text);t.setTextSize(13);t.setTextColor(MUTED);return t;}
 void empty(LinearLayout parent,String title,String detail){LinearLayout box=card(parent);box.setGravity(Gravity.CENTER);box.setPadding(dp(20),dp(32),dp(20),dp(32));ImageView image=new ImageView(this);image.setImageResource(R.drawable.ic_ui_inbox);image.setColorFilter(CYAN);box.addView(image,new LinearLayout.LayoutParams(dp(36),dp(36)));TextView h=label(box,title);h.setTextSize(17);h.setGravity(Gravity.CENTER);h.setTypeface(Typeface.DEFAULT_BOLD);caption(box,detail).setGravity(Gravity.CENTER);}
 void fileRow(LinearLayout parent,String name,String detail,Runnable open,Runnable remove){LinearLayout box=new LinearLayout(this);box.setGravity(Gravity.CENTER_VERTICAL);box.setPadding(dp(14),dp(14),dp(12),dp(14));box.setBackground(shape(SURFACE,14,EDGE));LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.bottomMargin=dp(10);parent.addView(box,lp);ImageView image=new ImageView(this);image.setImageResource(R.drawable.ic_ui_file);image.setColorFilter(CYAN);box.addView(image,new LinearLayout.LayoutParams(dp(27),dp(32)));LinearLayout words=column();words.setPadding(dp(13),0,dp(10),0);box.addView(words,new LinearLayout.LayoutParams(0,-2,1));TextView title=label(words,name);title.setTextSize(14);title.setMaxLines(2);title.setEllipsize(android.text.TextUtils.TruncateAt.END);caption(words,detail);words.setOnClickListener(v->open.run());image.setOnClickListener(v->open.run());if(remove!=null){TextView menu=new TextView(this);menu.setText("⋮");menu.setTextColor(INK);menu.setTextSize(25);menu.setGravity(Gravity.CENTER);menu.setContentDescription(name+" 메뉴");box.addView(menu,new LinearLayout.LayoutParams(dp(44),dp(44)));menu.setOnClickListener(v->{PopupMenu popup=new PopupMenu(this,menu);popup.getMenu().add("휴대폰 사본 삭제");popup.setOnMenuItemClickListener(m->{remove.run();return true;});popup.show();});}else{ImageView arrow=new ImageView(this);arrow.setImageResource(R.drawable.ic_ui_chevron);arrow.setColorFilter(MUTED);box.addView(arrow,new LinearLayout.LayoutParams(dp(18),dp(24)));arrow.setOnClickListener(v->open.run());}}
 TextView label(LinearLayout box,String s){TextView t=new TextView(this);t.setText(s);t.setTextColor(INK);t.setTextSize(16);t.setPadding(0,dp(2),0,dp(2));box.addView(t);return t;}
 EditText field(String hint){return field(page,hint);}
 EditText field(LinearLayout parent,String hint){EditText e=new EditText(this);e.setHint(hint);e.setTextColor(INK);e.setHintTextColor(MUTED);e.setBackground(inputFace());e.setTextSize(16);e.setPadding(dp(14),dp(12),dp(14),dp(12));LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.topMargin=dp(10);parent.addView(e,lp);return e;}
 void button(LinearLayout parent,String name,Runnable fn){
  boolean primary=name.equals("보내기")||name.equals("PC에 요청하기")||name.equals("로그인")||name.equals("기기 연결");boolean file=name.matches("(?i).+\\.(md|txt|json|docx|pptx|ppt|pdf)$");
  int icon=file?R.drawable.ic_ui_file:name.equals("보내기")||name.equals("PC에 요청하기")?R.drawable.ic_ui_send:name.equals("기기 연결 및 설정")?R.drawable.ic_ui_settings:name.equals("보관 파일")?R.drawable.ic_ui_inbox:name.equals("파일 첨부")?R.drawable.ic_ui_folder:0;
  Button b=new Button(this);b.setText(name);b.setTextSize(14);b.setTypeface(Typeface.create("sans-serif-medium",0));b.setAllCaps(false);b.setTextColor(primary?0xff072a2c:INK);b.setMinWidth(0);b.setMinimumWidth(0);b.setMinHeight(dp(48));b.setGravity(file?Gravity.START|Gravity.CENTER_VERTICAL:Gravity.CENTER);b.setBackgroundTintList(null);
  b.setBackground(new RippleDrawable(ColorStateList.valueOf(0x444ce0d6),buttonFace(primary),shape(Color.WHITE,14,0)));b.setPadding(dp(11),dp(8),dp(11),dp(10));if(icon!=0){Drawable graphic=getDrawable(icon).mutate();graphic.setTint(primary?0xff082e31:CYAN);graphic.setBounds(0,0,dp(18),dp(18));b.setCompoundDrawablesRelative(graphic,null,null,null);b.setCompoundDrawablePadding(dp(6));}
  boolean inline=parent.getOrientation()==LinearLayout.HORIZONTAL;LinearLayout.LayoutParams lp=inline?new LinearLayout.LayoutParams(0,-2,1):new LinearLayout.LayoutParams(-1,-2);lp.topMargin=dp(9);if(inline&&parent.getChildCount()>0)lp.setMarginStart(dp(8));parent.addView(b,lp);b.setOnClickListener(v->fn.run());
 }
 private void styleRequestInput(EditText input){input.setBackground(inputFace());input.setTextColor(INK);input.setHintTextColor(MUTED);input.setHighlightColor(0x554ce0d6);input.setPadding(dp(14),dp(14),dp(14),dp(14));if(Build.VERSION.SDK_INT>=29){GradientDrawable cursor=new GradientDrawable();cursor.setColor(CYAN);cursor.setSize(dp(2),dp(23));input.setTextCursorDrawable(cursor);}}
 void login(){pair();}
 void showPairWait(long until){if(!screen.equals("pair")||pairWait==null)return;if(pairingTimer!=null)pairingTimer.cancel();note.setText("코드를 5회 잘못 입력했습니다.");pairWait.setVisibility(View.VISIBLE);pairingTimer=new CountDownTimer(Math.max(0,until-System.currentTimeMillis()),1000){public void onTick(long ms){long seconds=(ms+999)/1000;if(screen.equals("pair")&&pairWait!=null)pairWait.setText(String.format(java.util.Locale.ROOT,"%02d:%02d",seconds/60,seconds%60));}public void onFinish(){if(screen.equals("pair")&&pairWait!=null){pairWait.setVisibility(View.GONE);note.setText("");}}}.start();}
 void pair(){page("pair","내 PC와 연결");LinearLayout container=page;page=card(container);TextView intro=label(page,"내 PC를 연결하세요");intro.setTextSize(24);intro.setTypeface(Typeface.DEFAULT_BOLD);
  label(page,"PC의 기기 연결 화면에서 코드를 만든 뒤 입력하세요.");
  label(page,"같은 와이파이가 아니어도 연결됩니다. PC 앱은 켜 두세요.");
  pairWait=label(page,"");pairWait.setTextColor(CYAN);pairWait.setTextSize(24);pairWait.setGravity(Gravity.CENTER);pairWait.setVisibility(View.GONE);pairWait.setContentDescription("다시 입력할 수 있을 때까지 남은 시간");
  EditText code=field("6자리 연결 코드");code.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);code.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(6)});code.setTextSize(26);code.setGravity(Gravity.CENTER);code.setLetterSpacing(.18f);code.setContentDescription("6자리 연결 코드");code.setHint("000000");
  long waiting=getSharedPreferences("pairing",MODE_PRIVATE).getLong("until",0);if(waiting>System.currentTimeMillis())showPairWait(waiting);
  button(page,"기기 연결",()->{long until=getSharedPreferences("pairing",MODE_PRIVATE).getLong("until",0);if(until>System.currentTimeMillis()){showPairWait(until);return;}String c=code.getText().toString().trim();if(!c.matches("[0-9]{6}")){note.setText("PC에 표시된 6자리 코드를 입력하세요.");return;}
   note.setText("PC에 연결하는 중입니다.");async(()->{
    JSONObject attempt=store.load();
    if(attempt==null||!c.equals(attempt.optString("pendingCode"))){String previous=attempt==null?"":attempt.optString("device",attempt.optString("previousDevice",""));if(previous.isEmpty()&&session!=null)previous=session.optString("device",session.optString("previousDevice",""));if(previous.isEmpty())previous=getSharedPreferences("pairing",MODE_PRIVATE).getString("previousDevice","");attempt=obj("origin",PairedLink.ORIGIN,"pendingCode",c,"requestId",PairedLink.requestId(),"pairKey",PairedLink.pairKey(),"previousDevice",previous);store.save(attempt);}
    PairedWire.Reply reply=PairedLink.pair(PairedLink.ORIGIN,c,attempt.getString("requestId"),attempt.getString("pairKey"));
    JSONObject r=new JSONObject(reply.body);if(reply.status!=200){if(reply.status==429&&r.has("retryAfter")){long deadline=System.currentTimeMillis()+r.getInt("retryAfter")*1000L;getSharedPreferences("pairing",MODE_PRIVATE).edit().putLong("until",deadline).commit();runOnUiThread(()->showPairWait(deadline));return;}if(reply.status==403)store.clear();throw new IOException(r.optString("error","연결하지 못했습니다. PC에서 새 코드를 만들고 다시 시도하세요.")+(r.has("remaining")?" 남은 시도 "+r.getInt("remaining")+"회":""));}
    String previous=attempt.optString("previousDevice"),device=r.getString("device");if(!previous.isEmpty()&&!previous.equals(device)){SharedPreferences.Editor files=getSharedPreferences("paired-"+device,MODE_PRIVATE).edit();for(Map.Entry<String,?> item:getSharedPreferences("paired-"+previous,MODE_PRIVATE).getAll().entrySet()){String key=item.getKey();if((key.startsWith("file-")||key.equals("tree"))&&item.getValue() instanceof String)files.putString(key,(String)item.getValue());else if(key.startsWith("removed-")&&item.getValue() instanceof Boolean)files.putBoolean(key,(Boolean)item.getValue());}if(!files.commit())throw new IOException("기존 보관 파일 정보를 옮기지 못했습니다. 다시 시도하세요.");}
    session=obj("origin",PairedLink.ORIGIN,"token",r.getString("token"),"device",device);store.save(session);getSharedPreferences("pairing",MODE_PRIVATE).edit().remove("until").commit();PairedReceiver.schedule(this);runOnUiThread(()->work());
   });
  });
  label(page,"한 번 연결하면 다음 실행부터 자동으로 연결됩니다.");
 }
 void work(){getSharedPreferences("pairing",MODE_PRIVATE).edit().putString("previousDevice",session.optString("device")).commit();local=getSharedPreferences("paired-"+session.optString("device"),MODE_PRIVATE);page("work","DIANA  ·  PC 문서 작업");
 LinearLayout composer=card(page);TextView title=label(composer,"무엇을 만들까요?");title.setTextSize(22);title.setTypeface(Typeface.DEFAULT_BOLD);caption(composer,"PC 자료를 찾아 요약하거나 새 문서를 요청하세요.");
 editor=field(composer,"어떤 문서 작업을 할까요?");styleRequestInput(editor);editor.setMinLines(4);editor.setMaxLines(8);editor.setGravity(Gravity.START|Gravity.TOP);LinearLayout actions=line(composer);editor.setText(local.getString("draftText",local.getString("text","")));editor.addTextChangedListener(new android.text.TextWatcher(){public void beforeTextChanged(CharSequence x,int a,int c,int f){}public void onTextChanged(CharSequence x,int a,int b,int c){local.edit().putString("draftText",x.toString()).apply();}public void afterTextChanged(android.text.Editable e){}});
 button(actions,"보내기",()->{String text=editor.getText().toString().trim();if(text.isEmpty())return;String key=text.equals(local.getString("text",""))?local.getString("id",null):null;final String id=key==null?UUID.randomUUID().toString():key;if(!local.edit().putString("id",id).putString("text",text).commit())return;async(()->{JSONObject r=call(obj("op","job","action","desk-start","id",id,"text",text));local.edit().remove("text").remove("id").remove("draftText").commit();runOnUiThread(()->{if(screen.equals("work")){editor.setText("");note.setText(r.optString("notice","PC에 보냈습니다."));}});refresh();});});
 button(actions,"파일 첨부",()->{Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");startActivityForResult(i,21);});
 rows=column();rows.setPadding(0,dp(4),0,0);page.addView(rows);}
 void refresh()throws Exception{JSONObject r=call(obj("op","state"));JSONArray all=new JSONArray();int offset=0;
 while(true){JSONArray batch=r.getJSONArray("files");for(int i=0;i<batch.length();i++){JSONObject f=batch.getJSONObject(i);receive(f);all.put(f);}if(!r.optBoolean("more"))break;offset+=20;r=call(obj("op","state","offset",offset));}
 final JSONArray jobs=r.getJSONArray("jobs");String sig=jobs.toString()+all.toString();runOnUiThread(()->{if(!screen.equals("work")||isDestroyed())return;connection.setText("PC 연결됨");if(signature.equals(sig))return;signature=sig;rows.removeAllViews();for(int i=0;i<jobs.length();i++)renderJob(rows,jobs.optJSONObject(i));if(all.length()>0){TextView recent=label(rows,"최근 파일");recent.setTextSize(17);recent.setTypeface(Typeface.DEFAULT_BOLD);recent.setPadding(0,dp(8),0,dp(12));int shown=0;for(int i=0;i<all.length()&&shown<3;i++){JSONObject f=all.optJSONObject(i);if(local.contains("file-"+f.optString("id"))){fileRow(rows,f.optString("name"),"휴대폰에 저장됨",()->open(f.optString("id")),null);shown++;}}}else if(jobs.length()==0)caption(rows,"만든 파일은 ‘파일’에 모아둘게요.");});}
 void renderJob(LinearLayout parent,JSONObject job){
  String state=job.optString("status");
  boolean mobileApproval=state.equals("approval")&&job.optBoolean("canApprove");
  LinearLayout task=card(parent);
  TextView heading=label(task,state.equals("failed")?"요청 확인이 필요해요":state.equals("reading")?"자료를 읽고 있어요":state.equals("saving")?"파일을 저장하고 있어요":mobileApproval?"저장 전 확인":"PC에서 확인을 기다려요");
  heading.setTextSize(15);heading.setTypeface(Typeface.DEFAULT_BOLD);
  caption(task,state.equals("failed")?job.optString("error"):state.equals("reading")?"완료되면 결과 파일을 받을 수 있습니다.":state.equals("saving")?"PC에 결과를 저장하고 있습니다.":mobileApproval?"미리보기를 확인하고 새 파일로 저장할 수 있습니다.":"미리보기와 저장 승인은 PC에서 확인하세요.");
  LinearLayout buttons=line(task);
  if(mobileApproval)button(buttons,"미리보기",()->showPhonePreview(job.optString("id")));
  if(state.equals("failed"))button(buttons,"다시 시도",()->job("desk-retry",job));
  if(!state.equals("saving"))button(buttons,state.equals("failed")?"닫기":"중단",()->job("desk-cancel",job));
 }
 void showPhonePreview(String id){
  async(()->{
   JSONObject result=call(obj("op","phone-preview","id",id));
   if(!id.equals(result.getString("id")))throw new IOException("작업 정보를 다시 확인하세요.");
   String preview=result.getString("preview"),nonce=result.getString("nonce");
   String format=result.getString("format").toUpperCase(java.util.Locale.ROOT);
   runOnUiThread(()->{
    if(isDestroyed()||isFinishing()||!active||!screen.equals("work"))return;
    ScrollView scroll=new ScrollView(this);
    TextView text=new TextView(this);
    text.setText(preview);text.setTextSize(15);text.setPadding(dp(22),dp(12),dp(22),dp(12));
    scroll.addView(text);
    new AlertDialog.Builder(this).setTitle("저장 전 미리보기 · "+format).setView(scroll)
     .setNegativeButton("닫기",null)
     .setPositiveButton("승인 후 저장",(dialog,which)->async(()->{
      call(obj("op","phone-approve","id",id,"nonce",nonce,"confirm",true));
      refresh();
     })).show();
   });
  });
 }
 void job(String action,JSONObject j){async(()->{call(obj("op","job","action",action,"id",j.getString("id")));refresh();});}
 void receive(JSONObject f)throws Exception{new PairedFiles(this,session).receive(f);}
 void open(String id){try{JSONObject r=new JSONObject(local.getString("file-"+id,""));Uri uri=Uri.parse(r.getString("uri"));String name=r.getString("name"),ext=name.substring(name.lastIndexOf('.')+1);String type=android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);if(type==null)type="text/plain";startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri,type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));}catch(Exception e){note.setText("파일을 열 앱과 저장 위치를 확인하세요.");}}
 void archive(){page("archive","보관 파일");caption(page,"받은 파일을 열거나 휴대폰 사본을 관리하세요.");java.util.ArrayList<String> keys=new java.util.ArrayList<>();for(String key:local.getAll().keySet())if(key.startsWith("file-"))keys.add(key);java.util.Collections.sort(keys);if(keys.isEmpty()){empty(page,"아직 받은 파일이 없어요","PC에서 저장한 결과가 여기에 표시됩니다.");return;}for(String key:keys){try{JSONObject f=new JSONObject(local.getString(key,""));String id=key.substring(5);fileRow(page,f.getString("name"),"휴대폰 보관 파일",()->open(id),()->new AlertDialog.Builder(this).setTitle("휴대폰 사본 삭제").setMessage(f.optString("name")+"\n\nPC에 있는 파일은 그대로 유지됩니다.").setNegativeButton("유지",null).setPositiveButton("삭제",(dlg,btn)->{try{if(getContentResolver().delete(Uri.parse(f.optString("uri")),null,null)!=1)throw new IOException();local.edit().remove(key).putBoolean("removed-"+id,true).commit();archive();}catch(Exception e){note.setText("파일을 삭제하지 못했습니다.");}}).show());}catch(Exception ignored){note.setText("보관 파일 정보를 확인하세요.");}}}
 void settings(){page("settings","설정");LinearLayout pc=card(page);TextView pcTitle=label(pc,"내 PC 연결");pcTitle.setTextSize(17);pcTitle.setTypeface(Typeface.DEFAULT_BOLD);caption(pc,"연결 정보는 이 기기에 안전하게 보관됩니다.");button(pc,"기기 연결 해제",()->new AlertDialog.Builder(this).setTitle("기기 연결 해제").setMessage("현재 휴대폰과 PC의 연결을 해제할까요? 받은 파일은 유지됩니다.").setNegativeButton("유지",null).setPositiveButton("해제",(d,b)->async(()->{call(obj("op","revoke","device",session.getString("device")));store.clear();runOnUiThread(()->login());})).show());LinearLayout storage=card(page);TextView storageTitle=label(storage,"파일 저장");storageTitle.setTextSize(17);storageTitle.setTypeface(Typeface.DEFAULT_BOLD);caption(storage,local.getString("tree","").isEmpty()?"앱의 보관 파일에 자동 저장":"선택한 폴더에 저장");button(storage,"저장 폴더 변경",()->startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE),22));LinearLayout app=card(page);label(app,"DIANA");caption(app,"버전 "+BuildConfig.VERSION_NAME);}
 protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(result!=RESULT_OK||data==null||data.getData()==null)return;Uri uri=data.getData();
 if(request==22){try{getContentResolver().takePersistableUriPermission(uri,data.getFlags()&(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION));local.edit().putString("tree",uri.toString()).commit();settings();}catch(Exception e){note.setText("선택한 위치를 사용할 수 없습니다.");}}
 if(request==21)async(()->{String name;try(Cursor c=getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)){if(c==null||!c.moveToFirst())throw new IOException("파일 이름을 확인할 수 없습니다.");name=c.getString(0);}byte[] bytes=read(getContentResolver().openInputStream(uri),8000000);call(obj("op","job","action","desk-upload","requestId",UUID.randomUUID().toString(),"name",name,"sha256",sha(bytes),"base64",android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP)));runOnUiThread(()->note.setText(name+" 첨부됨"));});}
}

