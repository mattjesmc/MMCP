package com.mattmc.mcptoolkit.nav;

import com.google.gson.JsonObject;
import net.minecraft.world.level.pathfinder.PathType;

/**
 * What a body is allowed to do <em>in order to get somewhere</em> — the mobility half of a session's
 * profile (BOT_SURFACE_DESIGN.md §1.2). Vanilla already models this concept: {@link NodeEvaluator}
 * carries {@code canPassDoors}/{@code canOpenDoors}/{@code canFloat}/{@code canWalkOverFences} as
 * per-body capability flags, hardcoded per mob type. This extends that idea with the two capabilities
 * vanilla has no notion of — <b>breaking</b> a blocking block and <b>placing</b> one to bridge a gap —
 * and carries the budgets that bound them.
 *
 * <p><b>Why it is a profile and not a per-call flag.</b> The same profile drives the throwaway probe in
 * {@code check_path} and the real body at execution, so prediction and execution run the same solver
 * with the same rights. A {@code check_path} that assumed bridging while the body could not bridge
 * (or the reverse) is the exact class of disagreement the truthful-reporting doctrine exists to
 * prevent.
 *
 * <p><b>Default is {@link #VANILLA}</b> — no doors opened, nothing broken, nothing placed. Modifying
 * the world as a side effect of navigating is opt-in ({@code may_modify}) and disclosed in the
 * ledger, because "go to the village" silently tunnelling through someone's wall is a false success.
 */
public final class NavProfile {

    /**
     * Maximum landing DISTANCE of a running jump, in blocks from the take-off cell. Vanilla mob
     * pathfinding only steps 1-wide gaps; a player sprint-jump reliably clears a 4-block gap (four
     * empty cells, landing on the fifth) — i.e. a landing distance of 5. Modelled as a cheap movement
     * edge (no blocks spent), so A* leaps a gap it could leap instead of bridging it; the bridge is
     * only for gaps too wide to clear. A distance of 5 covers the "3-4 block gap" a sprint-jump makes.
     */
    static final int SPRINT_JUMP_GAP = 5;

    /**
     * Path like a vanilla LAND mob: no door opening, no breaking, no bridging, and <b>no swimming</b> —
     * BUT sprint-jumps are free. Kept non-swimming deliberately: it is the A/B reference the bench's
     * pinned arms solve against, and swimming changes which routes exist near water. Live bodies use
     * {@link #DEFAULT}.
     */
    public static final NavProfile VANILLA = new NavProfile(false, false, false, 0, 0, false);

    /**
     * What a real body gets: {@link #VANILLA}'s rights plus <b>swimming</b> (§12.4). Water is a medium
     * this body moves through, not a wall to route around — which is also what stops the driver's
     * edge-care freezing it at a shoreline, since a swimmable column is footing of a different kind.
     */
    public static final NavProfile DEFAULT = new NavProfile(false, false, false, 0, 0, true);

    /** Default budgets when a caller opts in without naming one. */
    private static final int DEFAULT_BREAK_BUDGET = 16;
    private static final int DEFAULT_PLACE_BUDGET = 16;
    /** Hard ceiling — a build-assisted path is a local repair, never an excavation project. */
    private static final int MAX_BUDGET = 256;

    private final boolean canOpenDoors;
    private final boolean canBreak;
    private final boolean canPlace;
    private final int breakBudget;
    private final int placeBudget;
    private final boolean canSwim;

    private NavProfile(final boolean canOpenDoors, final boolean canBreak, final boolean canPlace,
                       final int breakBudget, final int placeBudget, final boolean canSwim) {
        this.canOpenDoors = canOpenDoors;
        this.canBreak = canBreak;
        this.canPlace = canPlace;
        this.breakBudget = breakBudget;
        this.placeBudget = placeBudget;
        this.canSwim = canSwim;
    }

    public boolean canOpenDoors() {
        return canOpenDoors;
    }

    public boolean canBreak() {
        return canBreak;
    }

    public boolean canPlace() {
        return canPlace;
    }

    public int breakBudget() {
        return breakBudget;
    }

    public int placeBudget() {
        return placeBudget;
    }

    /**
     * May this body swim — i.e. is water a medium it moves through rather than an obstacle to route
     * around? Like {@link #canSprintJump} this is a MOVEMENT capability, not a build one, so it spends
     * no budget. It switches on three things at once, because they are one fact: the search accepts
     * {@code WATER} cells as traversable (vanilla's amphibious branch), it gains vertical edges so a
     * body can dive and ascend, and the driver gets a swim input frame instead of walk inputs.
     */
    public boolean canSwim() {
        return canSwim;
    }

