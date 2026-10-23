package kr.nightdesk.phone;

import java.util.function.BooleanSupplier;

/** Main-thread coordinator: only one status read, and hidden/stale reads cannot update UI. */
final class ForegroundRefresh {
    interface Scheduler {
        void post(Runnable task, long delayMs);
        void remove(Runnable task);
    }
    interface Request { void fetch(Completion completion); }
    interface Completion { void finish(boolean pending, boolean failed, Runnable apply); }
    private final Scheduler scheduler;
    private final BooleanSupplier blocked;
    private final Request request;
    private final Runnable tick = this::poll;
    private boolean visible, inFlight, requested;
    private int generation, failures;

    ForegroundRefresh(Scheduler scheduler, BooleanSupplier blocked, Request request) {
        this.scheduler = scheduler; this.blocked = blocked; this.request = request;
    }
    void start() {
        if (visible) return;
        visible = true; generation++; failures = 0;
        schedule(0);
    }
    void stop() {
        visible = false; generation++; requested = false;
        scheduler.remove(tick);
    }
    void refresh() {
        if (!visible) return;
        if (inFlight) requested = true;
        else schedule(0);
    }
    private void schedule(long delayMs) {
        scheduler.remove(tick);
        if (visible) scheduler.post(tick, delayMs);
    }
    private void poll() {
        if (!visible || inFlight) return;
        if (blocked.getAsBoolean()) { schedule(1000); return; }
        inFlight = true;
        requested = false;
        final int started = generation;
        Completion completion = new Completion() {
            private boolean finished;
            @Override public void finish(boolean pending, boolean failed, Runnable apply) {
                if (finished) return;
                finished = true;
                inFlight = false;
                boolean current = visible && started == generation;
                boolean held = current && blocked.getAsBoolean();
                if (current && !held && apply != null) {
                    try { apply.run(); } catch (RuntimeException error) { failed = true; }
                }
                if (!visible) return;
                if (!current || requested) { schedule(0); return; }
                if (held) { schedule(1000); return; }
                failures = failed ? Math.min(failures + 1, 4) : 0;
                if (failed) schedule(Math.min(30_000, 5000L << (failures - 1)));
                else if (pending) schedule(5000);
            }
        };
        try { request.fetch(completion); }
        catch (RuntimeException error) { completion.finish(false, true, null); }
    }
}
