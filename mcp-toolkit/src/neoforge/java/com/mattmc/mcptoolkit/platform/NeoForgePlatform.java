package com.mattmc.mcptoolkit.platform;

import com.mattmc.mcptoolkit.McpToolkit;
import net.neoforged.fml.ModList;
import net.neoforged.fml.jarcontents.JarContents;
import net.neoforged.fml.loading.FMLEnvironment;
import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforgespi.language.IModFileInfo;
import net.neoforged.neoforgespi.language.IModInfo;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystem;
import java.nio.file.FileSystemAlreadyExistsException;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * {@link LoaderPlatform} on NeoForge — the mirror of {@link FabricPlatform}, and the whole of what
 * the toolkit needs NeoForge for.
 *
 * <p>{@link Platform} selects this by probing for {@code net.neoforged.fml.loading.FMLPaths} — the
 * marker, and one of the classes below. It does <em>not</em> select by trying to load this class:
 * every {@code net.neoforged} reference here is inside a method body, so this class loads perfectly
 * well on Fabric and would be chosen there. That mistake is what 0.81.0 shipped and the first
 * NeoForge boot caught; see {@code Platform}'s class note.
 */
public final class NeoForgePlatform implements LoaderPlatform {

    @Override
    public String loaderName() {
        return "neoforge";
    }

    @Override
    public Path gameDir() {
        return FMLPaths.GAMEDIR.get();
    }

    @Override
    public Path configDir() {
        return FMLPaths.CONFIGDIR.get();
    }

    @Override
    public boolean isDevelopment() {
        // Inverted deliberately: FML asks "is this production", Fabric asks "is this development".
        // Same question, and the toolkit's callers are all phrased the Fabric way.
        return !FMLEnvironment.isProduction();
    }

    @Override
    public boolean isDedicatedServer() {
        return FMLEnvironment.getDist().isDedicatedServer();
    }

    @Override
    public Optional<String> modVersion(final String modId) {
        return ModList.get().getModContainerById(modId)
            .map(c -> c.getModInfo().getVersion().toString());
    }

    /**
     * Cached zip filesystems, one per mod jar, open for the life of the process. See
     * {@link #usableRoot}; there is nowhere sensible to close them, because the Paths handed out
     * stay valid only while the filesystem is open and the callers keep them.
     */
    private static final Map<Path, FileSystem> JAR_FILESYSTEMS = new ConcurrentHashMap<>();

    /**
     * NeoForge's {@code JarContents.getContentRoots()} is the nearest analogue of Fabric's
     * {@code ModContainer.getRootPaths()} — plural for the same reason: a dev run splits compiled
     * classes and processed resources across separate directories, and only one carries
     * {@code assets/}.
     *
     * <p><b>But it is not the same kind of Path, and that difference cost a boot.</b> Fabric hands
     * back roots you can {@code resolve} into; NeoForge hands back the mod JAR FILE itself, because
     * its own resource API is stream-based ({@code JarContents.openFile}) and never needs one. So
     * {@code root.resolve("mcp-server-dist")} produced {@code .../mcp-toolkit.jar/mcp-server-dist},
     * which exists nowhere, and the first NeoForge boot logged "mcp-server-dist missing from mod
     * resources".
     *
     * <p>Normalising here rather than at the one call site is deliberate: a raw jar path that
     * silently resolves to nothing is a trap that would be re-sprung by the next caller.
     * {@link LoaderPlatform#modRoots} promises roots you can resolve against, so this returns those.
     */
    @Override
    public List<Path> modRoots(final String modId) {
        IModFileInfo info = ModList.get().getModFileById(modId);
        if (info == null) {
            return List.of();
        }
        List<Path> out = new ArrayList<>();
        for (Path raw : info.getFile().getContents().getContentRoots()) {
            Path usable = usableRoot(raw);
            if (usable != null) {
                out.add(usable);
            }
        }
        return List.copyOf(out);
    }

    /** The mod file's own path (a jar, or the dev directories FML unions) plus the usable roots. */
    @Override
    public List<LoadedMod> loadedMods() {
        List<LoadedMod> out = new ArrayList<>();
        for (IModInfo mod : ModList.get().getMods()) {
            List<Path> origins = new ArrayList<>();
            IModFileInfo file = mod.getOwningFile();
            if (file != null && file.getFile() != null) {
                Path filePath = file.getFile().getFilePath();
                if (filePath != null) {
                    origins.add(filePath);
                }
            }
            for (Path root : modRoots(mod.getModId())) {
                if (root.getFileSystem() == FileSystems.getDefault()) {
                    origins.add(root);
                }
            }
            out.add(new LoadedMod(mod.getModId(), mod.getVersion().toString(), List.copyOf(origins)));
        }
        return out;
    }

