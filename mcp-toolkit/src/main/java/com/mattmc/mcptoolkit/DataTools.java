package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtIo;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.packs.repository.PackRepository;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import net.minecraft.world.level.storage.LevelResource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Live data push — the server-side twin of {@code push_asset}. Writes recipes/loot tables/tags/advancements/
 * functions/etc. into a toolkit-managed <em>world datapack</em> and reloads the server, so datapack changes
 * take effect without editing files by hand or restarting. Mirrors {@link com.mattmc.mcptoolkit.client.AssetTools}:
 * one persistent folder pack ({@code file/mcptoolkit_data}) under the world's {@code datapacks/} dir, force-selected
 * on reload.
 *
 * <p><b>Limitation:</b> worldgen data (dimensions, dimension types, most {@code worldgen/} registries) is read
 * at world load and does <em>not</em> hot-reload — those still need a world restart. The reloadable kinds
 * (recipe, loot_table, tags, advancement, function, item_modifier, predicate, damage_type, chat_type) do —
 * and so do <b>structures</b>, which is easy to assume otherwise because they are worldgen's raw material:
 * {@code MinecraftServer.reloadResources} calls {@code structureTemplateManager.onResourceManagerReload},
 * which clears the template cache. That is what makes {@code capture_structure}'s loop a reload rather than
 * a restart.
 */
public final class DataTools {
    private DataTools() {}

    private static final String PACK_NAME = "mcptoolkit_data";
    private static final String PACK_ID = "file/" + PACK_NAME;

