package com.mattmc.mcptoolkit.client;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.ItemSyntax;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolContext;
import com.mattmc.mcptoolkit.ToolDef;
import com.mattmc.mcptoolkit.canvas.Canvas;
import com.mattmc.mcptoolkit.canvas.CanvasStage;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Rotations;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.TagParser;
import net.minecraft.core.Vec3i;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Difficulty;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntitySpawnRequest;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.decoration.ArmorStand;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.Vec3;

import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * <b>{@code studio} — put a subject in the white room and stand the client in front of it.</b>
 * ({@code RENDER_SEAM_DESIGN.md} §6's {@code op:"canvas"}, the last unbuilt line of that design;
 * the staging half is {@link CanvasStage}.)
 *
 * <h2>Why this is its own entry and not an {@code op} on {@code render}</h2>
 *
 * §6 put {@code canvas} and {@code clear} on {@code render}'s {@code op} field, on the manifest-tax
 * argument that a second question about an existing argument list is the cheap kind. That argument is
 * right about tokens and loses to a stronger rule: <b>{@code render} is
 * {@code mechanism: "observe"}</b>, and the {@code inspect} profile — "a session that answers
 * questions about a world it must not change" — is a keep-list <i>checked per name against the live
 * manifest's mechanism</i>, with {@code render} on it. Staging writes blocks and moves a player. Put
 * that behind an observe-tagged entry and the read-only inspector can edit the world while every
 * check in the repo still passes: the mechanism stamp would say {@code observe}, the profile probe
 * would go on being green, and the claim the profile is chosen for would simply be false. That is the
 * "a check whose failure mode is delete a restriction to go green" shape, and the answer to it here
 * is the one ARCHITECTURE.md already gives: <i>mechanisms, never conflated</i>. So the camera stays a
 * read and this is a {@code world_edit} beside it — the same reasoning §6 itself used to keep
 * {@code open_world} out of {@code render}, applied to the case §6 got wrong.
 *
 * <p>It costs one manifest entry and buys back more than it costs: because the picture stays
 * {@code render}'s job, this schema is three fields rather than a second copy of the camera's, one
 * trip pays for as many shots and orbits as the caller wants, and a human can walk into the studio
 * while the subject is standing there — which is the whole prize §10.4 named.
 *
 * <h2>The three things a caller cannot do without it</h2>
 *
 * <ul>
 *   <li><b>The camera photographs the level the CLIENT is in.</b> {@code renderLevel} draws
 *       {@code Minecraft.level}; no {@code dimension} argument can move it. A shot in the studio
 *       therefore means teleporting a real player there — and <b>back</b>: a probe that once left the
 *       player in the studio cost a whole battery run, because every later read defaulted to a flat
 *       void nobody had asked about. {@code leave} is that restore, and it is one word.</li>
 *   <li><b>Knowing when the client can see it.</b> §13.3: {@code settled:true} is a fact about this
 *       client's renderer and says nothing about blocks still travelling from the server — measured
 *       at 700-900 ms. This call returns only once the client's OWN copy of the staged cells is
 *       there, so the {@code render} that follows cannot photograph an empty room.</li>
 *   <li><b>Coordinates nobody chose.</b> The slot is allocated ({@code [[probe-site-ownership]]}).</li>
 * </ul>
 */
@Environment(EnvType.CLIENT)
public final class StudioTools {

    private StudioTools() {}

    /** How long to wait for the staged subject to reach this client before giving up and saying so. */
    private static final long WAIT_MS = 15_000L;

    /** How long between witness polls. Chunk packets arrive on ticks; finer than this reads the same. */
    private static final long POLL_MS = 100L;

    /** Where the client is faced when it lands: at the subject, from the corner it was put down in. */
    private static final float STAND_YAW = -45.0F;
    private static final float STAND_PITCH = 10.0F;

