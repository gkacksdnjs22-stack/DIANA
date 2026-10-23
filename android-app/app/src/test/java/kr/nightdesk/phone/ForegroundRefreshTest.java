package kr.nightdesk.phone;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public class ForegroundRefreshTest {
    @Test public void resumeStartsOneImmediateReadAndRepeatedResumeDoesNotDuplicateIt() {
        Harness app = new Harness();
        app.refresh.start();
        app.refresh.start();
        assertEquals(1, app.clock.pending());
        assertEquals(0, app.clock.nextDelay());
        app.clock.runReady();
        assertEquals(1, app.requests.size());
        app.refresh.start();
        app.clock.runReady();
        assertEquals(1, app.requests.size());
        app.finish(0, false, false);
        assertEquals(Arrays.asList("request:0", "apply:0"), app.events);
        assertEquals(0, app.clock.pending());
    }

    @Test public void pendingUploadPollsEveryFiveSecondsAndTerminalResultStopsPolling() {
        Harness app = started();
        app.finish(0, true, false);
        assertEquals(5000, app.clock.nextDelay());
        app.clock.advance(4999);
        assertEquals(1, app.requests.size());
        app.clock.advance(1);
        assertEquals(2, app.requests.size());
        app.finish(1, true, false);
        assertEquals(5000, app.clock.nextDelay());
        app.clock.advance(5000);
        app.finish(2, false, false);
        app.clock.advance(60_000);
        assertEquals(3, app.requests.size());
        assertEquals(0, app.clock.pending());
        assertEquals(Arrays.asList("request:0", "apply:0", "request:1", "apply:1", "request:2", "apply:2"), app.events);
    }

    @Test public void explicitRefreshesDuringAReadAreCoalescedWithoutOverlappingRequests() {
        Harness app = started();
        app.refresh.refresh();
        app.refresh.refresh();
        app.clock.advance(60_000);
        assertEquals(1, app.requests.size());
        app.finish(0, false, false);
        assertEquals(1, app.clock.pending());
        assertEquals(0, app.clock.nextDelay());
        app.clock.runReady();
        assertEquals(2, app.requests.size());
        app.clock.advance(60_000);
        assertEquals(2, app.requests.size());
        app.finish(1, false, false);
        assertEquals(0, app.clock.pending());
    }

    @Test public void stopCancelsAScheduledReadAndAnAlreadyScheduledPendingPoll() {
        Harness app = new Harness();
        app.refresh.start();
        app.refresh.stop();
        app.clock.advance(60_000);
        assertEquals(0, app.requests.size());
        app.refresh.start();
        app.clock.runReady();
        app.finish(0, true, false);
        app.refresh.stop();
        app.clock.advance(60_000);
        assertEquals(1, app.requests.size());
        assertEquals(0, app.clock.pending());
    }

    @Test public void hiddenScreenDiscardsLateResponseAndDoesNotScheduleMoreWork() {
        Harness app = started();
        app.refresh.stop();
        app.finish(0, true, false);
        app.clock.advance(60_000);
        assertEquals(Arrays.asList("request:0"), app.events);
        assertEquals(0, app.clock.pending());
        app.refresh.refresh();
        assertEquals(0, app.clock.pending());
    }

    @Test public void returningDuringAnOldReadWaitsForItThenFetchesFreshStatus() {
        Harness app = started();
        app.refresh.stop();
        app.refresh.start();
        app.clock.runReady();
        assertEquals(1, app.requests.size());
        app.finish(0, true, false);
        assertEquals(Arrays.asList("request:0"), app.events);
        assertEquals(0, app.clock.nextDelay());
        app.clock.runReady();
        assertEquals(2, app.requests.size());
        app.finish(1, false, false);
        assertEquals(Arrays.asList("request:0", "request:1", "apply:1"), app.events);
    }

    @Test public void userOperationBlocksFetchingUntilItFinishes() {
        Harness app = new Harness();
        app.blocked = true;
        app.refresh.start();
        app.clock.runReady();
        assertEquals(0, app.requests.size());
        app.clock.advance(3000);
        assertEquals(0, app.requests.size());
        app.blocked = false;
        app.refresh.refresh();
        assertEquals(0, app.clock.nextDelay());
        app.clock.runReady();
        assertEquals(1, app.requests.size());
        app.finish(0, false, false);
        assertEquals(Arrays.asList("request:0", "apply:0"), app.events);
    }

    @Test public void readCompletedDuringUserOperationCannotApplyAndIsRecheckedAfterward() {
        Harness app = started();
        app.blocked = true;
        app.finish(0, false, false);
        assertEquals(Arrays.asList("request:0"), app.events);
        app.clock.advance(1000);
        assertEquals(1, app.requests.size());
        app.blocked = false;
        app.refresh.refresh();
        app.clock.runReady();
        app.finish(1, false, false);
        assertEquals(Arrays.asList("request:0", "request:1", "apply:1"), app.events);
    }

    @Test public void explicitRefreshDuringAFailedReadIsRetainedInsteadOfWaitingForBackoff() {
        Harness app = started();
        app.refresh.refresh();
        app.requests.get(0).finish(false, true, null);
        assertEquals(0, app.clock.nextDelay());
        app.clock.runReady();
        assertEquals(2, app.requests.size());
        app.finish(1, false, false);
        assertEquals(0, app.clock.pending());
    }

    @Test public void networkFailuresBackOffToThirtySecondsAndSuccessResetsTheDelay() {
        Harness app = started();
        long[] delays = {5000, 10_000, 20_000, 30_000, 30_000};
        for (int index = 0; index < delays.length; index++) {
            app.requests.get(index).finish(false, true, null);
            assertEquals(delays[index], app.clock.nextDelay());
            app.clock.advance(delays[index] - 1);
            assertEquals(index + 1, app.requests.size());
            app.clock.advance(1);
            assertEquals(index + 2, app.requests.size());
        }
        app.finish(5, true, false);
        assertEquals(5000, app.clock.nextDelay());
        app.clock.advance(5000);
        app.requests.get(6).finish(false, true, null);
        assertEquals(5000, app.clock.nextDelay());
    }

    @Test public void duplicateCompletionCannotApplyTwiceOrReleaseAnotherRead() {
        Harness app = started();
        ForegroundRefresh.Completion old = app.requests.get(0);
        app.finish(0, true, false);
        old.finish(false, true, () -> fail("duplicate response applied"));
        assertEquals(5000, app.clock.nextDelay());
        app.clock.advance(5000);
        old.finish(true, false, () -> fail("old response applied during another request"));
        app.refresh.refresh();
        app.clock.runReady();
        assertEquals(2, app.requests.size());
        app.finish(1, false, false);
        app.clock.runReady();
        assertEquals(3, app.requests.size());
        app.finish(2, false, false);
        assertEquals(Arrays.asList("request:0", "apply:0", "request:1", "apply:1", "request:2", "apply:2"), app.events);
    }

    @Test public void responseApplyFailureRetriesAndAHiddenScreenCancelsThatRetry() {
        Harness app = started();
        app.requests.get(0).finish(false, false, () -> { throw new IllegalStateException("view unavailable"); });
        assertEquals(5000, app.clock.nextDelay());
        app.refresh.stop();
        app.clock.advance(60_000);
        assertEquals(1, app.requests.size());
        app.refresh.start();
        app.clock.runReady();
        assertEquals(2, app.requests.size());
    }

    private static Harness started() {
        Harness app = new Harness();
        app.refresh.start();
        app.clock.runReady();
        return app;
    }

    private static final class Harness {
        final FakeScheduler clock = new FakeScheduler();
        final List<ForegroundRefresh.Completion> requests = new ArrayList<>();
        final List<String> events = new ArrayList<>();
        boolean blocked;
        final ForegroundRefresh refresh = new ForegroundRefresh(clock, () -> blocked, completion -> {
            events.add("request:" + requests.size());
            requests.add(completion);
        });
        void finish(int index, boolean pending, boolean failed) {
            requests.get(index).finish(pending, failed, () -> events.add("apply:" + index));
        }
    }

    /** Deterministic main-thread queue: advancing time also runs tasks newly due before the target. */
    private static final class FakeScheduler implements ForegroundRefresh.Scheduler {
        private static final class Scheduled {
            final Runnable task;
            final long at;
            Scheduled(Runnable task, long at) { this.task = task; this.at = at; }
        }
        final List<Scheduled> queue = new ArrayList<>();
        long now;
        @Override public void post(Runnable task, long delayMs) {
            assertTrue("negative schedule delay", delayMs >= 0);
            queue.add(new Scheduled(task, now + delayMs));
        }
        @Override public void remove(Runnable task) { queue.removeIf(scheduled -> scheduled.task == task); }
        int pending() { return queue.size(); }
        long nextDelay() {
            Scheduled next = next();
            assertNotNull("expected a scheduled request", next);
            return next.at - now;
        }
        void runReady() { advance(0); }
        void advance(long elapsed) {
            long target = now + elapsed;
            int executed = 0;
            for (Scheduled next; (next = next()) != null && next.at <= target;) {
                assertTrue("unbounded immediate polling", ++executed < 1000);
                queue.remove(next);
                now = next.at;
                next.task.run();
            }
            now = target;
        }
        private Scheduled next() {
            Scheduled first = null;
            for (Scheduled item : queue) if (first == null || item.at < first.at) first = item;
            return first;
        }
    }
}
