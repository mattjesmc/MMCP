package com.mattmc.mcptoolkit;

import com.mattmc.mcptoolkit.platform.Platform;
import org.jspecify.annotations.Nullable;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

/**
 * Extraction of the bundled Node MCP server into {@code <gameDir>/mcptoolkit/mcp-server} — shared by
 * every registration written into a workspace — and of the Blockbench plugins
 * into {@code <gameDir>/mcptoolkit/blockbench} beside it.
 *
 * <p><b>Why the plugins ride the shim's stamp</b> (TODO.md 1.10): the two are one release unit, and
 * a plugin one version out of step with the shim that drives it answers wrongly rather than
 * refusing. They are written inside the same {@code fresh} branch as the server, so there is no
 * second stamp to disagree with the first: if the shim under this game directory is version N, the
 * plugins beside it are version N. The objection to extracting them at all — that a per-save copy
 * is three copies of a file whose version must match — is answered by that and only by that.
 *
 * <p>Why spawns must call this too (found live, 2026-07-30): the extract used to refresh only when
 * the WORKBENCH button was pressed, so a companion or survival session launched into a workspace
 * whose {@code .mcp.json} pointed at a months-old server copy — silently missing every capability
 * the current build ships (the survival profile among them). A spawn that runs against the
 * workspace's own extract now refreshes it first, behind the same stamp: dev always re-extracts
 * (the version never bumps between edits), production re-extracts on version change.
 *
 * <p>No client imports — callable from common code. Progress/errors are returned as strings; the
 * bootstrap wraps them in toasts, spawns put them in the outcome line.
 */
public final class ServerExtract {
    private ServerExtract() {}

    /**
     * Ensure the extracted server under {@code gameDir} is current, running npm install when the
     * extraction was fresh or the SDK is missing. Returns null on success, else a short error line.
     */
    public static synchronized @Nullable String ensureFresh(final Path gameDir) {
        try {
            String version = Platform.modVersion(McpToolkit.MOD_ID).orElseThrow();
            boolean dev = Platform.isDevelopment();
            Path serverDir = gameDir.resolve("mcptoolkit").resolve("mcp-server");
            Path stamp = serverDir.resolve(".extracted-version");

            boolean fresh = dev || !Files.exists(stamp) || !version.equals(Files.readString(stamp).trim());
            // Read BEFORE the copy overwrites it, so "did the dependency manifest change" is answerable.
            byte[] pkgBefore = readIfExists(serverDir.resolve("package.json"));
            if (fresh) {
                Path root = Platform.findModResource(McpToolkit.MOD_ID, "mcp-server-dist").orElseThrow(
                    () -> new IllegalStateException("mcp-server-dist missing from mod resources"));
                try (Stream<Path> s = Files.walk(root)) {
                    for (Path p : (Iterable<Path>) s::iterator) {
                        if (Files.isDirectory(p)) {
                            continue;
                        }
                        // relativize().toString() is mandatory: a jar ZipFS Path cannot be resolved
                        // against a Windows filesystem path directly.
                        Path dest = serverDir.resolve(root.relativize(p).toString());
                        Files.createDirectories(dest.getParent());
                        Files.copy(p, dest, StandardCopyOption.REPLACE_EXISTING);
                    }
                }
                extractPlugins(gameDir, version);
                Files.writeString(stamp, version);
                McpToolkit.LOGGER.info("[MCP Toolkit] extracted MCP server {} into {}", version, serverDir);
            }

            // npm is gated on ACTUAL need, not on `fresh`. In dev `fresh` is always true (the version
            // never bumps between edits), so coupling npm to it would run a 180s-budget subprocess on
            // every single dev boot — which is precisely why this was never safe to call from server
            // startup. Copying 25 small files is milliseconds; installing is not. Reinstall only when
            // the SDK is genuinely absent or when the dependency manifest itself changed.
            boolean sdkMissing =
                !Files.isDirectory(serverDir.resolve("node_modules").resolve("@modelcontextprotocol"));
            boolean depsChanged = !java.util.Arrays.equals(pkgBefore, readIfExists(serverDir.resolve("package.json")));
            if (sdkMissing || depsChanged) {
                // Off Windows the extract is still useful - the server files are there and the bridge
                // serves - so say what is missing and how to finish by hand rather than throwing
                // "Cannot run program cmd" from inside the copy that just succeeded (RELEASE.md F4).
                if (!Platform.isWindows()) {
                    return "the MCP server was extracted to " + serverDir + " but its dependencies were not "
                        + "installed: the toolkit runs `npm install` through `cmd`, which is Windows-only in "
                        + "release 1. Run `npm install --omit=dev` in that directory yourself; the bridge is "
                        + "platform-neutral and serves either way.";
                }
                Path npmLog = gameDir.resolve("mcptoolkit").resolve("npm-install.log");
                Process npm = new ProcessBuilder("cmd", "/c", "npm", "install", "--omit=dev")
                    .directory(serverDir.toFile())
                    .redirectErrorStream(true)
                    .redirectOutput(npmLog.toFile())
                    .start();
                if (!npm.waitFor(180, TimeUnit.SECONDS) || npm.exitValue() != 0) {
                    npm.destroyForcibly();
                    return "npm install failed — see " + npmLog;
                }
            }
            return null;
        } catch (Exception e) {
            return "server extraction failed: " + e;
        }
    }

    /**
     * Write the bundled Blockbench plugins into {@code <gameDir>/mcptoolkit/blockbench}. Called from
     * inside the server extract's own {@code fresh} branch, which is what makes the shim's stamp
     * cover them too.
     *
     * <p>A jar without {@code blockbench-dist} is a build defect, not a user's problem, and it must
     * not take the shim's extraction down with it — a modder who never opens Blockbench would lose
     * every launch to it. So this logs what is missing and returns; the loud arbiter is
     * {@code BundledResourcesTest}, which fails the build instead.
     */
    private static void extractPlugins(final Path gameDir, final String version) {
        Path dir = gameDir.resolve("mcptoolkit").resolve("blockbench");
        try {
            Path root = Platform.findModResource(McpToolkit.MOD_ID, "blockbench-dist").orElse(null);
            if (root == null) {
                McpToolkit.LOGGER.warn("[MCP Toolkit] this jar carries no blockbench-dist - the Blockbench"
                    + " plugins were not written to {} (LIVE_MODDING.md names them)", dir);
                return;
            }
            int n = 0;
            try (Stream<Path> s = Files.walk(root)) {
                for (Path p : (Iterable<Path>) s::iterator) {
                    if (Files.isDirectory(p)) {
                        continue;
                    }
                    // Same ZipFS rule as above: relativize().toString(), never Path-against-Path.
                    Path dest = dir.resolve(root.relativize(p).toString());
                    Files.createDirectories(dest.getParent());
                    Files.copy(p, dest, StandardCopyOption.REPLACE_EXISTING);
                    n++;
                }
            }
            McpToolkit.LOGGER.info("[MCP Toolkit] extracted {} Blockbench plugin(s) {} into {}", n, version, dir);
        } catch (Exception e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] could not write the Blockbench plugins into {}: {}", dir, e.toString());
        }
    }

    /** File bytes, or null when the file is absent — absent and empty must stay distinguishable. */
    private static byte @Nullable [] readIfExists(final Path p) {
        try {
            return Files.exists(p) ? Files.readAllBytes(p) : null;
        } catch (java.io.IOException e) {
            return null;
        }
    }
}
