package com.mattmc.mcptoolkit.mcp;

import com.mattmc.mcptoolkit.ToolDef;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * What {@code /mmcp mcp} says, as text — with no Minecraft in it.
 *
 * <p>{@link McpCommands} is the four lines that colour these and hand them to a
 * {@code CommandSourceStack}; everything that could be WRONG is here. That split is not tidiness: the
 * counts below are the only check a keep-list ever gets (a typo in a declared surface shows up as a
 * number one short of what its author expected), and a check whose own correctness can only be
 * confirmed by a human reading chat during a live session is a check nobody runs twice.
 *
 * <p>The three states are all failure-shaped in different ways and each gets a sentence rather than
 * a blank: the door switched off, the bridge not bound (so there is no port to print, and the one it
 * ASKED for is the fact that explains why), and the working case.
 */
public final class McpReport {
    private McpReport() {}

    /** How a line should read. {@link McpCommands} maps these to colours; nothing else depends on them. */
    public enum Kind {
        /** The address. The one line a person is here for. */
        URL,
        /** How to give that address to a client. */
        HINT,
        /** A surface, and the number of tools it currently serves. */
        SURFACE,
        /** The surface {@code /mcp} alone serves — the same line, said louder. */
        SURFACE_DEFAULT,
        /** An aside: how many clients are on it. */
        NOTE,
        /** The door is off, and this is how it was turned off. */
        OFF,
        /** The door is on but there is nothing to connect to. */
        UNBOUND
    }

    public record Line(Kind kind, String text) {}

    /**
     * @param mcpEnabled    {@code BridgeServer.mcpEnabled()}
     * @param boundPort     the port actually bound, or {@code <= 0} if the bind never succeeded
     * @param requestedPort the port {@code init()} asked for — the fact that explains an unbound one
     * @param surfaces      the installed set
     * @param tools         the live registry, which is what makes the counts live
     * @param connections   how many MCP clients are connected right now
     */
    public static List<Line> lines(final boolean mcpEnabled, final int boundPort, final int requestedPort,
                                   final Surfaces surfaces, final Collection<ToolDef> tools,
                                   final int connections) {
        List<Line> out = new ArrayList<>();
        if (!mcpEnabled) {
            out.add(new Line(Kind.OFF, "this game's own MCP server is OFF (mcp.enabled=false in "
                + "config/mcptoolkit.properties, or -Dmcptoolkit.mcp=false)"));
            return out;
        }
        if (boundPort <= 0) {
            out.add(new Line(Kind.UNBOUND, "the bridge is NOT BOUND, so there is no MCP server to "
                + "connect to (asked for port " + requestedPort + ")"));
            return out;
        }
        String base = "http://127.0.0.1:" + boundPort + McpEndpoint.PATH;
        out.add(new Line(Kind.URL, base + "   (surface \"" + surfaces.defaultName() + "\")"));
        out.add(new Line(Kind.HINT, "add it to a client that speaks MCP over HTTP, e.g.  "
            + "claude mcp add --transport http mcptoolkit " + base));
        for (String name : surfaces.names()) {
            McpSurface surface = surfaces.resolve(name);
            if (surface == null) {
                continue;
            }
            int served = 0;
            for (ToolDef def : tools) {
                if (surface.serves(def)) {
                    served++;
                }
            }
            out.add(new Line(name.equals(surfaces.defaultName()) ? Kind.SURFACE_DEFAULT : Kind.SURFACE,
                McpEndpoint.PATH + "/" + name + "  " + served + " tool(s)  " + surface.description()));
        }
        out.add(new Line(Kind.NOTE, connections == 0
            ? "no client is connected to it right now"
            : connections + " client(s) connected"));
        return out;
    }
}
