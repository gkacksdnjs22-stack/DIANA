package kr.nightdesk.phone;

import android.content.Context;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.concurrent.TimeUnit;

final class SyncScheduler {
    static final String PERIODIC = "nightdesk-periodic-receive";
    static boolean enabled(Context c) { return c.getSharedPreferences("settings", 0).getBoolean("auto_receive", true); }
    static void configure(Context c) {
        try {
            if (new SecureStore(c).load() == null || !enabled(c)) { WorkManager.getInstance(c).cancelUniqueWork(PERIODIC); return; }
            Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
            PeriodicWorkRequest work = new PeriodicWorkRequest.Builder(SyncWorker.class, 15, TimeUnit.MINUTES).setConstraints(constraints).build();
            WorkManager.getInstance(c).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, work);
        } catch (Exception ignored) { /* Pairing UI explains unavailable credentials. */ }
    }
    static void once(Context c) {
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        WorkManager.getInstance(c).enqueueUniqueWork("nightdesk-sync-now", ExistingWorkPolicy.KEEP,
            new OneTimeWorkRequest.Builder(SyncWorker.class).setConstraints(constraints).build());
    }
}