    public static void register() {
        McpTools.register(ToolDef.async(
            "push_data",
            "Write a datapack file into the toolkit's live world datapack and reload the server so it takes "
                + "effect immediately. \"path\" is relative to the pack root, e.g. "
                + "\"data/<namespace>/recipe/foo.json\" or \"data/minecraft/tags/block/mineable/pickaxe.json\" "
                + "(tag dirs are SINGULAR: tags/block, tags/item) "
                + "— use a namespace the attached game actually loads; an unknown one succeeds and does nothing. "
                + "Supply the bytes as \"base64\", or as \"file\" (absolute local path the server copies from — "
                + "prefer this for anything already on disk; it keeps the bytes out of the conversation). "
                + "Every push is CHECKED AGAINST THE GAME'S OWN CODEC first and reports `validation` "
                + "{kind, id, checked_by, valid, error} — this catches what a reload cannot: worldgen "
                + "files (never reloaded), a batched push, and a directory no loader scans (kind null). "
                + "It never blocks the write; \"dry_run\" true checks and writes nothing. "
                + "Set \"reload\" false to batch several pushes "
                + "before a final reload_data. A reload reports `ok` and any `problems` the game LOGGED AND "
                + "SKIPPED — vanilla steps over a malformed recipe or loot table, so check that rather than "
                + "reading `reloaded` as loaded. Reloadable: recipes, loot tables, tags, advancements, functions, "
                + "predicates, item modifiers, and STRUCTURES (data/<ns>/structure/*.nbt — the server clears "
                + "its template cache on reload, so iterating on a structure's blocks is a reload, not a "
                + "restart; see capture_structure). NOT reloadable: worldgen (needs a world restart).",
            Schemas.objectOpt(
                Schemas.object(
                    "path", Schemas.str("Pack-relative path, e.g. data/<namespace>/recipe/foo.json"),
                    "base64", Schemas.str("File contents, base64-encoded. Omit if \"file\" is given."),
                    "file", Schemas.str("Absolute local path to copy the bytes from. Omit if \"base64\" is given."),
                    "dry_run", Schemas.bool("Validate only: report `validation` and write nothing."),
                    "reload", Schemas.bool("Reload the server after writing (default true).")),
                "base64", "file", "dry_run", "reload"),
            ExecutionContext.SERVER,
            Mechanism.PRIVILEGED,
            (ctx, a) -> push(ctx.serverOrThrow(), a)));

        McpTools.register(ToolDef.async(
            "capture_structure",
            "Save a box of the LIVE WORLD as a vanilla structure .nbt inside the toolkit's live world "
                + "datapack — the missing hop between building something in the world and having it be "
                + "datapack content. `id` is namespaced: \"mymod:rooms/library\" writes "
                + "data/mymod/structure/rooms/library.nbt, which is where the game looks for a structure "
                + "of that id, and is reloadable (structures re-read on datapack reload, so iterating on "
                + "a piece's BLOCKS is a reload, not a restart). `min` + `size` name the frame; both are "
                + "required and neither is inferred — a piece captured one block off draws with a seam "
                + "and nothing says so. Air is captured (it carves), minecraft:structure_void is not, "
                + "exactly as a structure block saves. Returns the PATH and a census — bytes, palette "
                + "size, `palettes` (a template with more than one is a trap: readers that expect the "
                + "single-palette key resolve every block to air), block_entities, entities, and any "
                + "non-vanilla block ids — never the bytes themselves. Set \"reload\" false to batch.",
            Schemas.objectOpt(
                Schemas.object(
                    "min", Schemas.vec3i("Lowest corner of the box to capture (inclusive)."),
                    "size", Schemas.vec3i("Box size in blocks, each >= 1."),
                    "id", Schemas.str("Namespaced structure id, e.g. mymod:rooms/library."),
                    "dimension", Schemas.str("Dimension to read (default minecraft:overworld)."),
                    "entities", Schemas.bool("Capture entities standing in the box too (default false)."),
                    "reload", Schemas.bool("Reload the server after writing (default true).")),
                "dimension", "entities", "reload"),
            ExecutionContext.SERVER,
            Mechanism.PRIVILEGED,
            (ctx, a) -> capture(ctx.serverOrThrow(), a)));

        McpTools.register(ToolDef.async(
            "reload_data",
            "Reload the server's datapacks — the programmatic equivalent of /reload — picking up the toolkit's "
                + "live datapack and any external datapack edits. Use after batched push_data calls. "
                + "Returns `ok` plus `problems`: the WARN/ERROR lines the game logged DURING this reload. "
                + "Read those, not `reloaded` — vanilla logs and steps over a malformed recipe or loot "
                + "table, so a reload can succeed with your file not loaded. get_log has the full lines.",
            Schemas.object(),
            ExecutionContext.SERVER,
            Mechanism.PRIVILEGED,
            (ctx, a) -> reload(ctx.serverOrThrow())));

        McpTools.register(ToolDef.of(
            "list_data",
            "List every file in the toolkit's live world datapack — the data overrides push_data has "
                + "accumulated. The pack persists in the world's datapacks/ dir across restarts. Returns "
                + "pack-relative paths with sizes.",
            Schemas.object(),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> listData(ctx.serverOrThrow())));

        McpTools.register(ToolDef.async(
            "clear_data",
            "Delete entries from the live world datapack and reload, restoring the underlying data. Pass "
                + "\"path\" (pack-relative, as listed by list_data) to remove one file or a whole "
                + "directory, or omit it to clear the pack. Set \"reload\" false to batch. PROMOTION "
                + "rides here: \"promote\" copies each file out to a mod's source tree first, so the "
                + "step that gets forgotten - dropping the override that then shadows the copy - "
                + "cannot be skipped.",
            Schemas.objectOpt(
                Schemas.object(
                    "path", Schemas.str("Pack-relative path of an entry, or of a directory "
                        + "(data/<namespace>) to take all of; omit to clear all."),
                    "promote", Schemas.str("A mod's EXISTING resources root (src/main/resources): "
                        + "each file is copied there, same relative path, before anything is deleted. "
                        + "Never defaulted, never created - a promotion with nowhere to go is refused, "
                        + "and a refusal clears nothing. Requires \"path\"."),
                    "reload", Schemas.bool("Reload the server after deleting (default true).")),
                "path", "promote", "reload"),
            ExecutionContext.SERVER,
            Mechanism.PRIVILEGED,
            (ctx, a) -> clearData(ctx.serverOrThrow(), a)));
    }

    /**
     * The live pack's directory — <b>normalized</b>, which is load-bearing. The containment check in
     * {@code push}/{@code clearData} compares a normalized target against this root, and a dedicated
     * server's world path is RELATIVE ({@code .\world\datapacks\...}): normalizing only one side made
     * {@code target.startsWith(root)} false for every legal path, so push_data and clear_data refused
     * everything with "path escapes the pack root". A client-hosted world has an absolute path and
     * normalizes to itself, which is why this only ever bit headless runs (found by the 0.41.0
     * extension probes, the first to push a datapack from a headless server).
     */
    private static Path root(final MinecraftServer server) {
        return server.getWorldPath(LevelResource.DATAPACK_DIR).resolve(PACK_NAME).normalize();
    }

