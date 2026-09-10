package com.mattmc.mcptoolkit;

import com.mojang.serialization.Codec;
import com.mojang.serialization.codecs.RecordCodecBuilder;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.util.datafix.DataFixTypes;
import net.minecraft.world.level.saveddata.SavedData;
import net.minecraft.world.level.saveddata.SavedDataType;

import java.util.UUID;

/**
 * Persistent world identity for per-world agent memory (MEMORY_DESIGN.md §World identity): a random UUID
 * minted on first access and stored in the overworld's saved data. World name and seed are display
 * metadata, not identity — copies, renames, and same-seed servers make them non-identifying.
 */
public class WorldIdentity extends SavedData {
    public static final Codec<WorldIdentity> CODEC = RecordCodecBuilder.create(i -> i.group(
        Codec.STRING.fieldOf("world_uuid").forGetter(w -> w.uuid)
    ).apply(i, WorldIdentity::new));

    public static final SavedDataType<WorldIdentity> TYPE = new SavedDataType<>(
        Identifier.fromNamespaceAndPath(McpToolkit.MOD_ID, "world_identity"),
        WorldIdentity::new, CODEC, DataFixTypes.LEVEL);

    private final String uuid;

    public WorldIdentity() {
        this(UUID.randomUUID().toString());
        this.setDirty();
    }

    public WorldIdentity(final String uuid) {
        this.uuid = uuid;
    }

    /** The stable UUID of this server's world, minting and persisting one on first call. */
    public static String get(final MinecraftServer server) {
        return server.overworld().getDataStorage().computeIfAbsent(TYPE).uuid;
    }
}
