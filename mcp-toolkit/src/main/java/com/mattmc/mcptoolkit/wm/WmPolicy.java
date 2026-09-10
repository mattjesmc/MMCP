package com.mattmc.mcptoolkit.wm;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.nav.NavBody;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import org.jspecify.annotations.Nullable;

import java.util.Map;
import java.util.Queue;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * Phase 4's live seam (the world-model project's DESIGN.md §9; wire contract in its
 * wmserve/PROTOCOL.md): the learned policy behind the existing recorder taps. Modes
 * ({@code wm.policy} in mcptoolkit.properties):
 *
 * <ul>
 *   <li>{@code off} (default) — this class is a null check, nothing else. The scripted stack
 *       is untouched; no thread, no socket, no cost.</li>
 *   <li>{@code shadow} — Phase-4 slice 0: every recorder tap is mirrored to the sidecar, every
 *       prediction is written back into the actions stream as a {@code {"k":"policy"}} row
 *       beside the expert's own frame for the same tick. Live inference, zero actuation risk;
 *       divergence is computed OFFLINE from the streams (the recorder stores truths, not
 *       derivations). Requires {@code wm.record=true} — shadow rows need a stream to land in.</li>
 *   <li>{@code on} — the driving step ({@link #stepNav}) is available to the executor seam.
 *       v1 wires NOTHING to it by itself: who calls it, for which goal legs, with what fallback
 *       is the deploy step's decision, made where {@code Bodies.Nav} hands out drivers.</li>
 * </ul>
 *
 * <p>Threading: taps run on the server thread and only enqueue. Responses arrive on the client's
 * IO thread and are PARKED ({@link #pendingRows}); the next {@link #onObs} on the server thread
 * drains them into the recorder, whose internals are server-thread-only. A parked row's outer
 * stream tick is therefore 1–2 ticks late — the row's {@code frame.t} carries the tick the
 * prediction was FOR, and the offline join uses that.
 */
public final class WmPolicy {
    private WmPolicy() {}

    private static volatile @Nullable WmPolicyClient client;
    private static volatile @Nullable MinecraftServer server;
    private static volatile String mode = "off";
    /** actionId -> body uuid: goal_end arrives without a body in scope. */
    private static final Map<String, UUID> GOAL_BODY = new ConcurrentHashMap<>();
    private record ParkedRow(LivingEntity body, JsonObject frame) { }
    private static final Queue<ParkedRow> pendingRows = new ConcurrentLinkedQueue<>();

    /** From Wm.init's SERVER_STARTED hook, after the recorder decision. */
    static void start(final WmConfig config, final MinecraftServer srv,
                      final @Nullable String registrySha) {
        mode = config.policy();
        if ("off".equals(mode)) {
            return;
        }
        if (!Wm.recording()) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] wm.policy={} requires wm.record=true in v1 "
                + "(shadow rows and fan taps ride the recorder) — policy DISABLED this run", mode);
            mode = "off";
            return;
        }
        if (registrySha == null) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] wm.policy={} but the registry dump has no hash "
                + "— policy DISABLED this run (the handshake could not be honest)", mode);
            mode = "off";
            return;
        }
        server = srv;
        JsonObject hello = new JsonObject();
        hello.addProperty("type", "hello");
        hello.addProperty("wmframe", WmRecorder.WMFRAME_VERSION);
        hello.addProperty("registry_sha256", registrySha);
        hello.addProperty("action_features", 20); // wmloader.dataset.ACTION_FEATURES, pinned
        hello.addProperty("action_out", 15);      // wmnav.model.ACTION_OUT, pinned
        hello.addProperty("mode", mode);
        client = new WmPolicyClient("127.0.0.1", config.policyPort(), hello);
        McpToolkit.LOGGER.info("[MCP Toolkit] wm policy {} — sidecar expected on 127.0.0.1:{}",
            mode, config.policyPort());
    }

    static void stop() {
        WmPolicyClient c = client;
        client = null;
        server = null;
        mode = "off";
        GOAL_BODY.clear();
        pendingRows.clear();
        if (c != null) {
            c.close();
        }
    }

    public static boolean active() {
        return client != null;
    }

    // ---- taps (server thread; mirror of the recorder's own) ---------------------

    /** A fan was recorded — mirror it. {@code frame} is the recorder's own serialized object. */
    static void onFan(final @Nullable Entity source, final JsonObject frame) {
        WmPolicyClient c = client;
        if (c == null || !(source instanceof LivingEntity living)) {
            return;
        }
        JsonObject req = new JsonObject();
        req.addProperty("type", "fan");
        req.addProperty("body", living.getUUID().toString());
        req.addProperty("t", frame.has("t") ? frame.get("t").getAsInt() : tick());
        req.add("frame", frame.deepCopy());
        c.enqueue(req, null);
    }

    /** Every tick the body exists (from Wm.tickEntity): the obs mirror + the row drain. */
    static void onObs(final LivingEntity body) {
        WmPolicyClient c = client;
        if (c == null) {
            return;
        }
        drainParked();
        JsonObject req = new JsonObject();
        req.addProperty("type", "obs");
        req.addProperty("body", body.getUUID().toString());
        req.addProperty("t", tick());
        req.add("envelope", envelope(body));
        c.enqueue(req, null);
    }

    /** An expert input frame was recorded (from Wm.actionMove/actionSwim): ask the policy what
     *  IT would have done, park the answer as a {@code policy} row. */
    static void onExpertTick(final LivingEntity body) {
        WmPolicyClient c = client;
        if (c == null) {
            return;
        }
        int t = tick();
        JsonObject req = new JsonObject();
        req.addProperty("type", "tick");
        req.addProperty("body", body.getUUID().toString());
        req.addProperty("t", t);
        req.add("envelope", envelope(body));
        c.enqueue(req, reply -> {
            if (reply == null || !"action".equals(optString(reply, "type"))) {
                return;
            }
            JsonObject frame = reply.deepCopy();
            frame.addProperty("k", "policy");
            frame.addProperty("t", t); // the tick this prediction was FOR; the outer row is later
            frame.remove("id");
            frame.remove("type");
            pendingRows.add(new ParkedRow(body, frame));
        });
    }

    static void onGoalStart(final @Nullable LivingEntity body, final String actionId,
                            final String action, final @Nullable JsonObject selector,
                            final @Nullable JsonObject profile) {
        WmPolicyClient c = client;
        if (c == null || body == null) {
            return;
        }
        GOAL_BODY.put(actionId, body.getUUID());
        JsonObject req = new JsonObject();
        req.addProperty("type", "goal");
        req.addProperty("body", body.getUUID().toString());
        req.addProperty("action_id", actionId);
        req.addProperty("action", action);
        if (selector != null) {
            req.add("selector", selector.deepCopy());
        }
        if (profile != null) {
            req.add("profile", profile.deepCopy());
        }
        c.enqueue(req, null);
    }

    static void onGoalEnd(final String actionId) {
        WmPolicyClient c = client;
        UUID body = GOAL_BODY.remove(actionId);
        if (c == null || body == null) {
            return;
        }
        JsonObject req = new JsonObject();
        req.addProperty("type", "goal_end");
        req.addProperty("body", body.toString());
        req.addProperty("action_id", actionId);
        c.enqueue(req, null);
    }

    /** Body despawn/replace: drop the sidecar's state for it. */
    static void onBodyGone(final UUID uuid) {
        WmPolicyClient c = client;
        if (c == null) {
            return;
        }
        JsonObject req = new JsonObject();
        req.addProperty("type", "reset");
        req.addProperty("body", uuid.toString());
        c.enqueue(req, null);
    }

    // ---- the ON-mode driving step (exposed, deliberately unwired in v1) ---------

    /**
     * One learned policy step actuated through the widened frame: synchronous ask (bounded), then
     * {@code driveMove}/{@code driveSwim} with the sidecar's absolute fields. Returns false when
     * the sidecar is absent/slow/warming up — the CALLER falls back to the scripted driver for
     * that tick; a silent freeze is never an option. Who calls this (which goal legs, which
     * bodies) is the deploy step's wiring decision at the {@code Bodies.Nav} seam.
     */
    public static boolean stepNav(final NavBody nav, final LivingEntity body, final long timeoutMs) {
        WmPolicyClient c = client;
        if (c == null || !"on".equals(mode)) {
            return false;
        }
        JsonObject req = new JsonObject();
        req.addProperty("type", "tick");
        req.addProperty("body", body.getUUID().toString());
        req.addProperty("t", tick());
        req.add("envelope", envelope(body));
        JsonObject reply = c.request(req, timeoutMs);
        if (reply == null || !"action".equals(optString(reply, "type"))
            || (reply.has("warmup") && reply.get("warmup").getAsBoolean())) {
            return false;
        }
        float yaw = reply.get("yaw").getAsFloat();
        float pitch = reply.get("pitch").getAsFloat();
        boolean sprint = reply.get("sprint").getAsBoolean();
        if ("swim".equals(optString(reply, "cls"))) {
            nav.driveSwim(yaw, pitch, reply.get("swim_fwd").getAsFloat(),
                reply.get("swim_vert").getAsFloat(), sprint);
        } else {
            nav.driveMove(yaw, pitch, reply.get("forward").getAsFloat(),
                reply.get("strafe").getAsFloat(), reply.get("jump").getAsBoolean(),
                reply.get("sneak").getAsBoolean(), sprint);
        }
        return true;
    }

    // ---- plumbing ---------------------------------------------------------------

    private static void drainParked() {
        WmRecorder r = Wm.recorderOrNull();
        if (r == null) {
            pendingRows.clear();
            return;
        }
        ParkedRow row;
        while ((row = pendingRows.poll()) != null) {
            if (!row.body().isRemoved()) {
                r.writeAction(row.body(), "policy", row.frame());
            }
        }
    }

    private static JsonObject envelope(final LivingEntity body) {
        JsonObject env = new JsonObject();
        WmRecorder.envelope(env, body);
        return env;
    }

    private static int tick() {
        MinecraftServer s = server;
        return s == null ? 0 : s.getTickCount();
    }

    private static @Nullable String optString(final JsonObject o, final String key) {
        return o.has(key) && o.get(key).isJsonPrimitive() ? o.get(key).getAsString() : null;
    }
}
