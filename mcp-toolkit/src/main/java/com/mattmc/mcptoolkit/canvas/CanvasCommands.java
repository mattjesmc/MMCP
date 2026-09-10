package com.mattmc.mcptoolkit.canvas;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.DataTools;
import com.mattmc.mcptoolkit.CommandRoot;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.commands.arguments.IdentifierArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.Vec3i;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.RandomSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructurePlaceSettings;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import net.minecraft.world.phys.AABB;
import org.jspecify.annotations.Nullable;

import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;

/**
 * <b>{@code /mmcp edit …} — the human's half of the edit loop.</b>
 * ({@code RENDER_SEAM_DESIGN.md} §10.6, the third missing piece: a human does not call an MCP tool.)
 *
 * <pre>
 *   /mmcp edit &lt;structure id&gt;        open it in the workshop, frame it, stand you on the platform
 *   /mmcp edit blank &lt;x&gt; &lt;y&gt; &lt;z&gt;     open an empty frame of that size
 *   /mmcp frame                        where the frame is, and whether you can see it
 *   /mmcp frame &lt;face&gt; &lt;n&gt;            move one face out by n blocks (negative pulls it in)
 *   /mmcp frame grow &lt;n&gt;              move all six
 *   /mmcp save [id] [entities]         capture the FRAME into a .nbt in the live datapack
 *   /mmcp cancel                       clear the slot and drop the session
 *   /mmcp canvas [tp]                  what is open; tp puts you back in your own frame
 * </pre>
 *
 * <h2>Why this is commands and no MCP tool, for now</h2>
 *
 * §6 of the design puts the bridge side on {@code render}'s {@code op} field — and {@code render} does
 * not exist yet (phases 1 and 3 are not built). The alternative was a tool entry that would have to be
 * reshaped the moment it did. {@code FakePlayerCommand} already wrote down the rule this follows: a
 * server command is reachable from a probe through {@code run_command} at ZERO manifest cost, which is
 * exactly what a capability still under verification should cost. When {@code render} lands, its
 * {@code edit}/{@code save}/{@code cancel} ops call the same methods these do — the {@code ReviewWalk}
 * arrangement, where a verdict given in-game and one read back over the bridge cannot disagree.
 *
 * <h2>Two verbs, and neither of them is quiet</h2>
 *
 * <p><b>Nothing ever auto-saves.</b> The July design exported on {@code SERVER_STOPPING}, which is a
 * silent data path in both directions: a crash loses the edit with no message, and an accidental quit
 * overwrites a good file with a half-finished one (trap 11). So {@code save} is a word somebody types,
 * and opening a second edit while one is already open is a refusal rather than an implicit close.
 *
 * <p><b>{@code cancel} clears one slot: the caller's.</b> The design sketched a
 * {@code /mmcp canvas clear} that would "put it away"; a command that wipes other people's frames out
 * of a shared canvas is the same destructive shape as the auto-save, so it is not here. Each session
 * ends its own.
 */
final class CanvasCommands {

    private CanvasCommands() {}

    /** Cells one frame may cover. The same cap {@code capture_structure} and {@code place_structure} use. */
    private static final int MAX_CELLS = 64 * 64 * 64;
    /** How far the cleared working area extends past the frame, and how far out {@code save} looks. */
    private static final int MARGIN = 8;
    /** The floor a human stands on, one below the frame — outside it, so it is never captured. */
    private static final BlockState PLATFORM = Blocks.SMOOTH_STONE.defaultBlockState();
    /** How many stray cells outside the frame {@code save} names before it only counts them. */
    private static final int STRAY_SAMPLE = 3;

