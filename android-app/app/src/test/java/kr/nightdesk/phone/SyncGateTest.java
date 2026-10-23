package kr.nightdesk.phone;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public class SyncGateTest {
    private static final long TIMEOUT_MS = 4000;

    @Test public void concurrentTasksPublishOneAtATime() throws Exception {
        SyncGate gate = new SyncGate();
        CountDownLatch firstInside = new CountDownLatch(1), releaseFirst = new CountDownLatch(1), secondInside = new CountDownLatch(1), secondWaiting = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        AtomicInteger active = new AtomicInteger(), maxActive = new AtomicInteger(), checks = new AtomicInteger();
        Thread first = start(failure, () -> gate.run(() -> false, () -> {
            maxActive.accumulateAndGet(active.incrementAndGet(), Math::max);
            firstInside.countDown();
            try { await(releaseFirst); } finally { active.decrementAndGet(); }
            return null;
        }));
        await(firstInside);
        Thread second = start(failure, () -> gate.run(() -> {
            if (checks.incrementAndGet() >= 2) secondWaiting.countDown(); return false;
        }, () -> {
            maxActive.accumulateAndGet(active.incrementAndGet(), Math::max);
            secondInside.countDown(); active.decrementAndGet(); return null;
        }));
        try {
            await(secondWaiting);
            assertEquals("second task entered while the first was publishing", 1, secondInside.getCount());
        } finally { releaseFirst.countDown(); }
        join(first); join(second);
        assertNull(failure.get());
        assertEquals(0, secondInside.getCount());
        assertEquals(1, maxActive.get());
        assertEquals(0, active.get());
    }

    @Test public void cancelledQueuedWorkerStopsWithoutExecutingItsTask() throws Exception {
        SyncGate gate = new SyncGate();
        CountDownLatch ownerInside = new CountDownLatch(1), releaseOwner = new CountDownLatch(1), waiterBlocked = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        AtomicBoolean stopped = new AtomicBoolean(), executed = new AtomicBoolean(), cancelled = new AtomicBoolean();
        AtomicInteger checks = new AtomicInteger();
        Thread owner = start(failure, () -> gate.run(() -> false, () -> { ownerInside.countDown(); await(releaseOwner); return null; }));
        await(ownerInside);
        Thread waiter = start(failure, () -> {
            try {
                gate.run(() -> { if (checks.incrementAndGet() >= 2) waiterBlocked.countDown(); return stopped.get(); }, () -> { executed.set(true); return null; });
                fail("cancelled waiter completed its task");
            } catch (InterruptedIOException expected) { cancelled.set(true); }
        });
        try {
            await(waiterBlocked); stopped.set(true); join(waiter);
            assertTrue(cancelled.get()); assertFalse(executed.get());
        } finally { releaseOwner.countDown(); waiter.interrupt(); }
        join(owner); join(waiter);
        assertNull(failure.get());
        assertEquals(Integer.valueOf(7), gate.run(() -> false, () -> 7));
    }

    @Test public void exceptionReleasesTheGateForADifferentThread() throws Exception {
        SyncGate gate = new SyncGate();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        AtomicBoolean threw = new AtomicBoolean(), nextExecuted = new AtomicBoolean();
        IOException marker = new IOException("fixture publication failed");
        Thread failed = start(failure, () -> {
            try { gate.run(() -> false, () -> { throw marker; }); fail("task failure was swallowed"); }
            catch (IOException expected) { assertSame(marker, expected); threw.set(true); }
        });
        join(failed);
        Thread next = start(failure, () -> gate.run(() -> false, () -> { nextExecuted.set(true); return null; }));
        try { join(next); } finally { next.interrupt(); }
        assertNull(failure.get()); assertTrue(threw.get()); assertTrue(nextExecuted.get());
    }

    @Test public void interruptingAQueuedWorkerPreservesItsInterruptAndNeverRunsTheTask() throws Exception {
        SyncGate gate = new SyncGate();
        CountDownLatch ownerInside = new CountDownLatch(1), releaseOwner = new CountDownLatch(1), waiterBlocked = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        AtomicInteger checks = new AtomicInteger();
        AtomicBoolean executed = new AtomicBoolean(), interrupted = new AtomicBoolean();
        Thread owner = start(failure, () -> gate.run(() -> false, () -> { ownerInside.countDown(); await(releaseOwner); return null; }));
        await(ownerInside);
        Thread waiter = start(failure, () -> {
            try {
                gate.run(() -> { if (checks.incrementAndGet() >= 2) waiterBlocked.countDown(); return false; }, () -> { executed.set(true); return null; });
                fail("interrupted waiter completed its task");
            } catch (InterruptedIOException expected) { interrupted.set(Thread.currentThread().isInterrupted()); }
        });
        try { await(waiterBlocked); waiter.interrupt(); join(waiter); }
        finally { releaseOwner.countDown(); waiter.interrupt(); }
        join(owner); join(waiter);
        assertNull(failure.get()); assertTrue(interrupted.get()); assertFalse(executed.get());
    }

    @Test public void cancellationBeforeEntryDoesNotRunTheTask() throws Exception {
        SyncGate gate = new SyncGate(); AtomicBoolean executed = new AtomicBoolean();
        try { gate.run(() -> true, () -> { executed.set(true); return null; }); fail("cancelled caller ran"); }
        catch (InterruptedIOException expected) { assertFalse(Thread.currentThread().isInterrupted()); }
        assertFalse(executed.get());
        assertEquals(Integer.valueOf(3), gate.run(() -> false, () -> 3));
    }

    private interface Action { void run() throws Exception; }
    private static Thread start(AtomicReference<Throwable> failure, Action action) {
        Thread thread = new Thread(() -> { try { action.run(); } catch (Throwable error) { failure.compareAndSet(null, error); } });
        thread.setDaemon(true); thread.start(); return thread;
    }
    private static void await(CountDownLatch latch) throws InterruptedException {
        assertTrue("timed out waiting for worker coordination", latch.await(TIMEOUT_MS, TimeUnit.MILLISECONDS));
    }
    private static void join(Thread thread) throws InterruptedException {
        thread.join(TIMEOUT_MS);
        if (thread.isAlive()) { thread.interrupt(); fail("worker did not finish"); }
    }
}
