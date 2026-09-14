package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.mixin.MobAccessor;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.ai.goal.Goal;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.entity.BlockEntity;
import org.jspecify.annotations.Nullable;

import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * <b>The re-entry tier: the bytes are new, the objects are old.</b>
 * ({@code docs/platform/HOTSWAP_CEILING.md} §3 — "a swap lands and nothing changes".)
 *
 * <p>{@link java.lang.instrument.Instrumentation#redefineClasses} replaces bytecode. It does not
 * rebuild the object graph the old bytecode already produced, and it does not re-run a static
 * initialiser. So a swap can be completely successful and completely invisible: the screen is still
 * holding the widgets the old {@code init()} built, the mob is still running the goal list the old
 * {@code registerGoals()} made, the registry still holds the one {@code Block} built once at
 * registration. {@code redefined: 1} is true in every one of those cases, and reliably produces a
 * false belief — which is the defect this class exists to close.
 *
 * <p>It answers in two registers, and the split is deliberate:
 * <ul>
 *   <li><b>The account</b> (always, on every swap). Per class: what KIND of thing it is in this
 *       running game, what old state survives the swap, and what would make the code run again. It
 *       is computed from the LOADED class — its real supertypes, and where the game is cheap to ask,
 *       live evidence: the client is on that screen right now, three of those mobs are loaded.</li>
 *   <li><b>The act</b> ({@code reinit: true}). The re-entries that are genuinely reachable from here
 *       and not reachable by any other tool: rebuild the current screen's widgets, re-run a loaded
 *       mob's {@code registerGoals()}. Everything else is named as a route rather than faked.</li>
 * </ul>
 *
 * <p><b>Kinds are decided by real class references, never by name.</b> {@code Mob.class
 * .isAssignableFrom(cls)} is remapped with the rest of the jar, so it means the same thing in a dev
 * run and in a production install; a string compare against {@code "net.minecraft.world.entity.Mob"}
 * would silently answer PLAIN for every Minecraft supertype in production, and a wrong account is
 * worse than none. The one kind this file cannot decide is {@link Kind#SCREEN} — {@code Screen} is a
 * client class and this file is loaded on a dedicated server — so it is delegated to
 * {@link ClientReentry}, whose implementation lives in the client package and is absent by design
 * where there is no client.
 */
public final class Reentry {
    private Reentry() {}

    /** How long a re-entry act may hold the bridge's HTTP thread waiting on a game loop. */
    private static final long ACT_TIMEOUT_SECONDS = 5;

    /** The rule the whole block exists to state. Said once per swap, not once per class. */
    static final String RULE = "the bytes are new, the objects are old: a swap is visible only where "
        + "the code RUNS AGAIN. Static initialisers do not re-run and constructors do not re-run for "
        + "objects that already exist, so anything computed once - a cached table, a lambda handed to "
        + "a registry, a parsed config, a widget, a goal list - is still what the OLD code made.";

    /**
     * What a swapped class is, in the only terms that decide whether its swap is visible: who is
     * holding objects it already built.
     */
    public enum Kind {
        /** A {@code Screen}: its widgets were built by {@code init()} and are held until it re-inits. */
        SCREEN,
        /** A {@code Mob}: its goal lists were built once, by the constructor's {@code registerGoals()}. */
        MOB,
        /** Any other {@code Entity}: ticks run again, spawn-time state does not. */
        ENTITY,
        /** A {@code BlockEntity}: the object and its ticker both outlive the swap. */
        BLOCK_ENTITY,
        /** A {@code Block} or {@code Item}: ONE instance, built and baked at registration. */
        REGISTERED_SINGLETON,
        /** A {@code Goal}: the object is already inside a live selector. */
        GOAL,
        /** A mixin: the swap re-applied it, and everything below is about its TARGETS. */
        MIXIN,
        /** Everything else: bodies run again on the next call, and nothing else changes. */
        PLAIN
    }

    /** What survives the swap, per kind — the sentence that makes a silent swap legible. */
    static String holds(final Kind kind) {
        return switch (kind) {
            case SCREEN -> "a Screen's widgets are built once by init() and held in its children "
                + "list; a swap changes the code that builds them, not the ones already built";
            case MOB -> "a Mob's goal and target selectors are filled once, by registerGoals() from "
                + "the constructor, and every mob already in the world keeps the list the old code made";
            case ENTITY -> "the entity's tick body runs again by itself on the next tick, but what "
                + "its constructor and spawn did once is still the old code's work";
            case BLOCK_ENTITY -> "the block entity object survives the swap and its tick body runs "
                + "again, but the TICKER was resolved once when the chunk loaded, so a changed "
                + "getTicker keeps the old one";
            case REGISTERED_SINGLETON -> "a registry holds ONE instance of this, built at "
                + "registration: method bodies run again on the next use, but constructor-set "
                + "Properties, the baked state definition and attached components are what "
                + "registration made them";
            case GOAL -> "the goal OBJECT is already inside a live selector, so canUse/tick run again "
                + "on the next tick - but what its constructor captured is the old value";
            case MIXIN -> "the targets were retransformed, so their bodies are new from the next CALL "
                + "onward; objects those methods already built are untouched";
            case PLAIN -> "method bodies run again on the next call; the class's static initialiser "
                + "does not re-run, so anything it computed once is still the old value";
        };
    }

    /** What makes the code run again — an act this tool can do, or the route to one it cannot. */
    static String route(final Kind kind, final boolean actable) {
        return switch (kind) {
            case SCREEN -> actable
                ? "reinit:true rebuilds the current screen's widgets in place (it re-runs init(), "
                + "which is what a window resize does) - it works for a container screen too, which "
                + "close_screen + open_screen cannot reopen"
                : "the client is not on this screen, so there is nothing to rebuild; open it and it "
                + "will run the new init()";
            case MOB -> actable
                ? "reinit:true clears both selectors on the loaded instances and re-runs "
                + "registerGoals(). Goals added from OUTSIDE registerGoals() - by another mod, or by "
                + "the toolkit's own bodies - are cleared with them and do not come back"
                : "no instance of it is loaded, so the next one spawned already runs the new code";
            case ENTITY -> "respawn it to rebuild what spawn built (studio/stage_entity, or kill and "
                + "summon); ticking behaviour needs nothing";
            case BLOCK_ENTITY -> "re-place the block, or make its chunk reload, to rebuild the ticker";
            case REGISTERED_SINGLETON -> "registration runs once per JVM: restart for anything set in "
                + "the constructor. Behaviour methods (use, tick, getStateForPlacement) are live now";
            case GOAL -> "its tick and canUse are already the new code. If the change is in what "
                + "the CONSTRUCTOR captures, the live goal object still holds the old value: swap the "
                + "Mob class that builds this goal and re-enter THAT, which rebuilds its goals too";
            case MIXIN -> "call the patched method again - interact, re-open, re-enter the code path. "
                + "Objects the old injector already produced stay as they are";
            case PLAIN -> "call it again. If the change is in a static initialiser or in something "
                + "registered at startup, no call re-runs it and only a restart lands it";
        };
    }

    /**
     * The kind of a loaded class. Order matters: a {@code Mob} is an {@code Entity}, and the mixin
     * shell is asked about first because it is not really the class at all — it is Mixin's stand-in,
     * and everything true of the swap is true of the TARGETS instead.
     */
    static Kind kindOf(final Class<?> cls) {
        if (MixinHotswap.isAgentShell(cls)) {
            return Kind.MIXIN;
        }
        try {
            if (Mob.class.isAssignableFrom(cls)) {
                return Kind.MOB;
            }
            if (Entity.class.isAssignableFrom(cls)) {
                return Kind.ENTITY;
            }
            if (BlockEntity.class.isAssignableFrom(cls)) {
                return Kind.BLOCK_ENTITY;
            }
            if (Block.class.isAssignableFrom(cls) || Item.class.isAssignableFrom(cls)) {
                return Kind.REGISTERED_SINGLETON;
            }
            if (Goal.class.isAssignableFrom(cls)) {
                return Kind.GOAL;
            }
            ClientReentry client = clientReentry;
            if (client != null && client.isScreen(cls)) {
                return Kind.SCREEN;
            }
        } catch (LinkageError e) {
            // A class whose supertypes will not resolve is not a classification finding; PLAIN says
            // the one thing that is true of every class, and the swap is not taken down to say it.
            return Kind.PLAIN;
        }
        return Kind.PLAIN;
    }

    /**
     * The {@code reentry} block: one entry per swapped class, plus whatever {@code reinit} did.
     *
     * @param classes the PRIMARY loaded copy of each swapped class, by binary name and in call order
     * @param server  the running server, or null — live evidence is skipped rather than guessed
     * @param act     whether to perform the re-entries that are reachable ({@code reinit: true})
     */
    static JsonObject block(final Map<String, Class<?>> classes, final @Nullable MinecraftServer server,
                            final boolean act) {
        JsonObject out = new JsonObject();
        out.addProperty("rule", RULE);
        JsonArray arr = new JsonArray();
        int actedTotal = 0;
        boolean anyActable = false;
        for (var e : classes.entrySet()) {
            Kind kind = kindOf(e.getValue());
            JsonObject one = new JsonObject();
            one.addProperty("class", e.getKey());
            one.addProperty("kind", kind.name().toLowerCase(java.util.Locale.ROOT));
            // Live evidence FIRST, because it decides which route is the honest one: "reinit:true
            // rebuilds this screen" and "you are not on this screen" are different advice, and only
            // the running game can tell them apart.
            Live live = live(kind, e.getValue(), server);
            if (live.evidence != null) {
                one.addProperty("live", live.evidence);
            }
            one.addProperty("holds", holds(kind));
            one.addProperty("route", route(kind, live.actable));
            anyActable |= live.actable;
            if (act && live.actable) {
                String did = perform(kind, e.getValue(), server);
                one.addProperty("reentered", did);
                actedTotal++;
            } else if (act) {
                one.addProperty("reentered", false);
            }
            arr.add(one);
        }
        out.add("classes", arr);
        if (act && actedTotal == 0) {
            out.addProperty("reinit_note", anyActable
                ? "nothing was re-entered - the acts this tool can perform all failed; see each class"
                : "reinit had nothing to do: none of these classes has a live object this tool can "
                + "rebuild. The per-class route says what would make the new code run");
        }
        return out;
    }

    /** Live evidence about a swapped class, and whether {@code reinit} can act on it. */
    private record Live(@Nullable String evidence, boolean actable) {
        static final Live NONE = new Live(null, false);
    }

    private static Live live(final Kind kind, final Class<?> cls, final @Nullable MinecraftServer server) {
        switch (kind) {
            case SCREEN -> {
                ClientReentry client = clientReentry;
                if (client == null) {
                    return Live.NONE;
                }
                String current = client.currentScreenIs(cls);
                if (ClientReentry.UNKNOWN.equals(current)) {
                    return new Live("the render thread did not answer, so whether the client is on "
                        + "this screen is unknown", false);
                }
                return current == null
                    ? new Live("the client is NOT on this screen", false)
                    : new Live("the client is on this screen right now (" + current + ")", true);
            }
            case MOB, ENTITY -> {
                if (server == null) {
                    return Live.NONE;
                }
                Integer n = onServer(server, () -> countLoaded(server, cls), null);
                if (n == null) {
                    return Live.NONE;
                }
                return new Live(n + " loaded instance(s) in this world", kind == Kind.MOB && n > 0);
            }
            default -> {
                return Live.NONE;
            }
        }
    }

    /** Perform the act for one class and describe exactly what happened, in the reply. */
    private static String perform(final Kind kind, final Class<?> cls,
                                  final @Nullable MinecraftServer server) {
        try {
            return switch (kind) {
                case SCREEN -> {
                    ClientReentry client = clientReentry;
                    yield client == null ? "no client" : client.rebuildCurrentScreen();
                }
                case MOB -> server == null ? "no server" : reregisterGoals(server, cls);
                default -> "nothing to do";
            };
        } catch (RuntimeException | LinkageError e) {
            // A failed re-entry must not undo a landed swap: the bytes ARE new whatever happened
            // here, and the reply has to keep saying so.
            return "failed: " + e;
        }
    }

    /**
     * Clear both selectors and re-run {@code registerGoals()} on every loaded instance — the exact
     * re-entry for the most common live mob edit there is, and one no other tool in this toolkit can
     * perform. Runs on the server thread, because a goal selector is tick state.
     *
     * <p>It is honest about what it destroys: goals added from outside {@code registerGoals()} are
     * cleared along with the rest and are not put back. That is why it is opt-in per call rather than
     * something a swap does by itself.
     */
    private static String reregisterGoals(final MinecraftServer server, final Class<?> cls) {
        String done = onServer(server, () -> {
            int n = 0;
            for (ServerLevel level : server.getAllLevels()) {
                for (Entity entity : level.getAllEntities()) {
                    if (cls.isInstance(entity) && entity instanceof Mob mob) {
                        MobAccessor access = (MobAccessor) mob;
                        access.mcptoolkit$goalSelector().removeAllGoals(g -> true);
                        access.mcptoolkit$targetSelector().removeAllGoals(g -> true);
                        access.mcptoolkit$registerGoals();
                        n++;
                    }
                }
            }
            return "re-ran registerGoals() on " + n + " loaded instance(s), both selectors cleared first";
        }, null);
        return done == null
            ? "the server loop did not answer in " + ACT_TIMEOUT_SECONDS + "s, so NOTHING was re-entered"
            : done;
    }

    /** How many loaded entities are instances of this class. Server thread only. */
    private static int countLoaded(final MinecraftServer server, final Class<?> cls) {
        int n = 0;
        for (ServerLevel level : server.getAllLevels()) {
            for (Entity entity : level.getAllEntities()) {
                if (cls.isInstance(entity)) {
                    n++;
                }
            }
        }
        return n;
    }

    /**
     * Run a job on the server loop and wait for it, briefly, or answer {@code fallback}. The bridge
     * dispatches {@code hotswap_class} on its own HTTP thread ({@link ExecutionContext#ANY}), so this
     * blocks nothing the game needs; a server that is stopping simply never runs the job, which is
     * why there is a timeout and why a miss is a value rather than a thrown swap.
     */
    private static <T> T onServer(final MinecraftServer server,
                                  final java.util.function.Supplier<T> job, final T fallback) {
        try {
            return server.submit(job::get).get(ACT_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return fallback;
        } catch (Exception e) {
            return fallback;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // The client half, which this file may not name directly.
    // ---------------------------------------------------------------------------------------------

    /**
     * The two client questions the re-entry account needs, implemented in the client package and
     * installed by the client entrypoint. Absent on a dedicated server, where it is not that the
     * answer is unknown but that there is no screen to hold anything.
     */
    public interface ClientReentry {
        /** Whether this loaded class is a {@code Screen} subclass. */
        boolean isScreen(Class<?> cls);

        /**
         * The current screen's class name if it is an instance of {@code cls}, null if the client is
         * on some other screen, and {@link #UNKNOWN} if the render thread did not answer — which is
         * not the same fact and must not be reported as one.
         */
        @Nullable String currentScreenIs(Class<?> cls);

        /** The render thread did not answer; nothing is known either way. */
        String UNKNOWN = "?";

        /** Re-run the current screen's {@code init()}, and say what happened. */
        String rebuildCurrentScreen();
    }

    private static volatile @Nullable ClientReentry clientReentry;

    /** Called from the client entrypoint. */
    public static void setClient(final ClientReentry client) {
        clientReentry = client;
    }

    /** Test seam: install a stand-in (or null) for the client half. */
    static void setClientForTest(final @Nullable ClientReentry client) {
        clientReentry = client;
    }
}
