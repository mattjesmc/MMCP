package com.mattmc.mcptoolkit;

/**
 * Registers {@code get_log} — the read side of {@link LogCapture}.
 *
 * <p>One tool, and it is deliberately the plainest surface in the toolkit: a modder debugging a
 * pack does not want an interpretation of the log, they want the log, filtered. The judgement calls
 * live in the defaults — {@code level} defaults to {@code warn}, because the question this tool
 * exists to answer is "what went wrong", and an INFO-by-default read would bury it under chunk
 * chatter on the very first call.
 */
public final class LogTools {
    private LogTools() {}

    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 200;

    public static void register() {
        McpTools.register(ToolDef.of(
            "get_log",
            "Read the running game's own log — WHAT THE GAME LOGGED AND SKIPPED. Vanilla's data "
                + "loaders are forgiving: a malformed recipe, loot table or model is logged and "
                + "stepped over, so push_data/push_asset and their reloads report success while the "
                + "file loaded nothing. This is where that says so. WARN and above are kept in a "
                + "ring INFO chatter cannot evict, so a warning stays findable long after the INFO "
                + "around it has rolled. Entries: {seq, at, level, logger, thread, message, thrown}. "
                + "Without `since` you get the newest page plus a `cursor`; a cursor the ring has "
                + "rolled past returns `gap` rather than a short page that reads like a quiet log. "
                + "Capture starts at mod init — anything earlier (mod resolution, mixin apply) is "
                + "only in logs/latest.log. ERROR and FATAL also arrive as `error` events in "
                + "get_events. `crash` reads a CRASH REPORT instead - the previous game's death, "
                + "which no in-process ring can hold: title, exception, top frames each attributed "
                + "to the mod whose jar loaded the class, `suspect` = the first frame that is "
                + "somebody's mod. ping.last_crash says one is waiting.",
            Schemas.objectOpt(Schemas.object(
                "since", Schemas.integer("Last seq seen; returns strictly newer lines."),
                "level", Schemas.str("Minimum severity: fatal | error | warn (default) | info | all."),
                "contains", Schemas.str("Case-insensitive substring of the message or stack trace."),
                "logger", Schemas.str("Case-insensitive substring of the logger name."),
                "limit", Schemas.integer("Max lines (default 50, cap 200)."),
                "crash", Schemas.str("\"latest\", an index from 1 (newest), or a file name in "
                    + "<gameDir>/crash-reports. Returns that report's summary; the other filters "
                    + "are ignored.")),
                "since", "level", "contains", "logger", "limit", "crash"),
            ExecutionContext.ANY,
            Mechanism.OBSERVE,
            (ctx, a) -> {
                if (a.has("crash") && !a.get("crash").isJsonNull()) {
                    return CrashReports.read(a.get("crash"));
                }
                Long since = a.has("since") && !a.get("since").isJsonNull()
                    ? a.get("since").getAsLong() : null;
                int severity = LogCapture.severityOf(a.has("level") && !a.get("level").isJsonNull()
                    ? a.get("level").getAsString() : null);
                String contains = a.has("contains") && !a.get("contains").isJsonNull()
                    ? a.get("contains").getAsString() : null;
                String logger = a.has("logger") && !a.get("logger").isJsonNull()
                    ? a.get("logger").getAsString() : null;
                int limit = a.has("limit") && !a.get("limit").isJsonNull()
                    ? a.get("limit").getAsInt() : DEFAULT_LIMIT;
                if (limit <= 0) {
                    limit = DEFAULT_LIMIT;
                }
                return LogCapture.query(since, severity, contains, logger, Math.min(limit, MAX_LIMIT));
            }));
    }
}