    /**
     * The live pack's directory, for the one other subsystem that writes into it:
     * {@link com.mattmc.mcptoolkit.canvas.Canvas} installs the canvas dimension files here so a
     * loader-only game (no fabric-api, hence no mod-resource datapack) gets them anyway. Exposed
     * rather than duplicated, because the normalization above is load-bearing and a second copy of it
     * would be a second chance to get a dedicated server's relative world path wrong.
     */
    public static Path packRoot(final MinecraftServer server) {
        return root(server);
    }

    /** {@link #ensureInit} for that same caller: create the pack and repair its {@code pack.mcmeta}. */
    public static void ensurePack(final Path root) throws IOException {
        ensureInit(root);
    }

    /**
     * {@code capture_structure}, called with arguments rather than over the bridge — the edit
     * session's {@code save} is exactly this tool run against the frame the session remembered, and
     * routing it here rather than re-implementing {@code fillFromWorld} is what keeps the two from
     * drifting. Same arguments, same refusals, same census.
     */
    public static CompletableFuture<JsonElement> captureBox(final MinecraftServer server,
                                                            final JsonObject args) {
        return capture(server, args);
    }

    /** {@code reload_data} for the same caller — what makes a just-written template loadable. */
    public static CompletableFuture<JsonElement> reloadPacks(final MinecraftServer server) {
        return reload(server);
    }

    /**
     * The live pack's {@code pack.mcmeta} — and it is not a one-liner any more, for a reason found
     * by the tool this version adds.
     *
     * <p>Since {@code PackFormat.lastPreMinorVersion(SERVER_DATA) == 81}, a datapack declaring a
     * format above that <b>must</b> carry {@code min_format} and {@code max_format}. This one
     * declared only {@code pack_format}, so every reload logged
     * "Error reading pack metadata, attempting fallback type" at WARN and fell back to a codec that
     * reports the pack as {@code Integer.MAX_VALUE} — i.e. the toolkit's own pack claimed to be
     * from a version of the game that does not exist. It kept working, which is exactly why nobody
     * noticed: the fallback path force-selects it anyway. The FIRST reload run under
     * {@code get_log} printed it, and it had to be fixed before {@code ok:false} could mean
     * anything, since otherwise every reload in the world would have reported a problem.
     *
     * <p>{@code max_format} parses through {@code TOP_CODEC}, whose default minor is
     * {@code Integer.MAX_VALUE}, so the bare major spans the whole minor series — the same range
     * {@code PackFormat.minorRange()} builds.
     *
     * <p><b>An existing file is repaired, not left alone.</b> The pack persists in the world folder
     * across restarts, so a "write only when missing" fix would never reach a world that already
     * has one — including this workspace's own. The toolkit wrote this file and nobody else edits
     * it, so rewriting a stale one is bookkeeping rather than clobbering.
     */
    private static void ensureInit(final Path root) throws IOException {
        Files.createDirectories(root.resolve("data"));
        Path meta = root.resolve("pack.mcmeta");
        String want = "{\"pack\":{\"description\":\"MCP Toolkit live datapack\","
            + "\"pack_format\":" + SharedConstants.DATA_PACK_FORMAT_MAJOR + ","
            + "\"min_format\":" + SharedConstants.DATA_PACK_FORMAT_MAJOR + ","
            + "\"max_format\":" + SharedConstants.DATA_PACK_FORMAT_MAJOR + "}}";
        if (!Files.exists(meta) || !Files.readString(meta).contains("min_format")) {
            Files.writeString(meta, want);
        }
    }

