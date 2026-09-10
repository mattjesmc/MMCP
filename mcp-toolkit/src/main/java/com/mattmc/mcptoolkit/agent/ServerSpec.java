package com.mattmc.mcptoolkit.agent;

import org.jspecify.annotations.Nullable;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Everything a client needs in order to register the toolkit's MCP server for one workspace: the
 * directory the config belongs in, the name the server should carry, the process to run, and the
 * environment that process needs.
 *
 * <p>This is deliberately not a file. Claude Code writes {@code .mcp.json}; another host writes
 * something else in another place, or registers over an API and writes nothing at all. What is
 * common is the four facts below, and the two that are easy to get wrong are both here rather than
 * left to the adapter: {@code MCPTK_URL} names the port <b>this instance actually bound</b>, and
 * {@code MCPTK_PROFILE}, when a profile is named at all, is baked in so a hand-typed launch in that
 * directory runs under the same surface.
 *
 * <p><b>The name is the tool prefix.</b> {@link McpServersFile#CANONICAL} is what a session sees in
 * front of every tool it calls ({@code mcp__mcptoolkit__bot_scan}), which is why it is one constant
 * and not a string typed here.
 */
public record ServerSpec(String name,
                         Path workspace,
                         String command,
                         List<String> args,
                         Map<String, String> env,
                         String bridgeUrl,
                         @Nullable String profile) {

    public ServerSpec {
        args = List.copyOf(args);
        env = Map.copyOf(env);
    }

    /**
     * The standard registration for a workspace: {@code node <serverIndex>} with the bridge URL, the
     * memory directory and — when one is named — the profile.
     */
    public static ServerSpec forWorkspace(final Path workspace,
                                          final Path serverIndex,
                                          final Path memoryDir,
                                          final String bridgeUrl,
                                          final @Nullable String profile,
                                          final Map<String, String> extraEnv) {
        Map<String, String> env = new LinkedHashMap<>();
        env.put("MCPTK_URL", bridgeUrl);
        env.put("MCPTK_MEMORY_DIR", fs(memoryDir));
        if (profile != null && !profile.isBlank()) {
            env.put("MCPTK_PROFILE", profile);
        }
        env.putAll(extraEnv);
        return new ServerSpec(McpServersFile.CANONICAL, workspace, "node", List.of(fs(serverIndex)),
            env, bridgeUrl, profile);
    }

    /** Absolute path with forward slashes — valid inside JSON without escaping; Node accepts it. */
    public static String fs(final Path p) {
        return p.toAbsolutePath().toString().replace('\\', '/');
    }
}
