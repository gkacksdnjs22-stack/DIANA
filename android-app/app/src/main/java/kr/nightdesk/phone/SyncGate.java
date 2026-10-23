package kr.nightdesk.phone;

import java.io.InterruptedIOException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;

/** Serializes file publication while allowing a queued worker to be cancelled. */
final class SyncGate {
    interface Task<T> { T run() throws Exception; }
    private final ReentrantLock lock = new ReentrantLock(true);

    <T> T run(BooleanSupplier stopped, Task<T> task) throws Exception {
        boolean acquired = false;
        try {
            checkStopped(stopped);
            while (!(acquired = lock.tryLock(100, TimeUnit.MILLISECONDS))) checkStopped(stopped);
            checkStopped(stopped);
            return task.run();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            InterruptedIOException error = new InterruptedIOException("동기화가 중단되었습니다.");
            error.initCause(interrupted);
            throw error;
        } finally {
            if (acquired) lock.unlock();
        }
    }
    private static void checkStopped(BooleanSupplier stopped) throws InterruptedIOException {
        if (Thread.currentThread().isInterrupted() || stopped.getAsBoolean()) throw new InterruptedIOException("동기화가 중단되었습니다.");
    }
}
