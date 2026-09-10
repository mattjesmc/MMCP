package com.mattmc.mcptoolkit.platform;

import com.mattmc.mcptoolkit.McpToolkitEntrypoint;

import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import java.util.function.Supplier;

/**
 * Everything the toolkit needs from a mod loader, and nothing else — the cross-loader seam
 * (see {@code CROSS_LOADER_DESIGN.md}).
 *
 * <p>Before this existed, 15 of the toolkit's 173 files called {@code FabricLoader.getInstance()}
 * directly. That was the entire behavioural coupling to Fabric: all 18 mixins target vanilla classes,
 * and the {@code hooks/} layer that replaced fabric-api in 0.79.0 is already loader-neutral. Naming
 * the dependency as an interface is what turns "a Fabric mod" into "a mod that currently only has a
 * Fabric implementation".
 *
 * <p><b>Six questions, a discovery mechanism, and (0.126.0) the loaded-mod list.</b> That is deliberately the whole surface. Every
 * method here exists because a real call site needed it; nothing is added speculatively, because an
 * unused method on this interface is a portability claim nobody has checked.
 *
 * <p>Implementations are resolved by {@link Platform}, lazily, on first use.
 */
public interface LoaderPlatform {

    /**
     * One extension mod's contribution point, with the mod id needed to attribute its tools.
     *
     * <p>A {@link Supplier}, not an instance, and that is load-bearing twice over. It keeps the
     * promise {@code EXTENDING.md} makes to modders — an extension class is constructed only when the
     * toolkit asks for it, so a mod that ships one needs no {@code isModLoaded} guard. And it keeps
     * construction inside {@code Extensions.discover()}'s containment: a mod whose constructor throws
     * must cost only its own tools, exactly as a mod whose {@code registerTools} throws does. Building
     * the instance here instead would move that throw out to the discovery loop and take every later
     * extension down with it.
     */
    record Extension(String modId, Supplier<McpToolkitEntrypoint> entrypoint) {}

    /**
     * Short lower-case loader id — {@code "fabric"}, {@code "neoforge"}, {@code "forge"}. Reported by
     * {@code ping} so a boot report says which world it came from rather than leaving it to inference;
     * the cross-loader boot matrix is six cells and they are otherwise hard to tell apart in a log.
     */
    String loaderName();

    /** The game directory — {@code run/} in a dev workspace, the instance root in production. */
    Path gameDir();

    /** The config directory, conventionally {@code <gameDir>/config}. */
    Path configDir();

    /**
     * True in a Gradle dev run, false in a real instance. The toolkit branches on this for the bridge
     * port, the world-model data dir, and whether {@code mcp-server-dist} is re-extracted every boot.
     */
    boolean isDevelopment();

    /**
     * True only on a dedicated server. Note this is a question about the <em>process</em>, not about
     * whether a world is loaded: an integrated server inside a client answers false.
     */
    boolean isDedicatedServer();

    /** A loaded mod's version string, or empty if that mod is not present. */
    Optional<String> modVersion(String modId);

    /**
     * Every filesystem root a loaded mod's contents live under, or empty if not present.
     *
     * <p>Plural, and that is not pedantry: in a Loom dev run a mod has SEVERAL roots (compiled classes
     * and processed resources are separate directories) and only one of them carries {@code assets/}.
     * A caller that takes the first root works in production and silently fails in dev.
     */
    List<Path> modRoots(String modId);

    /**
     * Resolve a path inside a loaded mod's contents, or empty if absent. Used to read
     * {@code mcp-server-dist} straight out of the jar; the returned path may live on a zip filesystem,
     * so callers must {@code relativize().toString()} rather than resolving it against a real path.
     */
    Optional<Path> findModResource(String modId, String path);

    /**
     * One loaded mod and the filesystem locations it was loaded FROM - the jar file in production,
     * the classes and resources directories in a dev run. Distinct from {@link #modRoots}, which
     * are the roots you resolve a resource against and may live on a zip filesystem: an origin is
     * the path a {@code ProtectionDomain}'s code source names, so the two can be compared.
     * {@code version} is the loader's own string for it ({@code ping.build} hashes every one and
     * lists the buildable ones - RELEASE_1.md section K1).
     */
    record LoadedMod(String modId, String version, List<Path> origins) {}

