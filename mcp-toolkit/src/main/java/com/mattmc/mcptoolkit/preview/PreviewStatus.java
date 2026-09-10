package com.mattmc.mcptoolkit.preview;

import org.jspecify.annotations.Nullable;

import java.util.Set;

/**
 * The one thing the SERVER is allowed to know about geometry: whether the client could parse it.
 *
 * <p>{@code stage_entity} runs on the server and the interchange JSON is read on the client
 * (ENTITY_AUTHORING_DESIGN.md §4.3), so a headless author would otherwise learn about broken
 * geometry only by taking a screenshot and noticing a magenta cube. The client installs a probe here
 * at startup; the tool asks it and echoes the answer. Same shape as
 * {@code BridgeServer.setClientEnvelopeStamper}: a client-only implementation reached through a
 * client-free holder, so this class stays loadable on a dedicated server where no probe is ever
 * installed and every answer is {@link #NO_CLIENT}.
 *
 * <p>The probe is called from the SERVER thread. Its implementation reads the client resource
 * manager and bakes model parts — neither touches GL and both are the sort of work vanilla itself
 * does off-thread during a resource reload — but that is a property of {@code PreviewModels}, and
 * the reason it is documented in both places.
 */
public final class PreviewStatus {
    private PreviewStatus() {}

    /** No client in this JVM (dedicated server): geometry is somebody else's to parse. */
    public static final String NO_CLIENT = "no_client";
    /** The client parsed the model and is wearing it. */
    public static final String OK = "ok";
    /** The client could not parse it and is wearing the error model. */
    public static final String ERROR = "error";

    /** Resolves a model id to its parse error, and to the clips it carries. */
    public interface Probe {
        @Nullable String errorFor(String modelId);

        /** The clip names in that model — empty for format-1 geometry, and for a failed load. */
        Set<String> clipsOf(String modelId);
    }

    private static volatile @Nullable Probe probe;

    public static void install(final Probe p) {
        probe = p;
    }

    public static boolean available() {
        return probe != null;
    }

    /** {@link #NO_CLIENT}, {@link #OK}, or {@link #ERROR}. */
    public static String statusOf(final String modelId) {
        Probe p = probe;
        if (p == null) {
            return NO_CLIENT;
        }
        return p.errorFor(modelId) == null ? OK : ERROR;
    }

    /** The parse error for a model id, or null when there is none (or no client to ask). */
    public static @Nullable String errorFor(final String modelId) {
        Probe p = probe;
        return p == null ? null : p.errorFor(modelId);
    }

    /**
     * The clips a model id carries, empty when there is no client to ask. An author staging a clip
     * has to get its NAME right, and the server cannot read the file that holds them — so without
     * this the only way to learn a clip name from the bridge is to guess one and read the error.
     */
    public static Set<String> clipsOf(final String modelId) {
        Probe p = probe;
        return p == null ? Set.of() : p.clipsOf(modelId);
    }
}
