package kr.nightdesk.phone;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
public final class SyncWorker extends Worker {
    public SyncWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }
    @NonNull @Override public Result doWork() {
        try { SyncEngine.sync(getApplicationContext(), this::isStopped); return Result.success(); }
        catch (Exception error) {
            getApplicationContext().getSharedPreferences("MainActivity", 0).edit().putString("last_error", error.getMessage() == null ? "동기화를 다시 시도합니다." : error.getMessage()).apply();
            if (error instanceof Api.ApiException && (((Api.ApiException) error).status == 401 || ((Api.ApiException) error).status == 403)) return Result.failure();
            return getRunAttemptCount() < 5 ? Result.retry() : Result.failure();
        }
    }
}
