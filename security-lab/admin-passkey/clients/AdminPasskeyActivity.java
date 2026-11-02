package kr.nightdesk.phone;
import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.net.Uri;
import android.widget.Button;
import android.widget.TextView;
import android.widget.LinearLayout;

/** View-only Activity. Authentication work belongs to the process controller. */
public final class AdminPasskeyActivity extends Activity {
    private AdminPasskeyController controller;
    private TextView status;
    private final Runnable changed=this::refresh;
    @Override public void onCreate(Bundle b){super.onCreate(b);controller=AdminPasskeyController.get(this);
        LinearLayout root=new LinearLayout(this);root.setOrientation(1);root.setPadding(24,36,24,24);setContentView(root);
        TextView title=new TextView(this);title.setText("DIANA LAB 관리자 패스키");title.setTextSize(24);root.addView(title);
        TextView note=new TextView(this);note.setText("시험용 관리자 인증입니다. 일반 휴대폰 연결 및 PC 문서 접근·최종 승인과 별개입니다.");root.addView(note);
        status=new TextView(this);root.addView(status);
        add(root,"관리자 패스키로 로그인",controller::login);add(root,"현재 관리자 권한 확인",controller::status);add(root,"관리자 로그아웃",controller::logout);
        callback(getIntent());
    }
    private void add(LinearLayout root,String label,Runnable action){Button b=new Button(this);b.setText(label);root.addView(b);b.setOnClickListener(v->action.run());}
    private void refresh(){if(isFinishing()||isDestroyed())return;status.setText(controller.message());String url=controller.takeBrowserUrl();if(url!=null){try{Intent intent=new Intent(Intent.ACTION_VIEW,Uri.parse(url));intent.addCategory(Intent.CATEGORY_BROWSABLE);startActivity(intent);}catch(Exception e){status.setText("브라우저를 열지 못했습니다. 로그인부터 다시 시작하세요.");}}}
    @Override protected void onStart(){super.onStart();controller.observe(changed);}
    @Override protected void onStop(){controller.unobserve(changed);super.onStop();}
    @Override protected void onDestroy(){controller.unobserve(changed);super.onDestroy();}
    @Override public void onNewIntent(Intent intent){super.onNewIntent(intent);callback(intent);}
    private void callback(Intent intent){if(intent!=null&&intent.getData()!=null)controller.callback(intent.getData().toString());}
}
