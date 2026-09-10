package com.mattmc.mcptoolkit.mixin;

import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.TickingBlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

import java.util.List;

/**
 * {@code Level.blockEntityTickers} — the list vanilla walks every tick in
 * {@code tickBlockEntities()}, and the only exact answer to "how many block entities are TICKING in
 * this dimension, and which ones".
 *
 * <p>Counting a chunk's {@code getBlockEntities()} map instead would answer a different question:
 * that map holds every block entity in the chunk, including the ones with no ticker at all (a chest,
 * a sign), and it can only be read for chunks something already enumerated. This list is the tick
 * cost itself, and each {@link TickingBlockEntity} carries its own {@code getPos()} and
 * {@code getType()} — which is what lets {@code get_perf} say <em>which chunk</em> the ticking is in
 * rather than only how much of it there is.
 *
 * <p>An {@code @Accessor} rather than an access widener on purpose: this jar ships Fabric AND
 * NeoForge (CROSS_LOADER_DESIGN.md), and an access widener is Fabric's dialect alone — the same
 * reason {@code place_structure} diffs the world instead of widening {@code StructureTemplate}.
 * Mixin is the one seam both loaders read.
 */
@Mixin(Level.class)
public interface LevelTickersAccessor {

    @Accessor("blockEntityTickers")
    List<TickingBlockEntity> mcptoolkit$blockEntityTickers();
}
