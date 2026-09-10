package com.mattmc.mcptoolkit.platform;

import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.McpToolkitEntrypoint;
import net.fabricmc.api.EnvType;
import net.fabricmc.loader.api.FabricLoader;
import net.fabricmc.loader.api.ModContainer;
import net.fabricmc.loader.api.entrypoint.EntrypointContainer;
import net.fabricmc.loader.api.metadata.ModOrigin;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * {@link LoaderPlatform} on Fabric. Every method is a direct delegation to {@code FabricLoader} — this
 * class is the only place in the toolkit that names it.
 *
 * <p>{@link Platform} selects this by probing for {@code net.fabricmc.loader.api.FabricLoader} — the
 * marker, and the class every method below calls. It does <em>not</em> select by trying to load this
 * class: an import and a constant-pool entry are not enough to make a class fail to load, because the
 * JVM does not resolve types referenced only from method bodies. This class loads fine on NeoForge.
 * 0.81.0 assumed otherwise, and the first NeoForge boot picked FabricPlatform and died in
 * the extract path asking it for the game directory.
 */
public final class FabricPlatform implements LoaderPlatform {

    @Override
    public String loaderName() {
        return "fabric";
    }

    @Override
    public Path gameDir() {
        return FabricLoader.getInstance().getGameDir();
    }

    @Override
    public Path configDir() {
        return FabricLoader.getInstance().getConfigDir();
    }

    @Override
    public boolean isDevelopment() {
        return FabricLoader.getInstance().isDevelopmentEnvironment();
    }

    @Override
    public boolean isDedicatedServer() {
        return FabricLoader.getInstance().getEnvironmentType() == EnvType.SERVER;
    }

    @Override
    public Optional<String> modVersion(final String modId) {
        return FabricLoader.getInstance().getModContainer(modId)
            .map(c -> c.getMetadata().getVersion().getFriendlyString());
    }

    @Override
    public List<Path> modRoots(final String modId) {
        return FabricLoader.getInstance().getModContainer(modId)
            .map(ModContainer::getRootPaths)
            .orElseGet(List::of);
    }

    @Override
    public Optional<Path> findModResource(final String modId, final String path) {
        return FabricLoader.getInstance().getModContainer(modId).flatMap(c -> c.findPath(path));
    }

    /**
     * A PATH origin is the jar (or the dev directories) itself. A NESTED origin's
     * {@link ModOrigin#getPaths()} throws by contract, and Knot loads a jar-in-jar from its
     * extraction under {@code .fabric/processedMods}, so the containing jar is a poor match for the
     * code source; the root paths' filesystem is the better clue there, and {@code CrashReports}
     * tries both.
     */
    @Override
    public List<LoadedMod> loadedMods() {
        List<LoadedMod> out = new ArrayList<>();
        for (ModContainer mod : FabricLoader.getInstance().getAllMods()) {
            List<Path> origins = new ArrayList<>();
            ModOrigin origin = mod.getOrigin();
            if (origin.getKind() == ModOrigin.Kind.PATH) {
                origins.addAll(origin.getPaths());
            }
            for (Path root : mod.getRootPaths()) {
                if (root.getFileSystem() == java.nio.file.FileSystems.getDefault()) {
                    origins.add(root);
                } else {
                    // A zip filesystem's toString is the archive it opened; the only handle a
                    // nested or builtin jar leaves on the default filesystem.
                    try {
                        Path archive = Path.of(root.getFileSystem().toString());
                        if (Files.exists(archive)) {
                            origins.add(archive);
                        }
                    } catch (RuntimeException ignored) {
                        // not a path; this root contributes nothing to attribution
                    }
                }
            }
            out.add(new LoadedMod(mod.getMetadata().getId(),
                mod.getMetadata().getVersion().getFriendlyString(), List.copyOf(origins)));
        }
        return out;
    }

    /**
     * Both discovery mechanisms, service file first.
     *
     * <p>The loader-neutral one is {@code META-INF/services/…} read out of each loaded mod's own
     * contents ({@link ServiceExtensions}); it is what NeoForge has too, and what {@code EXTENDING.md}
     * now documents. Fabric's {@code entrypoints} block stays supported because it is what shipped
     * from 0.41.0 to 0.82.0 and jars built against those versions must keep working.
     *
     * <p><b>A mod that declares both gets the service file and not the entrypoint.</b> That is the
     * transition shape: one jar declaring both runs its tools on an old toolkit (which only reads the
     * entrypoint) and on a new one (which prefers the service file), never twice. Registering twice
     * would not be silent — the second pass would collide on every tool name and land in {@code ping}
     * as a failure list — but "not silent" is a long way from "correct".
     */
    @Override
    public List<Extension> extensions() {
        List<Extension> out = new ArrayList<>();
        Set<String> declaredService = new HashSet<>();
        for (ModContainer mod : FabricLoader.getInstance().getAllMods()) {
            Optional<Path> file = mod.findPath(ServiceExtensions.SERVICE_FILE);
            if (file.isEmpty()) {
                continue;
            }
            String modId = mod.getMetadata().getId();
            try {
                ServiceExtensions.collect(modId, Files.readString(file.get()), out);
                declaredService.add(modId);
            } catch (IOException | RuntimeException e) {
                ServiceExtensions.warnUnreadable(modId, e);
            }
        }

        List<EntrypointContainer<McpToolkitEntrypoint>> found =
            FabricLoader.getInstance().getEntrypointContainers("mcptoolkit", McpToolkitEntrypoint.class);
        for (EntrypointContainer<McpToolkitEntrypoint> container : found) {
            String modId = container.getProvider().getMetadata().getId();
            if (declaredService.contains(modId)) {
                McpToolkit.LOGGER.info("[MCP Toolkit] mod '{}' declares both a fabric.mod.json"
                    + " entrypoint and {} - using the service file, which is the cross-loader one.",
                    modId, ServiceExtensions.SERVICE_FILE);
                continue;
            }
            // getEntrypoint() is what instantiates the mod's class, so it stays behind the supplier and
            // runs inside the caller's containment. The id is free beforehand.
            out.add(new Extension(modId, container::getEntrypoint));
        }
        return out;
    }

    /**
     * True. Vanilla only discovers packs from the vanilla jar and {@code resourcepacks/}; the job of
     * showing a mod's own {@code assets/} to the client belongs to fabric-resource-loader-v0, which
     * the toolkit does not have. {@code ToolkitResourcePack} is that module, done by hand.
     */
    @Override
    public boolean needsOwnAssetPack() {
        return true;
    }

    /** True — vanilla's codec-list seam is the whole mechanism here, and nothing overrides it. */
    @Override
    public boolean canSendCustomPayloads() {
        return true;
    }

    /**
     * False. Fabric puts nothing between a custom payload and the vanilla handler it was addressed
     * to, so the toolkit's own injection into {@code handleCustomPayload} is the delivery — and
     * standing it down here would mean the frame is never read at all.
     */
    @Override
    public boolean dispatchesCustomPayloads() {
        return false;
    }
}
