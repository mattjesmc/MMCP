package com.mattmc.mcptoolkit.hooks.client;

import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.platform.Platform;
import net.minecraft.network.chat.Component;
import net.minecraft.server.packs.PackLocationInfo;
import net.minecraft.server.packs.PackResources;
import net.minecraft.server.packs.PackSelectionConfig;
import net.minecraft.server.packs.PathPackResources;
import net.minecraft.server.packs.repository.Pack;
import net.minecraft.server.packs.repository.PackCompatibility;
import net.minecraft.server.packs.repository.PackSource;
import net.minecraft.server.packs.repository.RepositorySource;
import net.minecraft.world.flag.FeatureFlagSet;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;

/**
 * Exposes this mod's {@code assets/mcptoolkit/} to the client's resource manager, with no fabric-api.
 *
 * <p>Vanilla only discovers packs from the vanilla jar and the {@code resourcepacks/} folder; a mod's
 * own assets are invisible to it. Registering them is normally {@code fabric-resource-loader-v0}'s
 * job, and that was the LAST thing this mod still needed fabric-api for. Without it the bodies
 * render correctly but untextured - the client logs
 * {@code Missing resource mcptoolkit:textures/entity/drone.png} and draws the magenta/black
 * checkerboard. A headless server can never catch this, which is why it survived the loader-only
 * change: only a real client boot shows it.
 *
 * <p>Everything here is vanilla plus {@link Platform}, the loader seam — no fabric-api, and as of
 * 0.81.0 no Fabric either.
 */
public final class ToolkitResourcePack {
    private ToolkitResourcePack() {}

    private static final PackSelectionConfig SELECTION =
        // required + fixed: this is the mod's own art, not something a player opts into or reorders.
        // BOTTOM so an actual resource pack can still override it.
        new PackSelectionConfig(true, Pack.Position.BOTTOM, true);

    /** A source to hand to the client's {@code PackRepository}; contributes at most one pack. */
    public static RepositorySource source() {
        return consumer -> {
            Path root = assetRoot();
            if (root == null) {
                McpToolkit.LOGGER.warn("[MCP Toolkit] no assets/ root found - body textures will be missing.");
                return;
            }
            PackLocationInfo location = new PackLocationInfo(
                McpToolkit.MOD_ID,
                Component.literal("MCP Toolkit"),
                PackSource.BUILT_IN,
                Optional.empty());
            Pack.Metadata metadata = new Pack.Metadata(
                Component.literal("Body textures for the MCP Toolkit."),
                // The pack ships inside the mod, so it is compatible by construction. Saying so
                // avoids needing a pack.mcmeta, whose format fields are a per-version maintenance
                // burden - the stale run/resourcepacks/mcptoolkit_live pack is what that costs.
                PackCompatibility.COMPATIBLE,
                FeatureFlagSet.of(),
                List.of());
            Pack.ResourcesSupplier resources = new Pack.ResourcesSupplier() {
                @Override
                public PackResources openPrimary(final PackLocationInfo loc) {
                    return new PathPackResources(loc, root);
                }

                @Override
                public PackResources openFull(final PackLocationInfo loc, final Pack.Metadata meta) {
                    return new PathPackResources(loc, root);
                }
            };
            consumer.accept(new Pack(location, resources, metadata, SELECTION));
        };
    }

    /**
     * The mod root that actually holds {@code assets/}.
     *
     * <p>Not simply the first root: in a Loom dev run a mod has SEVERAL roots (compiled classes and
     * processed resources are separate directories) and only one of them carries the assets. In a
     * production jar there is one root and this picks it.
     */
    private static Path assetRoot() {
        for (Path root : Platform.modRoots(McpToolkit.MOD_ID)) {
            if (Files.isDirectory(root.resolve("assets"))) {
                return root;
            }
        }
        return null;
    }
}
