package kr.nightdesk.phone;

import android.content.Context;
import android.os.Build;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.concurrent.TimeUnit;

final class SyncScheduler {
    static final String PERIODIC = "nightdesk-periodic-receive";
    private static final String ONE_TIME = "nightdesk-sync-now";
    static boolean enabled(Context c) { return c.getSharedPreferences("MainActivity", 0).getBoolean("auto_receive", true); }
    static void configure(Context c) {
        try {
            if (new SecureStore(c).load() == null || !enabled(c)) {
                WorkManager.getInstance(c).cancelUniqueWork(PERIODIC);
                WorkManager.getInstance(c).cancelUniqueWork(ONE_TIME);
                return;
            }
            Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
            PeriodicWorkRequest work = new PeriodicWorkRequest.Builder(SyncWorker.class, 15, TimeUnit.MINUTES).setConstraints(constraints).build();
            WorkManager.getInstance(c).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, work);
        } catch (Exception ignored) { /* Pairing UI explains unavailable credentials. */ }
    }
    static void once(Context c) {
        if (!enabled(c)) return;
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        WorkManager.getInstance(c).enqueueUniqueWork(ONE_TIME, ExistingWorkPolicy.KEEP,
            new OneTimeWorkRequest.Builder(SyncWorker.class).setConstraints(constraints).build());
    }
    static void fromPush(Context c, boolean highPriority) {
        if (!enabled(c)) return;
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        OneTimeWorkRequest.Builder request = new OneTimeWorkRequest.Builder(SyncWorker.class).setConstraints(constraints);
        // Android 12+ has native expedited jobs. Older versions keep the normal
        // one-time path, which does not require a foreground-service notification.
        if (highPriority && Build.VERSION.SDK_INT >= 31) request.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST);
        // A file-ready hint received during a running download needs a follow-up
        // read: KEEP could otherwise discard it until the next periodic run.
        WorkManager.getInstance(c).enqueueUniqueWork(ONE_TIME, ExistingWorkPolicy.APPEND_OR_REPLACE, request.build());
    }
}