    private static CompletableFuture<JsonElement> push(final MinecraftServer server, final JsonObject a) {
        String rel = str(a, "path");
        boolean dry = a.has("dry_run") && !a.get("dry_run").isJsonNull() && a.get("dry_run").getAsBoolean();
        boolean reload = !dry
            && (!a.has("reload") || a.get("reload").isJsonNull() || a.get("reload").getAsBoolean());
        JsonObject r = new JsonObject();
        try {
            // Two doors for the same bytes, matching push_asset. `file` is not a convenience: a
            // recipe you just wrote to disk otherwise rides through the transcript base64-encoded,
            // which is ~40 tokens as a path and thousands as a blob, on the write half of the loop
            // a modder repeats most often.
            byte[] bytes;
            if (a.has("base64") && !a.get("base64").isJsonNull()) {
                bytes = Base64.getDecoder().decode(a.get("base64").getAsString());
            } else if (a.has("file") && !a.get("file").isJsonNull()) {
                Path src = Path.of(a.get("file").getAsString());
                if (!Files.isRegularFile(src)) {
                    throw new IllegalArgumentException("no such file: " + src);
                }
                bytes = Files.readAllBytes(src);
            } else {
                throw new IllegalArgumentException("need either 'base64' or 'file'");
            }
            Path root = root(server);
            Path target = root.resolve(rel).normalize();
            if (!target.startsWith(root)) {
                throw new IllegalArgumentException("path escapes the pack root: " + rel);
            }
            // The question the loader would ask, asked BEFORE the write and reported either way. It
            // is never a refusal: a batch pushes siblings in an order where one legitimately cannot
            // resolve the other yet, and refusing the write would make that order illegal.
            r.add("validation", DataCodecs.validate(server, root.relativize(target).toString(), bytes));
            r.addProperty("bytes", bytes.length);
            if (dry) {
                r.addProperty("dry_run", true);
                r.addProperty("would_write", root.relativize(target).toString().replace('\\', '/'));
                r.addProperty("reloaded", false);
                return CompletableFuture.completedFuture(r);
            }
            ensureInit(root);
            Files.createDirectories(target.getParent());
            Files.write(target, bytes);
            r.addProperty("written", root.relativize(target).toString().replace('\\', '/'));
        } catch (Exception e) {
            return CompletableFuture.failedFuture(e);
        }
        if (!reload) {
            r.addProperty("reloaded", false);
            return CompletableFuture.completedFuture(r);
        }
        return reload(server).thenApply(v -> {
            if (v.isJsonObject()) {
                v.getAsJsonObject().entrySet().forEach(e -> r.add(e.getKey(), e.getValue()));
            }
            r.addProperty("reloaded", true);
            return (JsonElement) r;
        });
    }

    // ---- capture_structure ---------------------------------------------------

    /**
     * Cells one capture may cover. A jigsaw piece is at most 48³ and an authored room is a fraction of
     * that; past this the file is the problem, not the box.
     */
    private static final int CAPTURE_MAX_VOLUME = 64 * 64 * 64;

