package com.mattmc.mcptoolkit.hooks;

import com.google.gson.JsonObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

/**
 * The toolkit's own event primitive — the fabric-api replacement seam. The toolkit registers all
 * lifecycle/tick/UI callbacks on {@code HookEvent}s (see {@link ServerHooks} and
 * {@code hooks.client.ClientHooks}), which are fired by the toolkit's thin {@code @Inject} mixins
 * into vanilla. Design (FRAMEWORK decision, 2026-07-31):
 *
 * <ul>
 *   <li><b>Containment-first.</b> A throwing listener never breaks the vanilla caller (a bad tick
 *       listener must not crash the tick) — every failure is caught, counted, and logged with the
 *       listener's label. This is the goal-loop containment principle applied at the hook layer.</li>
 *   <li><b>Instrumented.</b> Per-listener call counts and cumulative nanos are kept, so a tool can
 *       answer "which subscriber is eating the tick" ({@link #statsJson()}); fabric-api can't.</li>
 *   <li><b>Coexistent.</b> These hooks ride their own injections and fire only toolkit listeners;
 *       fabric-api (when present for other mods) stacks beside them without interaction.</li>
 * </ul>
 */
public final class HookEvent<T> {
    private static final Logger LOGGER = LoggerFactory.getLogger("mcptoolkit/hooks");
    /** Global registry of every event, for the stats dump. */
    private static final List<HookEvent<?>> ALL = new CopyOnWriteArrayList<>();

    /** After this many logged stack traces per listener, failures log as one-liners only. */
    private static final int FULL_TRACE_LIMIT = 3;

    private final String name;
    private final CopyOnWriteArrayList<Entry<T>> listeners = new CopyOnWriteArrayList<>();

    private static final class Entry<T> {
        final String label;
        final T listener;
        long calls;
        long nanos;
        long failures;

        Entry(final String label, final T listener) {
            this.label = label;
            this.listener = listener;
        }
    }

    private HookEvent(final String name) {
        this.name = name;
    }

    public static <T> HookEvent<T> create(final String name) {
        HookEvent<T> e = new HookEvent<>(name);
        ALL.add(e);
        return e;
    }

    /** Register with a label derived from the calling class (good enough for the stats dump). */
    public void register(final T listener) {
        register(callerLabel(), listener);
    }

    public void register(final String label, final T listener) {
        listeners.add(new Entry<>(label, listener));
    }

    /**
     * Fire the event: {@code invocation} is applied to each listener in registration order. Timing
     * is recorded per listener; a throw is contained (logged, counted) and the remaining listeners
     * still run. Not synchronized — mutation is CopyOnWrite, and firing is single-threaded per side
     * (server thread / client thread) by construction of the injection points.
     */
    public void fire(final Consumer<T> invocation) {
        for (Entry<T> e : listeners) {
            long t0 = System.nanoTime();
            try {
                invocation.accept(e.listener);
            } catch (Throwable t) {
                e.failures++;
                if (e.failures <= FULL_TRACE_LIMIT) {
                    LOGGER.error("[MCP Toolkit] hook {} listener '{}' threw (failure {} — contained)",
                        name, e.label, e.failures, t);
                } else {
                    LOGGER.error("[MCP Toolkit] hook {} listener '{}' threw again ({}x — contained): {}",
                        name, e.label, e.failures, t.toString());
                }
            } finally {
                e.calls++;
                e.nanos += System.nanoTime() - t0;
            }
        }
    }

    /**
     * Fire a CONSUMING event: listeners run in registration order until one answers true, which is
     * the answer. A throw is contained exactly as in {@link #fire} and counts as "not handled", so a
     * broken listener cannot swallow an input event - the failure mode that matters for a key hook.
     */
    public boolean fireHandled(final java.util.function.Predicate<T> invocation) {
        for (Entry<T> e : listeners) {
            long t0 = System.nanoTime();
            boolean handled = false;
            try {
                handled = invocation.test(e.listener);
            } catch (Throwable t) {
                e.failures++;
                if (e.failures <= FULL_TRACE_LIMIT) {
                    LOGGER.error("[MCP Toolkit] hook {} listener '{}' threw (failure {} - contained)",
                        name, e.label, e.failures, t);
                } else {
                    LOGGER.error("[MCP Toolkit] hook {} listener '{}' threw again ({}x - contained): {}",
                        name, e.label, e.failures, t.toString());
                }
            } finally {
                e.calls++;
                e.nanos += System.nanoTime() - t0;
            }
            if (handled) {
                return true;
            }
        }
        return false;
    }

    /** Per-event, per-listener instrumentation: calls, cumulative ms, failures. */
    public static JsonObject statsJson() {
        JsonObject root = new JsonObject();
        for (HookEvent<?> ev : ALL) {
            JsonObject evO = new JsonObject();
            for (Entry<?> e : ev.listeners) {
                JsonObject l = new JsonObject();
                l.addProperty("calls", e.calls);
                l.addProperty("ms", e.nanos / 1_000_000);
                if (e.failures > 0) {
                    l.addProperty("failures", e.failures);
                }
                evO.add(e.label, l);
            }
            root.add(ev.name, evO);
        }
        return root;
    }

    private static String callerLabel() {
        // Walk past HookEvent frames to the registering class.
        for (StackTraceElement f : new Throwable().getStackTrace()) {
            String c = f.getClassName();
            if (!c.equals(HookEvent.class.getName())) {
                int dot = c.lastIndexOf('.');
                return dot < 0 ? c : c.substring(dot + 1);
            }
        }
        return "unknown";
    }
}