    /**
     * Every loaded mod with its origins, in the loader's order. The one consumer is crash-report
     * attribution ({@code CrashReports}): a frame's class is resolved to the location that loaded
     * it, and that location to the mod whose origin it is - the same answer on both loaders with no
     * parsing of either loader's crash-report prose. Builtin pseudo-mods ({@code minecraft},
     * {@code java}, the loader itself) are included when the loader lists them, because a frame in
     * vanilla is the commonest frame there is and "minecraft" is the honest attribution for it.
     */
    List<LoadedMod> loadedMods();

    /**
     * Every extension mod's contribution point, paired with the mod id that provided it.
     *
     * <p>The mod id is carried explicitly because it is not recoverable afterwards, and {@code ping}'s
     * {@code extensions} array — the place you look when a mod's tool is missing from the manifest —
     * is built from it. Fabric's {@code EntrypointContainer} hands it back for free; a service file
     * does not, so both implementations get it from WHERE the declaration was found rather than from a
     * second declaration by the modder that could disagree with the first.
     *
     * <p>The loader-neutral declaration is {@link ServiceExtensions#SERVICE_FILE}, and both platforms
     * read it. Fabric additionally honours its own {@code entrypoints} block, which is what shipped
     * from 0.41.0 to 0.82.0; NeoForge has no analogue and needs none.
     *
     * <p>Implementations must not instantiate an entrypoint until asked, and must return the list in a
     * stable order.
     */
    List<Extension> extensions();

    /**
     * Whether the toolkit must contribute its own {@code assets/} to the client resource manager.
     *
     * <p>The seventh question, and the only one that is not "tell me a fact about the environment"
     * but "must I do this work". It earns its place because the two loaders genuinely differ:
     * NeoForge already exposes a mod's assets, while Fabric's equivalent lived in
     * fabric-resource-loader-v0, which 0.79.0 dropped along with the rest of fabric-api — so on
     * Fabric the toolkit does it itself ({@code ToolkitResourcePack} +
     * {@code MinecraftPackRepositoryMixin}). Registering the pack on a loader that already has it
     * duplicates it.
     *
     * <p>A headless server can never catch a mistake here; only a real client boot can.
     */
    boolean needsOwnAssetPack();

    /**
     * Whether the toolkit can send its own serverbound custom payload on this loader.
     *
     * <p>The toolkit registers {@code HumanFramePayload}'s codec by {@code @ModifyArg} into
     * {@code ServerboundCustomPayloadPacket}'s static initializer — vanilla's own modding seam, and
     * enough on a bare loader. NeoForge adds a payload layer ABOVE vanilla's and refuses to send
     * anything not registered through its own {@code RegisterPayloadHandlersEvent}:
     * {@code "Payload mcptoolkit:human_frame may not be sent to the server!"}, thrown once per client
     * tick.
     *
     * <p>False therefore does not mean "this loader cannot do networking" — it means the toolkit has
     * not taught its payload registration to speak this loader's dialect, and the feature that needs
     * it should stand down quietly rather than throw twenty times a second. Both loaders answer true
     * as of 0.84.0; the method stays because it is what a third loader gets to answer honestly on the
     * day it is added, before anyone has written its registrar call. See
     * {@code CROSS_LOADER_DESIGN.md} §14.
     */
    boolean canSendCustomPayloads();

    /**
     * Whether this loader delivers a modded payload to a handler registered with the LOADER, rather
     * than leaving it to arrive through vanilla's own packet handler.
     *
     * <p>This is the other half of the question above, and the two are genuinely separate: vanilla's
     * codec seam decides whether the payload can be WRITTEN and READ; this decides who gets CALLED
     * once it has been. On Fabric nothing intercepts, so the toolkit's own
     * {@code ServerGamePacketListenerImplMixin} injection is the only delivery there is. On NeoForge
     * the registrar's handler is called for every modded payload, so that same injection would
     * deliver the frame a SECOND time — it stands down at runtime rather than being compiled out,
     * because the mixin is common to both loaders and a per-loader mixin config would be a second
     * thing to keep in step with this one.
     *
     * <p>Phrased as who-dispatches rather than which-loader on purpose: the reason the injection has
     * to be quiet is a property of the loader's networking, so a loader that grows native dispatch
     * later changes one boolean and nothing else.
     */
    boolean dispatchesCustomPayloads();
}
