package kr.nightdesk.phone;

import android.app.Application;
public final class NightDeskApplication extends Application {
    @Override public void onCreate() { super.onCreate(); Notifications.ensureChannel(this); PushSupport.initialize(this); SyncScheduler.configure(this); }
}
