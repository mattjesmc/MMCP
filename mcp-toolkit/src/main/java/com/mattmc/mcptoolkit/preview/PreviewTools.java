package com.mattmc.mcptoolkit.preview;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import com.mattmc.mcptoolkit.WorldPerceptionTools;
import com.mattmc.mcptoolkit.drone.DroneEntities;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.ai.attributes.AttributeInstance;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.level.entity.EntityTypeTest;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * {@code stage_entity} — the whole bridge surface of the entity editor
 * (ENTITY_AUTHORING_DESIGN.md §5.1), and deliberately ONE manifest entry rather than a family.
 *
 * <p>The place-shapes lesson priced that decision before it was made: a manifest entry is re-read on
 * every turn of every session that carries it, and the SCHEMA is the bigger half of the bill
 * (TOKEN_PER_TOOL_FINDINGS.md findings 4-6). Three ops sharing one field table cost one entry; three
 * tools would have cost three, for the same capability.
 *
 * <p>The server's half of the loop is small on purpose: it spawns a body, tells it a model ID and a
 * hitbox, and asks the client whether that ID parsed ({@link PreviewStatus}). Geometry itself is
 * never read here — {@code client/PreviewModels} is the one interpreter.
 */
public final class PreviewTools {
    private PreviewTools() {}

    /** The stage slot a call gets when it names none: one subject, re-staged as it is edited. */
    private static final String DEFAULT_TAG = "preview";
    /** How far in front of an author a preview lands when the call gives no {@code pos}. */
    private static final double DEFAULT_DISTANCE = 3.0;

    public static void register() {
        McpTools.register(ToolDef.of(
            "stage_entity",
            "Stage a PREVIEW ENTITY wearing authored geometry, so a model is judged by the game's own"
                + " rendering. `op`: \"stage\" spawns one wearing `model` — an interchange file at"
                + " assets/mcptoolkit/preview/<model>.json, put there with push_asset; re-staging the"
                + " same `tag` replaces it, `replace`:false accumulates (a contact sheet is a grid of"
                + " stages, not a mode). \"clear\" despawns them (one `tag`, or all). \"list\" reports"
                + " what is staged where, wearing what. The reply's `parse` is the CLIENT's verdict on"
                + " the geometry — \"ok\", or \"error\" with `parse_error`, so broken geometry is"
                + " learned without a screenshot (it renders as a magenta error cube), or"
                + " \"no_client\" on a dedicated server, where nothing in this JVM reads models."
                + " A format-2 model carries authored CLIPS: the reply lists them in `clips`,"
                + " `clip` plays one, and `clip_time` freezes it at a second so a mid-clip"
                + " pose can be screenshotted."
                + " Previews never persist, never move and take no damage.",
            schema(),
            ExecutionContext.SERVER,
            Mechanism.PRIVILEGED,
            (ctx, a) -> run(ctx.serverOrThrow(), a)));
    }

    private static JsonObject schema() {
        JsonObject pos = Schemas.object("x", Schemas.number(), "y", Schemas.number(),
            "z", Schemas.number());
        pos.addProperty("description",
            "Where to stage it. Default: " + (int) DEFAULT_DISTANCE + " blocks in front of a player.");
        JsonObject size = Schemas.array(Schemas.number());
        size.addProperty("description",
            "Hitbox [width, height] in blocks (default [1,1]); the exporter passes the model's bounds.");
        return Schemas.objectOpt(
            Schemas.object(
                "op", Schemas.str("stage | clear | list"),
                "model", Schemas.str("stage: the asset id under assets/mcptoolkit/preview/, no .json."),
                "tag", Schemas.str("Stage slot (default \"" + DEFAULT_TAG + "\"); what clear names."),
                "pos", pos,
                "dimension", Schemas.str("Default minecraft:overworld; the reply stamps what was used."),
                "yaw", Schemas.number("Facing, degrees. Default: turned toward the nearest player."),
                "spin", Schemas.bool("Slow turntable instead of a held yaw — every side, no walking."),
                "scale", Schemas.number("Render and hitbox multiplier (default 1)."),
                "size", size,
                "replace", Schemas.bool("stage: replace the same tag (default true)."),
                "clip", Schemas.str("stage: an authored clip to play; the reply lists `clips`."),
                "clip_time", Schemas.number("stage: freeze `clip` at this second, don't play.")),
            "model", "tag", "pos", "dimension", "yaw", "spin", "scale", "size", "replace",
            "clip", "clip_time");
    }

    private static JsonElement run(final MinecraftServer server, final JsonObject a) {
        String op = a.has("op") && !a.get("op").isJsonNull() ? a.get("op").getAsString() : null;
        if (op == null) {
            throw new IllegalArgumentException("missing `op` (stage | clear | list)");
        }
        return switch (op) {
            case "stage" -> stage(server, a);
            case "clear" -> clear(server, a);
            case "list" -> list(server);
            default -> throw new IllegalArgumentException(
                "unknown `op` '" + op + "' (stage | clear | list)");
        };
    }

