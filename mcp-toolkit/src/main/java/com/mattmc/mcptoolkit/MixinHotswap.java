package com.mattmc.mcptoolkit;

import java.lang.instrument.Instrumentation;

/**
 * The mixin tier of live code push: arming Mixin's OWN hot-swap agent with the {@link Instrumentation}
 * {@link HotswapTools} already self-attaches, so that redefining a mixin class re-applies it to its
 * targets instead of doing nothing.
 *
 * <p><b>Why this is not our code.</b> Mixin ships the whole mechanism — {@code
 * org.spongepowered.tools.agent.MixinAgent}, an {@code IHotSwap} — and the toolkit's job is only to
 * turn it on. The flow, read out of the shipped bytecode (see {@code docs/platform/HOTSWAP_CEILING.md}
 * section 1): {@code MixinTransformer}'s constructor reflectively instantiates the agent at startup
 * when {@code -Dmixin.hotSwap=true}; the agent registers every mixin class in its own
 * {@code MixinAgentClassLoader} as a bare <b>shell</b> (an empty class carrying the mixin's name) and
 * every target's ORIGINAL bytes beside it; when the shell is redefined, the agent's transformer reads
 * the submitted bytes as the new mixin, calls {@code IMixinTransformer.reload} to learn which targets
 * it affects, retransforms those targets against their original bytes, and then <b>returns the shell
 * bytecode</b> so that the redefinition actually installed on the shell is a no-op.
 *
 * <p>That last move is what makes this work on stock HotSpot: the JVM checks the bytes a transformer
 * RETURNS, so shell-to-shell adds no method and no field. The structural limit still applies where it
 * always did — to the target. Changing what an existing injector DOES keeps the target's shape and
 * lands; adding a new {@code @Inject} adds a handler method to the target and is rejected.
 *
 * <p><b>The flag cannot be set late.</b> {@code MixinTransformer} reads it once, when it is built,
 * which is before any mod class loads. A game started without it has no agent and no registered
 * shells, and no amount of attaching afterwards creates them — so {@link #arm} reports
 * {@link #NEEDS_RESTART} rather than pretending, and the reason a swap would be silent is named
 * before the swap instead of after it.
 *
 * <p>Everything here is reflective. Mixin is not a compile dependency of this file (NeoForge relocates
 * the package, and the toolkit is one jar for both loaders), so an absent or moved agent is a reported
 * state, never a link error.
 */
final class MixinHotswap {
    private MixinHotswap() {}

    /** Mixin's agent, which is also its {@code IHotSwap} implementation. */
    private static final String AGENT = "org.spongepowered.tools.agent.MixinAgent";
    /** The option {@code MixinEnvironment.Option.HOT_SWAP} reads, and the only way to set it. */
    private static final String FLAG = "mixin.hotSwap";

    /** The agent is live: redefining a mixin class re-applies it to its targets. */
    static final String ARMED = "armed";
    /** The game was started without {@code -Dmixin.hotSwap=true}; only a restart can change that. */
    static final String NEEDS_RESTART = "needs_restart";

    private static volatile String state;

    /**
     * Arm Mixin's agent with our instrumentation, once per JVM, and return the resulting state:
     * {@link #ARMED}, {@link #NEEDS_RESTART}, or {@code "unavailable: <reason>"} when the agent class
     * is not where it is expected (a relocated or older Mixin). Never throws — the mixin tier being
     * unavailable must not take the method-body tier down with it.
     */
    static synchronized String arm(final Instrumentation inst) {
        if (state != null) {
            return state;
        }
        if (!Boolean.parseBoolean(System.getProperty(FLAG))) {
            return state = NEEDS_RESTART;
        }
        try {
            Class<?> agent = Class.forName(AGENT, false, MixinHotswap.class.getClassLoader());
            agent.getMethod("init", Instrumentation.class).invoke(null, inst);
            return state = ARMED;
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            return state = "unavailable: " + e;
        }
    }

    /** The state {@link #arm} last reached, or null if no hotswap has attached an agent yet. */
    static String state() {
        return state;
    }

    /**
     * Why a mixin swap would not land, phrased as the fix, or null when the state is fine. The
     * message is the whole value of this class to a caller who is about to be disappointed.
     */
    static String why(final String state) {
        if (ARMED.equals(state)) {
            return null;
        }
        if (NEEDS_RESTART.equals(state)) {
            return "this game was started without -Dmixin.hotSwap=true, so Mixin built no hot-swap "
                + "agent and registered no mixin classes; the flag is read once at startup and cannot "
                + "be set now. Rebuild (tools/rebuild.ps1) to pick it up - it is on both loom runs "
                + "since 0.149.0.";
        }
        return "Mixin's hot-swap agent could not be armed (" + state + "), so a mixin swap would "
            + "redefine the mixin class and leave its targets untouched.";
    }

    /** True when a class was loaded by Mixin's agent classloader, i.e. it is a registered mixin shell. */
    static boolean isAgentShell(final Class<?> cls) {
        ClassLoader cl = cls.getClassLoader();
        return cl != null && cl.getClass().getName().startsWith(AGENT + "ClassLoader");
    }
}
