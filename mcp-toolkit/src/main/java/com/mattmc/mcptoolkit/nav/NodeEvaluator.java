package com.mattmc.mcptoolkit.nav;

import it.unimi.dsi.fastutil.ints.Int2ObjectMap;
import it.unimi.dsi.fastutil.ints.Int2ObjectOpenHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.util.Mth;
import net.minecraft.world.level.PathNavigationRegion;
import net.minecraft.world.level.pathfinder.Node;
import net.minecraft.world.level.pathfinder.PathType;
import net.minecraft.world.level.pathfinder.Target;

/**
 * Copy of vanilla {@code net.minecraft.world.level.pathfinder.NodeEvaluator} with the {@code Mob}
 * field retyped to {@link NavPhysique} — the §11.6 copy set. Structure is kept line-for-line close to
 * the original so drift stays diffable against {@code vanilla-src/}. {@code Node}/{@code Target}/
 * {@code PathType} remain the vanilla classes, so produced paths stay interchangeable.
 */
public abstract class NodeEvaluator {
    protected PathfindingContext currentContext;
    protected NavPhysique mob;
    protected final Int2ObjectMap<Node> nodes = new Int2ObjectOpenHashMap<>();
    protected int entityWidth;
    protected int entityHeight;
    protected int entityDepth;
    protected boolean canPassDoors = true;
    protected boolean canOpenDoors;
    protected boolean canFloat;
    protected boolean canWalkOverFences;

    public void prepare(final PathNavigationRegion level, final NavPhysique entity) {
        this.currentContext = new PathfindingContext(level, entity);
        this.mob = entity;
        this.nodes.clear();
        this.entityWidth = Mth.floor(entity.bbWidth() + 1.0F);
        this.entityHeight = Mth.floor(entity.bbHeight() + 1.0F);
        this.entityDepth = Mth.floor(entity.bbWidth() + 1.0F);
    }

    public void done() {
        this.currentContext = null;
        this.mob = null;
    }

    protected Node getNode(final BlockPos pos) {
        return this.getNode(pos.getX(), pos.getY(), pos.getZ());
    }

    protected Node getNode(final int x, final int y, final int z) {
        return this.nodes.computeIfAbsent(Node.createHash(x, y, z), k -> new Node(x, y, z));
    }

    public abstract Node getStart();

    public abstract Target getTarget(double x, double y, double z);

    protected Target getTargetNodeAt(final double x, final double y, final double z) {
        return new Target(this.getNode(Mth.floor(x), Mth.floor(y), Mth.floor(z)));
    }

    public abstract int getNeighbors(Node[] neighbors, Node pos);

    public abstract PathType getPathTypeOfMob(PathfindingContext context, int x, int y, int z, NavPhysique mob);

    public abstract PathType getPathType(PathfindingContext context, int x, int y, int z);

    public void setCanPassDoors(final boolean canPassDoors) {
        this.canPassDoors = canPassDoors;
    }

    public void setCanOpenDoors(final boolean canOpenDoors) {
        this.canOpenDoors = canOpenDoors;
    }

    public void setCanFloat(final boolean canFloat) {
        this.canFloat = canFloat;
    }

    public void setCanWalkOverFences(final boolean canWalkOverFences) {
        this.canWalkOverFences = canWalkOverFences;
    }

    public boolean canPassDoors() {
        return this.canPassDoors;
    }

    public boolean canOpenDoors() {
        return this.canOpenDoors;
    }

    public boolean canFloat() {
        return this.canFloat;
    }

    public boolean canWalkOverFences() {
        return this.canWalkOverFences;
    }
}