    // ---- stage ---------------------------------------------------------------

    private static JsonElement stage(final MinecraftServer server, final JsonObject a) {
        // EVERY argument is parsed before anything is spawned. A bad `size` that refused only after
        // the body existed would leave a stray preview standing in the world for every typo — the
        // no-half-apply rule place_shapes learned, at entity scale.
        if (!a.has("model") || a.get("model").isJsonNull()) {
            throw new IllegalArgumentException("stage needs a `model` — the asset id under "
                + "assets/mcptoolkit/preview/ (push_asset puts it there)");
        }
        String model = a.get("model").getAsString();
        String tag = a.has("tag") && !a.get("tag").isJsonNull() ? a.get("tag").getAsString() : DEFAULT_TAG;
        // Shape checks BEFORE world resolution, so a malformed `size` is answered with the truth
        // about `size` rather than with whatever the position default happened to complain about
        // first (on a headless server with nobody logged in, that is "there is nobody to stage in
        // front of" — a true sentence about the wrong argument).
        float[] size = size(a);
        Double scale = a.has("scale") && !a.get("scale").isJsonNull() ? a.get("scale").getAsDouble() : null;
        if (scale != null && (scale <= 0.0 || scale > 16.0)) {
            throw new IllegalArgumentException("`scale` must be above 0 and at most 16");
        }
        ServerLevel level = WorldPerceptionTools.levelArg(server, a);
        Vec3 pos = stagePos(level, a);
        float yaw = a.has("yaw") && !a.get("yaw").isJsonNull()
            ? a.get("yaw").getAsFloat() : facingNearestPlayer(level, pos);
        boolean spin = a.has("spin") && !a.get("spin").isJsonNull() && a.get("spin").getAsBoolean();
        boolean replace = !a.has("replace") || a.get("replace").isJsonNull()
            || a.get("replace").getAsBoolean();
        String clip = a.has("clip") && !a.get("clip").isJsonNull() ? a.get("clip").getAsString() : "";
        float clipTime = PreviewEntity.PLAY;
        if (a.has("clip_time") && !a.get("clip_time").isJsonNull()) {
            clipTime = a.get("clip_time").getAsFloat();
            if (clipTime < 0.0F) {
                throw new IllegalArgumentException("`clip_time` is seconds from the start of"
                    + " the clip and cannot be negative — omit it to play the clip instead");
            }
            if (clip.isEmpty()) {
                throw new IllegalArgumentException("`clip_time` needs a `clip` to be a time INTO");
            }
        }

        int replaced = replace ? despawn(server, tag) : 0;
        PreviewEntity preview = DroneEntities.PREVIEW.spawn(level, BlockPos.containing(pos),
            EntitySpawnReason.MOB_SUMMONED);
        if (preview == null) {
            throw new IllegalStateException("could not stage a preview at "
                + BlockPos.containing(pos).toShortString());
        }
        preview.snapTo(pos.x, pos.y, pos.z, yaw, 0.0F);
        preview.setYBodyRot(yaw);
        preview.setYHeadRot(yaw);
        preview.setModelId(model);
        preview.setTag(tag);
        preview.setSpinning(spin);
        preview.setClip(clip, clipTime);
        preview.setStageSize(size[0], size[1]);
        if (scale != null) {
            AttributeInstance attribute = preview.getAttribute(Attributes.SCALE);
            if (attribute != null) {
                attribute.setBaseValue(scale);
            }
            preview.refreshDimensions();
        }

        JsonObject r = describe(preview, level);
        r.addProperty("replaced", replaced);
        return r;
    }

    /**
     * Where a stage with no {@code pos} goes: in front of whoever is looking. The alternative — a
     * hard default like the world spawn — stages the subject somewhere nobody is standing, which for
     * an authoring loop whose whole product is a screenshot is a stage that may as well not exist.
     */
    private static Vec3 stagePos(final ServerLevel level, final JsonObject a) {
        if (a.has("pos") && !a.get("pos").isJsonNull()) {
            JsonObject p = a.getAsJsonObject("pos");
            for (String axis : new String[] {"x", "y", "z"}) {
                if (!p.has(axis) || p.get(axis).isJsonNull()) {
                    throw new IllegalArgumentException("`pos` needs x, y and z");
                }
            }
            return new Vec3(p.get("x").getAsDouble(), p.get("y").getAsDouble(), p.get("z").getAsDouble());
        }
        List<ServerPlayer> players = level.players();
        if (players.isEmpty()) {
            throw new IllegalArgumentException("no `pos`, and nobody is in "
                + level.dimension().identifier() + " to stage in front of");
        }
        ServerPlayer player = players.get(0);
        Vec3 look = player.getLookAngle();
        Vec3 flat = new Vec3(look.x, 0.0, look.z);
        flat = flat.lengthSqr() < 1.0e-4 ? new Vec3(0.0, 0.0, 1.0) : flat.normalize();
        return player.position().add(flat.scale(DEFAULT_DISTANCE));
    }

