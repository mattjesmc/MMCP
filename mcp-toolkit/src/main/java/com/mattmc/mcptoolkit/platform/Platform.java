package com.mattmc.mcptoolkit.platform;

import java.nio.file.Path;
import java.util.List;
import java.util.Optional;

/**
 * Resolves the one {@link LoaderPlatform} for the loader actually running, and re-exports it as static
 * calls so a call site reads {@code Platform.gameDir()} rather than {@code Platform.get().gameDir()}.
 *
 * <h2>Detection is an explicit question, not a side effect</h2>
 *
 * <p><b>0.81.0 got this wrong and the first NeoForge boot proved it.</b> The reasoning then was that
 * each implementation hard-references classes existing on only its own loader, so loading the wrong
 * one would throw {@link NoClassDefFoundError} and the probe could take the first that loaded. It
 * does not. {@code FabricPlatform} names {@code FabricLoader} only inside method BODIES — never in a
 * supertype, a field, or a method signature — and the JVM does not resolve those at class-load time.
 * So on NeoForge it loaded cleanly, constructed cleanly, was selected, and only blew up later when
 * the session tools asked it for the game directory. A wrong answer that survives selection
 * is worse than a loud failure, and it is what "detect by whether the class loads" actually buys.
 *
 * <p>So each candidate names a MARKER class — the loader API class its implementation actually calls
 * — and the probe resolves the marker first. That question cannot come back wrong:
 * {@code net.fabricmc.loader.api.FabricLoader} is genuinely absent on NeoForge and
 * {@code net.neoforged.fml.loading.FMLPaths} genuinely absent on Fabric, and if the marker resolves
 * then every call the implementation makes will resolve too.
 *
 * <p>{@code ServiceLoader} is still not the answer, but for a different reason than 0.81.0 gave: it
 * has no way to ASK which provider is correct. It would have loaded both implementations here — both
 * load fine — and handed back whichever came first.
 *
 * <p>{@link #install} lets a loader set the platform outright and skip the probe. Nothing does that
 * today, and it is deliberately not the primary path — several mixins ({@code MinecraftPackRepositoryMixin} during
 * {@code Minecraft.<init>}, most obviously) can reach the platform before any entrypoint has run, so
 * resolution must not depend on entrypoint ordering.
 */
public final class Platform {
    private Platform() {}

    /**
     * {marker class, implementation} per supported loader. The marker is the loader API class the
     * implementation actually calls, so "the marker resolves" and "this implementation will work"
     * are the same statement rather than two facts that have to be kept in step.
     *
     * <p>Order is not a preference: at most one marker can resolve in a given process.
     */
    private static final String[][] CANDIDATES = {
        {"net.fabricmc.loader.api.FabricLoader", "com.mattmc.mcptoolkit.platform.FabricPlatform"},
        {"net.neoforged.fml.loading.FMLPaths", "com.mattmc.mcptoolkit.platform.NeoForgePlatform"},
    };

    private static volatile LoaderPlatform impl;

    /**
     * Force a specific platform. For a loader that wants to skip the probe, and for tests. Must be
     * called before any other method here; after resolution it is ignored, because a platform that
     * changed mid-run would leave earlier answers stale and unexplained.
     */
    public static synchronized void install(final LoaderPlatform platform) {
        if (impl == null) {
            impl = platform;
        }
    }

    /** The resolved platform. Throws if no implementation loaded — there is no sane degraded mode. */
    public static LoaderPlatform get() {
        LoaderPlatform p = impl;
        if (p == null) {
            p = resolve();
        }
        return p;
    }

    private static synchronized LoaderPlatform resolve() {
        if (impl != null) {
            return impl;
        }
        ClassLoader cl = Platform.class.getClassLoader();
        StringBuilder tried = new StringBuilder();
        for (String[] candidate : CANDIDATES) {
            String marker = candidate[0];
            String platform = candidate[1];
            try {
                // The MARKER decides. Resolved WITHOUT initializing: presence is the whole question,
                // and running a loader class's static setup as a side effect of asking would not be.
                Class.forName(marker, false, cl);
            } catch (Throwable t) {
                tried.append("\n  ").append(platform).append(" - marker ").append(marker)
                    .append(" not present");
                continue;
            }
            try {
                impl = (LoaderPlatform) Class.forName(platform, true, cl)
                    .getDeclaredConstructor().newInstance();
                return impl;
            } catch (Throwable t) {
                // Marker present but implementation unusable: a bug here, not the wrong loader, so it
                // must be loud rather than fall through to another loader's platform.
                throw new IllegalStateException(
                    "[MCP Toolkit] " + marker + " is present, so this is the right loader for "
                        + platform + ", but that implementation could not be constructed.", t);
            }
        }
        throw new IllegalStateException(
            "[MCP Toolkit] no supported mod loader was detected, so the toolkit cannot tell what it is"
                + " running on. One marker class per loader is probed and exactly one is expected to"
                + " resolve; none did:" + tried);
    }

    // ---- convenience re-exports -----------------------------------------------------------------

    public static String loaderName() {
        return get().loaderName();
    }

    public static Path gameDir() {
        return get().gameDir();
    }

    public static Path configDir() {
        return get().configDir();
    }

    /** {@code <configDir>/mcptoolkit.properties} — the toolkit's one config file, resolved in 8 places. */
    public static Path configFile() {
        return get().configDir().resolve("mcptoolkit.properties");
    }

    public static boolean isDevelopment() {
        return get().isDevelopment();
    }

    /**
     * Whether this JVM is on Windows - the one platform release 1 supports for anything that spawns a
     * process (RELEASE_1.md section 0). Every {@code cmd /c} site asks this first and answers with a
     * sentence, because the alternative a mac user meets is {@code ProcessBuilder}'s
     * {@code IOException: Cannot run program "cmd"} with no hint that the bridge itself is fine.
     * The bridge, the tools and the extracted MCP server are platform-neutral; only the launches are not.
     */
    public static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("win");
    }

    public static boolean isDedicatedServer() {
        return get().isDedicatedServer();
    }

    public static Optional<String> modVersion(final String modId) {
        return get().modVersion(modId);
    }

    public static List<Path> modRoots(final String modId) {
        return get().modRoots(modId);
    }

    public static Optional<Path> findModResource(final String modId, final String path) {
        return get().findModResource(modId, path);
    }

    public static List<LoaderPlatform.LoadedMod> loadedMods() {
        return get().loadedMods();
    }

    public static List<LoaderPlatform.Extension> extensions() {
        return get().extensions();
    }

    public static boolean needsOwnAssetPack() {
        return get().needsOwnAssetPack();
    }

    public static boolean canSendCustomPayloads() {
        return get().canSendCustomPayloads();
    }

    public static boolean dispatchesCustomPayloads() {
        return get().dispatchesCustomPayloads();
    }
}
