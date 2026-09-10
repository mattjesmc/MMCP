package com.mattmc.mcptoolkit.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.preview.PreviewStatus;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.client.animation.AnimationChannel;
import net.minecraft.client.animation.AnimationDefinition;
import net.minecraft.client.animation.Keyframe;
import net.minecraft.client.animation.KeyframeAnimation;
import net.minecraft.client.model.geom.ModelPart;
import net.minecraft.client.model.geom.PartPose;
import net.minecraft.client.model.geom.builders.CubeDeformation;
import net.minecraft.client.model.geom.builders.CubeListBuilder;
import net.minecraft.client.model.geom.builders.LayerDefinition;
import net.minecraft.client.model.geom.builders.MeshDefinition;
import net.minecraft.client.model.geom.builders.PartDefinition;
import net.minecraft.client.renderer.texture.MissingTextureAtlasSprite;
import net.minecraft.resources.Identifier;
import net.minecraft.server.packs.resources.Resource;
import org.jspecify.annotations.Nullable;

import org.joml.Vector3f;

import java.io.BufferedReader;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * <b>The one interpreter.</b> Exactly one piece of code in this workspace turns interchange geometry
 * into {@link ModelPart}s, and this is it (ENTITY_AUTHORING_DESIGN.md §4.2, importing menagerie
 * ROADMAP §45.2 rule 4). The Blockbench plugin converts FILE FORMATS; it never interprets geometry,
 * never derives facts from it, and never renders a preview of its own — what an author judges is the
 * game's own rendering of this bake.
 *
 * <p><b>The format is the file format.</b> Geometry is read off the RESOURCE MANAGER
 * ({@code assets/mcptoolkit/preview/<id>.json}), so a file pushed into the live pack and the same
 * file promoted into a mod jar load through identical code — there is no "live" path that could
 * drift from the shipped one.
 *
 * <p><b>Units are vanilla model space, not Blockbench space</b> (§4.1): pivots and cube origins in
 * entity-model pixels with y DOWN (a part posed at y=24 sits at the feet), and part rotations in
 * RADIANS — the units {@code PartPose.offsetAndRotation} takes. Every field maps 1:1 onto
 * {@code addOrReplaceChild}, which is the point: the y-flip, the x16 scale and the Euler-order
 * change all happen once, in the plugin's exporter, so there is no second implementation of them
 * here to drift out of step. (Animation keyframes are the deliberate exception and are stored as
 * AUTHORED — see §9.1 — because vanilla's own {@code KeyframeAnimations} converts them at apply
 * time, and this loader will route through that same conversion rather than a copy of it.)
 *
 * <p><b>Invalidation is a generation counter</b> bumped by {@link AssetTools} whenever a push or a
 * clear touches {@code assets/mcptoolkit/preview/} (and on any reload, which is cheaper than being
 * wrong). A cached bake carries the generation it was made at; a stale one is simply re-read on next
 * use. That is what makes an edit-push-look loop honest: a bad push never leaves the old geometry on
 * screen pretending to be the new one.
 *
 * <p><b>A parse failure is never a crash and never silence.</b> It bakes the ERROR MODEL — a cube
 * in vanilla's own missing-texture magenta — and keeps the message, which
 * {@code stage_entity} echoes through {@link PreviewStatus} so a headless author learns about broken
 * geometry without taking a screenshot.
 *
 * <p><b>Threading.</b> {@link #modelOf} runs on the render thread; {@link #errorFor} is called from
 * the SERVER thread through {@link PreviewStatus}. Both may therefore bake. Baking touches no GL (it
 * builds plain vertex records), and reading a resource off a pack is work vanilla itself does from
 * worker threads during every reload; the cache is a {@link ConcurrentHashMap} and a double bake of
 * the same id is wasteful, not wrong.
 */
@Environment(EnvType.CLIENT)
public final class PreviewModels {
    private PreviewModels() {}

    /** Pack directory the interchange files live in, under {@code assets/mcptoolkit/}. */
    public static final String DIR = "preview/";
    /** The pack-relative prefix {@code push_asset} writes to — the string the errors quote back. */
    public static final String PACK_PREFIX = "assets/" + McpToolkit.MOD_ID + "/" + DIR;
    /**
     * Highest interchange format this loader speaks. A format-1 file is a format-2 file with no
     * {@code animations} key (§9.5), so both are read by exactly this code and nothing that was
     * pushed before phase 4 needs re-exporting.
     */
    private static final int FORMAT = 2;

    private record Baked(int generation, PreviewModel model, Identifier texture, @Nullable String error) {}

    private static final Map<String, Baked> CACHE = new ConcurrentHashMap<>();
    private static final AtomicInteger GENERATION = new AtomicInteger();
    private static volatile @Nullable PreviewModel errorModel;

    /** Installs the server-visible parse probe. Called once, from {@code McpToolkitClient.init}. */
    public static void register() {
        PreviewStatus.install(new PreviewStatus.Probe() {
            @Override
            public @Nullable String errorFor(final String modelId) {
                return PreviewModels.errorFor(modelId);
            }

            @Override
            public Set<String> clipsOf(final String modelId) {
                return PreviewModels.clipsOf(modelId);
            }
        });
    }

    /** Drop every cached bake: the next use re-reads the pack. Cheap — one integer. */
    public static void invalidate() {
        GENERATION.incrementAndGet();
    }

    /** The model for this id — the error model if it could not be read. Never null. */
    public static PreviewModel modelOf(final String modelId) {
        return entry(modelId).model();
    }

    /** The texture that model declares — vanilla's missing-texture checkerboard on any failure. */
    public static Identifier textureOf(final String modelId) {
        return entry(modelId).texture();
    }

    /** Why this id could not be loaded, or null when it loaded clean. */
    public static @Nullable String errorFor(final String modelId) {
        return entry(modelId).error();
    }

    /** The clips this id carries — empty for a format-1 model, and for one that failed to load. */
    public static Set<String> clipsOf(final String modelId) {
        return entry(modelId).model().clipNames();
    }

    /**
     * The error marker: a half-block cube in vanilla's own missing-texture magenta, floating where
     * the model should have been. Also the renderer's construction-time model (§4.3), because a
     * renderer exists long before any model id does and "no geometry yet" should look like it.
     *
     * <p>The UV numbers are load-bearing, not arbitrary. {@code missingno} is a 16x16 image that is
     * pink exactly where {@code y < h/2 ^ x < w/2} — top-right and bottom-left. An 8px cube's box UV
     * spans 32x16 texture pixels, so declaring the sheet 64x64 and starting at (32, 0) puts EVERY
     * face inside the top-right quadrant and the whole cube comes out uniformly magenta. The
     * obvious version — a 16px cube at (0, 0) — straddles all four quadrants, and the faces an
     * author actually looks at came out solid black, which reads as an unlit model rather than as a
     * failure.
     */
    public static PreviewModel errorModel() {
        PreviewModel made = errorModel;
        if (made == null) {
            MeshDefinition mesh = new MeshDefinition();
            mesh.getRoot().addOrReplaceChild(
                "error",
                CubeListBuilder.create().texOffs(32, 0).addBox(-4.0F, -12.0F, -4.0F, 8.0F, 8.0F, 8.0F),
                PartPose.offset(0.0F, 24.0F, 0.0F));
            made = new PreviewModel(LayerDefinition.create(mesh, 64, 64).bakeRoot(), Map.of());
            errorModel = made;
        }
        return made;
    }

    // ---- cache ---------------------------------------------------------------

    private static Baked entry(final String modelId) {
        int gen = GENERATION.get();
        Baked cached = CACHE.get(modelId);
        if (cached != null && cached.generation() == gen) {
            return cached;
        }
        Baked made = load(modelId, gen);
        CACHE.put(modelId, made);
        return made;
    }

    private static Baked failed(final int generation, final String message) {
        return new Baked(generation, errorModel(), MissingTextureAtlasSprite.getLocation(), message);
    }

    private static Baked load(final String modelId, final int generation) {
        if (modelId == null || modelId.isEmpty()) {
            return failed(generation, "no model id on this preview");
        }
        Identifier asset;
        try {
            asset = assetId(modelId);
        } catch (Exception e) {
            return failed(generation, e.getMessage());
        }
        try {
            Optional<Resource> resource = Minecraft.getInstance().getResourceManager().getResource(asset);
            if (resource.isEmpty()) {
                return failed(generation, "no geometry at " + asset + " — push "
                    + PACK_PREFIX + modelId + ".json first");
            }
            JsonObject root;
            try (BufferedReader reader = resource.get().openAsReader()) {
                root = JsonParser.parseReader(reader).getAsJsonObject();
            }
            ModelPart part = bake(root);
            return new Baked(generation, new PreviewModel(part, clips(root, part)), texture(root),
                null);
        } catch (Exception e) {
            String message = e.getMessage() == null ? e.toString() : e.getMessage();
            McpToolkit.LOGGER.warn("[MCP Toolkit] preview model '{}' failed to load: {}", modelId, message);
            return failed(generation, message);
        }
    }

    /** {@code <id>} to {@code mcptoolkit:preview/<id>.json}, refusing anything that escapes it. */
    static Identifier assetId(final String modelId) {
        if (modelId.contains("..") || modelId.startsWith("/") || modelId.endsWith("/")) {
            throw new IllegalArgumentException("bad model id '" + modelId + "'");
        }
        Identifier id = Identifier.tryBuild(McpToolkit.MOD_ID, DIR + modelId + ".json");
        if (id == null) {
            throw new IllegalArgumentException("bad model id '" + modelId
                + "' — lower case, digits, and . _ - / only");
        }
        return id;
    }

    // ---- the interpreter -----------------------------------------------------

    private static Identifier texture(final JsonObject root) {
        JsonObject texture = root.getAsJsonObject("texture");
        if (texture == null || !texture.has("asset") || texture.get("asset").isJsonNull()) {
            return MissingTextureAtlasSprite.getLocation();
        }
        return Identifier.parse(texture.get("asset").getAsString());
    }

    private static ModelPart bake(final JsonObject root) {
        int format = root.has("format") ? root.get("format").getAsInt() : FORMAT;
        if (format < 1 || format > FORMAT) {
            throw new IllegalArgumentException("format " + format + " is not readable by this toolkit"
                + " (it speaks 1 to " + FORMAT + "; 2 adds animations)");
        }
        JsonObject texture = root.getAsJsonObject("texture");
        int texWidth = texture != null && texture.has("width") ? texture.get("width").getAsInt() : 64;
        int texHeight = texture != null && texture.has("height") ? texture.get("height").getAsInt() : 64;
        JsonArray parts = root.getAsJsonArray("parts");
        if (parts == null || parts.isEmpty()) {
            throw new IllegalArgumentException("no `parts` — a model with no parts renders nothing,"
                + " which is indistinguishable from a model that never loaded");
        }

        MeshDefinition mesh = new MeshDefinition();
        // Flat list + `parent` by name, resolved in file order: a part may only name a parent that
        // came before it. That rule is what makes a cycle unrepresentable rather than a stack
        // overflow at bake time, and it is the same shape menagerie's AuthoredSets.PART_CODEC uses.
        Map<String, PartDefinition> defined = new HashMap<>();
        for (JsonElement element : parts) {
            JsonObject part = element.getAsJsonObject();
            String name = string(part, "name", null);
            if (name == null || name.isEmpty()) {
                throw new IllegalArgumentException("a part has no `name`");
            }
            if (defined.containsKey(name)) {
                throw new IllegalArgumentException("two parts named '" + name + "'");
            }
            String parent = string(part, "parent", null);
            PartDefinition into;
            if (parent == null || parent.isEmpty()) {
                into = mesh.getRoot();
            } else {
                into = defined.get(parent);
                if (into == null) {
                    throw new IllegalArgumentException("part '" + name + "' names parent '" + parent
                        + "', which is not defined above it — parents come first in `parts`");
                }
            }
            float[] pivot = vec3(part, "pivot", name);
            float[] rotation = vec3(part, "rotation", name);
            defined.put(name, into.addOrReplaceChild(name, cubes(part, name),
                PartPose.offsetAndRotation(pivot[0], pivot[1], pivot[2],
                    rotation[0], rotation[1], rotation[2])));
        }
        return LayerDefinition.create(mesh, texWidth, texHeight).bakeRoot();
    }


    // ---- animation (§9.2) ----------------------------------------------------

    /**
     * The clips in a format-2 file, baked against the model that was just built.
     *
     * <p><b>There is no arithmetic here, and that is the design decision.</b> §9.1 first proposed
     * storing keyframes in Blockbench's authored units and converting them here through vanilla's
     * {@code KeyframeAnimations} helpers. That would have been half a conversion: the helpers do
     * only vanilla's half of the flip ({@code posVec} negates y), while the other half — negating x
     * on position and x,y on rotation — belongs to Blockbench's exporter. A loader written from
     * {@code KeyframeAnimations.java} alone implements exactly half and mirrors every animation's x
     * translation, which is invisible on a symmetric subject and therefore on most of this
     * workspace. So the plugin does the WHOLE conversion and writes the numbers
     * {@code ModelPart::offsetPos/offsetRotation/offsetScale} actually receive — the same rule §4.1
     * already applies to geometry, for the same reason: every trap lives in one place, on the side
     * that has a harness to walk it.
     *
     * <p><b>The unknown-bone throw is the point of baking here.</b> {@code AnimationDefinition.bake}
     * resolves every bone name against the model and throws when one is missing; doing it at load
     * time routes that into the same error surface as bad geometry (§4.2) — magenta error model
     * plus a message on {@code stage_entity}'s {@code parse} status — instead of letting it
     * surface as an exception mid-frame, which is a render crash.
     */
    private static Map<String, KeyframeAnimation> clips(final JsonObject root, final ModelPart part) {
        JsonObject animations = root.getAsJsonObject("animations");
        if (animations == null || animations.isEmpty()) {
            return Map.of();
        }
        Map<String, KeyframeAnimation> baked = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> entry : animations.entrySet()) {
            String name = entry.getKey();
            if (!entry.getValue().isJsonObject()) {
                throw new IllegalArgumentException("clip '" + name + "' is not an object");
            }
            AnimationDefinition definition = clip(name, entry.getValue().getAsJsonObject());
            try {
                baked.put(name, definition.bake(part));
            } catch (IllegalArgumentException e) {
                // Vanilla's message names the bone but not the clip, and an author with six clips
                // needs to know which one to open.
                throw new IllegalArgumentException("clip '" + name + "': " + e.getMessage(), e);
            }
        }
        return baked;
    }

    private static AnimationDefinition clip(final String name, final JsonObject clip) {
        if (!clip.has("length") || clip.get("length").isJsonNull()) {
            throw new IllegalArgumentException("clip '" + name + "' has no `length`");
        }
        float length = clip.get("length").getAsFloat();
        if (!(length > 0.0F)) {
            throw new IllegalArgumentException("clip '" + name + "' has length " + length
                + " — a clip of no length divides by zero when it loops");
        }
        AnimationDefinition.Builder builder = AnimationDefinition.Builder.withLength(length);
        if (clip.has("loop") && !clip.get("loop").isJsonNull() && clip.get("loop").getAsBoolean()) {
            builder.looping();
        }
        JsonObject bones = clip.getAsJsonObject("bones");
        if (bones == null || bones.isEmpty()) {
            throw new IllegalArgumentException("clip '" + name + "' animates no bones — it would"
                + " bake clean and do nothing, which is indistinguishable from a clip that failed");
        }
        for (Map.Entry<String, JsonElement> bone : bones.entrySet()) {
            JsonArray channels = bone.getValue().getAsJsonArray();
            if (channels == null || channels.isEmpty()) {
                throw new IllegalArgumentException("clip '" + name + "' bone '" + bone.getKey()
                    + "' has no channels");
            }
            for (JsonElement element : channels) {
                builder.addAnimation(bone.getKey(),
                    channel(name, bone.getKey(), element.getAsJsonObject()));
            }
        }
        return builder.build();
    }

    private static AnimationChannel channel(final String clip, final String bone,
                                            final JsonObject channel) {
        String target = string(channel, "target", null);
        AnimationChannel.Target which = switch (target == null ? "" : target) {
            case "position" -> AnimationChannel.Targets.POSITION;
            case "rotation" -> AnimationChannel.Targets.ROTATION;
            case "scale" -> AnimationChannel.Targets.SCALE;
            default -> throw new IllegalArgumentException("clip '" + clip + "' bone '" + bone
                + "': unknown channel `target` '" + target + "' (position | rotation | scale)");
        };
        JsonArray frames = channel.getAsJsonArray("keyframes");
        if (frames == null || frames.isEmpty()) {
            throw new IllegalArgumentException("clip '" + clip + "' bone '" + bone + "' "
                + target + " has no `keyframes`");
        }
        Keyframe[] keyframes = new Keyframe[frames.size()];
        float previous = Float.NEGATIVE_INFINITY;
        for (int i = 0; i < frames.size(); i++) {
            JsonObject frame = frames.get(i).getAsJsonObject();
            String where = "clip '" + clip + "' bone '" + bone + "' " + target + " keyframe " + i;
            if (!frame.has("t") || frame.get("t").isJsonNull()) {
                throw new IllegalArgumentException(where + " has no `t`");
            }
            float t = frame.get("t").getAsFloat();
            // Vanilla's Entry.apply BINARY SEARCHES the keyframe array, so an out-of-order file
            // does not throw — it silently poses the model off a segment that does not exist.
            if (t < previous) {
                throw new IllegalArgumentException(where + " is at t=" + t + ", before the one"
                    + " above it at t=" + previous + " — keyframes are read in file order");
            }
            previous = t;
            Vector3f post = vector(frame, "post", where);
            Vector3f pre = frame.has("pre") && !frame.get("pre").isJsonNull()
                ? vector(frame, "pre", where) : post;
            String interpolation = string(frame, "interp", "linear");
            AnimationChannel.Interpolation how = switch (interpolation) {
                case "linear" -> AnimationChannel.Interpolations.LINEAR;
                case "catmullrom" -> AnimationChannel.Interpolations.CATMULLROM;
                default -> throw new IllegalArgumentException(where + ": unknown `interp` '"
                    + interpolation + "' (linear | catmullrom — a step is written as a held `pre`)");
            };
            keyframes[i] = new Keyframe(t, pre, post, how);
        }
        return new AnimationChannel(which, keyframes);
    }

    private static Vector3f vector(final JsonObject frame, final String key, final String where) {
        JsonArray a = frame.getAsJsonArray(key);
        if (a == null || a.size() != 3) {
            throw new IllegalArgumentException(where + ": `" + key + "` must be three numbers");
        }
        return new Vector3f(a.get(0).getAsFloat(), a.get(1).getAsFloat(), a.get(2).getAsFloat());
    }

    private static CubeListBuilder cubes(final JsonObject part, final String name) {
        CubeListBuilder builder = CubeListBuilder.create();
        JsonArray cubes = part.getAsJsonArray("cubes");
        if (cubes == null) {
            return builder; // a bare pivot: legal, and how a rotation-only bone is expressed
        }
        for (JsonElement element : cubes) {
            JsonObject cube = element.getAsJsonObject();
            float[] origin = required3(cube, "origin", name);
            float[] size = required3(cube, "size", name);
            JsonArray uv = cube.getAsJsonArray("uv");
            int u = uv != null && !uv.isEmpty() ? uv.get(0).getAsInt() : 0;
            int v = uv != null && uv.size() > 1 ? uv.get(1).getAsInt() : 0;
            float inflate = cube.has("inflate") && !cube.get("inflate").isJsonNull()
                ? cube.get("inflate").getAsFloat() : 0.0F;
            boolean mirror = cube.has("mirror") && !cube.get("mirror").isJsonNull()
                && cube.get("mirror").getAsBoolean();
            builder.texOffs(u, v)
                .mirror(mirror)   // stateful on the builder: set per cube, before its addBox
                .addBox(origin[0], origin[1], origin[2], size[0], size[1], size[2],
                    new CubeDeformation(inflate));
        }
        return builder;
    }

    private static @Nullable String string(final JsonObject o, final String key,
                                           final @Nullable String fallback) {
        return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsString() : fallback;
    }

    /** A three-number field, defaulting to zeros — pivots and rotations are both optional. */
    private static float[] vec3(final JsonObject o, final String key, final String part) {
        if (!o.has(key) || o.get(key).isJsonNull()) {
            return new float[] {0.0F, 0.0F, 0.0F};
        }
        return required3(o, key, part);
    }

    private static float[] required3(final JsonObject o, final String key, final String part) {
        JsonArray a = o.getAsJsonArray(key);
        if (a == null || a.size() != 3) {
            throw new IllegalArgumentException("part '" + part + "': `" + key
                + "` must be three numbers");
        }
        return new float[] {a.get(0).getAsFloat(), a.get(1).getAsFloat(), a.get(2).getAsFloat()};
    }
}
