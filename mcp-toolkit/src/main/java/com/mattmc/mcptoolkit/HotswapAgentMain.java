package com.mattmc.mcptoolkit;

import java.lang.instrument.Instrumentation;

/**
 * Entry point of the tiny java agent {@link HotswapTools} assembles at runtime and self-attaches to
 * obtain an {@link Instrumentation}. The attach mechanism loads this class in the SYSTEM classloader —
 * a separate copy from the toolkit's Knot-loaded one — so it must not touch any other toolkit class.
 * The two copies meet through {@link System#getProperties()}, which is a {@code Hashtable<Object,Object>}
 * and can carry the Instrumentation object across classloaders ({@code Instrumentation} itself is
 * bootstrap-loaded, hence the same type on both sides).
 */
public final class HotswapAgentMain {
    /** Key under which the Instrumentation is parked in {@link System#getProperties()}. */
    public static final String PROPERTY_KEY = "mcptoolkit.instrumentation";

    private HotswapAgentMain() {}

    public static void agentmain(String args, Instrumentation inst) {
        System.getProperties().put(PROPERTY_KEY, inst);
    }
}
