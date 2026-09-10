package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.LoggerContext;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Configuration;
import org.apache.logging.log4j.core.config.Property;
import org.jspecify.annotations.Nullable;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The game's own log, as a queryable ring — the channel that carries what the game <em>logs and
 * skips</em>.
 *
 * <p><b>Why this exists.</b> Vanilla's data loaders are forgiving by design: a malformed recipe, a
 * broken loot table, a model naming a missing texture are logged at ERROR and then stepped over,
 * and the reload completes normally. Every write tool in this toolkit therefore had the same hole —
 * {@code push_data} wrote the bytes, {@code reload_data} returned {@code reloaded: true}, and the
 * file had loaded nothing. That is the succeeds-falsely class ARCHITECTURE.md purges everywhere
 * else, and it survived here only because the truth was never in a tool's reach: it was in
 * {@code logs/latest.log}, which nothing read.
 *
 * <p><b>Two rings, on purpose.</b> A single buffer sized for problems is emptied by routine chatter,
 * and the ERROR from three seconds ago is gone before anybody asks. So WARN and above land in a
 * second ring that nothing milder can evict. A query for {@code level:"warn"} reads that one, which
 * is why a warning stays findable for a long session while the surrounding context is only ever
 * recent.
 *
 * <p><b>And the chatter is mostly DEBUG, which was worth measuring rather than assuming.</b> The
 * appender rides the ROOT logger at {@link Level#ALL}, so it sees whatever the game's own root level
 * admits — and a Loom dev run admits DEBUG. Measured on a quiet dedicated-server boot: <b>82 DEBUG,
 * 28 INFO, 4 WARN</b> out of 114 captured lines, three quarters of it Mixin and Netty. That is the
 * argument for the split ring stated as a number: a single buffer would be three-quarters full of
 * lines nobody asked for. It is deliberately NOT filtered out at capture — a modder debugging their
 * own mod wants {@code get_log {logger:"mymod", level:"all"}} to work, which is the one thing a file
 * tail is worst at — and {@code level} defaults to {@code warn} so nobody meets it by accident.
 *
 * <p><b>Sequence numbers, not timestamps, are the cursor.</b> Same contract as {@link EventLog}:
 * strictly-after, monotonic within one JVM run, and a query whose cursor predates the ring is told
 * so ({@code gap}) rather than silently served a short page that reads like a quiet log.
 *
 * <p><b>What it cannot see.</b> Capture attaches at {@link McpToolkit#init()}, so everything logged
 * before mod init — the loader's own mod-resolution errors, mixin apply failures — is in the file
 * and not here. {@code get_log}'s contract says so rather than papering over it.
 */
public final class LogCapture {
    private LogCapture() {}

    /** One captured log record. {@code severity} is log4j's intLevel: lower is worse. */
    public record Line(long seq, long millis, int severity, String level, String logger,
                       String thread, String message, @Nullable String thrown) {

        /** The wire form: short keys, and no field that is null. */
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("seq", seq);
            o.addProperty("at", millis);
            o.addProperty("level", level);
            o.addProperty("logger", logger);
            o.addProperty("thread", thread);
            o.addProperty("message", message);
            if (thrown != null) {
                o.addProperty("thrown", thrown);
            }
            return o;
        }
    }

    // log4j intLevel values, named so the comparisons below read as English. Lower is more severe.
    public static final int FATAL = 100;
    public static final int ERROR = 200;
    public static final int WARN = 300;
    public static final int INFO = 400;
    private static final int ALL_LEVELS = Integer.MAX_VALUE;

    private static final int ALL_CAP = 3000;
    private static final int PROBLEM_CAP = 1000;
    private static final int MAX_MESSAGE = 4000;
    private static final int MAX_FRAMES = 12;

    private static final Deque<Line> ALL = new ArrayDeque<>();
    private static final Deque<Line> PROBLEMS = new ArrayDeque<>();
    private static long nextSeq = 1;
    private static long allEvicted;
    private static long problemsEvicted;
    private static boolean attached;
    private static String attachNote = "not started";

    /**
     * An appender that throws takes the game's whole logging pipeline with it, so this one is
     * wrapped in a catch-everything and a re-entrancy guard: anything logged from inside a capture
     * (including {@link EventLog}'s own drift warning) is dropped rather than recursed into.
     */
    private static final ThreadLocal<Boolean> INSIDE = ThreadLocal.withInitial(() -> Boolean.FALSE);

    // ---- attach --------------------------------------------------------------

    /**
     * Attach the ring to the root logger. Called once from {@link McpToolkit#init()}. Failure is a
     * warning and nothing more — a toolkit that cannot read the log is a toolkit missing one tool,
     * not a toolkit that must refuse to start. {@code get_log} then reports {@code capturing:false}
     * with the reason, which is the honest answer to "why is this empty".
     */
    public static synchronized void start() {
        if (attached) {
            return;
        }
        try {
            org.apache.logging.log4j.spi.LoggerContext raw = LogManager.getContext(false);
            if (!(raw instanceof LoggerContext ctx)) {
                attachNote = "the log4j binding is not log4j-core (" + raw.getClass().getName()
                    + "), so no appender can be attached";
                McpToolkit.LOGGER.warn("[MCP Toolkit] log capture off: {}", attachNote);
                return;
            }
            RingAppender appender = new RingAppender();
            appender.start();
            Configuration cfg = ctx.getConfiguration();
            cfg.addAppender(appender);
            cfg.getRootLogger().addAppender(appender, Level.ALL, null);
            ctx.updateLoggers();
            attached = true;
            attachNote = "attached";
        } catch (Throwable t) {
            attachNote = "could not attach an appender: " + t;
            McpToolkit.LOGGER.warn("[MCP Toolkit] log capture off: {}", attachNote);
        }
    }

    private static final class RingAppender extends AbstractAppender {
        private RingAppender() {
            super("mcptoolkit-ring", null, null, true, Property.EMPTY_ARRAY);
        }

        @Override
        public void append(final LogEvent event) {
            record(event);
        }
    }

    // ---- capture -------------------------------------------------------------

    private static void record(final LogEvent event) {
        if (Boolean.TRUE.equals(INSIDE.get())) {
            return;
        }
        INSIDE.set(Boolean.TRUE);
        try {
            String message = event.getMessage() == null ? "" : event.getMessage().getFormattedMessage();
            if (message.length() > MAX_MESSAGE) {
                message = message.substring(0, MAX_MESSAGE) + " [" + message.length() + " chars total]";
            }
            Throwable thrown = event.getThrown();
            String stack = thrown == null ? null : stack(thrown);
            Level level = event.getLevel() == null ? Level.INFO : event.getLevel();
            String logger = event.getLoggerName() == null || event.getLoggerName().isEmpty()
                ? "root" : event.getLoggerName();
            String thread = event.getThreadName() == null ? "?" : event.getThreadName();

            Line line;
            synchronized (LogCapture.class) {
                line = new Line(nextSeq++, event.getTimeMillis(), level.intLevel(), level.name(),
                    logger, thread, message, stack);
                ALL.addLast(line);
                while (ALL.size() > ALL_CAP) {
                    ALL.removeFirst();
                    allEvicted++;
                }
                if (line.severity() <= WARN) {
                    PROBLEMS.addLast(line);
                    while (PROBLEMS.size() > PROBLEM_CAP) {
                        PROBLEMS.removeFirst();
                        problemsEvicted++;
                    }
                }
            }
            if (line.severity() <= ERROR) {
                announce(line);
            }
        } catch (Throwable ignored) {
            // Never let capture break logging. There is nowhere to report this that would not
            // re-enter the appender we are already inside.
        } finally {
            INSIDE.set(Boolean.FALSE);
        }
    }

    private static String stack(final Throwable t) {
        StringWriter sw = new StringWriter();
        try (PrintWriter pw = new PrintWriter(sw)) {
            t.printStackTrace(pw);
        }
        String[] lines = sw.toString().replace("\r\n", "\n").split("\n");
        int keep = Math.min(lines.length, MAX_FRAMES + 1);
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < keep; i++) {
            b.append(lines[i].strip()).append('\n');
        }
        if (lines.length > keep) {
            b.append("... ").append(lines.length - keep).append(" more lines");
        }
        return b.toString().strip();
    }

    // ---- the `error` event ---------------------------------------------------

    private static final long DEDUPE_MS = 10_000;
    private static final int BURST = 10;
    private static final long WINDOW_MS = 10_000;
    private static final int KEY_CAP = 256;

    /** key -> {lastEmitMillis, suppressedSinceLastEmit}, bounded so a storm of distinct keys cannot grow it. */
    private static final Map<String, long[]> SEEN = new LinkedHashMap<>() {
        @Override
        protected boolean removeEldestEntry(final Map.Entry<String, long[]> eldest) {
            return size() > KEY_CAP;
        }
    };
    private static long windowStart;
    private static int windowCount;
    private static long floodSuppressed;

    /**
     * ERROR and FATAL also arrive as {@code error} events, so a session watching the stream learns
     * about a broken pack without polling for it.
     *
     * <p><b>Rate limited in two directions, because a log storm is the normal failure.</b> One
     * malformed model logs per chunk render; a failed resource reload logs per pack entry. Per-key
     * dedupe collapses the repeat (and the next emit of that key carries how many it stood for),
     * and a global bucket caps the whole stream — an error channel that floods the event log
     * destroys the log it was added to.
     */
    private static void announce(final Line line) {
        String key = line.logger() + '|'
            + line.message().substring(0, Math.min(160, line.message().length()));
        long now = System.currentTimeMillis();
        long repeats;
        long flood;
        synchronized (SEEN) {
            long[] state = SEEN.computeIfAbsent(key, k -> new long[] {0L, 0L});
            if (state[0] != 0L && now - state[0] < DEDUPE_MS) {
                state[1]++;
                return;
            }
            if (now - windowStart > WINDOW_MS) {
                windowStart = now;
                windowCount = 0;
            }
            if (windowCount >= BURST) {
                floodSuppressed++;
                return;
            }
            windowCount++;
            state[0] = now;
            repeats = state[1];
            state[1] = 0;
            flood = floodSuppressed;
            floodSuppressed = 0;
        }
        JsonObject d = new JsonObject();
        d.addProperty("level", line.level());
        d.addProperty("logger", line.logger());
        d.addProperty("message", line.message().length() > 600
            ? line.message().substring(0, 600) + "..." : line.message());
        if (line.thrown() != null) {
            String head = line.thrown();
            int nl = head.indexOf('\n');
            d.addProperty("thrown", nl > 0 ? head.substring(0, nl) : head);
        }
        d.addProperty("seq", line.seq());
        if (repeats > 0) {
            d.addProperty("repeats", repeats);
        }
        if (flood > 0) {
            d.addProperty("flood_suppressed", flood);
        }
        EventLog.emit("error", d);
    }

    // ---- read ----------------------------------------------------------------

    /** The highest sequence number assigned so far — a watermark to read forward from. */
    public static synchronized long seq() {
        return nextSeq - 1;
    }

    /** Whether an appender is live, and if not, why. */
    public static synchronized String status() {
        return attachNote;
    }

    /** Whether an appender is live. */
    public static synchronized boolean capturing() {
        return attached;
    }

    /** Parse a caller-supplied minimum level into a severity ceiling. */
    public static int severityOf(final @Nullable String name) {
        if (name == null || name.isBlank()) {
            return WARN;
        }
        return switch (name.strip().toLowerCase(Locale.ROOT)) {
            case "fatal" -> FATAL;
            case "error" -> ERROR;
            case "warn", "warning" -> WARN;
            case "info" -> INFO;
            case "all", "debug", "trace" -> ALL_LEVELS;
            default -> throw new IllegalArgumentException("unknown level '" + name
                + "' (fatal | error | warn | info | all)");
        };
    }

    /**
     * WARN-and-above lines strictly after {@code sinceSeq} — how {@code reload_data} and
     * {@code reload_resources} report what the game logged and skipped during their own reload.
     */
    public static synchronized List<Line> problemsSince(final long sinceSeq, final int limit) {
        List<Line> out = new ArrayList<>();
        for (Line l : PROBLEMS) {
            if (l.seq() > sinceSeq) {
                out.add(l);
            }
        }
        if (out.size() > limit) {
            return new ArrayList<>(out.subList(out.size() - limit, out.size()));
        }
        return out;
    }

    /**
     * The {@code get_log} read. {@code sinceSeq} null means "the newest page"; otherwise
     * strictly-after. A cursor older than the chosen ring reports {@code gap} rather than quietly
     * serving whatever survived.
     */
    public static synchronized JsonObject query(final @Nullable Long sinceSeq, final int maxSeverity,
                                                final @Nullable String contains,
                                                final @Nullable String logger, final int limit) {
        boolean problemsOnly = maxSeverity <= WARN;
        Deque<Line> ring = problemsOnly ? PROBLEMS : ALL;
        long evicted = problemsOnly ? problemsEvicted : allEvicted;
        String needle = contains == null || contains.isBlank() ? null
            : contains.toLowerCase(Locale.ROOT);
        String loggerNeedle = logger == null || logger.isBlank() ? null
            : logger.toLowerCase(Locale.ROOT);

        List<Line> matched = new ArrayList<>();
        for (Line l : ring) {
            if (sinceSeq != null && l.seq() <= sinceSeq) {
                continue;
            }
            if (l.severity() > maxSeverity) {
                continue;
            }
            if (needle != null && !l.message().toLowerCase(Locale.ROOT).contains(needle)
                && (l.thrown() == null || !l.thrown().toLowerCase(Locale.ROOT).contains(needle))) {
                continue;
            }
            if (loggerNeedle != null && !l.logger().toLowerCase(Locale.ROOT).contains(loggerNeedle)) {
                continue;
            }
            matched.add(l);
        }
        // Cursor mode reads oldest-first (nothing may be skipped); catch-up mode tails the newest.
        int from = sinceSeq == null ? Math.max(0, matched.size() - limit) : 0;
        int count = Math.max(0, Math.min(limit, matched.size() - from));

        JsonObject r = new JsonObject();
        r.addProperty("capturing", attached);
        if (!attached) {
            r.addProperty("why", attachNote);
        }
        r.addProperty("ring", problemsOnly ? "problems" : "all");
        JsonArray entries = new JsonArray();
        long cursor = sinceSeq == null ? nextSeq - 1 : sinceSeq;
        for (int i = from; i < from + count; i++) {
            Line l = matched.get(i);
            entries.add(l.toJson());
            cursor = Math.max(cursor, l.seq());
        }
        r.add("entries", entries);
        r.addProperty("returned", entries.size());
        if (from + count < matched.size()) {
            r.addProperty("more", matched.size() - (from + count));
        }
        r.addProperty("cursor", cursor);
        // The ring rolled past the caller's cursor: say so instead of returning a short page that
        // reads like a quiet log.
        long oldest = ring.isEmpty() ? nextSeq : ring.peekFirst().seq();
        if (sinceSeq != null && evicted > 0 && sinceSeq < oldest - 1) {
            JsonObject gap = new JsonObject();
            gap.addProperty("from", sinceSeq);
            gap.addProperty("resumed_at", oldest);
            gap.addProperty("note", "the " + (problemsOnly ? "problems" : "all")
                + " ring rolled past your cursor; " + evicted + " lines have been evicted since "
                + "capture began, and the ones in your gap survive only in logs/latest.log");
            r.add("gap", gap);
        }
        return r;
    }
}