    /**
     * A world box becomes a structure {@code .nbt} in the live datapack. The body is vanilla's own
     * {@code fillFromWorld → save → write}; what this adds is everything a caller would otherwise find
     * out later.
     *
     * <p><b>The single palette is vanilla's guarantee, and this reports it rather than asserting it.</b>
     * {@code fillFromWorld} clears the palette list and adds exactly one, so a capture cannot be
     * multi-palette — but {@code save} writes {@code "palettes"} (plural) and NO {@code "palette"} when a
     * template holds more than one, and a reader that only knows the singular key then resolves every
     * block to air and bakes a completely blank structure that passes every size check. Rocketeer's
     * {@code PieceBake} found that by reading vanilla's source. So the count is read back out of the tag
     * that was actually written: if the invariant ever changes, this says so instead of a consumer
     * discovering it as an empty room.
     *
     * <p><b>An unread chunk would be captured as air.</b> Chunks in the footprint are paged in the same
     * way every read tool pages them — never generating terrain — and a column that stays unread refuses
     * the whole capture. Silently recording air for "I could not look" is the one failure that survives
     * to the datapack.
     */
    private static CompletableFuture<JsonElement> capture(final MinecraftServer server, final JsonObject a) {
        boolean reload = !a.has("reload") || a.get("reload").isJsonNull() || a.get("reload").getAsBoolean();
        JsonObject r = new JsonObject();
        try {
            ServerLevel level = WorldPerceptionTools.levelArg(server, a);
            BlockPos min = pos(a, "min");
            BlockPos size = pos(a, "size");
            if (size.getX() < 1 || size.getY() < 1 || size.getZ() < 1) {
                throw new IllegalArgumentException("`size` must be at least 1 on every axis, got "
                    + size.getX() + "x" + size.getY() + "x" + size.getZ());
            }
            long volume = (long) size.getX() * size.getY() * size.getZ();
            if (volume > CAPTURE_MAX_VOLUME) {
                throw new IllegalArgumentException("box volume " + volume + " exceeds the cap of "
                    + CAPTURE_MAX_VOLUME + " — capture one piece, not an area");
            }
            Identifier id = Identifier.parse(str(a, "id"));
            String rel = "data/" + id.getNamespace() + "/structure/" + id.getPath() + ".nbt";

            // Page the footprint in first: fillFromWorld reads block by block and an absent chunk
            // answers air, which is indistinguishable in the file from a room with an open wall.
            ReadSupport.ChunkLoader loader = new ReadSupport.ChunkLoader(level, true);
            BlockPos.MutableBlockPos probe = new BlockPos.MutableBlockPos();
            int unread = 0;
            for (int x = min.getX(); x < min.getX() + size.getX(); x++) {
                for (int z = min.getZ(); z < min.getZ() + size.getZ(); z++) {
                    if (!loader.ensure(probe.set(x, min.getY(), z))) {
                        unread++;
                    }
                }
            }
            if (unread > 0) {
                throw new IllegalArgumentException(unread + " of "
                    + (size.getX() * size.getZ()) + " columns in the box could not be read (never-"
                    + "generated terrain, or the paging budget) — every one of them would have been "
                    + "captured as AIR, so nothing was written");
            }

            // Census from the WORLD, beside the one the tag gives: what a consumer silently loses.
            int air = 0, solid = 0, voids = 0, blockEntities = 0;
            Set<String> nonVanilla = new LinkedHashSet<>();
            for (int x = min.getX(); x < min.getX() + size.getX(); x++) {
                for (int y = min.getY(); y < min.getY() + size.getY(); y++) {
                    for (int z = min.getZ(); z < min.getZ() + size.getZ(); z++) {
                        BlockState st = level.getBlockState(probe.set(x, y, z));
                        if (st.is(Blocks.STRUCTURE_VOID)) {
                            voids++;
                            continue;
                        }
                        if (st.isAir()) {
                            air++;
                        } else {
                            solid++;
                        }
                        Identifier key = BuiltInRegistries.BLOCK.getKey(st.getBlock());
                        if (!"minecraft".equals(key.getNamespace())) {
                            nonVanilla.add(key.toString());
                        }
                        if (level.getBlockEntity(probe) != null) {
                            blockEntities++;
                        }
                    }
                }
            }

            boolean entities = a.has("entities") && !a.get("entities").isJsonNull()
                && a.get("entities").getAsBoolean();
            StructureTemplate template = new StructureTemplate();
            template.fillFromWorld(level, min, size, entities, List.of(Blocks.STRUCTURE_VOID));
            CompoundTag tag = template.save(new CompoundTag());

            Path root = root(server);
            ensureInit(root);
            Path target = root.resolve(rel).normalize();
            if (!target.startsWith(root)) {
                throw new IllegalArgumentException("structure id escapes the pack root: " + id);
            }
            Files.createDirectories(target.getParent());
            NbtIo.writeCompressed(tag, target);

            r.addProperty("path", rel);
            r.addProperty("file", target.toAbsolutePath().toString());
            r.addProperty("id", id.toString());
            r.addProperty("bytes", Files.size(target));
            JsonObject sizeOut = new JsonObject();
            sizeOut.addProperty("x", size.getX());
            sizeOut.addProperty("y", size.getY());
            sizeOut.addProperty("z", size.getZ());
            r.add("size", sizeOut);
            r.addProperty("blocks", solid);
            r.addProperty("air", air);
            if (voids > 0) {
                r.addProperty("structure_void", voids); // recorded nowhere in the file, by design
            }
            r.addProperty("palette_size", tag.getListOrEmpty("palette").size());
            // Read back out of the tag, not assumed — see the javadoc.
            r.addProperty("palettes", tag.getList("palettes").map(l -> l.size()).orElse(1));
            r.addProperty("block_entities", blockEntities);
            r.addProperty("entities", tag.getListOrEmpty("entities").size());
            if (!nonVanilla.isEmpty()) {
                JsonArray mods = new JsonArray();
                nonVanilla.forEach(mods::add);
                r.add("non_vanilla", mods);
                r.addProperty("non_vanilla_note", "these resolve to AIR wherever the mod that owns them "
                    + "is not installed");
            }
        } catch (Exception e) {
            return CompletableFuture.failedFuture(e);
        }
        if (!reload) {
            r.addProperty("reloaded", false);
            return CompletableFuture.completedFuture(r);
        }
        return reload(server).thenApply(v -> {
            r.addProperty("reloaded", true);
            return (JsonElement) r;
        });
    }