    public static void register() {
        McpTools.register(ToolDef.async(
            "studio",
            "Stand a subject in mcptoolkit:studio — no sky, a white background and flat full-bright light — and put THIS CLIENT in front of it, so `render` can photograph it against nothing. The subject is `id` (a loaded structure template, which needs no world to stand in), `look_at` (a copy of blocks standing in the dimension the client is in; the originals are not touched), or `entity` (a LIVING subject: an entity type spawned on the studio floor, still, wearing `equipment` given in item syntax — the way to photograph what a mod renders on a body; armor_stand by default when only `equipment` is given). Returns the box it stands in, and only once this client can actually SEE it — the blocks (and the entity) have to travel from the server, which no render can wait for. Then: `render {look_at:<that box>}` frames it, `frames:N` orbits it. `freeze` (default true for an entity) freezes the game's tick like /tick freeze once the subject has arrived, so animation phase, item-model animation and the enchantment glint hold still between two renders; `leave` unfreezes. `leave:true` sweeps your subject and puts the client back where it was standing; nothing else clears it, and one session cannot sweep another's. Moves a real player, so a human driving this client will find themselves in the studio until you leave.",
            Schemas.objectOpt(Schemas.object(
                    "id", Schemas.str("A loaded structure template to stand in the studio, e.g. \"mymod:cottage\". query_registry {registry:\"structure_template\"} lists them."),
                    "look_at", subjectSchema(),
                    "entity", Schemas.str("An entity type id to stand on the floor, e.g. minecraft:armor_stand (the default with `equipment`), minecraft:zombie, mymod:beast. No AI, no gravity, never saved; swept by leave."),
                    "equipment", Schemas.object(),
                    "yaw", Schemas.number("The entity's facing in degrees (default 135: toward the camera's stand)."),
                    "nbt", Schemas.str("Extra entity NBT in /summon's SNBT form, applied at spawn, e.g. {Small:1b}."),
                    "arms", Schemas.bool("armor_stand only: show arms (default true, so held items render)."),
                    "pose", Schemas.object(),
                    "freeze", Schemas.bool("Freeze the game tick once the subject is visible (default true with `entity`, false otherwise). leave restores."),
                    "leave", Schemas.bool("Sweep this session's staged subject and put the client back where it was. Takes no other argument.")),
                "id", "look_at", "entity", "equipment", "yaw", "nbt", "arms", "pose", "freeze", "leave"),
            ExecutionContext.CLIENT,
            // The honest tag, and the reason this is not an op on `render`: it writes blocks into a
            // dimension and teleports a player. The audit ledger records it for the same reason.
            Mechanism.WORLD_EDIT,
            StudioTools::studio)
            // Staging, a dimension change and a wait for the client's own copy of the blocks —
            // seconds of honest work. The cap is a cap, not a delay.
            .withTimeout(60));
    }

    // ---------------------------------------------------------------------------------------------

    private static CompletableFuture<JsonElement> studio(final ToolContext ctx, final JsonObject a) {
        final boolean leaving = has(a, "leave") && a.get("leave").getAsBoolean();
        final boolean hasId = has(a, "id");
        final boolean hasLook = has(a, "look_at");
        final boolean hasEntity = has(a, "entity") || has(a, "equipment");
        if (leaving) {
            if (hasId || hasLook || hasEntity) {
                throw new IllegalArgumentException("`leave` puts the client back and sweeps what it"
                    + " staged; a subject in the same call would be staged and immediately thrown"
                    + " away. Leave first, then stage.");
            }
            return leave(ctx);
        }
        final int subjects = (hasId ? 1 : 0) + (hasLook ? 1 : 0) + (hasEntity ? 1 : 0);
        if (subjects != 1) {
            throw new IllegalArgumentException(subjects > 1
                ? "a stage takes ONE subject: `id` for a loaded structure template, `look_at` for a box"
                    + " of blocks standing in this dimension, `entity` (with `equipment`) for a living"
                    + " one. More than one was given, and they are different subjects."
                : "give a subject — `id` for a loaded structure template, `look_at` for a box of"
                    + " blocks standing in the dimension the client is in, or `entity` / `equipment`"
                    + " for a living one — or `leave:true` to put the client back.");
        }
        return stage(ctx, a, hasId ? Identifier.parse(a.get("id").getAsString()) : null, hasEntity);
    }