    @Override
    public Optional<Path> findModResource(final String modId, final String path) {
        for (Path root : modRoots(modId)) {
            Path candidate = root.resolve(path);
            if (Files.exists(candidate)) {
                return Optional.of(candidate);
            }
        }
        return Optional.empty();
    }

    /**
     * A directory root as-is; a jar root as the root of a zip filesystem over it, so callers can
     * resolve and walk it the way they can on Fabric.
     */
    private static Path usableRoot(final Path raw) {
        if (Files.isDirectory(raw)) {
            return raw;                                    // dev run: exploded classes/resources
        }
        if (!Files.isRegularFile(raw)) {
            return null;
        }
        try {
            FileSystem fs = JAR_FILESYSTEMS.computeIfAbsent(raw, NeoForgePlatform::openZip);
            return fs.getRootDirectories().iterator().next();
        } catch (Exception e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] could not open mod jar {} as a filesystem: {}",
                raw, e.toString());
            return null;
        }
    }

    private static FileSystem openZip(final Path jar) {
        try {
            return FileSystems.newFileSystem(jar, (ClassLoader) null);
        } catch (FileSystemAlreadyExistsException e) {
            // Someone else (the loader, another mod) already mounted it; reuse rather than fail.
            return FileSystems.getFileSystem(jar.toUri());
        } catch (IOException e) {
            throw new IllegalStateException("cannot open " + jar + " as a zip filesystem", e);
        }
    }

    /**
     * The loader-neutral mechanism, and the only one here: {@link ServiceExtensions#SERVICE_FILE},
     * read out of each loaded mod file's contents. Fabric's {@code entrypoints} block has no NeoForge
     * analogue; this is what replaced it, and Fabric reads the same file.
     *
     * <p>Read through {@code JarContents} rather than through {@link #modRoots}: {@code containsFile}
     * and {@code readFile} are stream-based, so scanning every loaded mod costs a lookup each and does
     * not mount a zip filesystem per mod jar the way resolving a {@code Path} into each would. That
     * matters here and not in {@code findModResource} because this asks <em>every</em> mod, not one.
     *
     * <p>Attribution is by mod FILE, not by mod: one file may declare several mods (NeoForge allows
     * it, Fabric's nested jars are separate containers), and a service file in it is the file's, not
     * any one mod's. The first declared mod id names it — the alternative, attributing the same file
     * to each mod in it, would register the same tools once per mod and collide with itself.
     */
    @Override
    public List<Extension> extensions() {
        List<Extension> out = new ArrayList<>();
        for (IModFileInfo info : ModList.get().getModFiles()) {
            List<IModInfo> mods = info.getMods();
            if (mods.isEmpty()) {
                continue;                                  // a library jar, not a mod: nothing to attribute to
            }
            JarContents contents = info.getFile().getContents();
            if (!contents.containsFile(ServiceExtensions.SERVICE_FILE)) {
                continue;
            }
            String modId = mods.get(0).getModId();
            try {
                String text = new String(contents.readFile(ServiceExtensions.SERVICE_FILE), StandardCharsets.UTF_8);
                ServiceExtensions.collect(modId, text, out);
            } catch (IOException | RuntimeException e) {
                ServiceExtensions.warnUnreadable(modId, e);
            }
        }
        return out;
    }

    /**
     * False — NeoForge exposes a mod's own {@code assets/} to the client resource manager already,
     * so contributing a second pack for the same files would duplicate it.
     *
     * <p>This is the one place the two loaders genuinely differ in what the toolkit must DO, rather
     * than in how it asks a question. On Fabric this work is the toolkit's own
     * ({@code ToolkitResourcePack} + {@code MinecraftPackRepositoryMixin}) because it dropped
     * fabric-resource-loader-v0 along with the rest of fabric-api.
     */
    @Override
    public boolean needsOwnAssetPack() {
        return false;
    }

    /**
     * True since 0.84.0. NeoForge validates payload direction against its own registrar rather than
     * vanilla's codec list, so the toolkit's {@code @ModifyArg} into
     * {@code ServerboundCustomPayloadPacket.<clinit>} was never enough on its own here — it makes
     * the frame writable and readable, and NeoForge still refused to send it ("Payload
     * mcptoolkit:human_frame may not be sent to the server!", once per client tick). What closes it
     * is {@code NeoForgePayloads}, which registers the same type through
     * {@code RegisterPayloadHandlersEvent} so the channel exists to be negotiated.
     */
    @Override
    public boolean canSendCustomPayloads() {
        return true;
    }

    /**
     * True. A registered modded payload is delivered by NeoForge to the handler
     * {@code NeoForgePayloads} registered with it, on the main thread, before anything the toolkit
     * injects into vanilla's handler could be described as the delivery. So the common injection
     * stands down and this is the only path — see {@code LoaderPlatform#dispatchesCustomPayloads}.
     */
    @Override
    public boolean dispatchesCustomPayloads() {
        return true;
    }
}
