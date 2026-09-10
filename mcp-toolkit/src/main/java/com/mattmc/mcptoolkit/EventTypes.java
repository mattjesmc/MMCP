package com.mattmc.mcptoolkit;

import com.google.gson.JsonObject;
import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * The event vocabulary as a first-class artifact — one place that knows every type the
 * {@link EventLog} can carry, which of them mean DANGER, and how each reads in one line.
 *
 * <p><b>Why this exists.</b> The vocabulary used to live as prose inside {@code get_events}'
 * description, and it drifted: thirteen live types (every body event, every reflex event,
 * {@code world_closed}, the engage/possession pairs) were emitted by the mod and named nowhere the
 * model could read them. That is not a documentation bug, it is a capability bug — {@code type} is
 * an exact-match filter, so a type you cannot see is a type you cannot subscribe to, and a narrow
 * filter over a silent stream is indistinguishable from a dead world (ARCHITECTURE.md, "a listen
 * filter is a sense organ"). The registry closes it structurally: the tool description is
 * RENDERED from this list, and {@link EventLog#emit} warns once about any type missing from it, so
 * a new emitter cannot ship undocumented.
 *
 * <p><b>Urgency</b> is declared here too, because it is the same knowledge: the events that mean
 * the body is losing (or has lost) integrity are exactly the ones a paged read must never bury.
 * {@link EventLog} uses it for the {@code urgent} preview; nothing else may reorder the stream.
 */
public final class EventTypes {
    private EventTypes() {}

    /** One documented line of the vocabulary — one type, or a paired onset/clear (a/b). */
    private record Line(String group, String[] names, String doc) {}

    /**
     * Types whose arrival means the body is in trouble. Deliberately small: a "priority" that
     * covers half the stream prioritizes nothing. Onset only — {@code body_safe} is good news, and
     * {@code reaction_fired} is the body already handling itself.
     */
    private static final Set<String> URGENT = Set.of(
        "body_endangered", "body_damaged", "body_died", "body_removed",
        "drone_damaged", "drone_removed", "nearest_threat_changed",
        // A death that did not happen. The body is at 1 health and its last-resort item is spent —
        // strictly worse news than the body_damaged that accompanies it, and the one event whose
        // absence would let an agent keep fighting the thing that just killed it.
        "totem_used",
        // A guard knocked aside by an axe: the body is standing where it chose to stand BECAUSE it
        // was covered, and it is not covered any more. At most once per disable by construction.
        "shield_disabled",
        // A reflex that gave up IS a loss of integrity — the body's automatic defence against
        // drowning/starving/burning just stopped covering it, and only the agent can restore it. It
        // is emitted at most once per suspension window, so it cannot become the noise it replaces.
        "reaction_suspended",
        // A navigation being starved by a reflex loop is the body NOT ESCAPING while it believes it
        // is traveling (the w2-79881 corner death). Rate-limited at the emitter (once per 60
        // preemptions), so it cannot flood.
        "nav_starved",
        // A body placed where the hostile-clearance rule could not be met is in a kill zone from
        // tick one — at most one per spawn, by construction.
        "spawned_in_danger");

    /**
     * Types whose urgency is decided PER EVENT by the emitter, via {@code data.urgent}.
     *
     * <p>Exactly one member today, and the reason it exists is worth keeping: a
     * {@code block_sighted} for iron is an opportunity and must not jump the queue, while one for
     * lava three blocks into a tunnel is the same danger {@code body_endangered} carries — and only
     * the agent that armed the watch knows which of its watches mean that. So urgency here is
     * declared by the WATCHER ({@code bot_watch}'s {@code urgent:true}), not inferred by the mod
     * from the block id. That distinction is the whole point: an importance classifier stays on the
     * don't-build list, and this is a subscription honouring the priority its subscriber asked for.
     *
     * <p>Membership is a closed set, not a free-for-all: any emitter could otherwise set
     * {@code urgent} and quietly promote itself into the danger preview.
     */
    private static final Set<String> INSTANCE_URGENT = Set.of("block_sighted",
        // A rescue reflex that keeps failing WHILE THE HAZARD IS STILL ON THE BODY. Per-event and
        // not blanket-urgent for the reason this set exists: `lava_near` backstepping off a lava
        // lip fired 130 times in three watched hours and never once meant "you are dying" — a
        // repeating reflex is normally the body coping, and promoting all of them would drown the
        // lane it is meant to protect. The emitter decides, and it decides by ASKING THE DANGER
        // SENSE (Reflexes.emitDone) rather than pattern-matching the reason string.
        //
        // Live, session w1-97535 (2026-08-11): the `drown` reflex fire-failed 13 times with
        // `no_surface_reachable` in a sealed underwater pocket — the reflex layer diagnosed the
        // drowning perfectly and said so — and the body died anyway, because the only place that
        // said it was a routine row in a stream the agent was not reading (it was inside a long
        // bot_target move). `reaction_suspended` already covers "the reflex gave up"; this covers
        // the worse case, where the reflex has NOT given up and cannot help either.
        "reaction_repeating");

    /**
     * Ordered by what a living body needs first. The rendering below becomes the tool description,
     * so each doc is written for the model that must act on it, not for a changelog.
     */
    private static final List<Line> LINES = List.of(
        new Line("BODY", new String[] {"body_endangered", "body_safe"},
            "{cause: air_low|in_lava|on_fire|falling|suffocating|starving} — YOUR PAIN, onset then "
                + "clear, once each (air_low also carries seconds_left). Act on it"),
        new Line("BODY", new String[] {"body_damaged", "body_died"},
            "{cause, health, hazards} — what actually hurt you, named; body_died carries the hazards "
                + "you were suffering, so \"drowned\" is in the record"),
        new Line("BODY", new String[] {"body_removed"}, "your body is gone (despawned/replaced)"),
        new Line("BODY", new String[] {"food_low", "food_ok"},
            "{food, remedy} — hunger crossed 10 (of 20) on the way down, and cleared at 12. NOT "
                + "urgent: this is the gentle warning that arrives while eating is still a choice, "
                + "long before body_endangered {cause:starving} at 6 makes it an emergency"),
        new Line("BODY", new String[] {"spawned_in_danger"},
            "{pos, hostile_distance} — your fresh body could not be placed clear of hostiles: it "
                + "is in a kill zone RIGHT NOW. Arm reflexes and move before anything else"),
        // COMBAT KIT (COMBAT_KIT_PLAN.md §4.6). The 2026-08-11 audit had to reconstruct every one
        // of these from tick envelopes, which is the definition of a fact the stream should have
        // been carrying.
        new Line("BODY", new String[] {"totem_used"},
            "{health, cause} — YOU SHOULD BE DEAD. A totem of undying was consumed: you are at 1 "
                + "health with no totem in hand. Urgent, because reading `health: 1` and inferring "
                + "\"a bad hit\" is how the next one lands"),
        new Line("FIGHT", new String[] {"offhand_switched"},
            "{item, why, health} — the body filled its own offhand: a shield while healthy, a totem "
                + "once one more hit would be death. It is a real action and a real slot change, "
                + "not bookkeeping"),
        new Line("FIGHT", new String[] {"shield_disabled"},
            "{cause, ticks} — AN AXE KNOCKED YOUR GUARD ASIDE. The shield is on cooldown and cannot "
                + "be raised until it clears; raising it refuses. Break contact or fight with the "
                + "weapon. Urgent, because the body is still standing where it stood believing it "
                + "was covered"),
        new Line("FIGHT", new String[] {"guard_lowered"},
            "{item, reason, held_ticks, blocked_hits, blocked_damage} — the shield came down: "
                + "expired | commanded | interrupted (something else took the hand — one in-flight "
                + "use per body, so a draw or a meal ends a block) | shield_disabled | superseded"),
        new Line("FIGHT", new String[] {"shot_landed"},
            "{action_id, arrow_id, target_id, hit, damage, flight_ticks} — your arrow stopped "
                + "flying, and whether it connected. The shot's own action_completed says what LEFT "
                + "the bow (power, draw_ticks); this says what the world did with it, because a "
                + "body that cannot tell a hit from a miss cannot learn to aim"),
        new Line("FIGHT", new String[] {"crossbow_loaded", "crossbow_load_failed"},
            "{item, held_ticks, charge_ticks, why | reason} — a crossbow was wound. It STAYS wound: "
                + "the next bot_shoot fires it instantly (draw_ticks 0). The body does this by "
                + "itself between the shots of a ranged fight, so the ~25 ticks are paid out of "
                + "time nothing was waiting on"),
        new Line("FIGHT", new String[] {"trident_landed", "trident_returned", "trident_lost"},
            "{item, x, y, z, entity_id, loyalty} — WHERE YOUR THROWN TRIDENT IS. A throw spends the "
                + "weapon, so the one thing an agent must never have to guess is where it went: "
                + "landed = lying at those coordinates (Retrieve schedules the walk back), returned "
                + "= Loyalty flew it home and it is carried again, lost = it left the world without "
                + "coming to rest"),
        new Line("FIGHT", new String[] {"pickup_scheduled", "pickup_started", "pickup_done",
            "pickup_abandoned"},
            "{item, x, y, z, reason} — the errand for a weapon the body threw. It runs only while "
                + "the body has NOTHING else to do (no goal, no queue, no fight, no reflex) and "
                + "yields to anything you start, so it can sit on the books through several fights. "
                + "Walking over a landed trident IS the pickup — there is no collect verb"),
        new Line("FIGHT", new String[] {"attack_mode_changed"},
            "{action_id, mode, why} — a hunt that could not WALK to its target switched to shooting "
                + "it. Before this the goal simply died `target_unreachable` (7 times in the 9h47m "
                + "run of 2026-08-11) against targets it could see perfectly well"),
        new Line("REFLEX", new String[] {"reaction_fired", "reaction_done"},
            "a reflex TOOK your body: which id, which op, what it interrupted. If you are somewhere "
                + "unexpected, read these instead of guessing"),
        new Line("REFLEX", new String[] {"reaction_suspended", "reaction_rearmed"},
            "{id, reason, rearms_in_ticks} — a reflex failed the SAME way 3 times running (eat with "
                + "no food, shoot with no bow, dodge pressed against a wall) and stopped rather than "
                + "retrying 20x a second: that protection is OFF until you fix the precondition and "
                + "re-arm it"),
        new Line("REFLEX", new String[] {"reaction_repeating", "reaction_streak_ended"},
            "{id, reason, count, since_tick} — a reflex is fire-failing IDENTICALLY on repeat; the "
                + "stream carries one compact heartbeat instead of a pair of rows per fire, and the "
                + "exact tally lands when the streak breaks. count is truth, not sampling"),
        new Line("REFLEX", new String[] {"nav_starved"},
            "{action_id, by, preemptions} — a leg reflex keeps preempting your outstanding "
                + "navigation: the body is NOT traveling. Deal with the trigger or disarm the "
                + "named reflex"),
        new Line("ACTS", new String[] {"action_completed", "action_failed", "action_superseded"},
            "your commanded actions finishing, correlated by action_id (superseded = a newer command "
                + "replaced it — normal while tailing)"),
        new Line("ACTS", new String[] {"act_warning"},
            "{action, action_id, at, note} — an act the GOAL LOOP started on your behalf came back "
                + "with something worth reading (wrong-tier tool, an 8-minute dig, a silk-touch "
                + "class change). Hand-issued acts say this in their reply; goal-driven ones had no "
                + "way to say it at all"),
        new Line("ACTS", new String[] {"dig_starved"},
            "{action_id, by, starved_ticks, at} — your dig is FROZEN because a reflex or a fight "
                + "owns the body: it does not advance and every other dig answers busy. Deal with "
                + "the trigger or bot_mine {action:\"cancel\"}"),
        new Line("ACTS", new String[] {"inventory_full"},
            "{action, at, spilled} — your pack filled up mid-act, so mined drops fell ON THE GROUND "
                + "(they despawn) or container items stayed behind. The act still reported success"),
        new Line("NEAR", new String[] {"entity_entered_radius", "entity_left_radius"},
            "a LIVING entity became/ceased observable from your body (enter 24, leave 26 — dropped "
                + "items are not evented; read them with sense_entities). In perceived mode "
                + "(bot_profile perceived) these fire from your SENSES instead — what the body "
                + "first perceives / no longer perceives ({reason: lost|gone|died}), never through "
                + "walls"),
        new Line("NEAR", new String[] {"nearest_threat_changed"},
            "the closest hostile changed identity, or cleared:true. Never re-fires on distance drift"),
        new Line("DRONE", new String[] {"drone_damaged", "drone_removed"},
            "the flying observer body's vitals ({reason: despawned|replaced|died_or_unloaded})"),
        new Line("DRONE", new String[] {"possessed", "possession_released", "engage_started",
            "engage_ended", "follow_lost"},
            "possession, combat engagement and follow-target transitions"),
        new Line("WORLD", new String[] {"block_sighted"},
            "{watch_id, block, pos, distance} — a block you asked bot_watch about entered one of your "
                + "sightlines: how you notice ore while mining, or lava before you break into it. "
                + "Only ever what you WATCHED for, and only what a ray actually hit"),
        new Line("WORLD", new String[] {"weather_changed", "time_of_day"},
            "{raining, thundering} / {label: dawn|day|dusk|night}"),
        new Line("WORLD", new String[] {"world_closed"},
            "a world unloaded: its events (and their game_ticks) no longer serve, and how many went "
                + "with it"),
        // The log channel (LogCapture). Registered here so it can be named in a `type` filter, and
        // documented in one line because the payload is deliberately a pointer: the event says
        // something broke, get_log says what.
        new Line("BUILD", new String[] {"error"},
            "{level, logger, message, thrown, seq, repeats} — the GAME logged an ERROR. Usually a "
                + "pack the game logged-and-skipped, so a push/reload that reported success loaded "
                + "nothing. Deduped per message and capped per window (`repeats`/`flood_suppressed` "
                + "say how many it stands for); read the full lines with get_log {since: seq-1}. "
                + "NOT delivered to player-legal sessions — a body perceives the world, not stderr"),
        new Line("AUDIT", new String[] {"audit"},
            "every world_edit/privileged call, success or failure, with compacted args. NOT delivered "
                + "to player-legal sessions — a body perceives the world, not the server's ledger"),
        new Line("SOCIAL", new String[] {"chat", "session_msg"},
            "the player talking to you (delivered only to the bound chat responder; asking for "
                + "type=chat elsewhere fails fast rather than starving) / another session messaging "
                + "you via session_send — reply with session_send to data.from"),
        // The review layer's live channel. The file under <server dir>/review is how the NEXT
        // session learns a verdict; these are how a session that is still running learns it, which
        // is the difference between an inbox and a conversation — post an ask, watch for the
        // answer, fix the thing, stage it again while the person is still standing there.
        new Line("SOCIAL", new String[] {"review_posted", "review_answered"},
            "a human-review ask was queued / a human answered one {id, source, verdict: "
                + "ok|no|note|checked, comment, by, staged}. `checked` means the ask's own predicate "
                + "closed it and NOBODY LOOKED. Read the whole queue with review_status"));

    private static final Set<String> KNOWN = buildKnown();

    private static Set<String> buildKnown() {
        Set<String> out = new LinkedHashSet<>();
        for (Line l : LINES) {
            java.util.Collections.addAll(out, l.names());
        }
        return java.util.Collections.unmodifiableSet(out);
    }

    /** Every registered type. Exposed so tests can assert the emitters and this list agree. */
    public static Set<String> known() {
        return KNOWN;
    }

    public static boolean isKnown(final String type) {
        return KNOWN.contains(type);
    }

    /**
     * Urgency of ONE event — the type-level rule ({@link #URGENT}: the body is losing, or has lost,
     * integrity), plus the per-instance opt-in for the {@link #INSTANCE_URGENT} types.
     * {@link EventLog} calls this once at emit and stores the verdict, because an evicted event
     * keeps only its identity: re-deriving urgency later from a {@code data} that is gone would
     * silently under-count {@code missed_urgent}.
     *
     * <p>Deliberately the ONLY way to ask. A type-only overload existed briefly and was removed:
     * a second entry point that ignores {@code data} answers "not urgent" for exactly the events
     * whose urgency was declared, which is a danger preview that quietly drops danger.
     */
    public static boolean isUrgent(final String type, final @Nullable JsonObject data) {
        if (URGENT.contains(type)) {
            return true;
        }
        return INSTANCE_URGENT.contains(type) && data != null && data.has("urgent")
            && data.get("urgent").isJsonPrimitive() && data.get("urgent").getAsBoolean();
    }

    /**
     * A one-line headline for the {@code urgent} preview — enough to decide whether to abandon what
     * you are doing, without paging the whole backlog to find out. Never throws on odd data: a
     * preview that can fail is worse than a vague one.
     */
    public static String summarize(final String type, final @Nullable JsonObject data) {
        try {
            JsonObject d = data == null ? new JsonObject() : data;
            return switch (type) {
                case "body_endangered" -> "DANGER " + str(d, "cause")
                    + (d.has("seconds_left") ? " (" + str(d, "seconds_left") + "s left)" : "");
                // A blocked blow reaches this preview too, and it must not read as "hurt by": the
                // body lost nothing and the news is that something is ATTACKING it.
                case "body_damaged" -> d.has("blocked")
                    ? "BLOCKED " + str(d, "cause") + " — the shield took "
                        + str(d, "blocked_damage")
                        + (d.has("damage") && !"0".equals(str(d, "damage"))
                            ? "; " + str(d, "damage") + " got through" : ", no damage taken")
                    : "hurt by " + str(d, "cause")
                        + (d.has("health") ? " — health " + str(d, "health") : "");
                case "shield_disabled" -> "GUARD BROKEN — your shield was knocked aside by "
                    + str(d, "cause") + " and cannot be raised until its cooldown clears";
                case "totem_used" -> "TOTEM SPENT — you should have died to " + str(d, "cause")
                    + "; at 1 health with no totem in hand";
                case "body_died" -> "DIED: " + str(d, "cause")
                    + (d.has("hazards") ? " while " + d.get("hazards") : "");
                case "body_removed" -> "body gone: " + str(d, "reason");
                case "drone_damaged" -> "drone hurt — health " + str(d, "health");
                case "drone_removed" -> "drone gone: " + str(d, "reason");
                case "block_sighted" -> "SIGHTED " + str(d, "block")
                    + (d.has("distance") ? " " + str(d, "distance") + " blocks away" : "")
                    + (d.has("pos") && d.get("pos").isJsonObject() ? " at " + d.get("pos") : "");
                case "reaction_suspended" -> "REFLEX OFF: " + str(d, "id") + " keeps failing ("
                    + str(d, "reason") + ") — that protection is not covering you";
                // Only reaches the preview when the emitter marked it urgent, i.e. the hazard is
                // still on the body. Name the hazard: "cannot save you" is the decision, and the
                // cause is what the agent has to act on.
                case "reaction_repeating" -> "REFLEX CANNOT SAVE YOU: " + str(d, "id") + " has failed "
                    + str(d, "count") + "x (" + str(d, "reason") + ")"
                    + (d.has("hazards") ? " while " + d.get("hazards") : "")
                    + " — it is still trying and still not working; move yourself NOW";
                case "nav_starved" -> "NOT TRAVELING: reflex " + str(d, "by")
                    + " keeps preempting your navigation (" + str(d, "preemptions")
                    + "x) — deal with its trigger or disarm it";
                case "spawned_in_danger" -> "SPAWNED IN A KILL ZONE — nearest hostile "
                    + str(d, "hostile_distance") + " blocks; arm reflexes and move NOW";
                // READ THE KEY THE EMITTER ACTUALLY WRITES. This asked for `name`; the threat object
                // carries {id, type, distance, …} and never a name, so the single event type most
                // worth summarizing rendered as "nearest threat is now ?" in EVERY session since the
                // lane was built. The information was one key over the whole time — which is why the
                // probe that ships with this fix bans "?" from the urgent lane generically rather
                // than asserting this one string.
                case "nearest_threat_changed" -> d.has("cleared")
                    ? "no threat nearest anymore"
                    : "nearest threat is now " + threatPhrase(d);
                default -> type;
            };
        } catch (RuntimeException e) {
            return type;
        }
    }

    private static String str(final JsonObject o, final String key) {
        return o.has(key) && o.get(key).isJsonPrimitive() ? o.get(key).getAsString() : "?";
    }

    /**
     * "skeleton, 11 blocks, behind" — species, range, and which way to turn. A threat headline that
     * cannot say what or where is not a headline; the whole point of the urgent lane is deciding
     * whether to abandon what you are doing without paging the backlog.
     */
    private static String threatPhrase(final JsonObject d) {
        if (!d.has("threat") || !d.get("threat").isJsonObject()) {
            return "a hostile";
        }
        JsonObject t = d.getAsJsonObject("threat");
        String kind = t.has("type") && t.get("type").isJsonPrimitive()
            ? t.get("type").getAsString() : (t.has("name") && t.get("name").isJsonPrimitive()
                ? t.get("name").getAsString() : "a hostile");
        int cut = kind.indexOf(':');
        if (cut >= 0) {
            kind = kind.substring(cut + 1); // minecraft:skeleton -> skeleton
        }
        StringBuilder sb = new StringBuilder(kind);
        if (t.has("distance") && t.get("distance").isJsonPrimitive()) {
            sb.append(", ").append(Math.round(t.get("distance").getAsDouble())).append(" blocks");
        }
        if (t.has("bearing") && t.get("bearing").isJsonPrimitive()) {
            sb.append(", ").append(t.get("bearing").getAsString());
        }
        return sb.toString();
    }

    /**
     * The vocabulary as the {@code get_events} description renders it — grouped, one line per
     * related set. Built at registration time, so adding a type here documents it everywhere at
     * once. Kept terse on purpose: this text is part of the static tool prefix, which is re-read
     * every turn and measures 50-92% of the token bill (TOKEN_PER_TOOL_FINDINGS.md Finding 1).
     */
    public static String toolDoc() {
        StringBuilder sb = new StringBuilder();
        String group = null;
        List<String> parts = new ArrayList<>();
        for (Line l : LINES) {
            if (!l.group().equals(group)) {
                flush(sb, group, parts);
                group = l.group();
            }
            parts.add(String.join("/", l.names()) + ": " + l.doc());
        }
        flush(sb, group, parts);
        return sb.toString();
    }

    private static void flush(final StringBuilder sb, final @Nullable String group,
                              final List<String> parts) {
        if (group == null || parts.isEmpty()) {
            return;
        }
        if (sb.length() > 0) {
            sb.append(" ");
        }
        sb.append(group.toUpperCase(Locale.ROOT)).append(" — ").append(String.join("; ", parts))
            .append(".");
        parts.clear();
    }
}
