package com.mattmc.mcptoolkit;

import com.mattmc.mcptoolkit.platform.Platform;

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
public record BridgeConfig(boolean enabled, int port) {

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

    public static BridgeConfig load() {
        boolean dev = Platform.isDevelopment();
        int defaultPort = dev ? DEV_DEFAULT_PORT : PRODUCTION_DEFAULT_PORT;
        Path file = Platform.configFile();
        if (!Files.exists(file)) {
            // No write here. The file is written from init(), which is the only place that knows the
            // EFFECTIVE port; writing it here would have to guess, and in dev would guess wrong for
            // every project that declares a port of its own.
            return new BridgeConfig(true, defaultPort);
        }
        Properties props = new Properties();
        try (InputStream in = Files.newInputStream(file)) {
            props.load(in);
        } catch (IOException e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] could not read {} ({}); using defaults", file, e.toString());
            return new BridgeConfig(true, defaultPort);
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
        return new BridgeConfig(enabled, port);
    }
}