    /** Yaw that turns a stage toward the nearest player, or 0 when the level is empty. */
    private static float facingNearestPlayer(final ServerLevel level, final Vec3 pos) {
        ServerPlayer nearest = null;
        double best = Double.MAX_VALUE;
        for (ServerPlayer p : level.players()) {
            double d = p.position().distanceToSqr(pos);
            if (d < best) {
                best = d;
                nearest = p;
            }
        }
        if (nearest == null) {
            return 0.0F;
        }
        double dx = nearest.getX() - pos.x;
        double dz = nearest.getZ() - pos.z;
        return Mth.wrapDegrees((float) (Mth.atan2(dz, dx) * (180.0 / Math.PI)) - 90.0F);
    }

    private static float[] size(final JsonObject a) {
        if (!a.has("size") || a.get("size").isJsonNull()) {
            return new float[] {1.0F, 1.0F};
        }
        JsonArray size = a.getAsJsonArray("size");
        if (size.size() != 2) {
            throw new IllegalArgumentException("`size` is [width, height] in blocks");
        }
        float w = size.get(0).getAsFloat();
        float h = size.get(1).getAsFloat();
        if (w <= 0.0F || h <= 0.0F || w > 64.0F || h > 64.0F) {
            throw new IllegalArgumentException("`size` must be positive and at most 64 blocks");
        }
        return new float[] {w, h};
    }

    // ---- clear / list --------------------------------------------------------

    private static JsonElement clear(final MinecraftServer server, final JsonObject a) {
        String tag = a.has("tag") && !a.get("tag").isJsonNull() ? a.get("tag").getAsString() : null;
        JsonObject r = new JsonObject();
        r.addProperty("cleared", despawn(server, tag));
        if (tag != null) {
            r.addProperty("tag", tag);
        }
        return r;
    }

    private static JsonElement list(final MinecraftServer server) {
        JsonArray staged = new JsonArray();
        for (ServerLevel level : server.getAllLevels()) {
            for (PreviewEntity preview : previews(level)) {
                staged.add(describe(preview, level));
            }
        }
        JsonObject r = new JsonObject();
        r.addProperty("count", staged.size());
        r.add("staged", staged);
        return r;
    }

    /**
     * Despawn every staged preview, or every one wearing {@code tag}. Swept across all LOADED levels:
     * a preview in an unloaded chunk cannot be reached, and does not need to be — it is never saved,
     * so it dies with the chunk rather than lingering the way a forceloaded probe site does.
     */
    private static int despawn(final MinecraftServer server, final @Nullable String tag) {
        int removed = 0;
        for (ServerLevel level : server.getAllLevels()) {
            for (PreviewEntity preview : previews(level)) {
                if (tag == null || tag.equals(preview.tag())) {
                    preview.discard();
                    removed++;
                }
            }
        }
        return removed;
    }

    private static List<PreviewEntity> previews(final ServerLevel level) {
        return new ArrayList<>(level.getEntities(EntityTypeTest.forClass(PreviewEntity.class),
            e -> !e.isRemoved()));
    }

    private static JsonObject describe(final PreviewEntity preview, final ServerLevel level) {
        JsonObject o = new JsonObject();
        o.addProperty("id", preview.getId());
        o.addProperty("uuid", preview.getUUID().toString());
        o.addProperty("tag", preview.tag());
        o.addProperty("model", preview.modelId());
        JsonObject pos = new JsonObject();
        pos.addProperty("x", preview.getX());
        pos.addProperty("y", preview.getY());
        pos.addProperty("z", preview.getZ());
        o.add("pos", pos);
        o.addProperty("dimension", level.dimension().identifier().toString());
        o.addProperty("yaw", preview.getYRot());
        o.addProperty("spin", preview.spinning());
        // The clips live in the geometry file, which only the client reads (§4.3) — so they reach
        // an author the same way a parse error does, through the probe. Without it the only way
        // to learn a clip name over the bridge is to guess one and read the refusal.
        Set<String> clips = PreviewStatus.clipsOf(preview.modelId());
        if (!clips.isEmpty()) {
            JsonArray names = new JsonArray();
            clips.forEach(names::add);
            o.add("clips", names);
        }
        if (!preview.clip().isEmpty()) {
            o.addProperty("clip", preview.clip());
            if (preview.clipTime() >= 0.0F) {
                o.addProperty("clip_time", preview.clipTime());
            }
            if (PreviewStatus.available() && !clips.contains(preview.clip())) {
                o.addProperty("clip_error", "no clip named '" + preview.clip() + "' in this model"
                    + (clips.isEmpty() ? " — it carries none"
                        : " (it has: " + String.join(", ", clips) + ")")
                    + "; it is standing in the rest pose");
            }
        }
        JsonArray size = new JsonArray();
        size.add(preview.stageWidth());
        size.add(preview.stageHeight());
        o.add("size", size);
        o.addProperty("parse", PreviewStatus.statusOf(preview.modelId()));
        String error = PreviewStatus.errorFor(preview.modelId());
        if (error != null) {
            o.addProperty("parse_error", error);
        }
        return o;
    }
}
