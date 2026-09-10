package com.mattmc.mcptoolkit.wm;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.platform.Platform;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.zip.GZIPOutputStream;

/**
 * One recording session: the four tick-stamped JSONL.gz streams plus the manifest
 * (the world-model project's DESIGN.md §13.1). Opened at server start, closed at server stop — the <b>game tick
 * is the only clock</b> ({@link MinecraftServer#getTickCount()}), and a session spans one server
 * run so the tick stamps stay monotonic.
 *
 * <p>Writes are {@code synchronized}: streams are fed from the server thread (frames, ticks,
 * actions, most episodes) and from the bridge's HTTP thread (intent records, which must land
 * BEFORE the tool reaches GoalRunner — §14.3 step 1). Every row is one gzip'd JSON line; the
 * volume is modest (tens of bytes a row) and the alternative — buffering rows for a flush that a
 * crash would lose — would trade durability for nothing measurable.
 *
 * <p>The world seed is deliberately NOT in the manifest: a seed is the ultimate X-ray — the whole
 * world derives from it (§13.1) — and a field that is never written cannot leak into a loader. Its
 * SHA-256 <b>is</b> admissible and rides {@code world.seed_sha256} (V3_PLAN.md §3 R-a): the split
 * has to know WHICH world a session came from (§1 E2's group key, §5's held-out world), and a
 * digest answers exactly that question while generating nothing — the seed's privilege comes from
 * being able to reconstruct the world, which a one-way hash cannot do. Identify without revealing.
 */
final class WmRecorder {

    static final String WMFRAME_VERSION = "wmframe/0.1";

    private static final Gson GSON = new Gson();

    private final MinecraftServer server;
    private final Path dir;
    private final Writer frames;
    private final Writer ticks;
    private final Writer actions;
    private final Writer episodes;

    /** Session-scoped stable anonymization of entity identity (§2.5): uuid → dense int handle.
     *  Never the raw uuid on disk; resets with the session so no cross-session identity leaks. */
    private final Map<UUID, Integer> handles = new HashMap<>();
    /** What the per-tick watch last knew about a body — the actions sink (called from deep inside
     *  the drivers, which know nothing of slots) reads these to stamp session and goal id. */
    private final Map<UUID, String> bodySession = new java.util.concurrent.ConcurrentHashMap<>();
    private final Map<UUID, String> bodyGoal = new java.util.concurrent.ConcurrentHashMap<>();
    /** Last tick each body got a {@code ticks} row — the §13.1 join guarantee lives here: the
     *  entity tick writes at most one row per tick, and the action sink writes one FIRST when a
     *  drive lands on a tick the entity never ticked in (a body spawned and driven between ticks
     *  — the full-battery validator run caught exactly two such rows in 45k). */
    private final Map<UUID, Integer> lastTickRow = new java.util.concurrent.ConcurrentHashMap<>();

    // Gait/gaze overhead accounting (§13.2: the fan must be cheap — measure, don't assume).
    private long gaitNanos;
    private int gaitFans;
    private int gazeFans;
    private long rowsWritten;
    // §15 human-capture accounting: how much of this session is demonstration data.
    private long humanMoveRows;
    private long humanPressRows;
    // Phase-2 client-channel accounting: src:"client" row counts + the reconciliation ledger.
    private long humanClientMoveRows;
    private long humanClientPressRows;
    private long humanFallbackTicks;
    private long humanDisagreeTicks;
    private long humanPayloadGaps;
    private long humanPayloadDups;
    private long humanPayloadDropped;
    // Phase-5 obs-gap accounting (§15.3 mitigation 3: measure the residual, don't pretend).
    private long humanTgtPresses;
    private long humanObsGapPresses;
    /** Buckets for skew −3..+3 (index skew+3), counted at frame consumption. */
    private final int[] humanSkew = new int[7];
    /** The R-b purpose tag once a driver claims this session; see {@link #purpose(String)}. */
    private volatile @Nullable String purpose;

    /** True once a SECOND, different purpose has been stamped — the session holds rows from two
     *  drivers, so no single purpose is true of it ({@link #purpose(String)}). */
    private volatile boolean purposeConflict;