    static void register() {
        ServerHooks.COMMAND_REGISTRATION.register((dispatcher, registryAccess, environment) ->
            dispatcher.register(CommandRoot.root()
                .then(CommandRoot.gated("edit")
                    .then(Commands.literal("blank")
                        .then(Commands.argument("x", IntegerArgumentType.integer(1))
                            .then(Commands.argument("y", IntegerArgumentType.integer(1))
                                .then(Commands.argument("z", IntegerArgumentType.integer(1))
                                    .executes(ctx -> open(ctx, null, new Vec3i(
                                        IntegerArgumentType.getInteger(ctx, "x"),
                                        IntegerArgumentType.getInteger(ctx, "y"),
                                        IntegerArgumentType.getInteger(ctx, "z"))))))))
                    // IdentifierArgument, not a string: Brigadier's unquoted strings do not admit a
                    // COLON, so `string()` would have made every namespaced id need quotes in-game.
                    .then(Commands.argument("id", IdentifierArgument.id())
                        .suggests((ctx, builder) -> SharedSuggestionProvider.suggest(
                            ctx.getSource().getServer().getStructureManager().listTemplates()
                                .map(Identifier::toString).sorted().limit(200).toList(), builder))
                        .executes(ctx -> open(ctx, IdentifierArgument.getId(ctx, "id"), null))))
                .then(CommandRoot.gated("frame")
                    .executes(CanvasCommands::frameReport)
                    .then(Commands.literal("grow")
                        .then(Commands.argument("n", IntegerArgumentType.integer(-64, 64))
                            .executes(ctx -> grow(ctx, IntegerArgumentType.getInteger(ctx, "n")))))
                    .then(Commands.argument("face", StringArgumentType.word())
                        .suggests((ctx, builder) -> SharedSuggestionProvider.suggest(
                            List.of("up", "down", "north", "south", "east", "west"), builder))
                        .then(Commands.argument("n", IntegerArgumentType.integer(-64, 64))
                            .executes(ctx -> face(ctx, StringArgumentType.getString(ctx, "face"),
                                IntegerArgumentType.getInteger(ctx, "n"))))))
                .then(CommandRoot.gated("save")
                    .executes(ctx -> save(ctx, null, false))
                    .then(Commands.literal("entities").executes(ctx -> save(ctx, null, true)))
                    .then(Commands.argument("id", IdentifierArgument.id())
                        .suggests((ctx, builder) -> SharedSuggestionProvider.suggest(
                            ctx.getSource().getServer().getStructureManager().listTemplates()
                                .map(Identifier::toString).sorted().limit(200).toList(), builder))
                        .executes(ctx -> save(ctx, IdentifierArgument.getId(ctx, "id"), false))
                        .then(Commands.literal("entities").executes(ctx ->
                            save(ctx, IdentifierArgument.getId(ctx, "id"), true)))))
                .then(CommandRoot.gated("cancel").executes(CanvasCommands::cancel))
                .then(CommandRoot.gated("canvas")
                    .executes(CanvasCommands::list)
                    .then(Commands.literal("tp").executes(CanvasCommands::tp)))));
    }

    // ---------------------------------------------------------------------------------------------

    private static void reply(final CommandSourceStack source, final String text) {
        source.sendSuccess(() -> Component.literal(text), false);
    }

    private static int refuse(final CommandSourceStack source, final String text) {
        source.sendFailure(Component.literal(text));
        return 0;
    }

    /** Who owns a session. A player is their name; anything else — a probe, a function — is one owner. */
    private static String owner(final CommandSourceStack source) {
        return source.getPlayer() != null ? source.getTextName() : "server";
    }

    // ---------------------------------------------------------------------------------------------
    // edit

