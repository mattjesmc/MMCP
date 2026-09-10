package com.mattmc.mcptoolkit.wm;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.drone.FakePlayerEntity;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import com.mattmc.mcptoolkit.mixin.ServerPlayerGameModeAccessor;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Input;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * §15 human-demonstration capture, both channels (HUMAN_RIG_PLAN.md).
 *
 * <p><b>Channel 1 — server-side (phase 1, permanent fallback + cross-check).</b> What the server
 * legally sees of a genuinely connected player — the persisted client input frame
 * ({@link ServerPlayer#getLastClientInput()}: ternary forward/strafe, held jump/sneak/sprint),
 * exact per-tick look floats, press edges from the packet handlers, and the two
 * server-authoritative holds (dig progress, item use) — one action row per tick per armed player,
 * tagged {@code src:"server"}.
 *
 * <p><b>Channel 2 — client capture (phase 2, the fidelity upgrade).</b> {@code HumanCapture} sends
 * a {@link HumanFramePayload} per client tick; the packet mixin hops it to the server thread where
 * {@link #noteClientFrame} buffers it. When END_SERVER_TICK finds a fresh frame, the tick's rows
 * upgrade to {@code src:"client"}: analog speed/strafe, resolved sprint/sneak, keybind-level
 * attack/use with edge counts + crosshair target, and record-only sub-tick mouse sums (decision 7).
 * No fresh frame → the phase-1 row, and a fallback tick is counted. Reconciliation is MEASURED,
 * not assumed: every consumed frame's key booleans diff against {@code lastClientInput}
 * (disagreements counted — any nonzero in a lag-free session is a framing bug), and gap/dup/drop/
 * skew stats ride the manifest human section.
 *
 * <p><b>Never fake players</b>: toolkit bodies extend ServerPlayer but receive no input packets —
 * enrolling one would record an all-zero ghost of a body whose real inputs the drivers already
 * record through the widened sinks. Spectators are skipped too (no embodiment, nothing to imitate).
 *
 * <p>Press EDGES accumulate from the packet mixin during the tick's packet drain and are consumed
 * at END_SERVER_TICK — same tick, so the §13.1 join holds. The input packet itself is
 * edge-triggered (sent only on change), which is why the travel frame samples the PERSISTED state
 * per tick instead of counting packets. The client payload is sent after the same tick's input
 * packets on the same TCP stream, so its server-thread arrival preserves that order.
 */
public final class WmHuman {
    private WmHuman() {}

    private static volatile boolean enabled;

    /** Press edges seen this tick, keyed by player. Server thread only (packet handlers re-dispatch
     *  to it, the tick hook runs on it) — a plain map, cleared every tick. */
    private static final Map<UUID, Presses> PRESSES = new HashMap<>();

    private static final class Presses {
        boolean swing;
        boolean use;
        int slot = -1;
    }

    /** The phase-2 client channel, keyed by player. Server thread only (the packet mixin hops via
     *  {@code server.execute}). A map entry existing at all means the channel went live for that
     *  player — from then on, a tick without a fresh frame is a counted fallback. */
    private static final Map<UUID, Channel> CHANNEL = new HashMap<>();

    private static final class Channel {
        HumanFramePayload frame;
        boolean consumed = true;
        long lastClientTick = Long.MIN_VALUE;
    }

    static void init() {
        enabled = true;
        ServerHooks.END_SERVER_TICK.register(WmHuman::tick);
    }

    /** Is this player's input being captured? The packet mixin checks this before noting. */
    public static boolean armed(final ServerPlayer player) {
        return enabled && Wm.recording()
            && !(player instanceof FakePlayerEntity) && !player.isSpectator();
    }

    // ---- press edges, from ServerGamePacketListenerImplMixin (server thread) ----

    public static void noteSwing(final ServerPlayer player) {
        presses(player).swing = true;
    }

    public static void noteUse(final ServerPlayer player) {
        presses(player).use = true;
    }

    public static void noteHotbar(final ServerPlayer player, final int slot) {
        presses(player).slot = slot;
    }

    private static Presses presses(final ServerPlayer player) {
        return PRESSES.computeIfAbsent(player.getUUID(), u -> new Presses());
    }

    // ---- the client channel, from ServerGamePacketListenerImplMixin (server thread) ----

    /** A {@link HumanFramePayload} arrival. Latest-wins per player: two frames landing inside one
     *  server tick drop the first (counted — sustained drops mean tick-rate skew, not loss). */
    public static void noteClientFrame(final ServerPlayer p, final HumanFramePayload f) {
        WmRecorder r = Wm.recorderOrNull();
        if (r == null || !armed(p) || f.schema() != HumanFramePayload.SCHEMA) {
            return; // schema mismatch = future client against this server: ignore, don't misparse
        }
        Channel ch = CHANNEL.computeIfAbsent(p.getUUID(), u -> new Channel());
        if (ch.lastClientTick != Long.MIN_VALUE) {
            long d = f.clientTick() - ch.lastClientTick;
            if (d <= 0) {
                r.noteHumanPayload(WmRecorder.PAYLOAD_DUP);
            } else if (d > 1) {
                r.noteHumanPayload(WmRecorder.PAYLOAD_GAP);
            }
        }
        if (!ch.consumed) {
            r.noteHumanPayload(WmRecorder.PAYLOAD_DROPPED);
        }
        ch.lastClientTick = f.clientTick();
        ch.frame = f;
        ch.consumed = false;
    }

    // ---- the per-tick capture ---------------------------------------------------

    private static void tick(final MinecraftServer server) {
        WmRecorder r = Wm.recorderOrNull();
        if (r == null) {
            PRESSES.clear();
            CHANNEL.clear();
            return;
        }
        for (ServerPlayer p : server.getPlayerList().getPlayers()) {
            if (armed(p) && !p.isRemoved()) {
                capture(r, p);
            }
        }
        PRESSES.clear();
        // Disconnected players leave the channel map (a rejoin starts a fresh gap/dup baseline).
        if (!CHANNEL.isEmpty()) {
            CHANNEL.keySet().removeIf(u -> server.getPlayerList().getPlayer(u) == null);
        }
    }

    private static void capture(final WmRecorder r, final ServerPlayer p) {
        // The session key doubles as the §13.3 actor label. Own key per player: feeding the shared
        // anon seen-set would bleed human knowledge into anonymous probes (the hermeticity lesson).
        String actor = "human:" + p.getGameProfile().name();
        // Goal attribution: while a human_task is active its action id rides every captured row,
        // exactly as a bot goal's id rides driver rows — the §13.5 episode join for human play.
        String goalId = HumanTasks.goalIdFor(p);
        Wm.tickBody(actor, p, goalId); // seen-set proprioception + session/goal attribution
        r.writeTick(actor, p, goalId); // envelope row (self-dedupes per tick)
        WmGait.tickHuman(r, actor, p); // human-density gait + cadence look fans

        // The phase-2 frame, when the client channel delivered one for this tick. Consumed at most
        // once; skew and the boolean cross-check are measured at the moment of consumption.
        Channel ch = CHANNEL.get(p.getUUID());
        HumanFramePayload cf = ch != null && !ch.consumed ? ch.frame : null;
        if (cf != null) {
            ch.consumed = true;
            r.noteHumanSkew((int) (p.level().getGameTime() - cf.clientTick()));
            if (!cf.asInput().equals(p.getLastClientInput())) {
                r.noteHumanDisagree();
            }
        } else if (ch != null) {
            r.noteHumanFallback();
        }

        // The travel frame: every tick, zeroed frames are actions, not absences (§13.1). Client
        // channel = analog impulses + resolved effective holds (decision 2); server channel = the
        // persisted ternary + raw key booleans, the permanent fallback.
        Input in = p.getLastClientInput();
        JsonObject f = new JsonObject();
        boolean wet = p.isSwimming() || p.isInWater();
        if (cf != null) {
            if (wet) {
                // Wet frame vert stays honest ternary in both channels — the vertical impulse IS
                // jump/sneak; there is no analog source for it client-side either.
                f.addProperty("k", "swim");
                f.addProperty("yaw", WmRecorder.round(cf.yaw()));
                f.addProperty("pitch", WmRecorder.round(cf.pitch()));
                f.addProperty("fwd", WmRecorder.round(cf.fwd()));
                f.addProperty("vert", (cf.key(HumanFramePayload.KEY_JUMP) ? 1.0 : 0.0)
                    - (cf.key(HumanFramePayload.KEY_SHIFT) ? 1.0 : 0.0));
                f.addProperty("sprint", cf.st(HumanFramePayload.ST_SPRINT));
            } else {
                f.addProperty("k", "walk");
                f.addProperty("yaw", WmRecorder.round(cf.yaw()));
                f.addProperty("pitch", WmRecorder.round(cf.pitch()));
                f.addProperty("speed", WmRecorder.round(cf.fwd()));
                if (cf.strafe() != 0.0F) {
                    f.addProperty("strafe", WmRecorder.round(cf.strafe()));
                }
                if (cf.st(HumanFramePayload.ST_SNEAK)) {
                    f.addProperty("sneak", true);
                }
                f.addProperty("jump", cf.key(HumanFramePayload.KEY_JUMP));
                f.addProperty("sprint", cf.st(HumanFramePayload.ST_SPRINT));
            }
            if (cf.mouseSamples() > 0) {
                // Sub-tick mouse trace: record-only in v1 (decision 7 — attention prior, not a
                // model input). Raw pre-sensitivity pixel sums.
                f.addProperty("mdx", WmRecorder.round(cf.mouseDx()));
                f.addProperty("mdy", WmRecorder.round(cf.mouseDy()));
                f.addProperty("msamp", cf.mouseSamples());
            }
            f.addProperty("src", "client");
        } else {
            float fwd = (in.forward() ? 1.0F : 0.0F) - (in.backward() ? 1.0F : 0.0F);
            float strafe = (in.left() ? 1.0F : 0.0F) - (in.right() ? 1.0F : 0.0F);
            if (wet) {
                // The wet frame (the walk-frame-in-water mismatch the server-only design caught):
                // vert from held jump/sneak, the server's honest ternary.
                f.addProperty("k", "swim");
                f.addProperty("yaw", WmRecorder.round(p.getYRot()));
                f.addProperty("pitch", WmRecorder.round(p.getXRot()));
                f.addProperty("fwd", WmRecorder.round(fwd));
                f.addProperty("vert", (in.jump() ? 1.0 : 0.0) - (in.shift() ? 1.0 : 0.0));
                f.addProperty("sprint", in.sprint());
            } else {
                f.addProperty("k", "walk");
                f.addProperty("yaw", WmRecorder.round(p.getYRot()));
                f.addProperty("pitch", WmRecorder.round(p.getXRot()));
                f.addProperty("speed", WmRecorder.round(fwd));
                if (strafe != 0.0F) {
                    f.addProperty("strafe", WmRecorder.round(strafe));
                }
                if (in.shift()) {
                    f.addProperty("sneak", true);
                }
                f.addProperty("jump", in.jump());
                f.addProperty("sprint", in.sprint());
            }
            f.addProperty("src", "server");
        }
        r.writeAction(p, actor, f);
        r.noteHuman(false, cf != null);

        // The button half: packet edges this tick + the two server-authoritative holds. A dig tick
        // is attack-held on the authoritative progress clock; a consuming body is use-held —
        // exactly the bot convention, so the loader unions rows identically. The client frame adds
        // keybind-level holds, GLFW-resolution edge counts, and the crosshair target at the edge.
        Presses pr = PRESSES.get(p.getUUID());
        boolean dig = ((ServerPlayerGameModeAccessor) p.gameMode).mcptoolkit$isDestroyingBlock();
        boolean atk = dig || (pr != null && pr.swing)
            || (cf != null && (cf.st(HumanFramePayload.ST_ATK_HELD) || cf.atkEdges() > 0));
        boolean use = p.isUsingItem() || (pr != null && pr.use)
            || (cf != null && (cf.st(HumanFramePayload.ST_USE_HELD) || cf.useEdges() > 0));
        int slot = pr == null ? -1 : pr.slot;
        if (atk || use || slot >= 0) {
            JsonObject press = new JsonObject();
            press.addProperty("k", "press");
            if (use) {
                press.addProperty("use", true);
            }
            if (atk) {
                press.addProperty("atk", true);
            }
            if (slot >= 0) {
                press.addProperty("slot", slot);
            }
            if (cf != null) {
                if (cf.atkEdges() > 0) {
                    press.addProperty("atk_n", cf.atkEdges());
                }
                if (cf.useEdges() > 0) {
                    press.addProperty("use_n", cf.useEdges());
                }
                if (cf.targetEid() != HumanFramePayload.NO_TARGET) {
                    press.addProperty("tgt_eid", cf.targetEid());
                    // The §15.3 mitigation-2 flag: the crosshair named an entity NO fan of this
                    // session sighted inside the window — an observation-inexplicable engagement,
                    // flagged instead of silently kept; the loader excludes flagged spans (phase
                    // 6). Same-tick sightings count: the gait/look fans cast earlier in this same
                    // capture() call, and an observation at tick t legally explains an action at
                    // tick t.
                    boolean gap = !WmObsGap.sighted(actor, cf.targetEid(), r.tick());
                    if (gap) {
                        press.addProperty("obs_gap", true);
                        JsonObject g = new JsonObject();
                        g.addProperty("t", r.tick());
                        g.addProperty("type", "obs_gap");
                        g.addProperty("session", actor);
                        if (goalId != null) {
                            g.addProperty("action_id", goalId);
                        }
                        g.addProperty("eid", cf.targetEid());
                        r.writeEpisode(g);
                    }
                    r.noteHumanTgtPress(gap);
                }
                press.addProperty("src", "client");
            } else {
                press.addProperty("src", "server");
            }
            r.writeAction(p, actor, press);
            r.noteHuman(true, cf != null);
        }
    }
}