    WmRecorder(final MinecraftServer server, final Path dataDir, final @Nullable String registryFile,
               final @Nullable String registryHash) throws IOException {
        this.server = server;
        String stamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss"));
        this.dir = dataDir.resolve("raw").resolve(stamp);
        Files.createDirectories(dir);
        this.frames = open("frames");
        this.ticks = open("ticks");
        this.actions = open("actions");
        this.episodes = open("episodes");

        JsonObject manifest = new JsonObject();
        manifest.addProperty("v", WMFRAME_VERSION);
        manifest.addProperty("toolkit_version",
            Platform.modVersion("mcptoolkit").orElse("unknown"));
        manifest.addProperty("mc_version", mcVersion());
        if (registryFile != null) {
            manifest.addProperty("registry_file", registryFile);
            manifest.addProperty("registry_sha256", registryHash);
        }
        manifest.addProperty("dim", server.overworld().dimension().identifier().toString());
        manifest.addProperty("difficulty", server.getWorldData().getDifficulty().getSerializedName());
        // R-a world identity (V3_PLAN.md §3): the loader's world_id is "w-" + the first 8 hex of
        // this hash. Everything about the honest split hangs off it — E2's group key is
        // (world_id, dim, 256-cell), the §5 test set is "sessions from the held-out world and
        // nowhere else" — and none of it is answerable from a session that cannot say where it
        // ran. Sessions recorded before this field map to the legacy "w-dev", true by
        // construction: there has only ever been one dev world.
        JsonObject world = new JsonObject();
        world.addProperty("name", server.getWorldData().getLevelName());
        // The seed is read HERE and dies here — only the digest is written (see the class note).
        world.addProperty("seed_sha256", sha256(Long.toString(server.overworld().getSeed())));
        manifest.add("world", world);
        manifest.addProperty("started_tick", server.getTickCount());
        Files.writeString(dir.resolve("manifest.json"), GSON.toJson(manifest) + "\n");
        McpToolkit.LOGGER.info("[MCP Toolkit] wm recorder ON — session {}", dir);
    }

    static String mcVersion() {
        return Platform.modVersion("minecraft").orElse("unknown");
    }

