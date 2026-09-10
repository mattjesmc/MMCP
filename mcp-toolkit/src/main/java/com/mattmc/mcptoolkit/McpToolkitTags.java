package com.mattmc.mcptoolkit;

import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.tags.TagKey;
import net.minecraft.world.level.block.Block;

/**
 * The toolkit's own block tags — the seam through which <em>modded</em> content teaches the toolkit's
 * classifiers about itself.
 *
 * <p><b>Why tags and not a Java set.</b> Identity is already dynamic here: the registries answer "what
 * blocks exist", and most affordances ({@code solid}, {@code pass}, {@code repl}, {@code tool}) are read
 * off the {@link net.minecraft.world.level.block.state.BlockState} itself, so modded blocks classify
 * correctly with no help. The exceptions are properties the game does <em>not</em> expose behaviorally —
 * "does standing in this hurt" is the big one — which vanilla itself answers from a hardcoded list. A
 * hardcoded list in the toolkit means a modded thorn bush reads as harmless: a silent perception
 * falsehood, the exact failure class the succeeds-falsely purge exists to prevent. A tag makes it
 * data: a mod (or a plain datapack, no Java at all) joins the tag and every classifier that consults it
 * updates at once, live across {@code reload_data}.
 *
 * <p><b>The tag ADDS to a Java floor; it does not define the defaults.</b> A mod's own {@code data/}
 * directory is only loaded as a datapack by {@code fabric-resource-loader} — part of fabric-api, which
 * this toolkit deliberately does not depend on (0.39.0, loader-only). So the shipped
 * {@code data/mcptoolkit/tags/block/*.json} files load in a game that happens to have fabric-api and
 * silently do not in one that doesn't. Vanilla parity therefore lives in the Java sets below, which are
 * always in force; the tag is a pure union on top. Two things follow: the classification never regresses
 * because a datapack failed to load, and a datapack cannot un-hazard vanilla's cactus — which is not a
 * use case worth the fragility.
 *
 * <p>See {@code EXTENSION_DESIGN.md} §3 and {@code EXTENDING.md}.
 */
public final class McpToolkitTags {
    private McpToolkitTags() {}

    /** The vanilla floor for {@link #CONTACT_HAZARDS} — exactly the set Affordances hardcoded pre-0.41.0. */
    private static final java.util.Set<Block> VANILLA_CONTACT_HAZARDS = java.util.Set.of(
        net.minecraft.world.level.block.Blocks.FIRE,
        net.minecraft.world.level.block.Blocks.SOUL_FIRE,
        net.minecraft.world.level.block.Blocks.CACTUS,
        net.minecraft.world.level.block.Blocks.MAGMA_BLOCK,
        net.minecraft.world.level.block.Blocks.SWEET_BERRY_BUSH,
        net.minecraft.world.level.block.Blocks.WITHER_ROSE,
        net.minecraft.world.level.block.Blocks.POWDER_SNOW);

    /**
     * Blocks that damage a body on contact. Consulted by {@link Affordances} for the {@code hazard}
     * flag on every read that emits a palette, and by the walker's node evaluator to price a cell as
     * damaging so paths route around it. Fluids are <em>not</em> members: lava is recognized through
     * its fluid state, which modded fluids inherit by joining {@code #minecraft:lava}.
     */
    public static final TagKey<Block> CONTACT_HAZARDS =
        TagKey.create(Registries.BLOCK, Identifier.fromNamespaceAndPath(McpToolkit.MOD_ID, "contact_hazards"));

    /**
     * Blocks that open a crafting grid when used — where {@code bot_craft} looks for a bench. Joining
     * this tag makes a modded station <em>findable</em>; whether the toolkit can drive its menu is a
     * separate question (a station with a bespoke screen may still refuse).
     */
    public static final TagKey<Block> CRAFTING_STATIONS =
        TagKey.create(Registries.BLOCK, Identifier.fromNamespaceAndPath(McpToolkit.MOD_ID, "crafting_stations"));

    /**
     * Does standing in / touching this block damage a body? The vanilla floor unioned with whatever
     * joined {@link #CONTACT_HAZARDS}. An unbound tag is simply empty, so this is safe before any
     * datapack loads.
     */
    public static boolean isContactHazard(final net.minecraft.world.level.block.state.BlockState state) {
        return VANILLA_CONTACT_HAZARDS.contains(state.getBlock()) || state.is(CONTACT_HAZARDS);
    }

    /** Does this block offer a crafting grid? Vanilla's table, plus anything in {@link #CRAFTING_STATIONS}. */
    public static boolean isCraftingStation(final net.minecraft.world.level.block.state.BlockState state) {
        return state.is(net.minecraft.world.level.block.Blocks.CRAFTING_TABLE)
            || state.is(CRAFTING_STATIONS);
    }

    /**
     * What {@link #CONTACT_HAZARDS} means to the PATHFINDER, defined once for every consumer.
     * Upgrades a cell vanilla classified as {@code OPEN} to {@code DAMAGING} when it is a tagged
     * hazard; every other verdict passes through untouched.
     *
     * <p>{@code OPEN} is the only verdict that may be overridden, and that is what keeps vanilla
     * pathing bit-identical: each vanilla hazard already classifies as something more specific
     * (cactus/sweet berry → {@code DAMAGING}, powder snow → {@code POWDER_SNOW}, fire →
     * {@code FIRE}, magma → {@code BLOCKED} as unpathfindable, wither rose → {@code DAMAGE_CAUTIOUS}),
     * so only a block vanilla would have called walkable-and-harmless can be changed here.
     * {@code DAMAGING} carries vanilla's own −1 malus, i.e. "route around this".
     *
     * <p>The air short-circuit is not a micro-optimization for its own sake: this runs per cell
     * inspected by A*, and the overwhelming majority of {@code OPEN} cells are plain air, which can
     * never be a hazard.
     */
    public static net.minecraft.world.level.pathfinder.PathType hazardOverlay(
            final net.minecraft.world.level.pathfinder.PathType computed,
            final net.minecraft.world.level.block.state.BlockState state) {
        if (computed != net.minecraft.world.level.pathfinder.PathType.OPEN || state.isAir()) {
            return computed;
        }
        return isContactHazard(state)
            ? net.minecraft.world.level.pathfinder.PathType.DAMAGING : computed;
    }
}
