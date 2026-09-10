package com.mattmc.mcptoolkit.wm;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

import java.util.Locale;
import java.util.Set;

/**
 * The §15 referee (HUMAN_RIG_PLAN.md phase 3): turns {@link VerdictPredicates} into the SAME
 * verdict shapes GoalRunner emits, so a human task ends the way a bot goal ends — a real
 * {@code action_completed} with {@code outcome:"achieved"} (or the honest {@code already_*}
 * degenerates), never a synthetic success and never only the lifecycle {@code stopped}s.
 * {@link HumanTasks} calls {@link #atAccept} once when a task is minted (a goal already satisfied
 * closes instantly, mirroring GoalRunner's first-tick {@code canActNow} verdicts) and
 * {@link #onTick} from its END_SERVER_TICK sweep; emission stays in HumanTasks so task state has
 * one owner.
 *
 * <p>Verdict vocabulary, mirrored from GoalRunner's terminal block: completes carry
 * {@code outcome} achieved | already_there | already_clear; fails carry {@code outcome:"stopped"}
 * plus a {@code reason} (obstructed, timeout, and HumanTasks' lifecycle reasons). The one
 * deliberate v1 simplification: {@code place} judges "a block is present", not "THIS player placed
 * it" — in the single-supervised-human rig the difference cannot bite, and the honest fix (press-
 * row attribution) is loader work, not referee work.
 */
public final class HumanReferee {
    private HumanReferee() {}

    /** A terminal judgment: {@code stopped} outcomes carry the reason, completes carry none. */
    public record Verdict(String outcome, @Nullable String reason, @Nullable String note) {
        boolean completed() {
            return !"stopped".equals(outcome);
        }
    }

    /**
     * The accept-time check — GoalRunner's first-tick {@code canActNow} verdicts, mirrored:
     * a move to a cell the player already stands on is {@code already_there}, a destroy of an
     * empty cell is {@code already_clear} (the succeeds-falsely guard: complete, but SAY nothing
     * happened), a place into an occupied cell is {@code stopped/obstructed}. Null = the task is
     * real work; present it.
     *
     * <p>This read is deliberately UNguarded: a far target pages its chunk in once at accept.
     * human_task is PRIVILEGED surface and the initial state MUST be read — skipping it would let
     * a destroy task on an already-empty far cell close "achieved" when the human merely walks
     * there, which is exactly the coordinate-guess-validating false success the bot side fixed
     * (already_clear, e0416e9). One disclosed chunk load buys that honesty.
     */
    public static @Nullable Verdict atAccept(final String verb, final ServerLevel level,
                                             final Vec3 playerPos, final BlockPos at) {
        return switch (verb) {
            case "move" -> !VerdictPredicates.moveArrived(playerPos, at) ? null
                : new Verdict("already_there", null,
                    "the player already stands at the goal cell — nothing was demonstrated and "
                        + "the episode is empty. If you expected travel, the coordinates are wrong");
            case "destroy" -> !VerdictPredicates.destroyCleared(level, at) ? null
                : new Verdict("already_clear", null,
                    "that cell already held no block — nothing was mined and there are no drops. "
                        + "If you expected a block here, the coordinates are wrong: scan tallies "
                        + "carry NO coordinates. locate gives exact remembered cells, vantage "
                        + "names obstructions, raycast reads what you are looking at");
            case "place" -> !VerdictPredicates.placePresent(level, at) ? null
                : new Verdict("stopped", "obstructed",
                    "a block already occupies that cell — there is nothing to place. If you "
                        + "expected it empty, the coordinates are wrong");
            default -> null;
        };
    }

    /**
     * The per-tick check. Achievement is checked BEFORE timeout — a goal that holds on the
     * deadline tick achieved, and claiming timeout would be the mirror-image false report.
     * Null = still running.
     */
    public static @Nullable Verdict onTick(final String verb, final ServerLevel level,
                                           final Vec3 playerPos, final BlockPos at,
                                           final long ticksActive, final int timeoutTicks) {
        // A wandered-away player lets the target chunk unload; judging then would page it back in
        // every tick (the raycast lesson). An unloaded target cannot have been satisfied by the
        // player this tick anyway — for move the player would BE the chunk's ticket — so the task
        // simply does not progress. Timeout below still counts.
        boolean holds = level.isLoaded(at) && switch (verb) {
            case "move" -> VerdictPredicates.moveArrived(playerPos, at);
            case "destroy" -> VerdictPredicates.destroyCleared(level, at);
            case "place" -> VerdictPredicates.placePresent(level, at);
            default -> false;
        };
        if (holds) {
            return new Verdict("achieved", null, null);
        }
        if (timeoutTicks > 0 && ticksActive >= timeoutTicks) {
            return new Verdict("stopped", "timeout", "the task's timeout_ticks (" + timeoutTicks
                + ") elapsed before the goal predicate held");
        }
        return null;
    }