    private static BlockPos pos(final JsonObject a, final String key) {
        if (!a.has(key) || !a.get(key).isJsonObject()) {
            throw new IllegalArgumentException("missing `" + key + "` {x,y,z}");
        }
        JsonObject o = a.getAsJsonObject(key);
        for (String axis : new String[] {"x", "y", "z"}) {
            if (!o.has(axis) || o.get(axis).isJsonNull()) {
                throw new IllegalArgumentException("`" + key + "` needs " + axis);
            }
        }
        return new BlockPos(o.get("x").getAsInt(), o.get("y").getAsInt(), o.get("z").getAsInt());
    }

    // ---- list_data / clear_data ----------------------------------------------

    private static JsonElement listData(final MinecraftServer server) {
        JsonObject r = new JsonObject();
        r.addProperty("pack", PACK_ID);
        JsonArray entries = new JsonArray();
        Path root = root(server);
        if (Files.isDirectory(root)) {
            try (var walk = Files.walk(root)) {
                for (Path p : walk.filter(Files::isRegularFile).sorted().toList()) {
                    String rel = root.relativize(p).toString().replace('\\', '/');
                    if (rel.equals("pack.mcmeta")) {
                        continue; // pack scaffolding, not an override
                    }
                    JsonObject o = new JsonObject();
                    o.addProperty("path", rel);
                    try {
                        o.addProperty("bytes", Files.size(p));
                    } catch (IOException ignored) {
                    }
                    entries.add(o);
                }
            } catch (IOException e) {
                throw new RuntimeException("could not walk the live datapack: " + e, e);
            }
        }
        r.add("entries", entries);
        r.addProperty("count", entries.size());
        return r;
    }

    /**
     * Delete entries, optionally promoting them into a mod source tree on the way out - the server
     * twin of {@code clear_assets}. Every file is COPIED before any file is deleted ({@link
     * Promote}); see that class for why the promotion rides the clear rather than standing alone.
     */
    private static CompletableFuture<JsonElement> clearData(final MinecraftServer server, final JsonObject a) {
        boolean reload = !a.has("reload") || a.get("reload").isJsonNull() || a.get("reload").getAsBoolean();
        JsonObject r = new JsonObject();
        JsonArray deleted = new JsonArray();
        try {
            Path root = root(server);
            Path data = root.resolve("data");
            String rel = a.has("path") && !a.get("path").isJsonNull() ? a.get("path").getAsString() : null;
            String promote = a.has("promote") && !a.get("promote").isJsonNull()
                ? a.get("promote").getAsString() : null;
            if (promote != null && rel == null) {
                throw new IllegalArgumentException("`promote` needs `path`: name the entry, or the "
                    + "namespace directory (data/<namespace>). Promoting the whole pack would put "
                    + "every namespace in it - minecraft's own tag overrides included - into one "
                    + "mod's source tree.");
            }
            List<Path> files;
            if (rel != null) {
                files = Promote.resolve(root, rel, "entry");
            } else if (Files.isDirectory(data)) {
                try (var walk = Files.walk(data)) {
                    files = walk.filter(Files::isRegularFile).sorted().toList();
                }
            } else {
                files = List.of();
            }
            if (promote != null) {
                Path dest = Promote.destination(promote);
                r.add("promoted", Promote.copy(root, files, dest));
                r.addProperty("note", Promote.note(dest));
            }
            for (Path p : files) {
                Files.delete(p);
                deleted.add(root.relativize(p).toString().replace('\\', '/'));
            }
            pruneEmptyDirs(data);
        } catch (Exception e) {
            return CompletableFuture.failedFuture(e);
        }
        r.add("deleted", deleted);
        r.addProperty("count", deleted.size());
        if (!reload) {
            r.addProperty("reloaded", false);
            return CompletableFuture.completedFuture(r);
        }
        return reload(server).thenApply(v -> {
            r.addProperty("reloaded", true);
            return (JsonElement) r;
        });
    }