    /**
     * Stage the subject, go there, and answer once the client can see it. Runs on the client thread
     * and completes its future seconds later; every failure after the teleport puts the player back.
     */
    private static CompletableFuture<JsonElement> stage(final ToolContext ctx, final JsonObject a,
                                                        final Identifier id, final boolean living) {
        final Minecraft mc = Minecraft.getInstance();
        final MinecraftServer server = ctx.server();
        if (server == null) {
            throw new IllegalStateException("the studio is staged on the SERVER and this client is not"
                + " running one. It works where the toolkit owns both ends — a singleplayer or dev"
                + " world. Against somebody else's server, photograph the subject where it stands with"
                + " render {look_at:…}.");
        }
        if (mc.level == null || mc.player == null) {
            throw new IllegalStateException("no level loaded — the client has to be in a world before"
                + " it can be moved to the studio");
        }
        if (!Canvas.present(server)) {
            throw new IllegalStateException(Canvas.absentMessage(server));
        }
        final BlockPos min = id == null && !living ? boxMin(a.getAsJsonObject("look_at")) : null;
        final Vec3i size = id == null && !living ? boxSize(a.getAsJsonObject("look_at")) : null;
        final ResourceKey<Level> from = mc.level.dimension();
        final UUID who = mc.player.getUUID();
        final String owner = owner(ctx);
        final boolean freeze = has(a, "freeze") ? a.get("freeze").getAsBoolean() : living;

        final CompletableFuture<JsonElement> out = new CompletableFuture<>();
        final long began = System.nanoTime();
        server.execute(() -> {
            final ServerPlayer player = server.getPlayerList().getPlayer(who);
            if (player == null) {
                out.completeExceptionally(new IllegalStateException("the server does not know this"
                    + " client's player (" + who + "), so it cannot be moved to the studio"));
                return;
            }
            final CanvasStage.Staged staged;
            UUID subject = null;
            try {
                if (living) {
                    final EntityType<?> type = entityType(a);
                    final Vec3i box = boxFor(type);
                    staged = CanvasStage.stageEmpty(server, owner, box, "entity "
                        + BuiltInRegistries.ENTITY_TYPE.getKey(type));
                    final ServerLevel studioLevel = Canvas.level(server, Canvas.STUDIO);
                    if (studioLevel == null) {
                        throw new IllegalStateException(Canvas.absentMessage(server));
                    }
                    final Entity spawned = spawnSubject(server, studioLevel, staged, type, a);
                    subject = spawned.getUUID();
                    CanvasStage.rememberEntity(owner, subject);
                } else if (id != null) {
                    staged = CanvasStage.stage(server, owner, id);
                } else {
                    final ServerLevel source = server.getLevel(from);
                    if (source == null) {
                        throw new IllegalStateException("the server has no level " + from.identifier()
                            + ", which is the dimension this client says it is in");
                    }
                    staged = CanvasStage.stage(server, owner, source, min, size);
                }
            } catch (final Exception e) {
                out.completeExceptionally(e);
                return;
            }
            final ServerLevel studio = Canvas.level(server, Canvas.STUDIO);
            if (studio == null) {
                out.completeExceptionally(new IllegalStateException(Canvas.absentMessage(server)));
                return;
            }
            // Remembered BEFORE the teleport and only if this session is not already away: a second
            // stage without a leave in between must not record the studio as somebody's home, which
            // is how a restore quietly becomes a no-op.
            final CanvasStage.Home home = CanvasStage.rememberHome(owner, new CanvasStage.Home(
                player.level().dimension(), player.getX(), player.getY(), player.getZ(),
                player.getYRot(), player.getXRot()));
            player.teleportTo(studio, staged.stand().getX() + 0.5, staged.stand().getY(),
                staged.stand().getZ() + 0.5, Set.of(), STAND_YAW, STAND_PITCH, true);
            await(server, who, home, staged, subject, freeze ? owner : null, began, out);
        });
        return out;
    }

    // ---------------------------------------------------------------------------------------------
    // the living subject (RELEASE_1.md section K3)

    /** Sessions holding the tick frozen. The last one out unfreezes. */
    private static final Set<String> FROZEN = java.util.concurrent.ConcurrentHashMap.newKeySet();

    /** Default facing: toward the stand the camera is put on (STAND_YAW looks back at it). */
    private static final float SUBJECT_YAW = 135.0F;

    private static EntityType<?> entityType(final JsonObject a) {
        final String idText = has(a, "entity") ? a.get("entity").getAsString() : "minecraft:armor_stand";
        final Identifier id;
        try {
            id = Identifier.parse(idText);
        } catch (final RuntimeException e) {
            throw new IllegalArgumentException("`entity` is not an id: '" + idText + "'");
        }
        return BuiltInRegistries.ENTITY_TYPE.getOptional(id).orElseThrow(() ->
            new IllegalArgumentException("no entity type " + id
                + "; query_registry {registry:\"entity_type\"} lists them"));
    }

