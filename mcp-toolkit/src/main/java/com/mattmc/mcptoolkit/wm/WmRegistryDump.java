package com.mattmc.mcptoolkit.wm;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.McpToolkit;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.EntityTypeTags;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * The one-off registry side table (the world-model project's DESIGN.md §2.6): per block the GAME-DERIVED
 * properties the vocab embedding seeds from — the same ones Sightlines classifies on — so unseen
 * blocks land near their behavioral siblings instead of at a random point; per entity type the
 * hostile/passive category, size, and projectile-ness. Content-hashed; the hash lands in every
 * recorder manifest so a dataset row can always name the vocabulary it was written against.
 *
 * <p>Properties are read off {@code defaultBlockState()} against an empty block getter — shape
 * queries that would genuinely need neighbors (fences, walls) degrade to their default-state
 * answer, which is the right granularity for a per-ID embedding seed. A block whose shape query
 * throws on the empty getter is recorded {@code collision:"unknown"} rather than skipped.
 */
final class WmRegistryDump {
    private WmRegistryDump() {}

    private static final Gson GSON = new Gson();

    record Result(@Nullable String file, @Nullable String sha256) { }

    /** Dump if absent, hash either way. Never throws — a failed dump costs the manifest its
     *  registry hash, not the session its recording. */
    static Result ensure(final MinecraftServer server, final Path dataDir) {
        String name = "registry-" + WmRecorder.mcVersion() + ".json";
        Path file = dataDir.resolve(name);
        try {
            if (!Files.exists(file)) {
                Files.createDirectories(dataDir);
                Files.writeString(file, GSON.toJson(dump(server)) + "\n");
                McpToolkit.LOGGER.info("[MCP Toolkit] wm registry dump written: {}", file);
            }
            return new Result(name, sha256(file));
        } catch (IOException | RuntimeException e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] wm registry dump failed: {}", e.toString());
            return new Result(null, null);
        }
    }

    private static JsonObject dump(final MinecraftServer server) {
        JsonObject root = new JsonObject();
        root.addProperty("v", WmRecorder.WMFRAME_VERSION);
        root.addProperty("mc_version", WmRecorder.mcVersion());

        JsonObject blocks = new JsonObject();
        for (Block block : BuiltInRegistries.BLOCK) {
            blocks.add(BuiltInRegistries.BLOCK.getKey(block).toString(), describeBlock(block));
        }
        root.add("blocks", blocks);

        JsonObject entities = new JsonObject();
        for (EntityType<?> type : BuiltInRegistries.ENTITY_TYPE) {
            entities.add(BuiltInRegistries.ENTITY_TYPE.getKey(type).toString(), describeEntity(type));
        }
        root.add("entities", entities);
        return root;
    }

    private static JsonObject describeBlock(final Block block) {
        BlockState state = block.defaultBlockState();
        Holder<Block> holder = BuiltInRegistries.BLOCK.wrapAsHolder(block);
        JsonObject o = new JsonObject();
        o.addProperty("occludes", state.canOcclude());
        String collision;
        try {
            collision = state.getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO).isEmpty()
                ? "none"
                : state.isCollisionShapeFullBlock(EmptyBlockGetter.INSTANCE, BlockPos.ZERO)
                    ? "full" : "partial";
        } catch (RuntimeException e) {
            collision = "unknown";
        }
        o.addProperty("collision", collision);
        if (!state.getFluidState().isEmpty()) {
            o.addProperty("fluid",
                BuiltInRegistries.FLUID.getKey(state.getFluidState().getType()).toString());
        }
        o.addProperty("hardness", block.defaultDestroyTime());
        String tier = holder.is(BlockTags.NEEDS_DIAMOND_TOOL) ? "diamond"
            : holder.is(BlockTags.NEEDS_IRON_TOOL) ? "iron"
            : holder.is(BlockTags.NEEDS_STONE_TOOL) ? "stone" : null;
        if (tier != null) {
            o.addProperty("tool_tier", tier);
        }
        String tool = holder.is(BlockTags.MINEABLE_WITH_PICKAXE) ? "pickaxe"
            : holder.is(BlockTags.MINEABLE_WITH_AXE) ? "axe"
            : holder.is(BlockTags.MINEABLE_WITH_SHOVEL) ? "shovel"
            : holder.is(BlockTags.MINEABLE_WITH_HOE) ? "hoe" : null;
        if (tool != null) {
            o.addProperty("tool", tool);
        }
        JsonArray tags = new JsonArray();
        holder.tags().map(t -> t.location().toString()).sorted().forEach(tags::add);
        if (!tags.isEmpty()) {
            o.add("tags", tags);
        }
        return o;
    }

    private static JsonObject describeEntity(final EntityType<?> type) {
        JsonObject o = new JsonObject();
        o.addProperty("category", type.getCategory().getName());
        o.addProperty("width", type.getWidth());
        o.addProperty("height", type.getHeight());
        if (type.builtInRegistryHolder().is(EntityTypeTags.IMPACT_PROJECTILES)) {
            o.addProperty("projectile", true);
        }
        return o;
    }

    private static String sha256(final Path file) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(Files.readAllBytes(file)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e); // SHA-256 is mandatory in every JRE
        }
    }
}