    private static int open(final CommandContext<CommandSourceStack> ctx, final @Nullable Identifier id,
                            final @Nullable Vec3i blankSize) {
        final CommandSourceStack source = ctx.getSource();
        final MinecraftServer server = source.getServer();
        final ServerLevel level = Canvas.level(server, Canvas.WORKSHOP);
        if (level == null) {
            return refuse(source, Canvas.absentMessage(server));
        }
        final String owner = owner(source);
        final EditSession already = EditSession.of(owner);
        if (already != null) {
            // Never an implicit close. See the class javadoc: an edit that ends without somebody
            // saying so is the failure this loop is built to not have.
            return refuse(source, "you already have " + already.describe() + " open. /mmcp save it,"
                + " or /mmcp cancel to throw it away — opening a second edit will not close the first.");
        }

        StructureTemplate template = null;
        Vec3i size = blankSize;
        if (id != null) {
            final Optional<StructureTemplate> maybe = server.getStructureManager().get(id);
            if (maybe.isEmpty()) {
                return refuse(source, "no loaded structure template '" + id + "'. query_registry"
                    + " {registry:\"structure_template\"} lists what is loaded; a template pushed into"
                    + " the live datapack needs a reload_data before the game can see it.");
            }
            template = maybe.get();
            size = template.getSize(Rotation.NONE);
            if (size.getX() < 1 || size.getY() < 1 || size.getZ() < 1) {
                return refuse(source, "'" + id + "' has a degenerate size ("
                    + size.getX() + "x" + size.getY() + "x" + size.getZ() + ") — there is nothing to open.");
            }
        }

        final long volume = (long) size.getX() * size.getY() * size.getZ();
        if (volume > MAX_CELLS) {
            return refuse(source, "that frame is " + volume + " cells, past the " + MAX_CELLS
                + " a capture may cover — edit it in pieces.");
        }

        final int slot = EditSession.allocate();
        final BlockPos origin = Canvas.slotOrigin(slot);
        clearSlot(level, origin, size, true);
        if (template != null && !template.placeInWorld(level, origin, origin,
                new StructurePlaceSettings().setIgnoreEntities(true),
                RandomSource.create(), Block.UPDATE_CLIENTS)) {
            clearSlot(level, origin, size, false);
            return refuse(source, "'" + id + "' placed nothing — its palette is empty or its size is"
                + " degenerate on some axis. Nothing was opened.");
        }

        final EditSession session = new EditSession(owner, id, Canvas.WORKSHOP, slot, origin, size, size);
        EditSession.put(server, session);

        final ServerPlayer player = source.getPlayer();
        if (player != null) {
            player.teleportTo(level, origin.getX() - 3.5, origin.getY(), origin.getZ() - 3.5,
                Set.of(), -45.0F, 10.0F, true);
        }
        reply(source, "Opened " + session.describe()
            + "\n  The frame IS the contract: /mmcp save captures exactly this box, never the"
            + " template's own size. Grow it before you build past it — /mmcp frame up 4."
            + (player == null ? "" : "\n  You are on the platform at the frame's near corner; it sits one"
                + " block BELOW the frame, so it is never captured.")
            + frameVisibility()
            + "\n  /mmcp frame · /mmcp save · /mmcp cancel");
        return 1;
    }

