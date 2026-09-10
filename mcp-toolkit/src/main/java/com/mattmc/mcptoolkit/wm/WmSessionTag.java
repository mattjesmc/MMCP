package com.mattmc.mcptoolkit.wm;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;

import java.io.IOException;
import java.util.List;
import java.util.Locale;

/**
 * {@code wm_session_tag} — the R-b purpose stamp (V3_PLAN.md §3): who is driving this recording
 * session, and therefore what the corpus may do with it.
 *
 * <p>The reason this exists is the audit's worst finding (EVAL_AUDIT_V2.md §10): v2 trained on
 * whatever happened to be under {@code data/raw}, and 62% of its steps turned out to be battery
 * geometry — the correctness gate's own fixtures, re-run as if they were experience. §1 E1 makes
 * admission explicit instead: {@code data/corpus-v3.json} lists every admitted session with its
 * purpose, battery sessions are excluded outright, curriculum lanes are train-only, {@code eval}
 * is the held-out world (§5). A session that never says what it was cannot be classified after the
 * fact, so drivers say it at start-up — battery.ps1, taskgen.mjs, human-session.mjs, the survival
 * launcher, and the testbench bridge (purpose {@code bench}, excluded like {@code battery}: a
 * measurement run sharing a server lifetime with a collection driver must trip the conflict
 * guard rather than ride in under the collection tag).
 *
 * <p><b>Absence is a value.</b> An untagged session is adhoc and out of corpus by default, which
 * is why {@code adhoc} is not a tag anyone can apply: writing it would be claiming a classification
 * that not writing anything already means, and the refusal says so.
 *
 * <p>Server-thread only (SERVER-context handler), which is also the thread {@link WmRecorder#close}
 * runs on — so the stamp and the closing summary can never interleave on the manifest file.
 */
final class WmSessionTag {
    private WmSessionTag() {}

    /**
     * The corpus vocabulary (V3_PLAN.md §1 E1), minus {@code adhoc} — see the class note. Ordered
     * so the refusal message reads the way the plan's table does.
     */
    private static final List<String> PURPOSES =
        List.of("battery", "bench", "curriculum", "taskgen", "survival", "human", "eval");

    static void register() {
        McpTools.register(ToolDef.of(
            "wm_session_tag",
            "Stamp the CURRENT wm recording session with its PURPOSE (V3_PLAN.md §3 R-b): "
                + String.join(" | ", PURPOSES) + ". The corpus admission record "
                + "(data/corpus-v3.json) keys off it — battery sessions are excluded from training "
                + "entirely (the battery is the correctness gate, not the corpus), curriculum lanes "
                + "are train-only, eval is the held-out world. An UNTAGGED session is adhoc and out "
                + "of corpus by default, which is why there is no 'adhoc' purpose to apply. Drivers "
                + "tag themselves once at start-up; the stamp is written straight through to the "
                + "session manifest, so it survives a crash. Call with NO purpose to read the "
                + "session's current tag and directory without changing anything.",
            Schemas.objectOpt(Schemas.object(
                "purpose", Schemas.str(String.join(" | ", PURPOSES)
                    + " — omit to report the current tag without stamping")),
                "purpose"),
            ExecutionContext.SERVER,
            Mechanism.PRIVILEGED, // a disk write outside the world — Mechanism's own definition
            (ctx, a) -> {
                WmRecorder r = Wm.recorderOrNull();
                if (r == null) {
                    throw new IllegalStateException("no wm session is recording — there is no "
                        + "manifest to tag. Recording is a per-run decision (wm.record=true in "
                        + "config/mcptoolkit.properties, then restart the server); a session cannot "
                        + "be opened mid-run without breaking the §13.1 tick alignment");
                }
                boolean read = !a.has("purpose") || a.get("purpose").isJsonNull();
                if (!read) {
                    String want = a.get("purpose").getAsString().trim().toLowerCase(Locale.ROOT);
                    if ("adhoc".equals(want)) {
                        throw new IllegalArgumentException("'adhoc' is not a tag to apply — it is "
                            + "what an UNTAGGED session already means (out of corpus by default). "
                            + "Tag the session with what it really is, or leave it alone: "
                            + String.join(" | ", PURPOSES));
                    }
                    if (!PURPOSES.contains(want)) {
                        throw new IllegalArgumentException("unknown purpose '" + want
                            + "' — the corpus vocabulary is " + String.join(" | ", PURPOSES)
                            + " (V3_PLAN.md §1 E1). An unknown tag would admit a session no loader "
                            + "can classify, so it is refused rather than written");
                    }
                    String had = r.purpose();
                    if (had != null && !had.equals(want)) {
                        // A session can genuinely change hands (a human session continuing as
                        // survival play), so the retag is allowed — but it is a CONFLICT, not a
                        // correction, because the rows already written were produced under the old
                        // purpose. WmRecorder.purpose records that in the manifest and the loader
                        // refuses the session; see the note there for the live case that caught it.
                        McpToolkit.LOGGER.warn("[MCP Toolkit] wm session purpose retagged {} -> {} "
                            + "— this session now holds rows from BOTH and is out of corpus", had, want);
                    }
                    try {
                        r.purpose(want);
                    } catch (IOException e) {
                        throw new IllegalStateException("could not write the session manifest: "
                            + e, e);
                    }
                }
                JsonObject out = new JsonObject();
                out.addProperty("session_dir", r.dir().toAbsolutePath().toString());
                String purpose = r.purpose();
                out.addProperty("purpose", purpose);
                out.addProperty("stamped", !read);
                out.addProperty("purpose_conflict", r.purposeConflict());
                out.addProperty("note", r.purposeConflict()
                    ? "CONFLICT — this session was stamped with more than one purpose, so its rows "
                        + "were produced under two drivers and no single purpose is true of it. It "
                        + "is out of corpus-v3.json whatever its row says. Give each driver its own "
                        + "server lifetime (a recorder session spans the whole run)."
                    : purpose == null
                    ? "UNTAGGED — this session reads as adhoc and stays out of corpus-v3.json"
                    : "battery".equals(purpose) || "bench".equals(purpose)
                        ? "tagged " + purpose + " — recorded in full and excluded from training "
                            + "by construction (§1 E1: neither the gate nor the measuring "
                            + "instrument is the corpus)"
                        : "tagged " + purpose + " — eligible for corpus-v3.json admission after "
                            + "the standing validator + eligibility pass");
                return out;
            }));
    }
}