    /** The subject's box: its hitbox rounded up, a block of margin around, a block of headroom. */
    private static Vec3i boxFor(final EntityType<?> type) {
        final int w = Math.max(1, (int) Math.ceil(type.getDimensions().width()));
        final int h = Math.max(1, (int) Math.ceil(type.getDimensions().height()));
        return new Vec3i(w + 2, h + 1, w + 2);
    }

    /**
     * Spawn the subject on the staged floor, still: /summon's own path ({@code loadEntityRecursive}
     * over the given NBT with the type id put in), then no AI, no gravity, invulnerable, silent,
     * never despawned, facing {@code yaw}; equipment through {@link ItemSyntax}; an armor stand gets
     * arms and its pose. Server thread.
     */
    private static Entity spawnSubject(final MinecraftServer server, final ServerLevel studio,
                                       final CanvasStage.Staged staged, final EntityType<?> type,
                                       final JsonObject a) {
        final Identifier typeId = BuiltInRegistries.ENTITY_TYPE.getKey(type);
        if (studio.getDifficulty() == Difficulty.PEACEFUL && !type.isAllowedInPeaceful()) {
            throw new IllegalArgumentException(typeId + " is not allowed in peaceful and this world is"
                + " peaceful - the game would remove it; stage a passive type or raise the difficulty");
        }
        final CompoundTag tag;
        try {
            tag = has(a, "nbt") ? TagParser.parseCompoundFully(a.get("nbt").getAsString()) : new CompoundTag();
        } catch (final com.mojang.brigadier.exceptions.CommandSyntaxException e) {
            throw new IllegalArgumentException("bad `nbt`: " + e.getMessage());
        }
        tag.putString("id", typeId.toString());
        final float yaw = has(a, "yaw") ? a.get("yaw").getAsFloat() : SUBJECT_YAW;
        final Vec3 pos = new Vec3(staged.origin().getX() + staged.size().getX() / 2.0,
            staged.origin().getY(), staged.origin().getZ() + staged.size().getZ() / 2.0);
        final Entity entity = EntityType.loadEntityRecursive(tag, studio,
            new EntitySpawnRequest(EntitySpawnReason.COMMAND, false), e -> {
                e.snapTo(pos.x, pos.y, pos.z, yaw, 0.0F);
                return e;
            });
        if (entity == null) {
            throw new IllegalStateException("the game made no " + typeId + " from that NBT");
        }
        entity.setNoGravity(true);
        entity.setInvulnerable(true);
        entity.setSilent(true);
        if (entity instanceof Mob mob) {
            mob.setNoAi(true);
            mob.setPersistenceRequired();
        }
        if (entity instanceof LivingEntity living) {
            living.setYBodyRot(yaw);
            living.setYHeadRot(yaw);
        }
        if (entity instanceof ArmorStand stand) {
            stand.setShowArms(!has(a, "arms") || a.get("arms").getAsBoolean());
            if (has(a, "pose")) {
                for (final Map.Entry<String, JsonElement> part : a.getAsJsonObject("pose").entrySet()) {
                    final Rotations r = rotations(part.getKey(), part.getValue());
                    switch (part.getKey()) {
                        case "head" -> stand.setHeadPose(r);
                        case "body" -> stand.setBodyPose(r);
                        case "left_arm" -> stand.setLeftArmPose(r);
                        case "right_arm" -> stand.setRightArmPose(r);
                        case "left_leg" -> stand.setLeftLegPose(r);
                        case "right_leg" -> stand.setRightLegPose(r);
                        default -> throw new IllegalArgumentException("`pose` parts are head, body,"
                            + " left_arm, right_arm, left_leg, right_leg; got '" + part.getKey() + "'");
                    }
                }
            }
        } else if (has(a, "pose") || has(a, "arms")) {
            throw new IllegalArgumentException("`pose` and `arms` are an armor stand's; " + typeId
                + " holds its rest pose");
        }
        if (has(a, "equipment")) {
            if (!(entity instanceof LivingEntity living)) {
                throw new IllegalArgumentException("`equipment` needs a living entity; " + typeId + " wears nothing");
            }
            for (final Map.Entry<String, JsonElement> slotEntry : a.getAsJsonObject("equipment").entrySet()) {
                final EquipmentSlot slot;
                try {
                    slot = EquipmentSlot.byName(slotEntry.getKey());
                } catch (final RuntimeException e) {
                    throw new IllegalArgumentException("`equipment` slots are head, chest, legs, feet,"
                        + " mainhand, offhand (and body, saddle where the type has them); got '"
                        + slotEntry.getKey() + "'");
                }
                living.setItemSlot(slot, ItemSyntax.parse(server.registryAccess(),
                    "equipment." + slotEntry.getKey(), slotEntry.getValue().getAsString(), 1));
            }
        }
        if (!studio.tryAddFreshEntityWithPassengers(entity)) {
            throw new IllegalStateException("the studio refused the entity (duplicate id)");
        }
        return entity;
    }

