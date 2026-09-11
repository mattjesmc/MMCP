package com.mattmc.mcptoolkit;

import com.mattmc.mcptoolkit.platform.Platform;
import org.jspecify.annotations.Nullable;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

/**
 * Bridge on/off + port config at {@code <gameDir>/config/mcptoolkit.properties}.
 *
 * <p>The commented default file is written once, if absent, in EVERY environment — see
 * {@link #ensureDefaultFile}. It used to be written only in production, on the reasoning that a
 * developer does not need a discoverable toggle. That was backwards: dev is the environment where
 * the port matters most (a workspace of five checkouts has five games wanting one number), the
 * file was the only lever a consumer had, and its name, its keys and its very existence were
 * invisible in exactly the place modders work. RELEASE_1 section B0, defect 1.
 *
 * <p>{@code -Dmcptoolkit.port} overrides the file and is handled by the caller, not here — which is
 * why the writer takes the EFFECTIVE port rather than reading it back out of this class. A dev game
 * launched on 25641 writes {@code port=25641}, so the file states what is true and a later hand-run
 * without the JVM arg lands on the same port instead of silently colliding on the default.
 */
public record BridgeConfig(boolean enabled, int port, boolean mcpEnabled, String mcpSurface) {

    public static final int PRODUCTION_DEFAULT_PORT = 25600;
    public static final int DEV_DEFAULT_PORT = 25599;

    private static final String DEFAULT_FILE = """
        # MCP Toolkit bridge — a localhost-only (127.0.0.1) HTTP endpoint that lets a local AI
        # assistant inspect and operate this game. enabled=false turns it off entirely.
        # The JVM arg -Dmcptoolkit.port overrides this file (a value <= 0 disables).
        #
        # ONE PORT PER PROJECT. An agent session's bridge URL is frozen for its whole life, so the
        # number below is what that session must dial — and if two games bind it, the second loses
        # the bind and the session that meant to drive it drives the FIRST one instead, against the
        # wrong world, without either end noticing. In a Gradle dev workspace, declare it once as
        # `mcmod.port` in the project's gradle.properties (the com.mattmc.mcmod convention plugin
        # turns it into -Dmcptoolkit.port) and set the matching MCPTK_URL in that repo's .mcp.json.
        # The value written here is the port this game actually used when the file was created.
        enabled=true
        port=@PORT@

        # There is no in-game launcher and no agent.client key: this game never starts an agent
        # of its own (0.143.0 archived that half). The direction that works is INBOUND — an agent
        # program you run registers this MCP server in its own host and dials the port above. Write
        # that registration from in game with `/mmcp server register <your project directory>`, or
        # by hand: node <gameDir>/mcptoolkit/mcp-server/index.mjs with MCPTK_URL set to this bridge.

        # THE OTHER DOOR: this game hosts an MCP server of its own, in the mod jar, at
        # http://127.0.0.1:<the port above>/mcp — no Node, nothing to install, nothing to spawn.
        # Point any MCP client that speaks Streamable HTTP straight at that URL. The trade is that
        # it exists only while the game does (the Node shim above is there whether or not the game
        # is) and that it serves the game's tools alone — no memory layer, no Blockbench.
        # `/mmcp mcp` in game prints the URL and what each surface serves.
        mcp.enabled=true

        # Which surface http://127.0.0.1:<port>/mcp serves. Built in: full (everything this game
        # registers), observe (reads only), modding (the modder's slice). Every surface is also
        # reachable by name at /mcp/<name>, so this only names the default. Declare your own in
        # config/mcptoolkit-surfaces.json.
        mcp.surface=full
        """;

    /**
     * Write the commented default config, with {@code effectivePort} filled in, if the file is not
     * already there. Called once from {@link BridgeServer#init()} after the port is resolved, so it
     * runs on the {@code -Dmcptoolkit.port} path too — the path every Gradle dev run takes, and the
     * one on which {@link #load()} is never consulted at all.
     *
     * <p>Never overwrites: the file is the user's once it exists, and this is documentation, not
     * state. Never called with a disabled bridge, so it cannot advertise {@code enabled=true} for a
     * bridge that is off.
     */
    public static void ensureDefaultFile(int effectivePort) {
        Path file = Platform.configFile();
        if (Files.exists(file)) {
            return;
        }
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, DEFAULT_FILE.replace("@PORT@", Integer.toString(effectivePort)));
        } catch (IOException e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] could not write default config {}: {}", file, e.toString());
        }
    }

    /**
     * The in-jar MCP server's gate, with both of its sources in one place: {@code -Dmcptoolkit.mcp}
     * wins over this file whenever it is set at all, and only the literal {@code false} closes the
     * door.
     *
     * <p>That asymmetry is the deliberate half. A misspelt value leaves the door OPEN, because the
     * failure a modder can diagnose is "the URL answers and I did not expect it to" — the other one
     * is a connection refused with a live game behind it and nothing anywhere saying why.
     *
     * <p>Lives here rather than at its one call site in {@code BridgeServer} so that it can be
     * asked as a question, with no JVM to set a property on and no game to boot.
     *
     * @param override the raw {@code mcptoolkit.mcp} system property, or null if it is not set
     */
    public boolean mcpEnabledWith(final @Nullable String override) {
        String value = override == null ? String.valueOf(mcpEnabled) : override;
        return !"false".equalsIgnoreCase(value.trim());
    }

    public static BridgeConfig load() {
        boolean dev = Platform.isDevelopment();
        int defaultPort = dev ? DEV_DEFAULT_PORT : PRODUCTION_DEFAULT_PORT;
        Path file = Platform.configFile();
        if (!Files.exists(file)) {
            // No write here. The file is written from init(), which is the only place that knows the
            // EFFECTIVE port; writing it here would have to guess, and in dev would guess wrong for
            // every project that declares a port of its own.
            return defaults(defaultPort);
        }
        Properties props = new Properties();
        try (InputStream in = Files.newInputStream(file)) {
            props.load(in);
        } catch (IOException e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] could not read {} ({}); using defaults", file, e.toString());
            return defaults(defaultPort);
        }
        boolean enabled = !"false".equalsIgnoreCase(props.getProperty("enabled", "true").trim());
        int port = defaultPort;
        String raw = props.getProperty("port");
        if (raw != null) {
            try {
                port = Integer.parseInt(raw.trim());
            } catch (NumberFormatException e) {
                McpToolkit.LOGGER.warn("[MCP Toolkit] invalid port '{}' in {}; using {}", raw, file, defaultPort);
            }
        }
        // The in-jar MCP server rides the same file and the same on-by-default rule as the bridge —
        // it is the same port and the same authority, reached by a different protocol. A file
        // written before 0.146.0 has neither key, and inherits both defaults.
        boolean mcp = !"false".equalsIgnoreCase(props.getProperty("mcp.enabled", "true").trim());
        String surface = props.getProperty("mcp.surface", DEFAULT_MCP_SURFACE).trim();
        if (surface.isEmpty()) {
            surface = DEFAULT_MCP_SURFACE;
        }
        return new BridgeConfig(enabled, port, mcp, surface);
    }

    /** The whole file's defaults, for when there is no file or it cannot be read. */
    private static BridgeConfig defaults(final int port) {
        return new BridgeConfig(true, port, true, DEFAULT_MCP_SURFACE);
    }

    /**
     * The surface {@code /mcp} serves when the file names none. Spelled here rather than referenced
     * from {@code mcp.Surfaces} so this class stays what it is — a properties reader with no opinion
     * about what a surface means — and {@code Surfaces} validates the name it is handed anyway.
     */
    private static final String DEFAULT_MCP_SURFACE = "full";
}
