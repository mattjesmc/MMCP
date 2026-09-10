package com.mattmc.mcptoolkit.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolContext;
import com.mattmc.mcptoolkit.ToolDef;
import com.mattmc.mcptoolkit.mixin.client.GameRendererAccessor;
import com.mojang.blaze3d.pipeline.RenderTarget;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Camera;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.TextureFilteringMethod;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.SectionPos;
import net.minecraft.util.Mth;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import net.minecraft.world.phys.Vec3;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * <b>The camera — RENDER_SEAM_DESIGN.md phases 1 and 3.</b> Put a viewpoint anywhere, at any
 * orientation, at a chosen resolution, render the level out of band, and write the result to a file —
 * or name a <i>subject</i> and let the camera work out where to stand.
 *
 * <p>The recipe is Mojang's, through public methods:
 * {@code Minecraft.grabPanoramixScreenshot} ({@code vanilla-src/net/minecraft/client/Minecraft.java:2700})
 * resizes the window and the main render target, drives the player's rotation directly, and calls
 * {@code gameRenderer.update / extract / renderLevel} with {@link DeltaTracker#ONE} so nothing
 * interpolates. Two consequences the design predicted and this class relies on:
 *
 * <ul>
 *   <li><b>The HUD is excluded by construction.</b> {@code renderLevel} renders the level only; the
 *       HUD is drawn later in {@code render()} from {@code guiRenderState}. There is nothing to hide,
 *       which is fortunate — 26.2 has no {@code options.hideGui} at all.</li>
 *   <li><b>Resolution is an argument, and so is the token bill.</b> Render large, average down on the
 *       way out ({@code Screenshot.takeScreenshot(target, downscale, cb)}), and the cost of a look is
 *       a number the caller chose rather than a property of the human's monitor.</li>
 * </ul>
 *
 * <h2>Panoramic mode is the instrument's own lens</h2>
 *
 * {@code camera.enablePanoramicMode()} does two things this needs, and the second is what phase 3 is
 * built on. It suppresses the held item ({@code GameRenderer.renderItemInHand} is gated on
 * {@code !cameraState.isPanoramicMode}, {@code GameRenderer.java:337}) and it pins the field of view
 * at <b>90°</b> ({@code Camera.calculateFov}, {@code Camera.java:222}). That pin makes the lens a
 * constant of the instrument rather than a property of whatever the human last dragged their FOV
 * slider to — so the framing arithmetic below is a fact about this tool, not a reading of somebody's
 * options file.
 *
 * <h2>Framing — what {@code look_at} computes, and from what</h2>
 *
 * {@code Projection.getMatrix} builds the frustum with {@code setPerspective(fov, width/height, …)}
 * ({@code client/renderer/Projection.java:73}), and JOML's {@code fovy} is <b>vertical</b>. So the
 * half-angles are {@code 45°} vertically and {@code atan(width/height)} horizontally, and the
 * limiting one is the smaller. A subject is framed by its <b>bounding sphere</b>, whose angular
 * radius at distance {@code d} is {@code asin(r/d)}: asking that its projection reach a fraction
 * {@code FILL} of the limiting half-extent gives {@code t = FILL·tan(θ)} and
 * {@code d = r·√(1+t²)/t} exactly. The sphere encloses the box, so this over-frames a long thin
 * subject seen end-on and never under-frames anything — a margin that is occasionally generous is a
 * different thing from a subject with its head cut off.
 *
 * <p><b>{@code yaw}/{@code pitch} never change meaning.</b> They are the camera's orientation in
 * every case; {@code look_at} only decides <i>where the camera stands so that orientation hits the
 * subject</i>. That is why they are not mutually exclusive with it, contrary to the design's §6
 * sketch: a camera at {@code centre − dir(yaw,pitch)·d} looking along {@code dir} has exactly the
 * yaw and pitch it was given. The one case where they would be a second answer to a settled question
 * is {@code at} + {@code look_at}, where the aim is derived from one point to the other — and that
 * is refused rather than silently resolved.
 *
 * <h2>Why the divisibility check is left to vanilla</h2>
 *
 * {@code Screenshot.takeScreenshot} throws {@code IllegalArgumentException} when the render size is
 * not divisible by the downscale factor. That check is deliberately <b>not</b> hoisted in front of the
 * mutation, because it is the only argument-reachable throw that lands <i>after</i> the window has
 * been resized, the player moved and the level rendered — which makes it the falsifier for the
 * {@code finally}, reachable from a probe, at zero schema cost. §8 trap 2 in one sentence: a restore
 * path with no falsifier is a restore path that will silently stop working. The caller loses nothing —
 * the message is rephrased on the way out and says more than an early refusal would have.
 *
 * <h2>What it refuses, and why each refusal exists</h2>
 *
 * No local player (trap 8: {@code renderLevel}
 * dereferences {@code minecraft.player} at {@code GameRenderer.java:527} whatever the camera entity
 * is), a client still loading resources (nothing would be extracted), and a camera standing in a chunk
 * this client has not been sent — which photographs a hole that looks exactly like a badly built
 * subject. <b>Every viewpoint is resolved and chunk-checked before anything is mutated</b>, so an
 * orbit whose fourth frame would land in unsent chunks refuses as an orbit rather than as three good
 * files and a surprise.
 *
 * <p>A minimized window is <i>not</i> refused, since 0.134.0. Trap 7 of the design record read
 * {@code Minecraft.java:1243} as gating the whole frame; it gates only the acquire of the window
 * surface, which this pass never uses, and the measurement is in {@link ScreenSpace}. The reply
 * carries {@code window_minimized:true} when it was, for the transcript's sake.
 */
@Environment(EnvType.CLIENT)
public final class RenderTools {

    private RenderTools() {}

    /** Vanilla's own panorama size, and the same ceiling: above this a render target stops being cheap. */
    private static final int MAX_DIM = 4096;
    private static final int MIN_DIM = 16;
    private static final int MAX_DOWNSCALE = 8;

    /**
     * How many frames one orbit may ask for. Sixteen is the point where a contact sheet stops being a
     * look and starts being a render farm — each frame is a full settle loop and a full-resolution
     * GPU readback, and the reply is N paths a caller then has to open.
     */
    private static final int MAX_FRAMES = 16;

    /**
     * How much of the limiting half-extent an automatically framed subject reaches: 0.8 leaves a tenth
     * of the frame as margin on each side. It is a constant rather than an argument on purpose — the
     * manifest is charged per turn for every field, and a caller who wants a different margin has
     * {@code distance}, which says the same thing in the units the picture is actually taken in.
     */
    private static final double FILL = 0.8;

    /**
     * The floor under a computed distance. A one-block subject's bounding sphere has radius 0.87, so
     * the formula alone would stand the camera 1.4 blocks off it — technically "filling the frame" and
     * practically inside the neighbouring block. Two blocks is far enough to see one block.
     */
    private static final double MIN_AUTO_DISTANCE = 2.0;

    /**
     * Where a framed shot is taken from when the caller does not say: a three-quarter view from above
     * the south-east, which is the angle a build is normally drawn at. It has to be <i>some</i> angle —
     * defaulting to the human's current heading would make the same call give a different picture
     * depending on which way somebody happened to be facing.
     */
    private static final float HERO_YAW = 135.0F;
    private static final float HERO_PITCH = 30.0F;

    /**
     * How many extra passes to spend waiting for the section compiler after a camera jump, and the
     * pause between them. A camera that lands 200 blocks away looks at sections nobody has built yet;
     * uploads happen inside {@code LevelRenderer.render}, so the way to make progress is to render
     * again, not to wait. {@code settled:false} in the reply is what says the frame may still have
     * holes in it — a number the caller can act on rather than a hole they have to notice.
     */
    private static final int MAX_SETTLE_PASSES = 16;
    private static final long SETTLE_PAUSE_MS = 10L;

    /**
     * How many passes in a row must find the compile queue empty before it means anything.
     *
     * <p><b>One reading is worthless, and this cost a probe run to find out.</b>
     * {@code hasRenderedAllSections()} is {@code sectionRenderDispatcher.isQueueEmpty()}
     * ({@code LevelRenderer.java:885}), and the queue is empty in three different situations that
     * look identical from here: the work is done, the work has not been SCHEDULED yet, and the work
     * has been taken off the queue by a worker thread and is being built right now.
     * {@code LevelRenderer.render} calls {@code compileSections} at its very END
     * ({@code :255}) and that method calls {@code compileAsync} ({@code :631}) — so on the pass that
     * first sees a changed section, the queue is read after the hand-off and reads clear. The loop
     * would exit on pass one having drawn nothing new, and the frame comes out showing the world as
     * it was before the edit. Three consecutive clear readings, ten milliseconds apart, is the
     * cheapest thing that distinguishes "done" from "not started".
     */
    private static final int SETTLE_CLEAR_PASSES = 3;

    private static final AtomicInteger SEQ = new AtomicInteger();

    public static void register() {
        McpTools.register(ToolDef.async(
            "render",
            "Render the level out of band from a viewpoint you choose and write it to a PNG. Not a screenshot: nobody is standing anywhere, the HUD and the held item are excluded by construction, and the resolution is an argument rather than a property of the window. The lens is fixed at 90 degrees FOV. Give `look_at` and the camera places itself — it stands off along `yaw`/`pitch` at whatever distance makes the subject fill the frame, so framing a build is a box rather than trigonometry; `frames:N` turns that into an orbit of N stills around it. Renders the dimension the CLIENT is in (reported back as `dimension`) — to photograph another one, put the client there first. Refuses rather than lying when the frame could not be right: a client still loading, or a camera standing in a chunk this client has not been sent (which would photograph a hole). A minimized window is fine — the render is out of band and never needs the screen — and is reported as `window_minimized:true`. `settled:false` means the chunk sections were still compiling and the frame may hold holes; `settled:true` is about this client's renderer only and says nothing about a block change still travelling from the server, so a render fired straight after a write can miss it. `inline` defaults to FALSE — the reply is a path, a resolution and a byte count, because a full-resolution PNG is the most expensive thing this toolkit can put in a transcript.",
            Schemas.objectOpt(Schemas.object(
                    "at", vec3Schema("Camera position — the eye itself, not a standing position. Fractional, because a camera lands between blocks. Omit to shoot from where the client's camera already is, or to let `look_at` place it."),
                    "look_at", lookAtSchema(),
                    "distance", Schemas.number("How far the camera stands back from `look_at`'s centre. Omit and it is computed so the subject fills the frame with a margin — which is the point of `look_at`."),
                    "frames", Schemas.integer("Orbit: take N shots evenly spaced around `look_at`, starting at `yaw` and turning right (1-" + MAX_FRAMES + "). The reply becomes a `frames` list of one entry per file."),
                    "yaw", Schemas.number("Heading in degrees: 0=south, 90=west, 180=north, -90=east. The camera's own orientation in every case — with `look_at` it also decides which side the camera stands on. Omit to keep the current one, or " + (int) HERO_YAW + " when framing."),
                    "pitch", Schemas.number("Pitch in degrees: -90=straight up, 0=level, 90=straight down. Omit to keep the current one, or " + (int) HERO_PITCH + " when framing."),
                    "width", Schemas.integer("Render width in pixels (16-4096, default 512)."),
                    "height", Schemas.integer("Render height in pixels (16-4096, default 512)."),
                    "downscale", Schemas.integer("Supersample: render at width x height and average down by this factor (1-8, default 1). Both must divide by it; the image written is width/downscale x height/downscale."),
                    "out", Schemas.str("Where to write the PNG. A relative path resolves against the game directory; the default is mcptoolkit/renders/ under it. An orbit numbers it: name-0.png, name-1.png."),
                    "inline", Schemas.bool("Also return the image in the reply (default false). Expensive — prefer handing the path to whoever needs to look at it. Single frames only.")),
                "at", "look_at", "distance", "frames", "yaw", "pitch", "width", "height", "downscale", "out", "inline"),
            ExecutionContext.CLIENT,
            Mechanism.OBSERVE,
            RenderTools::render));
    }

    // ---- the render ----------------------------------------------------------

    private static CompletableFuture<JsonElement> render(final ToolContext ctx, final JsonObject a) {
        Minecraft mc = Minecraft.getInstance();
        LocalPlayer player = mc.player;
        if (mc.level == null || player == null) {
            throw new IllegalStateException(
                "no level loaded — the camera renders the level the client is in, so there has to be one");
        }
        if (!mc.isGameLoadFinished()) {
            throw new IllegalStateException(
                "the client is still loading; nothing would be extracted into the frame");
        }
        // A minimized window is NOT a refusal. It was one until 0.134.0, on a reading of
        // Minecraft.java:1243 as gating the whole frame; the gate is only around acquiring the window
        // surface, and this pass never touches the surface — it draws into the main render target
        // and copies the pixels out of it (ScreenSpace has the measurement: the frame kept coming,
        // at the right heading, with the window iconic). The one refusal cost a battery 21 red
        // cases. The state is still reported, so a transcript can explain a human's missing window.
        final boolean minimizedAtStart = mc.getWindow().isMinimized();

        int width = intArg(a, "width", 512);
        int height = intArg(a, "height", 512);
        int downscale = intArg(a, "downscale", 1);
        if (width < MIN_DIM || width > MAX_DIM || height < MIN_DIM || height > MAX_DIM) {
            throw new IllegalArgumentException("width and height must be between " + MIN_DIM + " and "
                + MAX_DIM + " (got " + width + "x" + height + ")");
        }
        if (downscale < 1 || downscale > MAX_DOWNSCALE) {
            throw new IllegalArgumentException("downscale must be between 1 and " + MAX_DOWNSCALE
                + " (got " + downscale + ")");
        }
        boolean inline = has(a, "inline") && a.get("inline").getAsBoolean();

        Camera camera = mc.gameRenderer.mainCamera();
        // Every viewpoint is decided, and every one of them checked, BEFORE the window is resized or
        // the player is moved. An orbit that cannot be completed is refused as an orbit.
        List<Shot> shots = plan(mc, player, a, width, height);
        final int count = shots.size();
        if (inline && count > 1) {
            throw new IllegalArgumentException("inline returns ONE image — the reply envelope carries a "
                + "single image part — and this asks for " + count + ". Take the orbit, then render the "
                + "one frame you want to look at.");
        }
        for (Shot s : shots) {
            if (s.at() != null) {
                requireChunk(mc, s.at());
            }
        }

        // Everything from here is mutation of the live client, and every field taken here goes back in
        // the finally. The `O` fields matter as much as the live ones: DeltaTracker.ONE means partial
        // ticks of 1.0, so the camera reads the CURRENT value — but the game's next frame interpolates
        // from the old one, and a stale xRotO is a visible flick on the human's screen.
        RenderTarget target = mc.gameRenderer.mainRenderTarget();
        int ow = mc.getWindow().getWidth();
        int oh = mc.getWindow().getHeight();
        double ox = player.getX(), oy = player.getY(), oz = player.getZ();
        double oxo = player.xo, oyo = player.yo, ozo = player.zo;
        float oYaw = player.getYRot(), oPitch = player.getXRot();
        float oYawO = player.yRotO, oPitchO = player.xRotO;

        CompletableFuture<JsonElement> result = new CompletableFuture<>();
        // Filled in the finally, read in the screenshot callbacks — which fire a frame or two later,
        // by which time the human may have walked. The snapshot has to be taken at the moment the
        // restore happens or it is a reading of something else entirely.
        final JsonObject restored = new JsonObject();
        final JsonObject[] frames = new JsonObject[count];
        final AtomicInteger outstanding = new AtomicInteger(count);
        final boolean wantInline = inline;
        final long started = System.nanoTime();

        // THE STUDIO'S WEATHER IS THE OVERWORLD'S. A non-overworld level's weather is a DerivedLevelData
        // mirror of the overworld's, and the atmospheric fog blends a sky colour DARKENED BY RAIN AND
        // THUNDER into the fog colour (AtmosphericFogEnvironment.applyWeatherDarken) - so a studio
        // frame taken during an overworld storm came out 240,245,255 instead of the #FFFFFF
        // studio.json declares (2026-09-06, three runs in a row until `weather clear`). The studio's
        // whole point is a background that is what it says; in it, the client's weather levels are
        // zeroed for the frame and put back after. Only there: photographing the world where it
        // stands keeps its weather, because that IS the picture.
        final boolean inStudio = mc.level.dimension().equals(com.mattmc.mcptoolkit.canvas.Canvas.STUDIO);
        final float oRain = mc.level.getRainLevel(1.0F);
        final float oThunder = mc.level.getThunderLevel(1.0F);
        mc.gameRenderer.setRenderBlockOutline(false);
        try {
            if (inStudio) {
                mc.level.setRainLevel(0.0F);
                mc.level.setThunderLevel(0.0F);
            }
            camera.enablePanoramicMode();
            mc.getWindow().setWidth(width);
            mc.getWindow().setHeight(height);
            target.resize(width, height);

            long mark = started;
            for (int i = 0; i < count; i++) {
                final Shot shot = shots.get(i);
                aim(player, shot.yaw(), shot.pitch());
                if (shot.at() != null) {
                    place(mc, player, shot.at());
                }
                final Settling settling = settle(mc);

                final int index = i;
                final Path out = shot.out();
                final int renderWidth = width;
                final int renderHeight = height;
                final int factor = downscale;
                final Vec3 cameraAt = camera.position();
                final long ms = (System.nanoTime() - mark) / 1_000_000L;
                mark = System.nanoTime();
                // The callback fires on a later frame (RenderSystem.queueFencedTask); the texture-to-
                // buffer copy is ENCODED here and now (Screenshot.java:87), which is what makes an
                // orbit safe: the next frame's render cannot reach this frame's pixels, and neither
                // can the restore below. Never block on it.
                net.minecraft.client.Screenshot.takeScreenshot(target, downscale, image -> {
                    try (image) {
                        Files.createDirectories(out.getParent());
                        image.writeToFile(out);
                        JsonObject r = new JsonObject();
                        r.addProperty("path", out.toString());
                        r.addProperty("width", image.getWidth());
                        r.addProperty("height", image.getHeight());
                        r.addProperty("bytes", Files.size(out));
                        if (factor != 1) {
                            r.add("rendered", xy(renderWidth, renderHeight));
                            r.addProperty("downscale", factor);
                        }
                        r.add("camera_at", xyz(cameraAt));
                        r.addProperty("yaw", round(shot.yaw()));
                        r.addProperty("pitch", round(shot.pitch()));
                        if (shot.distance() > 0.0) {
                            r.addProperty("distance", round(shot.distance()));
                        }
                        r.addProperty("passes", settling.passes());
                        r.addProperty("settled", settling.ok());
                        r.addProperty("ms", ms);
                        frames[index] = r;
                        if (outstanding.decrementAndGet() == 0) {
                            result.complete(assemble(frames, restored, wantInline, started));
                        }
                    } catch (Exception e) {
                        result.completeExceptionally(e);
                    }
                });
            }
        } catch (IllegalArgumentException e) {
            // Vanilla's divisibility guard, rephrased. See the class comment: this arrives AFTER the
            // mutation on purpose, so the restore below is a path a probe can actually exercise.
            throw new IllegalArgumentException(width % downscale != 0 || height % downscale != 0
                ? "width and height must both divide by downscale: " + width + "x" + height
                  + " does not divide by " + downscale
                : String.valueOf(e.getMessage()), e);
        } finally {
            if (inStudio) {
                mc.level.setRainLevel(oRain);
                mc.level.setThunderLevel(oThunder);
            }
            player.setPos(ox, oy, oz);
            player.xo = oxo;
            player.yo = oyo;
            player.zo = ozo;
            player.setYRot(oYaw);
            player.setXRot(oPitch);
            player.yRotO = oYawO;
            player.xRotO = oPitchO;
            mc.gameRenderer.setRenderBlockOutline(true);
            mc.getWindow().setWidth(ow);
            mc.getWindow().setHeight(oh);
            target.resize(ow, oh);
            camera.disablePanoramicMode();
            fillRestored(mc, restored);
            // Carried on `restored` rather than captured per frame for the same reason `restored`
            // itself is filled here: this is the level the frames were actually taken in. `assemble`
            // lifts it back out to the top of the reply, where it has always been.
            restored.addProperty("_dimension", mc.level.dimension().identifier().toString());
            restored.addProperty("_window_minimized", minimizedAtStart);
        }
        return result;
    }

    /**
     * One frame's reply, or an orbit's. A single frame keeps the flat shape phase 1 shipped — a caller
     * who never asks for an orbit never learns that {@code frames} exists, which is §D2's discipline
     * ("a second question about an existing argument list is the cheap kind") applied to a reply.
     */
    private static JsonElement assemble(final JsonObject[] frames, final JsonObject restored,
                                        final boolean inline, final long started) {
        String dimension = restored.get("_dimension").getAsString();
        restored.remove("_dimension");
        boolean windowMinimized = restored.get("_window_minimized").getAsBoolean();
        restored.remove("_window_minimized");
        JsonObject r;
        if (frames.length == 1) {
            r = frames[0];
        } else {
            r = new JsonObject();
            JsonArray list = new JsonArray();
            for (JsonObject f : frames) {
                list.add(f);
            }
            r.add("frames", list);
            r.addProperty("count", frames.length);
            r.addProperty("ms", (System.nanoTime() - started) / 1_000_000L);
        }
        r.addProperty("dimension", dimension);
        if (windowMinimized) {
            r.addProperty("window_minimized", true);
        }
        // Read back off the live objects at the moment the finally ran, never echoed from the saved
        // values: this is the only thing in the reply that can catch a restore that ran and did not
        // take, and comparing it across two calls catches one that never ran at all.
        r.add("restored", restored);
        if (inline) {
            try {
                JsonObject img = new JsonObject();
                img.addProperty("mimeType", "image/png");
                img.addProperty("base64", Base64.getEncoder().encodeToString(
                    Files.readAllBytes(Path.of(frames[0].get("path").getAsString()))));
                r.add("_image", img);
            } catch (Exception e) {
                throw new IllegalStateException("wrote the frame but could not read it back for inline: "
                    + e, e);
            }
        }
        return r;
    }

    // ---- planning: where the camera stands, decided before anything moves ----

    /**
     * A single frame's viewpoint, resolved before the client is touched. {@code at} is null for
     * "wherever the camera already is"; {@code distance} is 0 when nothing was framed, and is in the
     * reply otherwise so an automatic placement is a number the caller can check rather than infer.
     */
    private record Shot(Vec3 at, float yaw, float pitch, double distance, Path out) {}

    private static List<Shot> plan(final Minecraft mc, final LocalPlayer player, final JsonObject a,
                                   final int width, final int height) {
        Vec3 at = has(a, "at") ? vec3(a.getAsJsonObject("at")) : null;
        JsonObject look = has(a, "look_at") ? a.getAsJsonObject("look_at") : null;
        boolean aimed = has(a, "yaw") || has(a, "pitch");
        boolean hasDistance = has(a, "distance");
        int frames = intArg(a, "frames", 1);

        if (look == null && hasDistance) {
            throw new IllegalArgumentException("distance is how far the camera stands back from the "
                + "subject `look_at` names, and there is no look_at here — say where the camera goes "
                + "with `at` instead.");
        }
        if (look == null && has(a, "frames")) {
            throw new IllegalArgumentException("frames orbits a subject, and an orbit needs a centre: "
                + "give `look_at` the box you want to go around.");
        }
        if (frames < 1 || frames > MAX_FRAMES) {
            throw new IllegalArgumentException("frames must be between 1 and " + MAX_FRAMES
                + " (got " + frames + ")");
        }
        if (at != null && look != null && (aimed || hasDistance || frames > 1)) {
            throw new IllegalArgumentException("`at` with `look_at` means the camera stands where you "
                + "put it and its aim is worked out from one to the other — so yaw, pitch, distance "
                + "and frames would each be a second answer to a question already settled. Drop `at` "
                + "to let the camera place itself, or drop `look_at` and aim by hand.");
        }

        if (look == null) {
            float yaw = has(a, "yaw") ? a.get("yaw").getAsFloat() : player.getYRot();
            float pitch = has(a, "pitch") ? a.get("pitch").getAsFloat() : player.getXRot();
            return List.of(new Shot(at, yaw, pitch, 0.0, resolveOut(mc, a, 0, 1)));
        }

        Subject subject = subject(look);
        if (at != null) {
            Vec3 aim = subject.centre().subtract(at);
            double len = aim.length();
            if (len < 1.0E-4) {
                throw new IllegalArgumentException("the camera is standing at the subject's own centre "
                    + xyz(subject.centre()) + ", so there is no direction to aim it in. Move `at` off "
                    + "the subject, or drop it and let `look_at` place the camera.");
            }
            float yaw = (float) Math.toDegrees(Math.atan2(-aim.x, aim.z));
            float pitch = (float) -Math.toDegrees(Math.asin(aim.y / len));
            return List.of(new Shot(at, yaw, pitch, len, resolveOut(mc, a, 0, 1)));
        }

        float yaw0 = has(a, "yaw") ? a.get("yaw").getAsFloat() : HERO_YAW;
        float pitch = has(a, "pitch") ? a.get("pitch").getAsFloat() : HERO_PITCH;
        double distance = hasDistance
            ? a.get("distance").getAsDouble()
            : autoDistance(subject.radius(), width, height);
        if (distance <= 0.0) {
            throw new IllegalArgumentException("distance must be positive (got " + distance
                + ") — a camera standing at zero is inside its own subject");
        }

        List<Shot> shots = new ArrayList<>(frames);
        for (int i = 0; i < frames; i++) {
            float yaw = Mth.wrapDegrees(yaw0 + i * (360.0F / frames));
            shots.add(new Shot(subject.centre().subtract(direction(yaw, pitch).scale(distance)),
                yaw, pitch, distance, resolveOut(mc, a, i, frames)));
        }
        return shots;
    }

    /** A framed subject as the sphere that encloses it, which is the only shape the arithmetic needs. */
    private record Subject(Vec3 centre, double radius) {}

    /**
     * {@code look_at} is BLOCK coordinates and inclusive at both ends, like every other box in this
     * toolkit ({@code describe_box}, {@code set_blocks}, {@code capture_structure}'s min+size). The
     * world box is therefore {@code min .. max+1}: a caller who hands over the box they built and
     * gets a frame cut one block short at the top has been given an off-by-one to find, and this is
     * the line it would live on. Corners are normalised rather than required in order — a box is a
     * box whichever end the caller wrote first.
     */
    private static Subject subject(final JsonObject look) {
        JsonObject minObj = look.getAsJsonObject("min");
        JsonObject maxObj = has(look, "max") ? look.getAsJsonObject("max") : minObj;
        String[] keys = {"x", "y", "z"};
        double[] lo = new double[3];
        double[] hi = new double[3];
        for (int i = 0; i < 3; i++) {
            double p = Math.floor(minObj.get(keys[i]).getAsDouble());
            double q = Math.floor(maxObj.get(keys[i]).getAsDouble());
            lo[i] = Math.min(p, q);
            hi[i] = Math.max(p, q) + 1.0;
        }
        Vec3 centre = new Vec3((lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, (lo[2] + hi[2]) / 2.0);
        double radius = 0.5 * Math.sqrt(sq(hi[0] - lo[0]) + sq(hi[1] - lo[1]) + sq(hi[2] - lo[2]));
        return new Subject(centre, radius);
    }

    /**
     * How far back to stand so a sphere of radius {@code r} fills {@link #FILL} of the frame's
     * limiting half-extent. The FOV is 90° <b>vertical</b> ({@code Projection.getMatrix} feeds JOML's
     * {@code fovy}, {@code Projection.java:73}), so the vertical half-angle is 45° and the horizontal
     * one is {@code atan(width/height)}; the smaller of the two is what crops. The sphere's angular
     * radius at distance {@code d} is {@code asin(r/d)}, so requiring
     * {@code tan(asin(r/d)) = FILL·tan(θ)} and solving gives the closed form below. The aspect is the
     * RENDER's, never the window's — the two differ by construction here, which is the whole point of
     * this tool, and reading the wrong one is the bug this comment exists to prevent.
     */
    private static double autoDistance(final double radius, final int width, final int height) {
        double limit = Math.min(Math.PI / 4.0, Math.atan((double) width / height));
        double t = FILL * Math.tan(limit);
        return Math.max(MIN_AUTO_DISTANCE, radius * Math.sqrt(1.0 + t * t) / t);
    }

    /**
     * Minecraft's yaw/pitch as a unit vector: yaw 0 is +Z (south) and turns toward −X (west), pitch is
     * positive downward. Read off {@code Camera.setRotation} ({@code Camera.java:342}) rather than
     * remembered — the sign of yaw is the single most-mistaken convention in this codebase.
     */
    private static Vec3 direction(final float yaw, final float pitch) {
        double y = Math.toRadians(yaw);
        double p = Math.toRadians(pitch);
        return new Vec3(-Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p));
    }

    private static void requireChunk(final Minecraft mc, final Vec3 at) {
        int cx = SectionPos.blockToSectionCoord(Mth.floor(at.x));
        int cz = SectionPos.blockToSectionCoord(Mth.floor(at.z));
        if (mc.level == null || mc.level.getChunkSource().getChunk(cx, cz, ChunkStatus.FULL, false) == null) {
            throw new IllegalStateException("this client has no chunk at " + cx + ", " + cz
                + " — the camera would photograph a hole, and a hole looks exactly like a badly "
                + "built subject. Move the player nearer, or raise the view distance, and ask again.");
        }
    }

    // ---- one frame -----------------------------------------------------------

    /** What a settle loop found: how many passes it cost, and whether the sections ever caught up. */
    private record Settling(int passes, boolean ok) {}

    /**
     * Render until the section compiler has nothing left, and say honestly whether it got there.
     *
     * <p>The counter is the whole point — see {@link #SETTLE_CLEAR_PASSES}. An empty compile queue
     * read once means nothing, because the pass that discovers a changed section is also the pass
     * that hands it to a worker and leaves the queue clear behind it.
     *
     * <p><b>What {@code settled:true} still does not promise.</b> It is a fact about this CLIENT's
     * renderer, and nothing more. A block written on the server a moment ago may not have reached the
     * client yet — measured at 700-900 ms in a dev singleplayer world — and no amount of rendering
     * makes it arrive sooner. A caller who writes and then immediately photographs is racing the
     * network, and the reply cannot tell them so, because from in here an empty studio and an empty
     * studio that is about to have a house in it are the same picture.
     */
    private static Settling settle(final Minecraft mc) {
        int passes = 0;
        int clear = 0;
        for (int i = 0; i < MAX_SETTLE_PASSES; i++) {
            pass(mc);
            passes++;
            clear = mc.levelRenderer.hasRenderedAllSections() ? clear + 1 : 0;
            if (clear >= SETTLE_CLEAR_PASSES) {
                break;
            }
            sleep();
        }
        // One more after settling: the pass that DISCOVERS a section is not the pass that draws it —
        // compileSections and the GPU upload both run at the END of LevelRenderer.render, after the
        // frame — so grabbing the frame that reported "all compiled" would grab the one before.
        pass(mc);
        return new Settling(passes + 1, clear >= SETTLE_CLEAR_PASSES);
    }

    /**
     * One out-of-band frame — the panorama's three calls, plus the two {@code GameRenderer.render}
     * makes around them that the panorama does not.
     *
     * <p><b>The panorama recipe is incomplete, and vanilla cannot see it.</b> The debug panorama only
     * ever shoots from the player's own head — the one camera position at which both omissions below
     * are harmless. Move the camera and they stop being harmless immediately.
     *
     * <p><b>The global settings uniform carries the camera.</b> {@code render()} writes it every frame
     * ({@code GameRenderer.java:411}); chunk sections are drawn relative to the integer camera position
     * inside it. Leave it holding the last real frame's value and the terrain is drawn offset by however
     * far this camera moved. The first live run of this class raised the camera 44 blocks and got a
     * BLACK frame with hard geometric edges — not a lighting failure, which is what it looks like, but
     * a picture taken from inside the ground.
     *
     * <p><b>The lightmap upload is the second omission.</b>
     * {@code extract} fills the {@code LightmapRenderState}; {@code lightmap.render(state)} is what
     * puts it on the GPU, and {@code render()} calls it immediately before {@code renderLevel}
     * ({@code GameRenderer.java:423}). Without it the sky comes out perfect — it does not sample the
     * lightmap — and every block face is unlit. The texture survives between frames, so a shot from
     * where the player stands looks right without it; it stops looking right the moment the render
     * happens somewhere the last real frame was not, and a different DIMENSION is the case that
     * matters here, the studio being a dimension whose whole point is its light.
     *
     * <p>The two {@code endFrame} calls are the other half of a real frame: the graph allocates its
     * targets from a pool, and a settle loop that runs the graph up to seventeen times without ever
     * releasing would hold that many sets of full-resolution textures. The screenshot is taken after
     * these deliberately — the pixels live in the MAIN render target, which the pool does not own.
     */
    private static void pass(final Minecraft mc) {
        mc.gameRenderer.update(DeltaTracker.ONE);
        mc.gameRenderer.extract(DeltaTracker.ONE, true);
        var state = mc.gameRenderer.gameRenderState();
        accessor(mc).mcptoolkit$globalSettingsUniform().update(
            state.windowRenderState.width,
            state.windowRenderState.height,
            state.optionsRenderState.glintStrength,
            mc.level == null ? 0L : mc.level.getGameTime(),
            DeltaTracker.ONE,
            state.optionsRenderState.menuBackgroundBlurriness,
            state.levelRenderState.cameraRenderState.pos,
            state.optionsRenderState.textureFiltering == TextureFilteringMethod.RGSS);
        // THE GLINT'S CLOCK (RELEASE_1.md section K3, measured 2026-09-06). Everything else this
        // pass draws is on game time, which `studio {freeze}` stops; the enchantment glint is not:
        // vanilla's TextureTransform scrolls it by Util.getMillis() * glintSpeed (rendertype/
        // TextureTransform.java:35), read at render time from THIS render state. Two shots of a
        // frozen enchanted stand differed by ~500 pixels on the glint alone; plain gear was
        // pixel-identical. So while the tick is frozen the speed is zero here - the glint still
        // draws, at phase zero, the same on every run and every machine. With the tick running it
        // is left alone, which is what keeps "frozen" and "not frozen" tellable apart.
        if (mc.level != null && mc.level.tickRateManager().isFrozen()) {
            state.optionsRenderState.glintSpeed = 0.0;
        }
        accessor(mc).mcptoolkit$lightmap().render(state.lightmapRenderState);
        mc.gameRenderer.renderLevel(DeltaTracker.ONE);
        mc.gameRenderer.renderBuffers().endFrame();
        accessor(mc).mcptoolkit$resourcePool().endFrame();
    }

    private static GameRendererAccessor accessor(final Minecraft mc) {
        return (GameRendererAccessor) mc.gameRenderer;
    }

    private static void aim(final LocalPlayer player, final float yaw, final float pitch) {
        player.setYRot(yaw);
        player.setXRot(pitch);
        player.yRotO = yaw;
        player.xRotO = pitch;
    }

    /**
     * Put the CAMERA at {@code want} — which is not the same as putting the player there.
     * {@code Camera.alignWithEntity} ({@code Camera.java:258-264}) sets its position to the entity's
     * interpolated position plus an interpolated eye height it keeps privately and converges
     * geometrically, so the offset is knowable but not readable. Rather than model it, aim once and
     * correct by the residual: ask the camera where it actually landed and move the player by the
     * difference. Two updates, exact, and self-checking — {@code camera_at} in the reply is read back
     * from the camera rather than echoed from the argument, so a placement that silently missed shows
     * up as a number that disagrees with the one asked for.
     */
    private static void place(final Minecraft mc, final LocalPlayer player, final Vec3 want) {
        setPosHard(player, want.x, want.y - player.getEyeHeight(), want.z);
        mc.gameRenderer.update(DeltaTracker.ONE);
        Vec3 err = want.subtract(mc.gameRenderer.mainCamera().position());
        if (err.lengthSqr() > 1.0E-8) {
            setPosHard(player, player.getX() + err.x, player.getY() + err.y, player.getZ() + err.z);
            mc.gameRenderer.update(DeltaTracker.ONE);
        }
    }

    /** Position with no interpolation left behind it — the previous-tick fields move with it. */
    private static void setPosHard(final LocalPlayer player, final double x, final double y, final double z) {
        player.setPos(x, y, z);
        player.xo = x;
        player.yo = y;
        player.zo = z;
    }

    private static void sleep() {
        try {
            Thread.sleep(SETTLE_PAUSE_MS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    // ---- reply pieces --------------------------------------------------------

    /** What the client looks like now — called from the finally, so "now" means "after the restore". */
    private static void fillRestored(final Minecraft mc, final JsonObject into) {
        into.add("window", xy(mc.getWindow().getWidth(), mc.getWindow().getHeight()));
        LocalPlayer p = mc.player;
        if (p != null) {
            into.add("player", xyz(p.position()));
            into.addProperty("yaw", round(p.getYRot()));
            into.addProperty("pitch", round(p.getXRot()));
        }
    }

    /**
     * Where frame {@code index} of {@code total} goes. An orbit given an explicit {@code out} numbers
     * it rather than writing every frame over the last one — the alternative is a caller who asks for
     * eight frames, gets one file, and has to work out which of the eight survived.
     */
    private static Path resolveOut(final Minecraft mc, final JsonObject a, final int index, final int total) {
        Path gameDir = mc.gameDirectory.toPath();
        if (has(a, "out")) {
            Path given = Path.of(a.get("out").getAsString());
            Path abs = (given.isAbsolute() ? given : gameDir.resolve(given)).normalize();
            if (total == 1) {
                return abs;
            }
            String name = abs.getFileName().toString();
            int dot = name.lastIndexOf('.');
            String stem = dot < 0 ? name : name.substring(0, dot);
            String ext = dot < 0 ? "" : name.substring(dot);
            return abs.resolveSibling(stem + "-" + index + ext);
        }
        String name = "render-" + System.currentTimeMillis() + "-" + SEQ.incrementAndGet() + ".png";
        return gameDir.resolve("mcptoolkit").resolve("renders").resolve(name).normalize();
    }

    /** A fractional {@code {x,y,z}}. Schemas has vec3i; a camera does not land on block centres. */
    private static JsonObject vec3Schema(final String description) {
        JsonObject o = Schemas.object("x", Schemas.number(), "y", Schemas.number(), "z", Schemas.number());
        o.addProperty("description", description);
        return o;
    }

    /** The subject box. Integer, because a subject is made of blocks even when a camera is not. */
    private static JsonObject lookAtSchema() {
        JsonObject o = Schemas.objectOpt(Schemas.object(
            "min", Schemas.vec3i("Lowest block of the subject."),
            "max", Schemas.vec3i("Highest block. Omit for a one-block subject.")), "max");
        o.addProperty("description", "A subject to frame, in BLOCK coordinates INCLUSIVE at both ends "
            + "(so 100..108 is nine blocks wide — the same box set_blocks and describe_box take). "
            + "Alone, it PLACES the camera: standing off along yaw/pitch far enough that the subject "
            + "fills the frame. With `at`, the camera stays where you put it and only its aim is "
            + "computed.");
        return o;
    }

    private static JsonObject xy(final int width, final int height) {
        JsonObject o = new JsonObject();
        o.addProperty("width", width);
        o.addProperty("height", height);
        return o;
    }

    private static JsonObject xyz(final Vec3 v) {
        JsonObject o = new JsonObject();
        o.addProperty("x", round(v.x));
        o.addProperty("y", round(v.y));
        o.addProperty("z", round(v.z));
        return o;
    }

    private static double sq(final double v) {
        return v * v;
    }

    private static double round(final double v) {
        return Math.round(v * 1000.0) / 1000.0;
    }

    private static Vec3 vec3(final JsonObject o) {
        return new Vec3(o.get("x").getAsDouble(), o.get("y").getAsDouble(), o.get("z").getAsDouble());
    }

    private static boolean has(final JsonObject a, final String key) {
        return a.has(key) && !a.get(key).isJsonNull();
    }

    private static int intArg(final JsonObject a, final String key, final int fallback) {
        return has(a, key) ? a.get(key).getAsInt() : fallback;
    }
}