    /**
     * Empty the working area, and lay (or lift) the platform under it.
     *
     * <p>Clearing on OPEN as well as on cancel is not belt-and-braces: a slot is reused once its last
     * session ends, and a session that ended when the server died never ran its own clear.
     */
    private static void clearSlot(final ServerLevel level, final BlockPos origin, final Vec3i size,
                                  final boolean platform) {
        final BlockState air = Blocks.AIR.defaultBlockState();
        for (int x = origin.getX() - MARGIN; x < origin.getX() + size.getX() + MARGIN; x++) {
            for (int z = origin.getZ() - MARGIN; z < origin.getZ() + size.getZ() + MARGIN; z++) {
                for (int y = origin.getY() - 1; y < origin.getY() + size.getY() + MARGIN; y++) {
                    final boolean floor = platform && y == origin.getY() - 1;
                    level.setBlock(new BlockPos(x, y, z), floor ? PLATFORM : air, Block.UPDATE_CLIENTS);
                }
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // frame

    private static int frameReport(final CommandContext<CommandSourceStack> ctx) {
        final CommandSourceStack source = ctx.getSource();
        final EditSession session = EditSession.of(owner(source));
        if (session == null) {
            return refuse(source, "nothing open. /mmcp edit <structure id>");
        }
        final BlockPos max = session.max();
        reply(source, session.describe()
            + "\n  min " + session.origin().getX() + " " + session.origin().getY() + " " + session.origin().getZ()
            + "   max " + max.getX() + " " + max.getY() + " " + max.getZ()
            + "   (" + session.volume() + " cells)"
            + frameVisibility()
            + "\n  /mmcp frame <up|down|north|south|east|west> <n>, or /mmcp frame grow <n>");
        return 1;
    }

    private static int grow(final CommandContext<CommandSourceStack> ctx, final int n) {
        final CommandSourceStack source = ctx.getSource();
        final EditSession session = EditSession.of(owner(source));
        if (session == null) {
            return refuse(source, "nothing open. /mmcp edit <structure id>");
        }
        return reframe(ctx, session,
            session.origin().offset(-n, -n, -n),
            new Vec3i(session.size().getX() + 2 * n, session.size().getY() + 2 * n,
                session.size().getZ() + 2 * n));
    }

    private static int face(final CommandContext<CommandSourceStack> ctx, final String rawFace, final int n) {
        final CommandSourceStack source = ctx.getSource();
        final EditSession session = EditSession.of(owner(source));
        if (session == null) {
            return refuse(source, "nothing open. /mmcp edit <structure id>");
        }
        final Direction face = Direction.byName(rawFace.toLowerCase(Locale.ROOT));
        if (face == null) {
            return refuse(source, "'" + rawFace + "' is not a face — up, down, north, south, east or west.");
        }
        // Moving a face OUT always grows the box by n on that axis; which corner moves depends on
        // whether the face is the positive or the negative end of it.
        final Vec3i step = face.getUnitVec3i();
        final BlockPos origin = face.getAxisDirection() == Direction.AxisDirection.NEGATIVE
            ? session.origin().offset(step.getX() * n, step.getY() * n, step.getZ() * n)
            : session.origin();
        final Vec3i size = new Vec3i(
            session.size().getX() + Math.abs(step.getX()) * n,
            session.size().getY() + Math.abs(step.getY()) * n,
            session.size().getZ() + Math.abs(step.getZ()) * n);
        return reframe(ctx, session, origin, size);
    }

    private static int reframe(final CommandContext<CommandSourceStack> ctx, final EditSession session,
                               final BlockPos origin, final Vec3i size) {
        final CommandSourceStack source = ctx.getSource();
        if (size.getX() < 1 || size.getY() < 1 || size.getZ() < 1) {
            return refuse(source, "that would leave the frame " + size.getX() + "x" + size.getY() + "x"
                + size.getZ() + " — every axis must stay at least 1.");
        }
        final long volume = (long) size.getX() * size.getY() * size.getZ();
        if (volume > MAX_CELLS) {
            return refuse(source, "that frame would be " + volume + " cells, past the " + MAX_CELLS
                + " a capture may cover.");
        }
        final EditSession moved = session.withFrame(origin, size);
        EditSession.put(source.getServer(), moved);
        reply(source, "Frame is now " + size.getX() + "x" + size.getY() + "x" + size.getZ()
            + " at " + origin.getX() + " " + origin.getY() + " " + origin.getZ()
            + " (" + volume + " cells). /mmcp save captures exactly this.");
        return 1;
    }

    private static String frameVisibility() {
        final Boolean drawn = CanvasFrame.available();
        if (Boolean.FALSE.equals(drawn)) {
            return "\n  NOTE: the frame is not drawn on this server (no gizmo collector — expected on a"
                + " dedicated server). Its corners are above; /mmcp frame repeats them.";
        }
        return "";
    }

    // ---------------------------------------------------------------------------------------------
    // save

    private static int save(final CommandContext<CommandSourceStack> ctx, final @Nullable Identifier rawId,
                            final boolean entities) {
        final CommandSourceStack source = ctx.getSource();
        final MinecraftServer server = source.getServer();
        final EditSession session = EditSession.of(owner(source));
        if (session == null) {
            return refuse(source, "nothing open. /mmcp edit <structure id>");
        }
        final Identifier id = rawId != null ? rawId : session.id();
        if (id == null) {
            return refuse(source, "this frame was opened blank, so there is no id to save it under —"
                + " /mmcp save <namespace:path>");
        }
        final ServerLevel level = Canvas.level(server, session.dimension());
        if (level == null) {
            return refuse(source, Canvas.absentMessage(server));
        }

        // Asked BEFORE the write and reported either way (trap 13): entities are not blocks, the
        // default does not take them, and a human's hour of item frames must not vanish quietly.
        final int standing = countEntities(level, session);
        // Trap 14: "I built past the box" is something the tool says, not something the human
        // discovers later as a seam.
        final Stray stray = straysOutside(level, session);

        final JsonObject args = new JsonObject();
        args.add("min", vec(session.origin().getX(), session.origin().getY(), session.origin().getZ()));
        args.add("size", vec(session.size().getX(), session.size().getY(), session.size().getZ()));
        args.addProperty("id", id.toString());
        args.addProperty("dimension", session.dimension().identifier().toString());
        args.addProperty("entities", entities);
        // FALSE, and this is the load-bearing half of the reply arriving at all. A capture with
        // reload:true returns a future that completes on a LATER tick, and a command's feedback
        // collector has stopped listening by then: run_command reported an EMPTY output for a save
        // that had in fact written the file. So the write is taken synchronously and answered
        // synchronously, and the reload — which only decides when the game can LOAD the new
        // template, not whether the bytes are on disk — is kicked off after and reported when it lands.
        args.addProperty("reload", false);

        final JsonObject r;
        try {
            // The SAME engine capture_structure runs, called with the frame the session remembered —
            // not a second implementation of it, which is the drift this repo spends its effort
            // avoiding. With reload:false its future is already complete, so this does not block.
            r = DataTools.captureBox(server, args).join().getAsJsonObject();
        } catch (final Exception e) {
            final Throwable cause = e.getCause() == null ? e : e.getCause();
            return refuse(source, "capture failed: "
                + (cause.getMessage() == null ? cause.toString() : cause.getMessage()));
        }
        reply(source, "Saved " + id + " -> " + str(r, "path")
            + "\n  " + num(r, "blocks") + " blocks, " + num(r, "air") + " air, "
            + num(r, "block_entities") + " block entities, " + num(r, "bytes") + " bytes"
            + (entities
                ? "\n  entities: " + num(r, "entities") + " captured"
                : "\n  entities: NOT captured — " + standing + " standing in the frame"
                    + (standing == 0 ? "" : " (item frames, armour stands and paintings among them"
                        + " are not in this file; /mmcp save " + id + " entities takes them)"))
            + stray.describe()
            + "\n  Reloading the datapack so the game can load it — until that finishes,"
            + " place_structure still holds the PREVIOUS bytes for this id."
            + "\n  The frame stays open: /mmcp save again after more edits, or /mmcp cancel to"
            + " clear the slot — the .nbt you just wrote is not touched by either."
            + "\n  What changed: place_structure {id:\"" + id + "\", compare:true} against the"
            + " original reports it cell by cell.");
        DataTools.reloadPacks(server).whenComplete((v, error) -> server.execute(() -> {
            if (error != null) {
                source.sendFailure(Component.literal("the datapack reload after saving " + id
                    + " failed: " + error.getMessage() + " — the .nbt is written; reload_data retries"));
            }
        }));
        return 1;
    }

    /** Non-air cells in the working area but outside the frame — the "I built past the box" report. */
    private record Stray(int count, List<String> sample) {
        String describe() {
            if (count == 0) {
                return "\n  Nothing of yours sits outside the frame.";
            }
            return "\n  " + count + " non-air cell(s) sit OUTSIDE the frame and were NOT saved: "
                + String.join(", ", sample) + (count > sample.size() ? ", …" : "")
                + "\n  Grow the frame (/mmcp frame <face> <n>) and save again if they belong to this piece.";
        }
    }

    private static Stray straysOutside(final ServerLevel level, final EditSession session) {
        final BlockPos origin = session.origin();
        final Vec3i size = session.size();
        final java.util.ArrayList<String> sample = new java.util.ArrayList<>();
        int count = 0;
        for (int x = origin.getX() - MARGIN; x < origin.getX() + size.getX() + MARGIN; x++) {
            for (int z = origin.getZ() - MARGIN; z < origin.getZ() + size.getZ() + MARGIN; z++) {
                for (int y = origin.getY(); y < origin.getY() + size.getY() + MARGIN; y++) {
                    final boolean inside = x >= origin.getX() && x < origin.getX() + size.getX()
                        && y >= origin.getY() && y < origin.getY() + size.getY()
                        && z >= origin.getZ() && z < origin.getZ() + size.getZ();
                    if (inside) {
                        continue;
                    }
                    if (level.getBlockState(new BlockPos(x, y, z)).isAir()) {
                        continue;
                    }
                    count++;
                    if (sample.size() < STRAY_SAMPLE) {
                        sample.add(x + " " + y + " " + z);
                    }
                }
            }
        }
        return new Stray(count, List.copyOf(sample));
    }

    private static int countEntities(final ServerLevel level, final EditSession session) {
        final AABB box = session.aabb();
        int n = 0;
        for (final Entity e : level.getEntities((Entity) null, box, x -> true)) {
            if (!(e instanceof net.minecraft.world.entity.player.Player)) {
                n++;
            }
        }
        return n;
    }

    // ---------------------------------------------------------------------------------------------
    // cancel, list, tp

    private static int cancel(final CommandContext<CommandSourceStack> ctx) {
        final CommandSourceStack source = ctx.getSource();
        final MinecraftServer server = source.getServer();
        final EditSession session = EditSession.of(owner(source));
        if (session == null) {
            return refuse(source, "nothing open. /mmcp edit <structure id>");
        }
        final ServerLevel level = Canvas.level(server, session.dimension());
        if (level != null) {
            clearSlot(level, session.origin(), session.size(), false);
        }
        EditSession.remove(server, session.owner());
        reply(source, "Cleared slot " + session.slot() + " and dropped the session ("
            + (session.id() == null ? "blank frame" : session.id().toString()) + ")."
            + " Any .nbt already saved is untouched.");
        return 1;
    }

    private static int list(final CommandContext<CommandSourceStack> ctx) {
        final CommandSourceStack source = ctx.getSource();
        final MinecraftServer server = source.getServer();
        final List<EditSession> open = EditSession.all();
        final StringBuilder out = new StringBuilder();
        out.append(Canvas.present(server)
            ? "Canvas: mcptoolkit:workshop and mcptoolkit:studio are loaded."
            : "Canvas: NOT in this world. " + Canvas.absentMessage(server));
        if (open.isEmpty()) {
            out.append("\n  Nothing open. /mmcp edit <structure id>");
        } else {
            for (final EditSession session : open) {
                out.append("\n  [").append(session.slot()).append("] ").append(session.describe());
            }
            // Only when something is open: whether a frame is DRAWN is a fact about a frame, and
            // saying it over an empty list reads as a fault in the canvas rather than as a property
            // of a dedicated server.
            out.append(frameVisibility());
        }
        reply(source, out.toString());
        return open.size();
    }

    private static int tp(final CommandContext<CommandSourceStack> ctx) {
        final CommandSourceStack source = ctx.getSource();
        final ServerPlayer player = source.getPlayer();
        if (player == null) {
            return refuse(source, "/mmcp canvas tp needs a player to move.");
        }
        final EditSession session = EditSession.of(owner(source));
        if (session == null) {
            return refuse(source, "nothing open. /mmcp edit <structure id>");
        }
        final ServerLevel level = Canvas.level(source.getServer(), session.dimension());
        if (level == null) {
            return refuse(source, Canvas.absentMessage(source.getServer()));
        }
        player.teleportTo(level, session.origin().getX() - 3.5, session.origin().getY(),
            session.origin().getZ() - 3.5, Set.of(), -45.0F, 10.0F, true);
        reply(source, "At " + session.describe());
        return 1;
    }

    // ---------------------------------------------------------------------------------------------

    private static JsonObject vec(final int x, final int y, final int z) {
        final JsonObject o = new JsonObject();
        o.addProperty("x", x);
        o.addProperty("y", y);
        o.addProperty("z", z);
        return o;
    }

    private static String str(final JsonObject o, final String key) {
        final JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? "?" : e.getAsString();
    }

    private static String num(final JsonObject o, final String key) {
        final JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? "?" : e.getAsString();
    }
}
