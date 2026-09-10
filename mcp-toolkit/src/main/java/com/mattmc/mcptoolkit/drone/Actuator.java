package com.mattmc.mcptoolkit.drone;

import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * The <b>actuator contract</b> — the embodiment seam that {@code Origin} deliberately is not (ARCHITECTURE.md,
 * "Origin is a sensor seam, not embodiment"). Where {@link com.mattmc.mcptoolkit.WorldPerceptionTools.Origin}
 * answers <em>"from where is an observation made?"</em>, an {@code Actuator} answers <em>"what body may the AI
 * command, and what can it reach and carry?"</em>. It bundles the acting body, its level and eye, its
 * interaction reach, and (when the body has hands) its inventory.
 *
 * <p><b>Session roles</b> (ARCHITECTURE.md, "Session roles"): {@code principal} = the player (owns/authorizes
 * the task, via the Claude Code harness); {@code observer} = where a perception read is taken from (the
 * perception tools' {@code Origin}); {@code actuator} = the body the AI may command. That last role is not a
 * config blob nobody checks: it is enforced right here. {@link #current} yields the actuator only when the
 * session has a live body, and {@link #require} is the single gate every acting tool passes through — no body
 * means role {@code actuator: none} and every embodied action is refused.
 *
 * <p><b>Body kinds, one shape.</b> The active body is the session's possessed mob when a possession is
 * live ({@link Possession}), otherwise its spawned body (flyer, walker, or player). Capabilities differ
 * honestly: every body can move, look, and attack; toolkit bodies AND the player body have hands
 * (the {@link Hands} contract — inventory, mine/place/use/craft) — {@link #hands} is the gate,
 * refusing with {@code no_hands} semantics for possessed bodies instead of pretending a wolf can
 * hold a pickaxe.
 */
public final class Actuator {
    /** How far the body can edit blocks (mine/place/use), in blocks from the eye — mirrors a player's reach. */
    public static final double BLOCK_REACH = 4.5;
    /** How far a TOOLKIT body (drone/walker — fictional, disclosed) reaches an entity to attack it.
     * The PLAYER body does NOT use this: its reach is the vanilla {@code entity_interaction_range}
     * attribute (3.0 default in 26.2) via {@link AttackGate#entityReach} — attacks beyond human
     * reach are imitation-illegal world-model data (V3_PLAN.md §2 F1). */
    public static final double ENTITY_REACH = 4.0;

    private final LivingEntity body;
    private final @Nullable BotBodyEntity drone;

    private Actuator(final LivingEntity body) {
        this.body = body;
        this.drone = body instanceof BotBodyEntity d ? d : null;
    }

    /** The session's actuator, or {@code null} when it has no commandable body ({@code actuator: none}). */
    public static @Nullable Actuator current(final @Nullable String sessionId) {
        LivingEntity body = DroneTools.activeBodyFor(sessionId);
        return body == null ? null : new Actuator(body);
    }

    /** The slot's actuator, or throws — the gate every embodied tool passes through. */
    static Actuator require(final DroneTools.Slot slot) {
        LivingEntity body = slot.activeBody();
        if (body == null) {
            throw new IllegalStateException("no actuator: your session has no body — spawn one with "
                + "bot_body {action:\"spawn\"} first. If you HAD a body, it is gone (died or "
                + "despawned): check get_events for body_died/body_removed before respawning");
        }
        return new Actuator(body);
    }

    /** The acting body (the possessed mob while possession is live, otherwise the drone). */
    public LivingEntity body() {
        return body;
    }

    /** The body as a drone when it is one — the only body kind with hands — or null. */
    public @Nullable BotBodyEntity droneOrNull() {
        return drone;
    }

    /** The body as the fake-player when it is one, or null — the player-native verb branches key on
     *  this (attack/eat/equip/select/inventory run against the REAL player inventory). */
    public @Nullable FakePlayerEntity playerOrNull() {
        return body instanceof FakePlayerEntity p ? p : null;
    }

    /**
     * The body's hands — the §13.1 contract (drone or player) — or throws when the active body has
     * none (possessed mobs can move, look, and attack, but carry no inventory and cannot
     * mine/place/use).
     */
    public Hands hands() {
        Hands hands = Hands.of(body);
        if (hands == null) {
            throw new IllegalStateException("this body has no hands (a possessed mob can "
                + "move/look/attack only) — bot_release to return to your own body");
        }
        return hands;
    }

    public ServerLevel level() {
        return (ServerLevel) body.level();
    }

    /** Where the body acts from — its eye, the same point it perceives from. */
    public Vec3 eye() {
        return body.getEyePosition();
    }

    public Container inventory() {
        return hands().container();
    }

    /** The held stack (selected slot), the default item for place/use/attack. */
    public ItemStack held() {
        return hands().selectedStack();
    }

    /** True if {@code point} (a block/hit center) is within block-interaction reach of the eye. */
    public boolean inBlockReach(final Vec3 point) {
        return eye().distanceTo(point) <= BLOCK_REACH;
    }

    /**
     * Why a tracked entity stopped existing, as a reason word — {@code died}, {@code despawned},
     * {@code disconnected}, {@code unloaded}, or {@code changed_dimension}. Callers prefix it
     * ({@code target_died}, {@code body_unloaded}). This exists because {@code isAlive()} is
     * {@code !isRemoved() && health > 0}: inside any {@code isRemoved() || !isAlive()} branch it is
     * always false, so discriminating on it collapses every unload/logout into a false "died" —
     * only {@link Entity#getRemovalReason()} can tell the cases apart.
     */
    static String removalWord(final Entity e) {
        Entity.RemovalReason why = e.getRemovalReason();
        if (why == null) {
            return "died"; // not removed, so this branch was entered on health alone
        }
        return switch (why) {
            case KILLED -> "died";
            // A conversion also discards, but the MOB_CONVERSION hook releases first with
            // body_converted, so a discard reaching this word really is a despawn.
            case DISCARDED -> "despawned";
            case UNLOADED_WITH_PLAYER -> e instanceof net.minecraft.world.entity.player.Player
                ? "disconnected" : "unloaded";
            case UNLOADED_TO_CHUNK -> "unloaded";
            case CHANGED_DIMENSION -> "changed_dimension";
        };
    }

    /** True if {@code target} is within melee reach of the body — the HONEST reach: the vanilla
     *  entity-interaction-range attribute on the player body, 4.0 on toolkit bodies. */
    public boolean inEntityReach(final Entity target) {
        return body.distanceTo(target) <= AttackGate.entityReach(body);
    }
}
