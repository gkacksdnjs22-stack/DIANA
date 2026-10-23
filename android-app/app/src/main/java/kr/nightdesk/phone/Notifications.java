package kr.nightdesk.phone;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

final class Notifications {
    static final String CHANNEL = "nightdesk-results";
    static void ensureChannel(Context c) { c.getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL, "작업 결과 도착", NotificationManager.IMPORTANCE_DEFAULT)); }
    static void received(Context c, int count) {
        if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        PendingIntent open = PendingIntent.getActivity(c, 0, new Intent(c, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(c, CHANNEL).setSmallIcon(R.drawable.ic_diana_notification).setContentTitle("작업 결과가 도착했어요")
            .setContentText(count + "개 파일을 확인하고 휴대폰에 저장했습니다.").setContentIntent(open).setAutoCancel(true).build();
        c.getSystemService(NotificationManager.class).notify(1001, notification);
    }
}