    /**
     * The verdict's event payload — GoalRunner's terminal shape minus the bot-only fields
     * (repairs/ledger/hits), plus {@code player}. ONE builder for the live referee, the lifecycle
     * closes, and the {@code wm_verdict} probe tool, so the equivalence probe pins the payload
     * that production actually emits. Envelope (game_tick/dimension) is stamped by the caller —
     * only it knows whether the player is still there to date it.
     */
    public static JsonObject payload(final String actionId, final String verb, final Verdict v,
                                     final String playerName) {
        JsonObject d = new JsonObject();
        d.addProperty("action_id", actionId);
        d.addProperty("action", "human_task");
        d.addProperty("goal", verb);
        d.addProperty("outcome", v.outcome());
        if (v.reason() != null) {
            d.addProperty("reason", v.reason());
        }
        if (v.note() != null) {
            d.addProperty("note", v.note());
        }
        d.addProperty("player", playerName);
        return d;
    }

    // ---- the dev probe tool -----------------------------------------------------

    private static final Set<String> VERBS = Set.of("move", "destroy", "place");

    /**
     * {@code wm_verdict} — the headless half of the referee-equivalence probe. DEV_ONLY on the
     * Node side (like human_task itself): evaluates the predicates and would-be verdict payloads
     * against the live world WITHOUT a task or a human, so the probe can run the same intent
     * through an expert goal and through this and assert the semantics match. Read-only by
     * construction: predicates never write.
     */
    static void register() {
        McpTools.register(ToolDef.of(
            "wm_verdict",
            "DEV probe for the §15 human-task referee: evaluate the v1 verdict predicate for an "
                + "action at a cell against the live world, without any task running. Returns "
                + "holds (the per-tick predicate), tick_verdict (the payload the referee would "
                + "emit now, null while unsatisfied) and accept_verdict (what human_task would "
                + "close with instantly at accept, null when the task would present as real "
                + "work). pos is the hypothetical player position — required for move, ignored "
                + "otherwise.",
            Schemas.objectOpt(Schemas.object(
                "action", Schemas.str("move | destroy | place"),
                "at", Schemas.vec3i("the goal's target block"),
                "pos", Schemas.object(
                    "x", Schemas.number(), "y", Schemas.number(), "z", Schemas.number())),
                "pos"),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> {
                String verb = a.get("action").getAsString().toLowerCase(Locale.ROOT);
                if (!VERBS.contains(verb)) {
                    throw new IllegalArgumentException("unknown action '" + verb
                        + "' — v1 referee verbs: " + String.join(", ", VERBS));
                }
                JsonObject atJson = a.getAsJsonObject("at");
                BlockPos at = new BlockPos(atJson.get("x").getAsInt(), atJson.get("y").getAsInt(),
                    atJson.get("z").getAsInt());
                Vec3 pos;
                if (a.has("pos") && a.get("pos").isJsonObject()) {
                    JsonObject p = a.getAsJsonObject("pos");
                    pos = new Vec3(p.get("x").getAsDouble(), p.get("y").getAsDouble(),
                        p.get("z").getAsDouble());
                } else if ("move".equals(verb)) {
                    throw new IllegalArgumentException("move needs 'pos' — the hypothetical "
                        + "player position the arrival predicate is judged from");
                } else {
                    pos = Vec3.atBottomCenterOf(at);
                }
                ServerLevel level = ctx.serverOrThrow().getLevel(Level.OVERWORLD);
                if (level == null) {
                    throw new IllegalStateException("no overworld");
                }
                // Residency guard: a raw getBlockState pages chunks in (the raycast lesson — an
                // observe tool must never load or generate terrain). The live referee never needs
                // this: it judges where a player IS, and players keep their chunks resident.
                if (!level.isLoaded(at)) {
                    throw new IllegalStateException("the target cell's chunk is not resident — "
                        + "wm_verdict refuses to page terrain in; forceload the site first");
                }
                Verdict tick = onTick(verb, level, pos, at, 0, 0);
                Verdict accept = atAccept(verb, level, pos, at);
                JsonObject r = new JsonObject();
                r.addProperty("action", verb);
                r.add("at", atJson.deepCopy());
                r.addProperty("holds", tick != null && tick.completed());
                r.add("tick_verdict", tick == null ? null
                    : stamped(payload("probe", verb, tick, "probe"), level));
                r.add("accept_verdict", accept == null ? null
                    : stamped(payload("probe", verb, accept, "probe"), level));
                return r;
            }));
    }

    private static JsonObject stamped(final JsonObject d, final ServerLevel level) {
        d.addProperty("game_tick", level.getGameTime());
        d.addProperty("dimension", level.dimension().identifier().toString());
        return d;
    }
}