    /** True when this profile may modify the world at all — i.e. the path can be build-assisted. */
    public boolean modifiesWorld() {
        return canBreak || canPlace;
    }

    /**
     * This profile stripped of its build rights: movement rights (doors, swim, sprint-jumps) kept,
     * break/place off, budgets zeroed. The profile every path-FOLLOWER must solve under —
     * {@code WalkerNavigation}'s invariant, stated there since §11.6: a path a body is about to
     * WALK must never assume un-performed repairs, because nothing mines or bridges during
     * path-following; build-assisted solving belongs to the goal loop, which performs each step
     * itself. The player body violated this when {@code startNav} began parsing the full profile
     * (done for the swim right) and handed {@code may_modify} to {@code PlayerNavigation}'s solve:
     * the follower then marched into planned-but-unbroken stone until the node timeout, 101 ticks
     * per leg, 25 legs on the 2026-08-02 live wedge.
     */
    public NavProfile withoutBuildRights() {
        if (!modifiesWorld()) {
            return this;
        }
        return new NavProfile(canOpenDoors, false, false, 0, 0, canSwim);
    }

    /**
     * This profile with the swim right off, everything else kept. The ATTACK goal's default
     * (w1_42257 R8): a deliberate exception to the surface-wide swim-on philosophy above — for
     * travel, refusing water is the surprising case; for a FIGHT, wading in after the target is
     * (the chicken chase crossed a pond chest-deep and spent the drown net as a routine tool). A
     * hunt whose caller explicitly passes {@code swim:true} keeps the right.
     */
    public NavProfile withoutSwim() {
        if (!canSwim) {
            return this;
        }
        return new NavProfile(canOpenDoors, canBreak, canPlace, breakBudget, placeBudget, false);
    }

    /**
     * The {@code bot_tunnel} profile: break rights with a budget sized to the corridor, doors open,
     * swimming off. Swimming is off ON PURPOSE — a tunnel that hits water stops and says so
     * ({@code fluid_ahead}); a body that instead swims onward has abandoned the corridor it was
     * asked to dig, without ever reporting that it did.
     */
    public static NavProfile tunnel(final int breakBudget) {
        return new NavProfile(true, true, false, Math.min(MAX_BUDGET, breakBudget), 0, false);
    }

    /**
     * May this body cross a gap with a running jump? True for every profile — a sprint-jump spends no
     * blocks and is a movement capability, not a build one, so even the VANILLA profile leaps gaps a
     * vanilla mob's own evaluator would refuse. (A flag rather than a constant so a future
     * human-realism profile can switch it off.)
     */
    public boolean canSprintJump() {
        return true;
    }

    /** Widest gap this body will jump rather than bridge (blocks of clear span). */
    public int maxJumpGap() {
        return SPRINT_JUMP_GAP;
    }

    /**
     * Read a profile from a tool call's {@code may_modify} (none|break|place|both), optional
     * {@code open_doors}, and optional {@code budget} {break, place}. Absent = {@link #VANILLA}.
     *
     * <p>{@code open_doors} defaults to <b>false</b> deliberately: an absent profile must leave an
     * existing caller's behavior byte-identical, and door rights change which paths exist.
     */
    public static NavProfile fromJson(final JsonObject a) {
        return fromJson(a, false);
    }

    /** As {@link #fromJson(JsonObject)}, for tools that want doors on unless told otherwise. */
    public static NavProfile fromJson(final JsonObject a, final boolean defaultOpenDoors) {
        if (a == null) {
            return defaultOpenDoors ? of(true, false, false) : DEFAULT;
        }
        String mode = a.has("may_modify") && !a.get("may_modify").isJsonNull()
            ? a.get("may_modify").getAsString() : "none";
        boolean brk;
        boolean place;
        switch (mode) {
            case "none" -> { brk = false; place = false; }
            case "break" -> { brk = true; place = false; }
            case "place" -> { brk = false; place = true; }
            case "both" -> { brk = true; place = true; }
            default -> throw new IllegalArgumentException(
                "`may_modify` must be none | break | place | both (got '" + mode + "')");
        }
        boolean doors = a.has("open_doors") && !a.get("open_doors").isJsonNull()
            ? a.get("open_doors").getAsBoolean() : defaultOpenDoors;
        JsonObject budget = a.has("budget") && a.get("budget").isJsonObject()
            ? a.getAsJsonObject("budget") : null;
        int breakBudget = brk ? budgetArg(budget, "break", DEFAULT_BREAK_BUDGET) : 0;
        int placeBudget = place ? budgetArg(budget, "place", DEFAULT_PLACE_BUDGET) : 0;
        // Swimming is ON unless the caller opts out — a body that refuses to enter water is the
        // surprising case, not the default one, and `swim:false` is how you ask for the land-only
        // route (or reproduce a VANILLA-profile baseline).
        boolean swim = !a.has("swim") || a.get("swim").isJsonNull() || a.get("swim").getAsBoolean();
        return new NavProfile(doors, brk, place, breakBudget, placeBudget, swim);
    }

