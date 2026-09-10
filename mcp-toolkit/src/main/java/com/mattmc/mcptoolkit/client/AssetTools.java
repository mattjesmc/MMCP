package com.mattmc.mcptoolkit.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Promote;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.server.packs.repository.PackRepository;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Live asset push: write a model/texture into a toolkit-managed resource pack that overrides the mod's
 * (and vanilla's) bundled assets, then hot-reload — so an edited Blockbench export shows on the block in
 * seconds, no restart. Reuses the {@code run/resourcepacks/} folder source Minecraft already registers;
 * the pack (id {@code file/mcptoolkit_live}) is force-selected at top priority on first use.
 */
@Environment(EnvType.CLIENT)
public final class AssetTools {
    private AssetTools() {}

    private static final String PACK_NAME = "mcptoolkit_live";
    private static final String PACK_ID = "file/" + PACK_NAME;
    /** Resource pack_format for MC 26.2. Declared three ways in the mcmeta — see {@link #ensureInit()}. */
    private static final int PACK_FORMAT = 88;

    public static void register() {
        McpTools.register(ToolDef.async(
            "push_asset",
            "Write an asset into the toolkit's live resource pack (which overrides mod and vanilla assets) and hot-reload so it shows in-game immediately. \"path\" is relative to the pack root, e.g. \"assets/<namespace>/textures/block/my_block.png\" or \"assets/<namespace>/models/block/my_block.json\" — use a namespace the attached game actually loads (query_registry shows them); a push to an unknown namespace succeeds and does nothing. Supply the bytes as \"base64\", or as \"file\" (absolute local path the game client copies from — prefer this for files already on disk; it keeps the bytes out of the conversation). Set \"reload\" false to batch several pushes before a final reload_resources. The reload reports `ok` and any `problems` the game LOGGED AND SKIPPED — a model naming a missing texture is stepped over, so check that rather than reading `reloaded` as loaded.",
            Schemas.objectOpt(
                Schemas.object(
                    "path", Schemas.str("Pack-relative path, e.g. assets/<namespace>/textures/block/foo.png"),
                    "base64", Schemas.str("File contents, base64-encoded (PNG, JSON, ...). Omit if \"file\" is given."),
                    "file", Schemas.str("Absolute local path to copy the bytes from. Omit if \"base64\" is given."),
                    "reload", Schemas.bool("Reload after writing (default true).")),
                "base64", "file", "reload"),
            ExecutionContext.CLIENT,
            Mechanism.PRIVILEGED,
            (ctx, a) -> push(a)));

        McpTools.register(ToolDef.async(
            "reload_resources",
            "Reload all client resource packs — the programmatic equivalent of F3+T. Use after batched "
                + "push_asset calls, or to pick up external resource/datapack-independent changes. Returns "
                + "`ok` plus `problems`: the WARN/ERROR lines logged DURING this reload. Read those — a model "
                + "naming a missing texture is logged and stepped over, so the reload succeeds and your asset "
                + "is not on screen. get_log has the full lines.",
            Schemas.object(),
            ExecutionContext.CLIENT,
            Mechanism.PRIVILEGED,
            (ctx, a) -> reload()));

        McpTools.register(ToolDef.of(
            "list_assets",
            "List every file in the toolkit's live resource pack — the overrides currently shadowing mod "
                + "and vanilla assets. The pack persists on disk across restarts, so this is how you find "
                + "out what push_asset has accumulated. Returns pack-relative paths with sizes.",
            Schemas.object(),
            ExecutionContext.CLIENT,
            Mechanism.OBSERVE,
            (ctx, a) -> listAssets()));

        McpTools.register(ToolDef.async(
            "clear_assets",
            "Delete overrides from the live resource pack and hot-reload, restoring the underlying mod/"
                + "vanilla assets. Pass \"path\" (pack-relative, as listed by list_assets) to remove one "
                + "file or a whole directory, or omit it to clear the pack. Set \"reload\" false to batch. "
                + "PROMOTION rides here: \"promote\" copies each file out to a mod's source tree first, so "
                + "the step that gets forgotten - dropping the override that then shadows the copy - "
                + "cannot be skipped.",
            Schemas.objectOpt(
                Schemas.object(
                    "path", Schemas.str("Pack-relative path of an asset, or of a directory "
                        + "(assets/<namespace>) to take all of; omit to clear all."),
                    "promote", Schemas.str("A mod's EXISTING resources root (src/main/resources): "
                        + "each file is copied there, same relative path, before anything is deleted. "
                        + "Never defaulted, never created - a promotion with nowhere to go is refused, "
                        + "and a refusal clears nothing. Requires \"path\"."),
                    "reload", Schemas.bool("Reload after deleting (default true).")),
                "path", "promote", "reload"),
            ExecutionContext.CLIENT,
            Mechanism.PRIVILEGED,
            (ctx, a) -> clearAssets(a)));
    }

    // ---- pack management (client thread) -------------------------------------

    private static Path root() {
        return Minecraft.getInstance().gameDirectory.toPath().resolve("resourcepacks").resolve(PACK_NAME);
    }

    /**
     * The live pack's {@code pack.mcmeta}. {@code min_format}/{@code max_format} are MANDATORY here
     * for the same reason they are on the datapack twin — {@code PackFormat} requires them above
     * {@code lastPreMinorVersion}, which is 64 for client resources and 81 for server data, and
     * this pack's format is 88. Without them the metadata read fails and vanilla falls back to a
     * codec that reports the pack as {@code Integer.MAX_VALUE}. See {@code DataTools.ensureInit}
     * for how that was found (a WARN on every reload that nothing read until {@code get_log}
     * existed), and for why an existing file is repaired rather than left alone.
     */
    private static void ensureInit() throws IOException {
        Path root = root();
        Files.createDirectories(root.resolve("assets"));
        Path meta = root.resolve("pack.mcmeta");
        String want = "{\"pack\":{\"description\":\"MCP Toolkit live overrides\","
            + "\"pack_format\":" + PACK_FORMAT + ","
            + "\"min_format\":" + PACK_FORMAT + ","
            + "\"max_format\":" + PACK_FORMAT + "}}";
        if (!Files.exists(meta) || !Files.readString(meta).contains("min_format")) {
            Files.writeString(meta, want);
        }
    }

    private static CompletableFuture<JsonElement> push(final JsonObject a) {
        String rel = str(a, "path");
        boolean reload = !a.has("reload") || a.get("reload").isJsonNull() || a.get("reload").getAsBoolean();
        JsonObject r = new JsonObject();
        try {
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
            ensureInit();
            Path root = root();
            Path target = root.resolve(rel).normalize();
            if (!target.startsWith(root)) {
                throw new IllegalArgumentException("path escapes the pack root: " + rel);
            }
            Files.createDirectories(target.getParent());
            Files.write(target, bytes);
            r.addProperty("written", root.relativize(target).toString().replace('\\', '/'));
            r.addProperty("bytes", bytes.length);
            invalidatePreviewGeometry(root, target);
        } catch (Exception e) {
            return CompletableFuture.failedFuture(e);
        }
        if (!reload) {
            r.addProperty("reloaded", false);
            return CompletableFuture.completedFuture(r);
        }
        return reload().thenApply(v -> {
            // Propagate the reload's own verdict instead of hardcoding success: `active` is whether
            // the override pack is actually selected — written+reloaded with active:false means the
            // file exists but nothing on screen changed.
            mergeReload(r, v);
            r.addProperty("reloaded", true);
            boolean active = v.isJsonObject() && v.getAsJsonObject().has("selected")
                && v.getAsJsonObject().get("selected").getAsBoolean();
            r.addProperty("active", active);
            if (!active) {
                r.addProperty("note", "the live pack is NOT in the selected pack list after reload — "
                    + "the written asset is on disk but not applied");
            }
            return (JsonElement) r;
        });
    }

    // ---- list_assets / clear_assets ------------------------------------------

    private static JsonElement listAssets() {
        JsonObject r = new JsonObject();
        r.addProperty("pack", PACK_ID);
        JsonArray assets = new JsonArray();
        Path root = root();
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
                    assets.add(o);
                }
            } catch (IOException e) {
                throw new RuntimeException("could not walk the live pack: " + e, e);
            }
        }
        r.add("assets", assets);
        r.addProperty("count", assets.size());
        return r;
    }

    /**
     * Delete overrides, optionally promoting them into a mod source tree on the way out.
     *
     * <p>Order is load-bearing: every file is COPIED before any file is deleted ({@link Promote}),
     * because a half-promotion that has already cleared the override is the only outcome worse than
     * not promoting at all.
     */
    private static CompletableFuture<JsonElement> clearAssets(final JsonObject a) {
        boolean reload = !a.has("reload") || a.get("reload").isJsonNull() || a.get("reload").getAsBoolean();
        JsonObject r = new JsonObject();
        JsonArray deleted = new JsonArray();
        try {
            Path root = root();
            Path assets = root.resolve("assets");
            String rel = a.has("path") && !a.get("path").isJsonNull() ? a.get("path").getAsString() : null;
            String promote = a.has("promote") && !a.get("promote").isJsonNull()
                ? a.get("promote").getAsString() : null;
            if (promote != null && rel == null) {
                // Promoting the whole pack would write every namespace it holds - other mods',
                // and minecraft's own overrides - into ONE mod's source tree. Naming the subtree is
                // the only way this call can know which mod it is promoting to.
                throw new IllegalArgumentException("`promote` needs `path`: name the asset, or the "
                    + "namespace directory (assets/<namespace>). Promoting the whole pack would put "
                    + "every namespace in it - vanilla's included - into one mod's source tree.");
            }
            List<Path> files;
            if (rel != null) {
                files = Promote.resolve(root, rel, "asset");
            } else if (Files.isDirectory(assets)) {
                try (var walk = Files.walk(assets)) {
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
                invalidatePreviewGeometry(root, p);
                Files.delete(p);
                deleted.add(root.relativize(p).toString().replace('\\', '/'));
            }
            pruneEmptyDirs(assets);
        } catch (Exception e) {
            return CompletableFuture.failedFuture(e);
        }
        r.add("deleted", deleted);
        r.addProperty("count", deleted.size());
        if (!reload) {
            r.addProperty("reloaded", false);
            return CompletableFuture.completedFuture(r);
        }
        return reload().thenApply(v -> {
            mergeReload(r, v);
            r.addProperty("reloaded", true);
            return (JsonElement) r;
        });
    }

    /**
     * Fold the auto-reload's own report — {@code ok}, {@code problems}, {@code selected} — into the
     * push/clear reply.
     *
     * <p><b>Found by §D1's owed client run (2026-08-26), and it is the succeeds-falsely class with a
     * missing line of glue as the vector.</b> {@code reload()} has computed {@code ok} and
     * {@code problems} since 0.91.0, and these two callers read exactly one field out of it and
     * dropped the rest. So a modder pushing a broken model got {@code written / reloaded:true /
     * active:true} and no hint at all, while the ERROR naming their file sat in the object that had
     * just been discarded — and had to know to make a SECOND {@code reload_resources} call to see it.
     * The server half ({@code DataTools.push}) merged the whole object from the start; these two
     * were the asymmetry. The commonest path must not be the blind one.
     */
    private static void mergeReload(final JsonObject into, final JsonElement reloadResult) {
        if (reloadResult != null && reloadResult.isJsonObject()) {
            reloadResult.getAsJsonObject().entrySet().forEach(e -> into.add(e.getKey(), e.getValue()));
        }
    }

    /** Drop directories the deletes emptied, deepest-first; {@code assets/} itself stays. */
    private static void pruneEmptyDirs(final Path assets) throws IOException {
        if (!Files.isDirectory(assets)) {
            return;
        }
        try (var walk = Files.walk(assets)) {
            for (Path p : walk.sorted(Comparator.reverseOrder()).toList()) {
                if (p.equals(assets) || !Files.isDirectory(p)) {
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
     * Interchange geometry is cached BAKED, so a push under {@code assets/mcptoolkit/preview/} has to
     * say so or the next frame draws the model that was there before it - an edit-push-look loop
     * whose "look" shows the PREVIOUS edit is worse than one that shows nothing. One integer, on the
     * thread that already owns the write; the counter itself lives in {@link PreviewModels}.
     *
     * <p>Compared as PATHS rather than as strings: the pack root is a real filesystem path, and a
     * separator-flavoured string compare is the kind of thing that works on one OS.
     */
    private static void invalidatePreviewGeometry(final Path root, final Path target) {
        if (target.normalize().startsWith(root.resolve(PreviewModels.PACK_PREFIX))) {
            PreviewModels.invalidate();
        }
    }

    private static CompletableFuture<JsonElement> reload() {
        // ANY reload can replace the pack this geometry came from (F3+T, a pack toggle, another
        // tool's push), so every reload drops the bakes. Re-reading a handful of small JSON files is
        // cheaper than being subtly wrong about which geometry is on screen.
        PreviewModels.invalidate();
        Minecraft mc = Minecraft.getInstance();
        try {
            ensureInit();
        } catch (IOException e) {
            return CompletableFuture.failedFuture(e);
        }
        PackRepository repo = mc.getResourcePackRepository();
        repo.reload(); // rediscover the folder pack (selection survives by id)
        if (!repo.getSelectedIds().contains(PACK_ID)) {
            repo.addPack(PACK_ID); // append -> highest priority (overrides mod + vanilla)
        }
        // The client's half of the succeeds-falsely hole DataTools.reload documents: a model that
        // names a missing texture, a broken blockstate JSON, an atlas entry that will not resolve
        // are all logged and stepped over, and the reload future completes clean. Watermark the log
        // and hand back what it said.
        long watermark = com.mattmc.mcptoolkit.LogCapture.seq();
        CompletableFuture<JsonElement> out = new CompletableFuture<>();
        mc.reloadResourcePacks().whenComplete((v, err) -> {
            if (err != null) {
                out.completeExceptionally(err);
            } else {
                JsonObject r = new JsonObject();
                r.addProperty("reloaded", true);
                r.addProperty("pack", PACK_ID);
                r.addProperty("selected", repo.getSelectedIds().contains(PACK_ID));
                com.mattmc.mcptoolkit.DataTools.reportProblems(r, watermark);
                out.complete(r);
            }
        });
        return out;
    }

    private static String str(final JsonObject a, final String key) {
        if (!a.has(key) || a.get(key).isJsonNull()) {
            throw new IllegalArgumentException("missing argument '" + key + "'");
        }
        return a.get(key).getAsString();
    }
}
