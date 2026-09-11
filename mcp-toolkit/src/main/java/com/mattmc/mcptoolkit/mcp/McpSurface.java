package com.mattmc.mcptoolkit.mcp;

import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.ToolDef;
import org.jspecify.annotations.Nullable;

import java.util.Set;

/**
 * A named slice of the tool registry, and the whole of what "a tool surface" means on this door.
 *
 * <p><b>The URL is the surface.</b> {@code /mcp} serves the configured default and {@code /mcp/<name>}
 * serves that one, which is the fact that makes an in-JVM MCP server worth having at all: the Node
 * shim's profile is a property of a PROCESS a session starts (its {@code MCPTK_PROFILE}), so a port
 * could never carry one — ARCHITECTURE.md says exactly this under "the consequence, when someone asks
 * for a port that carries a profile". A path can. Nothing here is negotiated, nothing is switchable
 * mid-session: the client dialled a URL and that URL is the answer to what it is holding.
 *
 * <p>Three ways to state membership, and they are tried in this order:
 *
 * <ul>
 *   <li>{@code mechanisms} — a COMPUTED surface: every tool whose {@link Mechanism} is in the set.
 *       This is the self-maintaining kind and the one to prefer. {@code observe} is built this way,
 *       so a read-only surface cannot go stale when a new read ships: the registry's own authority
 *       stamp decides, not a list somebody has to remember to edit.</li>
 *   <li>{@code keep} — an explicit allow-list. A name that is not in the live registry is simply
 *       never served, silently; a NEW tool stays hidden until somebody names it. That is the trade
 *       every keep-list takes (the shim's do too) and it is why only one built-in surface uses one.</li>
 *   <li>{@code hide} — subtracted last, from whatever the two above left.</li>
 * </ul>
 *
 * <p>An empty {@code keep} set and a null one are NOT the same thing: null means "no allow-list, take
 * everything", empty means "an allow-list naming nothing", which serves nothing. The config loader
 * keeps that distinction rather than folding it, so a file that writes {@code "keep": []} gets the
 * empty surface it literally asked for instead of quietly getting everything.
 */
public record McpSurface(
    String name,
    String description,
    @Nullable Set<String> keep,
    Set<String> hide,
    @Nullable Set<Mechanism> mechanisms,
    @Nullable String instructions
) {
    public McpSurface {
        keep = keep == null ? null : Set.copyOf(keep);
        hide = Set.copyOf(hide);
        mechanisms = mechanisms == null ? null : Set.copyOf(mechanisms);
    }

    /** Everything the registry holds. */
    public static McpSurface all(final String name, final String description) {
        return new McpSurface(name, description, null, Set.of(), null, null);
    }

    /** Whether this surface serves that tool. */
    public boolean serves(final ToolDef def) {
        if (hide.contains(def.name())) {
            return false;
        }
        if (mechanisms != null && !mechanisms.contains(def.mechanism())) {
            return false;
        }
        return keep == null || keep.contains(def.name());
    }

    /** The same surface with different instructions — how the config file's {@code instructions} lands. */
    public McpSurface withInstructions(final @Nullable String text) {
        return new McpSurface(name, description, keep, hide, mechanisms, text);
    }
}
