package kr.nightdesk.phone;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import java.io.File;
import java.util.Locale;

/** Opens Android's consent UI only after an explicit tap on a verified local APK. */
final class ApkInstaller {
    static boolean isApk(String filename) { return filename.toLowerCase(Locale.ROOT).endsWith(".apk"); }
    @SuppressWarnings("deprecation")
    static void open(Activity activity,File file) {
        if(!activity.getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(activity).setTitle("DIANA에서 APK 설치 허용")
                .setMessage("Android 설정에서 ‘이 출처 허용’을 켠 뒤 돌아와 APK 설치 버튼을 다시 누르세요. 설치 여부는 Android 설치 화면에서 직접 결정합니다.")
                .setNegativeButton("취소",null).setPositiveButton("설정 열기",(dialog,which)->{
                    try { activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+activity.getPackageName()))); }
                    catch(Exception error) { new AlertDialog.Builder(activity).setMessage("설정 앱의 ‘알 수 없는 앱 설치’에서 DIANA를 허용해 주세요.").setPositiveButton("확인",null).show(); }
                }).show();
            return;
        }
        Uri uri=FileProvider.getUriForFile(activity,activity.getPackageName()+".files",file);
        Intent install=new Intent(Intent.ACTION_INSTALL_PACKAGE).setData(uri)
            .setClipData(ClipData.newRawUri("APK",uri)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        activity.startActivity(install);
    }
}