    /** Lowercase 64-hex SHA-256 — the seed's one admissible form on disk (see the class note).
     *  Full digest, not a prefix: the loader takes the first 8 chars for {@code world_id}, and a
     *  truncation decided here would be a truncation nobody downstream could undo. */
    private static String sha256(final String s) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(64);
            for (byte b : digest) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16))
                    .append(Character.forDigit(b & 0xF, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is missing from this JVM", e);
        }
    }

    private Writer open(final String stream) throws IOException {
        return new BufferedWriter(new java.io.OutputStreamWriter(
            new GZIPOutputStream(Files.newOutputStream(dir.resolve(stream + ".jsonl.gz"))),
            StandardCharsets.UTF_8));
    }

    Path dir() {
        return dir;
    }

    int tick() {
        return server.getTickCount();
    }

    /** This session's R-b purpose tag, or null while nothing has claimed it. Never defaulted:
     *  ABSENT is a value — it means adhoc, which means out of corpus (V3_PLAN.md §1 E1). */
    @Nullable String purpose() {
        return purpose;
    }

    /** Has this session been stamped with more than one purpose? Such a session holds rows from two
     *  drivers and is out of the corpus whatever corpus-v3.json says — see {@link #purpose(String)}. */
    boolean purposeConflict() {
        return purposeConflict;
    }

    /** Stamp the session's purpose (V3_PLAN.md §3 R-b, {@link WmSessionTag}). Written straight
     *  through to the manifest rather than held until {@link #close()}: the corpus admission record
     *  keys off this field, and a session that crashed is exactly the session whose provenance
     *  someone will want to read. */
    void purpose(final String value) throws IOException {
        final String had = purpose;
        updateManifest(m -> {
            m.addProperty("purpose", value);
            // A recorder session spans the whole SERVER LIFETIME, but a purpose describes a
            // DRIVER. Run the battery and then taskgen against one server and both stamp the same
            // session: the last writer wins and a session that is mostly probe geometry ends up
            // labelled `taskgen`, i.e. admissible as training data. That is exactly how battery
            // geometry became 62% of v2 (V3_PLAN.md §4.4), re-entering through the tag meant to
            // prevent it — caught live on 2026-08-10, session 20260810-160812 (163k rows, mostly
            // battery, stamped taskgen).
            //
            // The retag itself stays legal: a session genuinely can change hands (a human session
            // that continues as survival play). What must not happen is that the change becomes
            // INVISIBLE. So the disagreement is recorded in the manifest, where the loader can see
            // it, rather than only in a log line nobody reads — and the loader refuses a session
            // whose rows were produced under two purposes, because no single purpose is true of it.
            if (had != null && !had.equals(value)) {
                m.addProperty("purpose_conflict", true);
                com.google.gson.JsonArray seen = m.has("purpose_seen")
                    ? m.getAsJsonArray("purpose_seen") : new com.google.gson.JsonArray();
                if (seen.isEmpty()) {
                    seen.add(had);
                }
                seen.add(value);
                m.add("purpose_seen", seen);
            }
        });
        if (had != null && !had.equals(value)) {
            purposeConflict = true;
        }
        purpose = value;
    }

    /** Read-modify-write of the manifest, for the few facts that only exist after it is written —
     *  the purpose tag and the closing summary. Synchronized with the row writers for the one
     *  reason that matters: a single writer of this file at a time. */
    private synchronized void updateManifest(final Consumer<JsonObject> edit) throws IOException {
        Path file = dir.resolve("manifest.json");
        JsonObject m = GSON.fromJson(Files.readString(file), JsonObject.class);
        edit.accept(m);
        Files.writeString(file, GSON.toJson(m) + "\n");
    }

    synchronized int handle(final UUID uuid) {
        return handles.computeIfAbsent(uuid, u -> handles.size() + 1);
    }

    // ---- per-tick body bookkeeping (server thread, from DroneTools.tickWatch) ----

    void noteBody(final LivingEntity body, final @Nullable String session, final @Nullable String goalId) {
        UUID id = body.getUUID();
        if (session != null) {
            bodySession.put(id, session);
        }
        if (goalId != null) {
            bodyGoal.put(id, goalId);
        } else {
            bodyGoal.remove(id);
        }
    }

    @Nullable String sessionOf(final LivingEntity body) {
        return bodySession.get(body.getUUID());
    }

    @Nullable String goalOf(final LivingEntity body) {
        return bodyGoal.get(body.getUUID());
    }

    /** A goal's verdict just emitted: drop its attribution NOW. The per-tick watch would only
     *  notice next tick, and by then the drivers have written one more (idle) frame stamped with
     *  a finished goal — the off-by-one the full-battery validator run flagged on 40 goals. */
    void goalEnded(final String actionId) {
        bodyGoal.values().removeIf(actionId::equals);
    }

    // ---- streams -------------------------------------------------------------

    /** {@code ticks}: the frame envelope (§2.2) — pose, vel, vitals — every tick a body exists.
     *  ~30 floats gz; recording always beats deciding when to record (§13.1). One row per
     *  (tick, body): the sink's self-heal below may have written this tick's row already. */
    void writeTick(final @Nullable String session, final LivingEntity body, final @Nullable String goalId) {
        Integer last = lastTickRow.put(body.getUUID(), tick());
        if (last != null && last == tick()) {
            return;
        }
        JsonObject o = new JsonObject();
        o.addProperty("t", tick());
        o.addProperty("body", handle(body.getUUID()));
        if (session != null) {
            o.addProperty("session", session);
        }
        if (goalId != null) {
            o.addProperty("goal", goalId);
        }
        o.addProperty("dim", body.level().dimension().identifier().toString());
        envelope(o, body);
        write(ticks, o);
    }

    /** {@code actions}: one emitted input frame + actor label (§13.3). Explicit zeroed frames are
     *  actions too (the walker's stale-yya lesson), so the sink records every write unconditionally. */
    void writeAction(final LivingEntity body, final String actor, final JsonObject frame) {
        // The §13.1 join, guaranteed at the sink: a drive on a tick with no envelope row yet
        // (body driven between ticks, before its first entity tick) writes the row itself.
        Integer last = lastTickRow.get(body.getUUID());
        if (last == null || last != tick()) {
            writeTick(sessionOf(body), body, goalOf(body));
        }
        JsonObject o = new JsonObject();
        o.addProperty("t", tick());
        o.addProperty("body", handle(body.getUUID()));
        o.addProperty("actor", actor);
        String goal = goalOf(body);
        if (goal != null) {
            o.addProperty("goal", goal);
        }
        o.add("frame", frame);
        write(actions, o);
    }

    void writeFrame(final JsonObject frame) {
        write(frames, frame);
    }

    void writeEpisode(final JsonObject row) {
        write(episodes, row);
    }

    private synchronized void write(final Writer w, final JsonObject o) {
        try {
            w.write(GSON.toJson(o));
            w.write('\n');
            rowsWritten++;
        } catch (IOException e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] wm recorder write failed: {}", e.toString());
        }
    }

    // ---- the frame envelope (§2.2): absolute pose, unconditionally ------------

    /** Pose/vel/vitals from the body. Stored raw (blocks, degrees, ticks) — featurization is the
     *  loader's job, the recorder stores truths (§2.2). */
    static void envelope(final JsonObject o, final LivingEntity body) {
        JsonObject pose = new JsonObject();
        pose.addProperty("x", round(body.getX()));
        pose.addProperty("y", round(body.getY()));
        pose.addProperty("z", round(body.getZ()));
        pose.addProperty("yaw", round(body.getYRot()));
        pose.addProperty("pitch", round(body.getXRot()));
        o.add("pose", pose);
        o.addProperty("eye", round(body.getEyeHeight()));
        Vec3 vel = body.getDeltaMovement();
        JsonObject v = new JsonObject();
        v.addProperty("x", round(vel.x));
        v.addProperty("y", round(vel.y));
        v.addProperty("z", round(vel.z));
        o.add("vel", v);

        JsonObject vitals = new JsonObject();
        vitals.addProperty("health", round(body.getHealth()));
        if (body instanceof Player p) {
            vitals.addProperty("food", p.getFoodData().getFoodLevel());
        }
        vitals.addProperty("air", body.getAirSupply());
        vitals.addProperty("on_ground", body.onGround());
        vitals.addProperty("in_water", body.isInWater());
        vitals.addProperty("submerged", body.isEyeInFluid(net.minecraft.tags.FluidTags.WATER));
        vitals.addProperty("held", itemId(body.getMainHandItem()));
        // Hotbar + armor classes (§2.2): legal — a player sees their own inventory at a glance —
        // and required the moment the policy owns equip/eat/attack verb choice.
        if (body instanceof Player p) {
            JsonArray hotbar = new JsonArray();
            for (int i = 0; i < 9; i++) {
                ItemStack s = p.getInventory().getItem(i);
                if (s.isEmpty()) {
                    hotbar.add((String) null);
                } else {
                    JsonArray slot = new JsonArray();
                    slot.add(itemId(s));
                    slot.add(s.getCount());
                    hotbar.add(slot);
                }
            }
            vitals.add("hotbar", hotbar);
        }
        JsonArray armor = new JsonArray();
        for (EquipmentSlot slot : new EquipmentSlot[] { EquipmentSlot.HEAD, EquipmentSlot.CHEST,
                EquipmentSlot.LEGS, EquipmentSlot.FEET }) {
            ItemStack s = body.getItemBySlot(slot);
            armor.add(s.isEmpty() ? null : itemId(s));
        }
        vitals.add("armor", armor);
        o.add("vitals", vitals);
    }

    static String itemId(final ItemStack stack) {
        return stack.isEmpty() ? "empty"
            : BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
    }

    static double round(final double v) {
        return Math.round(v * 1000.0) / 1000.0;
    }

    // ---- gait overhead accounting ---------------------------------------------

    void noteGait(final long nanos, final boolean gaze) {
        gaitNanos += nanos;
        if (gaze) {
            gazeFans++;
        } else {
            gaitFans++;
        }
    }

    void noteHuman(final boolean press, final boolean client) {
        if (press) {
            humanPressRows++;
            if (client) {
                humanClientPressRows++;
            }
        } else {
            humanMoveRows++;
            if (client) {
                humanClientMoveRows++;
            }
        }
    }

    // ---- phase-2 client-channel reconciliation (HUMAN_RIG_PLAN.md: measured, not assumed) ----

    static final int PAYLOAD_GAP = 0;
    static final int PAYLOAD_DUP = 1;
    static final int PAYLOAD_DROPPED = 2;

    /** An armed tick where the client channel had gone live but delivered no fresh frame — the
     *  row fell back to {@code src:"server"}. Sustained runs are the loader-excludable spans. */
    void noteHumanFallback() {
        humanFallbackTicks++;
    }

    /** A consumed frame whose key booleans differ from {@code lastClientInput} — any nonzero
     *  count in a lag-free session is a framing bug, which is the whole point of measuring it. */
    void noteHumanDisagree() {
        humanDisagreeTicks++;
    }

    void noteHumanPayload(final int kind) {
        switch (kind) {
            case PAYLOAD_GAP -> humanPayloadGaps++;
            case PAYLOAD_DUP -> humanPayloadDups++;
            default -> humanPayloadDropped++;
        }
    }

    /** serverGameTime − payload clientTick at consumption, clamped to ±3 (the tails all mean the
     *  same thing: the clocks diverged and the session needs a look). */
    void noteHumanSkew(final int skew) {
        humanSkew[Math.clamp(skew, -3, 3) + 3]++;
    }

    /** A press row that named a crosshair target — and whether the target was observation-
     *  inexplicable (no fan sighting inside the window, §15.3 mitigation 2). The ratio is the §8
     *  obs-gap-rate column: a recorder-quality metric worth watching per session. */
    void noteHumanTgtPress(final boolean gap) {
        humanTgtPresses++;
        if (gap) {
            humanObsGapPresses++;
        }
    }

    void close() {
        for (Writer w : new Writer[] { frames, ticks, actions, episodes }) {
            try {
                w.close();
            } catch (IOException ignored) {
                // closing on shutdown; the streams are line-oriented so a lost tail is one row
            }
        }
        // The §13.2 overhead answer, measured on this run and appended where the loader looks.
        JsonObject summary = new JsonObject();
        summary.addProperty("rows", rowsWritten);
        summary.addProperty("gait_fans", gaitFans);
        summary.addProperty("gaze_fans", gazeFans);
        summary.addProperty("gait_total_ms", Math.round(gaitNanos / 1.0e4) / 100.0);
        int fans = gaitFans + gazeFans;
        summary.addProperty("gait_mean_us_per_fan",
            fans == 0 ? 0.0 : Math.round(gaitNanos / (double) fans / 10.0) / 100.0);
        if (humanMoveRows > 0 || humanPressRows > 0) {
            JsonObject human = new JsonObject();
            human.addProperty("move_rows", humanMoveRows);
            human.addProperty("press_rows", humanPressRows);
            if (humanClientMoveRows > 0 || humanClientPressRows > 0 || humanFallbackTicks > 0) {
                // The phase-2 reconciliation ledger — the client channel went live this session.
                human.addProperty("client_move_rows", humanClientMoveRows);
                human.addProperty("client_press_rows", humanClientPressRows);
                human.addProperty("fallback_ticks", humanFallbackTicks);
                human.addProperty("disagree_ticks", humanDisagreeTicks);
                human.addProperty("payload_gaps", humanPayloadGaps);
                human.addProperty("payload_dups", humanPayloadDups);
                human.addProperty("payload_dropped", humanPayloadDropped);
                JsonObject skew = new JsonObject();
                for (int i = 0; i < humanSkew.length; i++) {
                    if (humanSkew[i] > 0) {
                        skew.addProperty(Integer.toString(i - 3), humanSkew[i]);
                    }
                }
                human.add("skew", skew);
                // The §8 obs-gap-rate column (§15.3 mitigation 3): targeted presses only — a
                // press that named no entity has no observation to be inexplicable against.
                human.addProperty("tgt_presses", humanTgtPresses);
                human.addProperty("obs_gap_presses", humanObsGapPresses);
                human.addProperty("obs_gap_rate", humanTgtPresses == 0 ? 0.0
                    : Math.round(humanObsGapPresses / (double) humanTgtPresses * 10000.0) / 10000.0);
            }
            summary.add("human", human);
        }
        summary.addProperty("ended_tick", server.getTickCount());
        try {
            // Read-modify-write, never a rebuild: the manifest gains facts mid-run (the R-b
            // purpose tag), and a file rewritten from anything but itself would silently drop them.
            updateManifest(m -> m.add("summary", summary));
        } catch (IOException | RuntimeException e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] wm manifest summary failed: {}", e.toString());
        }
        McpToolkit.LOGGER.info("[MCP Toolkit] wm recorder closed — {} rows, {} gait + {} gaze fans, "
            + "gait cost {}", rowsWritten, gaitFans, gazeFans, summary.get("gait_total_ms"));
    }
}
