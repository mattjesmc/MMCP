package com.mattmc.mcptoolkit;

/**
 * The authority class of a tool — <em>how</em> it affects (or doesn't affect) the game. Declared on every
 * {@link ToolDef} (required, no default: an untagged world-edit masquerading as a read is exactly the bug
 * this prevents) and stamped into the manifest and every dispatch result at the {@link BridgeServer}
 * chokepoint, so each response is legible about what kind of act it reports.
 *
 * <p>The distinction matters most between {@link #EMBODIED} and {@link #WORLD_EDIT}: "the drone mined this
 * block" and "the server rewrote this block" have different failure modes, permissions and consequences,
 * and must never be conflated (ARCHITECTURE.md, "Action: mechanisms, never conflated").
 */
public enum Mechanism {
    /** Reads only; no game-state mutation. Perception, inspection, status, registries. */
    OBSERVE("observe"),
    /**
     * A body or input surface performs a game-mediated act that can fail on the game's own terms
     * (out of reach, path blocked, widget missing): drone movement, UI clicks/typing.
     */
    EMBODIED("embodied"),
    /** Direct server edit of world state: instant, mass-effect, previewable/undoable where supported. */
    WORLD_EDIT("world_edit"),
    /** Authority beyond world blocks: commands, code redefinition, disk writes, resource/data reloads. */
    PRIVILEGED("privileged");

    private final String id;

    Mechanism(final String id) {
        this.id = id;
    }

    /** Wire name used in the manifest and dispatch envelopes. */
    public String id() {
        return id;
    }
}