    private static Rotations rotations(final String part, final JsonElement value) {
        if (!value.isJsonArray() || value.getAsJsonArray().size() != 3) {
            throw new IllegalArgumentException("`pose." + part + "` is [x, y, z] degrees");
        }
        final var arr = value.getAsJsonArray();
        return new Rotations(arr.get(0).getAsFloat(), arr.get(1).getAsFloat(), arr.get(2).getAsFloat());
    }

    /** Freeze the tick for this owner (server thread), idempotent across sessions. */
    private static void freeze(final MinecraftServer server, final String owner) {
        FROZEN.add(owner);
        if (!server.tickRateManager().isFrozen()) {
            server.tickRateManager().setFrozen(true);
        }
    }

    /** This owner lets go; the tick runs again once nobody holds it. Returns whether it ran again. */
    private static boolean unfreeze(final MinecraftServer server, final String owner) {
        final boolean held = FROZEN.remove(owner);
        if (held && FROZEN.isEmpty() && server.tickRateManager().isFrozen()) {
            server.tickRateManager().setFrozen(false);
            return true;
        }
        return false;
    }

    /**
     * Wait for the client to actually have the subject, then answer.
     *
     * <p>The waiting happens on a thread of its own and asks the client thread each time through
     * {@code Minecraft.submit}. It cannot be a loop on the client thread: that thread is the one that
     * reads chunk packets, so a client thread sleeping until chunks arrive is a client thread that
     * has stopped them from arriving. That is the deadlock this method exists to not have.
     */
    private static void await(final MinecraftServer server, final UUID who, final CanvasStage.Home home,
                              final CanvasStage.Staged staged, final UUID subject, final String freezeFor,
                              final long began, final CompletableFuture<JsonElement> out) {
        final Minecraft mc = Minecraft.getInstance();
        final Thread thread = new Thread(() -> {
            boolean seen = false;
            final long deadline = System.nanoTime() + WAIT_MS * 1_000_000L;
            try {
                while (System.nanoTime() < deadline) {
                    seen = mc.submit(() -> visible(staged) && (subject == null || entityHere(subject)))
                        .get(5, TimeUnit.SECONDS);
                    if (seen) {
                        break;
                    }
                    Thread.sleep(POLL_MS);
                }
            } catch (final InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (final Exception e) {
                goHome(server, who, home);
                out.completeExceptionally(e);
                return;
            }
            final long waited = (System.nanoTime() - began) / 1_000_000L;
            if (!seen) {
                // The stage is LEFT STANDING on purpose: the blocks are on the server and something
                // about this client is why they are not here. Sweeping it would remove the evidence.
                goHome(server, who, home);
                out.completeExceptionally(new IllegalStateException("staged " + staged.from()
                    + " in the studio at slot " + staged.slot() + " and moved the client there, but"
                    + " after " + (WAIT_MS / 1000) + "s this client still had none of the "
                    + staged.witnesses().size() + " cells it was told to watch for. The blocks are on"
                    + " the server; they never arrived here. The client has been put back and the"
                    + " stage left standing — studio {leave:true} sweeps it."));
                return;
            }
            boolean frozen = false;
            if (freezeFor != null) {
                // AFTER the arrival, never before: the entity's spawn and equipment reach the client
                // through ticks, and a tick frozen first is a subject that never arrives.
                try {
                    server.submit(() -> freeze(server, freezeFor)).get(5, TimeUnit.SECONDS);
                    frozen = true;
                } catch (final Exception e) {
                    out.completeExceptionally(new IllegalStateException("the subject is staged and"
                        + " visible but the tick could not be frozen: " + e.getMessage(), e));
                    return;
                }
            }
            out.complete(report(staged, home, waited, subject, frozen));
        }, "mcptoolkit-studio-stage");
        thread.setDaemon(true);
        thread.start();
    }

    /**
     * Has the staged subject reached this client? Asked of the CLIENT's own level, never the
     * server's — that is the whole question. An unloaded chunk answers air here, so one predicate
     * covers both "the chunk has not arrived" and "the blocks in it have not".
     *
     * <p><b>And has this client's RENDERER got it</b> — the second half, found 2026-09-06. The block
     * state arriving in {@code mc.level} is not the section mesh being compiled, and a {@code render}
     * fired the moment the first was true photographed an empty white studio while reporting
     * {@code settled:true}: the section was not yet dirty, so the compile queue was honestly empty.
     * 1.5 s later the same camera saw the subject. {@code isSectionCompiledAndVisible} is vanilla's
     * own "can the player see this yet" (what the loading screen waits on), asked from the stand the
     * player was teleported to facing the subject, so it answers for exactly the frame the caller is
     * about to take.
     */
    /** Has the living subject reached this client's level? Asked by id, of the client's own copy. */
    private static boolean entityHere(final UUID subject) {
        final Minecraft mc = Minecraft.getInstance();
        if (mc.level == null) {
            return false;
        }
        for (final Entity e : mc.level.entitiesForRendering()) {
            if (subject.equals(e.getUUID())) {
                return true;
            }
        }
        return false;
    }

    private static boolean visible(final CanvasStage.Staged staged) {
        final Minecraft mc = Minecraft.getInstance();
        if (mc.level == null || !mc.level.dimension().equals(Canvas.STUDIO)) {
            return false;
        }
        for (final BlockPos p : staged.witnesses()) {
            if (mc.level.getBlockState(p).isAir()) {
                return false;
            }
        }
        for (final BlockPos p : staged.witnesses()) {
            if (!mc.levelRenderer.isSectionCompiledAndVisible(p)) {
                return false;
            }
        }
        return true;
    }

    // ---------------------------------------------------------------------------------------------
    // leave

    /** Sweep this session's subject and put the client back. Both halves, or the reply says which. */
    private static CompletableFuture<JsonElement> leave(final ToolContext ctx) {
        final MinecraftServer server = ctx.server();
        if (server == null) {
            throw new IllegalStateException("no server running — there is no studio to leave");
        }
        final String owner = owner(ctx);
        final CompletableFuture<JsonElement> out = new CompletableFuture<>();
        server.execute(() -> {
            try {
                final boolean hadEntity = CanvasStage.entityOf(owner) != null;
                final CanvasStage.Staged gone = CanvasStage.clear(server, owner);
                final CanvasStage.Home home = CanvasStage.takeHome(owner);
                final boolean ranAgain = unfreeze(server, owner);
                final Minecraft mc = Minecraft.getInstance();
                final UUID who = mc.player == null ? null : mc.player.getUUID();
                final JsonObject r = new JsonObject();
                r.addProperty("cleared", gone != null);
                if (hadEntity) {
                    r.addProperty("entity_discarded", true);
                }
                if (ranAgain) {
                    r.addProperty("unfrozen", true);
                }
                if (gone != null) {
                    r.addProperty("slot", gone.slot());
                    r.addProperty("from", gone.from());
                    r.addProperty("blocks", gone.blocks());
                }
                if (home != null && who != null) {
                    goHome(server, who, home);
                    final JsonObject back = new JsonObject();
                    back.addProperty("dimension", home.dimension().identifier().toString());
                    back.addProperty("x", round(home.x()));
                    back.addProperty("y", round(home.y()));
                    back.addProperty("z", round(home.z()));
                    r.add("returned", back);
                } else {
                    r.addProperty("returned", false);
                }
                if (gone == null && home == null) {
                    // Not a failure: "there is nothing of yours in the studio" is the answer.
                    r.addProperty("note", "this session had nothing staged and was not in the studio."
                        + " A stage belongs to the session that made it — another session's is not"
                        + " yours to sweep.");
                }
                r.addProperty("staged_now", CanvasStage.all().size());
                out.complete(r);
            } catch (final Exception e) {
                out.completeExceptionally(e);
            }
        });
        return out;
    }

    /** Put the player back. Fire-and-forget onto the server thread; never allowed to throw. */
    private static void goHome(final MinecraftServer server, final UUID who, final CanvasStage.Home home) {
        server.execute(() -> {
            final ServerPlayer player = server.getPlayerList().getPlayer(who);
            final ServerLevel level = server.getLevel(home.dimension());
            if (player == null || level == null) {
                return;
            }
            player.teleportTo(level, home.x(), home.y(), home.z(), Set.of(),
                home.yaw(), home.pitch(), true);
        });
    }

    // ---------------------------------------------------------------------------------------------
    // the reply

    /**
     * What was staged, where it stands, and the two calls that follow. The box is spelled out in the
     * same INCLUSIVE block coordinates {@code render}'s {@code look_at} takes, so the next call is a
     * copy rather than an arithmetic exercise.
     */
    private static JsonElement report(final CanvasStage.Staged staged, final CanvasStage.Home home,
                                      final long waited, final UUID subject, final boolean frozen) {
        final JsonObject r = new JsonObject();
        r.addProperty("dimension", Canvas.STUDIO.identifier().toString());
        r.addProperty("slot", staged.slot());
        r.addProperty("from", staged.from());
        r.addProperty("blocks", staged.blocks());
        if (subject != null) {
            r.addProperty("entity", subject.toString());
        }
        r.addProperty("frozen", frozen);
        final JsonObject box = new JsonObject();
        box.add("min", xyz(staged.origin()));
        box.add("max", xyz(staged.max()));
        r.add("look_at", box);
        r.add("client_at", xyz(staged.stand()));
        // What the round trip cost: staging, the dimension change and the wait for this client's own
        // copy of the blocks. A number worth having, because it is the part no render can see.
        r.addProperty("ms", waited);
        r.addProperty("next", "render {look_at:{min:{x:" + staged.origin().getX() + ",y:"
            + staged.origin().getY() + ",z:" + staged.origin().getZ() + "},max:{x:" + staged.max().getX()
            + ",y:" + staged.max().getY() + ",z:" + staged.max().getZ() + "}}} — add frames:N to orbit"
            + " it. Then studio {leave:true}, which sweeps this subject and puts the client back in "
            + home.dimension().identifier() + " at " + round(home.x()) + " " + round(home.y()) + " "
            + round(home.z()) + ".");
        return r;
    }

    /**
     * Who owns a stage: the calling session, so two agents photographing at once get two slots and
     * neither can sweep the other's. A caller that sends no session header shares one owner with
     * every other anonymous caller — the same bargain every session-scoped thing in this bridge makes.
     */
    private static String owner(final ToolContext ctx) {
        final String session = ctx.sessionId();
        return session == null || session.isBlank() ? "anonymous" : session;
    }

    // ---------------------------------------------------------------------------------------------
    // arguments

    /** The subject box: INCLUSIVE at both ends, the same box {@code render}'s {@code look_at} takes. */
    private static JsonObject subjectSchema() {
        final JsonObject o = Schemas.objectOpt(Schemas.object(
            "min", Schemas.vec3i("Lowest block of the subject."),
            "max", Schemas.vec3i("Highest block. Omit for a one-block subject.")), "max");
        o.addProperty("description", "A box of blocks standing in the dimension this client is in, in"
            + " BLOCK coordinates INCLUSIVE at both ends (so 100..108 is nine blocks). It is COPIED"
            + " into the studio; the originals stay where they are.");
        return o;
    }

    private static BlockPos boxMin(final JsonObject look) {
        final JsonObject min = look.getAsJsonObject("min");
        final JsonObject max = look.has("max") && !look.get("max").isJsonNull()
            ? look.getAsJsonObject("max") : min;
        return new BlockPos(
            Math.min(min.get("x").getAsInt(), max.get("x").getAsInt()),
            Math.min(min.get("y").getAsInt(), max.get("y").getAsInt()),
            Math.min(min.get("z").getAsInt(), max.get("z").getAsInt()));
    }

    private static Vec3i boxSize(final JsonObject look) {
        final JsonObject min = look.getAsJsonObject("min");
        final JsonObject max = look.has("max") && !look.get("max").isJsonNull()
            ? look.getAsJsonObject("max") : min;
        return new Vec3i(
            Math.abs(max.get("x").getAsInt() - min.get("x").getAsInt()) + 1,
            Math.abs(max.get("y").getAsInt() - min.get("y").getAsInt()) + 1,
            Math.abs(max.get("z").getAsInt() - min.get("z").getAsInt()) + 1);
    }

    private static JsonObject xyz(final BlockPos p) {
        final JsonObject o = new JsonObject();
        o.addProperty("x", p.getX());
        o.addProperty("y", p.getY());
        o.addProperty("z", p.getZ());
        return o;
    }

    private static double round(final double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    private static boolean has(final JsonObject a, final String key) {
        return a.has(key) && !a.get(key).isJsonNull();
    }
}