    private static int budgetArg(final JsonObject budget, final String key, final int fallback) {
        if (budget == null || !budget.has(key) || budget.get(key).isJsonNull()) {
            return fallback;
        }
        int v = budget.get(key).getAsInt();
        if (v < 0) {
            throw new IllegalArgumentException("`budget." + key + "` must be >= 0");
        }
        return Math.min(v, MAX_BUDGET);
    }

    /** Explicit constructor for callers that aren't parsing JSON (probes, internal goals). */
    public static NavProfile of(final boolean openDoors, final boolean canBreak, final boolean canPlace) {
        return of(openDoors, canBreak, canPlace, true);
    }

    /** As {@link #of(boolean, boolean, boolean)}, naming the swim right explicitly. */
    public static NavProfile of(final boolean openDoors, final boolean canBreak, final boolean canPlace,
                                final boolean canSwim) {
        return new NavProfile(openDoors, canBreak, canPlace,
            canBreak ? DEFAULT_BREAK_BUDGET : 0, canPlace ? DEFAULT_PLACE_BUDGET : 0, canSwim);
    }

    /**
     * Apply the flags to the evaluator. Door opening is a <em>malus</em> change, not an algorithm:
     * {@link PathType#DOOR_WOOD_CLOSED} is impassable only because its malus is -1, and the malus now
     * lives on the {@link NavPhysique} (body-owned table, §11.6 decision 3 — the old
     * {@code applyTo(Mob)} that mutated the real mob's persistent malus map is gone; see
     * {@link MobPhysique#pathfindingMalus}). Iron doors are deliberately left impassable — they need
     * a button or lever the body may not be able to find, so they are reported rather than silently
     * attempted.
     */
    public void applyTo(final NodeEvaluator evaluator) {
        evaluator.setCanOpenDoors(canOpenDoors);
        evaluator.setCanPassDoors(true);
        // The swim right IS vanilla's float flag, and wiring it here fixes two things at once
        // (§12.4): WalkNodeEvaluator.getStart stops dragging a floating body's start node down to
        // the seabed, and findAcceptedNode stops routing water via tryFindFirstNonWaterBelow —
        // which is to say it stops planning a drowning walk along the bottom.
        evaluator.setCanFloat(canSwim);
    }

    /**
     * Write these rights into an ARGS object in the exact shape {@link #fromJson} reads back.
     *
     * <p>For the internal callers that synthesize a {@code bot_goto} argument object rather than
     * receiving one — the goal loop walks to its planned work this way. Without it those synthesized
     * calls re-parsed to the DEFAULT profile, so a goal issued with {@code swim:false} planned its
     * legs with the swim right anyway. {@link #describe} is the human/verdict form and is NOT
     * round-trippable (it flattens the budgets); this one is.
     */
    public void writeArgs(final JsonObject a) {
        a.addProperty("may_modify", canBreak && canPlace ? "both"
            : canBreak ? "break" : canPlace ? "place" : "none");
        a.addProperty("open_doors", canOpenDoors);
        a.addProperty("swim", canSwim);
        JsonObject budget = new JsonObject();
        budget.addProperty("break", breakBudget);
        budget.addProperty("place", placeBudget);
        a.add("budget", budget);
    }

    /** Wire form, echoed back in verdicts so the caller can see which rights the solver ran with. */
    public JsonObject describe() {
        JsonObject o = new JsonObject();
        o.addProperty("may_modify", canBreak && canPlace ? "both"
            : canBreak ? "break" : canPlace ? "place" : "none");
        o.addProperty("open_doors", canOpenDoors);
        o.addProperty("swim", canSwim);
        if (canBreak) {
            o.addProperty("break_budget", breakBudget);
        }
        if (canPlace) {
            o.addProperty("place_budget", placeBudget);
        }
        return o;
    }
}