    /** Drop directories the deletes emptied, deepest-first; {@code data/} itself stays. */
    private static void pruneEmptyDirs(final Path data) throws IOException {
        if (!Files.isDirectory(data)) {
            return;
        }
        try (var walk = Files.walk(data)) {
            for (Path p : walk.sorted(Comparator.reverseOrder()).toList()) {
                if (p.equals(data) || !Files.isDirectory(p)) {
                    continue;
                }
                try (var kids = Files.list(p)) {
                    if (kids.findAny().isEmpty()) {
                        Files.delete(p);
                    }
                }
            }
        }
    }

    /**
     * The datapack reload — and the report of <em>what it logged and skipped</em>.
     *
     * <p><b>{@code reloaded:true} used to be unconditional, and that was a lie by omission.</b>
     * Vanilla's loaders are forgiving: {@code RecipeManager} and {@code LootDataType} log a
     * malformed entry at ERROR and carry on, so the reload future completes normally and the file
     * loaded nothing. A modder pushing broken JSON therefore got a success. (The honest half, kept
     * on the record: a bad <em>tag</em> reference does fail the future, and always did.)
     *
     * <p>The fix is not a validator — the game already validated it, in the only place that can —
     * it is reading what the game said. A watermark is taken from {@link LogCapture} before the
     * reload and every WARN-or-worse line logged during it comes back in {@code problems}, with
     * {@code ok} false when there were any. The window is the reload's own, so unrelated chatter
     * from another thread can land in it; each line names its logger, which is what makes that
     * legible rather than misleading.
     */
    private static CompletableFuture<JsonElement> reload(final MinecraftServer server) {
        try {
            ensureInit(root(server));
        } catch (IOException e) {
            return CompletableFuture.failedFuture(e);
        }
        PackRepository repo = server.getPackRepository();
        repo.reload(); // rediscover the world datapacks folder (our pack included)
        Set<String> ids = new LinkedHashSet<>(repo.getSelectedIds());
        boolean available = repo.getAvailableIds().contains(PACK_ID);
        if (available) {
            ids.add(PACK_ID); // ensure our live pack is enabled (top priority: added last)
        }
        long watermark = LogCapture.seq();
        CompletableFuture<JsonElement> out = new CompletableFuture<>();
        server.reloadResources(ids).whenComplete((v, err) -> {
            if (err != null) {
                out.completeExceptionally(err);
                return;
            }
            JsonObject r = new JsonObject();
            r.addProperty("reloaded", true);
            r.addProperty("pack", PACK_ID);
            r.addProperty("packPresent", available);
            JsonArray packs = new JsonArray();
            ids.forEach(packs::add);
            r.add("enabledPacks", packs);
            reportProblems(r, watermark);
            out.complete(r);
        });
        return out;
    }

    /** How many logged problems a reload report carries before it starts pointing at {@code get_log}. */
    private static final int PROBLEM_LIMIT = 15;

    /**
     * Fold the reload window's WARN-and-worse log lines into a result. Shared with
     * {@code reload_resources} on the client side, which has exactly the same hole.
     */
    public static void reportProblems(final JsonObject r, final long watermark) {
        if (!LogCapture.capturing()) {
            // Say it once, in the result, rather than letting an empty `problems` read as "clean".
            r.addProperty("problems_unavailable", LogCapture.status());
            return;
        }
        List<LogCapture.Line> problems = LogCapture.problemsSince(watermark, PROBLEM_LIMIT + 1);
        r.addProperty("ok", problems.isEmpty());
        if (problems.isEmpty()) {
            return;
        }
        JsonArray arr = new JsonArray();
        for (int i = 0; i < Math.min(problems.size(), PROBLEM_LIMIT); i++) {
            arr.add(problems.get(i).toJson());
        }
        r.add("problems", arr);
        if (problems.size() > PROBLEM_LIMIT) {
            r.addProperty("problems_truncated",
                "more than " + PROBLEM_LIMIT + " lines; read the rest with get_log {since: "
                    + watermark + "}");
        }
        r.addProperty("note", "the game LOGGED AND SKIPPED these during the reload — content named "
            + "in them did not load, even though the reload itself succeeded");
    }

    private static String str(final JsonObject a, final String key) {
        if (!a.has(key) || a.get(key).isJsonNull()) {
            throw new IllegalArgumentException("missing argument '" + key + "'");
        }
        return a.get(key).getAsString();
    }
}
