package com.mattmc.mcptoolkit.agent;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;
import com.mattmc.mcptoolkit.McpToolkit;
import org.jspecify.annotations.Nullable;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * The de-facto {@code mcpServers} JSON file, edited as a MEMBER of it rather than as the whole thing.
 *
 * <h2>Why this exists (RELEASE_1 §B1)</h2>
 *
 * <p>Both bundled adapters used to build a fresh root object holding one entry and write it over
 * whatever was there. In this workspace {@code rocketeer/.mcp.json} and {@code nijntje/.mcp.json}
 * each hold the toolkit's entry <b>and</b> a {@code blockbench} one, and a registered directory
 * is a documented, principal-supplied directory — so a launch pointed at such a repo silently
 * deleted a server the human depends on. A registration is one key in someone else's file, and this
 * class is the only place that fact is encoded.
 *
 * <p><b>Nothing outside our own key is ever touched</b>, including top-level fields we do not
 * understand: the file is parsed, one member of {@code mcpServers} is replaced, and everything else
 * is written back as it was found.
 *
 * <h2>Identity is the ARGUMENTS, not the key</h2>
 *
 * <p>The key is the human's — and it is also the tool-name prefix every session sees
 * ({@code mcp__mcptoolkit__bot_scan}), so renaming one silently re-namespaces an agent's whole tool
 * surface. An entry is ours when its arguments name the {@code index.mjs} THIS game extracted; a key
 * we ourselves may have written ({@link #ALIASES}) is a weaker second signal, used only when no
 * arguments match. An entry pointing at ANOTHER game's extract is therefore not recognized as ours —
 * it belongs to that game, and taking it over silently is the wrong-game class §B0 was about.
 *
 * <p>Common code on purpose: a dedicated server has no menu and still registers.
 */
public final class McpServersFile {
    private McpServersFile() {}

    /**
     * The key a fresh registration is written under. Every {@code .mcp.json} in this workspace, the
     * docs and every {@code mcp__mcptoolkit__*} tool name already say this; the code said
     * {@code mcp-toolkit}, which merged into an existing file would have produced a second entry
     * beside the hand-written one and a different tool prefix in the same session.
     */
    public static final String CANONICAL = "mcptoolkit";

    /** Keys a toolkit registration has been written under. Used only to recognize our own past work. */
    public static final Set<String> ALIASES = Set.of("mcptoolkit", "mcp-toolkit");

    private static final String ROOT = "mcpServers";

    /** One server entry as it stands in the file. */
    public record Entry(String key, String command, List<String> args, Map<String, String> env) {
        public Entry {
            args = List.copyOf(args);
            env = Map.copyOf(env);
        }

        /** The bridge this registration dials, or null when it names none. */
        public @Nullable String bridgeUrl() {
            return env.get("MCPTK_URL");
        }

        /** The profile baked into this registration, or null for the default surface. */
        public @Nullable String profile() {
            return env.get("MCPTK_PROFILE");
        }

        public @Nullable String memoryDir() {
            return env.get("MCPTK_MEMORY_DIR");
        }

        /** The server script this entry runs, or null when it takes no argument. */
        public @Nullable String serverIndex() {
            return args.isEmpty() ? null : args.get(args.size() - 1);
        }
    }

    /** What a write did, so a caller can say "already current" instead of claiming a write. */
    public record Result(boolean changed, @Nullable String error) {
        public static final Result UNCHANGED = new Result(false, null);

        public static Result written() {
            return new Result(true, null);
        }

        public static Result failed(final String why) {
            return new Result(false, why);
        }
    }

    // ---- reading ---------------------------------------------------------------------------------

    /**
     * The entry in {@code file} that runs {@code serverIndex}, or — failing that — one under a key we
     * have written before.
     *
     * @return null when the file is missing, unreadable, or holds no toolkit registration at all
     */
    public static @Nullable Entry find(final Path file, final @Nullable Path serverIndex) {
        JsonObject servers = servers(file);
        if (servers == null) {
            return null;
        }
        Entry alias = null;
        for (String key : servers.keySet()) {
            Entry e = entry(key, servers.get(key));
            if (e == null) {
                continue;
            }
            if (serverIndex != null && runs(e, serverIndex)) {
                return e;      // ours, beyond doubt
            }
            if (alias == null && ALIASES.contains(key.toLowerCase(Locale.ROOT))) {
                alias = e;     // ours by name only — kept in case nothing matches by argument
            }
        }
        return alias;
    }

    /** Whether this entry runs the extract belonging to the game that owns {@code serverIndex}. */
    public static boolean runs(final Entry entry, final Path serverIndex) {
        String want = normalize(ServerSpec.fs(serverIndex));
        for (String a : entry.args()) {
            if (normalize(a).equals(want)) {
                return true;
            }
        }
        return false;
    }

    /** Every server in the file, in file order — the "what else lives here" a reader needs to see. */
    public static List<Entry> all(final Path file) {
        List<Entry> out = new ArrayList<>();
        JsonObject servers = servers(file);
        if (servers == null) {
            return out;
        }
        for (String key : servers.keySet()) {
            Entry e = entry(key, servers.get(key));
            if (e != null) {
                out.add(e);
            }
        }
        return out;
    }

    // ---- writing ---------------------------------------------------------------------------------

    /**
     * Merge {@code spec} into {@code file}, creating the file if it is not there.
     *
     * <p><b>Idempotence is decided by the RESULT, not by markers.</b> The old code looked for the
     * bridge URL and the string {@code MCPTK_PROFILE} in the raw text and rewrote when either was
     * missing — which cannot see a changed memory dir, cannot tell a matching profile from a merely
     * mentioned one, and rewrites a file a human has reformatted. Here the merged document is
     * compared with the one on disk and the write is skipped when they are equal.
     */
    public static Result write(final Path file, final ServerSpec spec) {
        String before;
        try {
            before = Files.exists(file) ? Files.readString(file) : null;
        } catch (IOException e) {
            return Result.failed("could not read " + file + ": " + e);
        }

        JsonObject root;
        if (before == null) {
            root = new JsonObject();
        } else {
            try {
                JsonElement parsed = JsonParser.parseString(before);
                if (!parsed.isJsonObject()) {
                    return Result.failed(file + " is not a JSON object — refusing to overwrite it");
                }
                root = parsed.getAsJsonObject();
            } catch (JsonSyntaxException e) {
                // Never silently replaced. A file we cannot parse is far more likely to be a human's
                // hand-edit than a corrupt one of ours, and the whole point of this class is that the
                // file is not ours to throw away.
                return Result.failed(file + " is not valid JSON (" + e.getMessage()
                    + ") — refusing to overwrite it; fix the file and try again");
            }
        }

        JsonObject servers = root.getAsJsonObject(ROOT);
        if (servers == null) {
            servers = new JsonObject();
            root.add(ROOT, servers);
        }

        Path index = spec.args().isEmpty() ? null : Path.of(spec.args().get(spec.args().size() - 1));
        String key = keyFor(servers, index, spec.name());
        // Normalize a key WE wrote (mcp-toolkit -> mcptoolkit) without ever renaming a key the human
        // chose: that rename changes the tool prefix of every session the workspace launches.
        if (!key.equals(spec.name()) && ALIASES.contains(key.toLowerCase(Locale.ROOT))) {
            servers.remove(key);
            key = spec.name();
        }
        servers.add(key, serverJson(spec));

        String after = new GsonBuilder().setPrettyPrinting().create().toJson(root);
        if (before != null && before.trim().equals(after.trim())) {
            return Result.UNCHANGED;
        }
        try {
            if (file.getParent() != null) {
                Files.createDirectories(file.getParent());
            }
            Files.writeString(file, after);
        } catch (IOException e) {
            return Result.failed("could not write " + file + ": " + e);
        }
        McpToolkit.LOGGER.info("[MCP Toolkit] registered '{}' in {}; {} other server(s) left as found",
            key, file, servers.size() - 1);
        return Result.written();
    }

    /**
     * Drop the toolkit's entry from {@code file}, leaving every other server in place.
     *
     * <p>The file itself is never deleted, even when nothing is left in it: it may predate us, it may
     * be in someone's git history, and an empty {@code mcpServers} is a valid and honest state.
     */
    public static Result remove(final Path file, final @Nullable Path serverIndex) {
        if (!Files.exists(file)) {
            return Result.UNCHANGED;
        }
        JsonObject root;
        try {
            JsonElement parsed = JsonParser.parseString(Files.readString(file));
            if (!parsed.isJsonObject()) {
                return Result.failed(file + " is not a JSON object");
            }
            root = parsed.getAsJsonObject();
        } catch (IOException | JsonSyntaxException e) {
            return Result.failed("could not read " + file + ": " + e);
        }
        JsonObject servers = root.getAsJsonObject(ROOT);
        Entry ours = find(file, serverIndex);
        if (servers == null || ours == null) {
            return Result.UNCHANGED;
        }
        servers.remove(ours.key());
        try {
            Files.writeString(file, new GsonBuilder().setPrettyPrinting().create().toJson(root));
        } catch (IOException e) {
            return Result.failed("could not write " + file + ": " + e);
        }
        McpToolkit.LOGGER.info("[MCP Toolkit] removed '{}' from {}; {} server(s) still there",
            ours.key(), file, servers.size());
        return Result.written();
    }

    // ---- internals -------------------------------------------------------------------------------

    /** The key to write under: the one already running this game's server, else the canonical name. */
    private static String keyFor(final JsonObject servers, final @Nullable Path index,
                                 final String canonical) {
        String aliasKey = null;
        for (String key : servers.keySet()) {
            Entry e = entry(key, servers.get(key));
            if (e == null) {
                continue;
            }
            if (index != null && runs(e, index)) {
                return key;
            }
            if (aliasKey == null && ALIASES.contains(key.toLowerCase(Locale.ROOT))) {
                aliasKey = key;
            }
        }
        return aliasKey != null ? aliasKey : canonical;
    }

    private static JsonObject serverJson(final ServerSpec spec) {
        JsonObject server = new JsonObject();
        server.addProperty("command", spec.command());
        JsonArray args = new JsonArray();
        spec.args().forEach(args::add);
        server.add("args", args);
        JsonObject env = new JsonObject();
        spec.env().forEach(env::addProperty);
        server.add("env", env);
        return server;
    }

    private static @Nullable Entry entry(final String key, final @Nullable JsonElement raw) {
        if (raw == null || !raw.isJsonObject()) {
            return null;
        }
        JsonObject o = raw.getAsJsonObject();
        String command = o.has("command") && o.get("command").isJsonPrimitive()
            ? o.get("command").getAsString() : "";
        List<String> args = new ArrayList<>();
        if (o.has("args") && o.get("args").isJsonArray()) {
            for (JsonElement a : o.getAsJsonArray("args")) {
                if (a.isJsonPrimitive()) {
                    args.add(a.getAsString());
                }
            }
        }
        Map<String, String> env = new LinkedHashMap<>();
        if (o.has("env") && o.get("env").isJsonObject()) {
            JsonObject e = o.getAsJsonObject("env");
            for (String k : e.keySet()) {
                if (e.get(k).isJsonPrimitive()) {
                    env.put(k, e.get(k).getAsString());
                }
            }
        }
        return new Entry(key, command, args, env);
    }

    private static @Nullable JsonObject servers(final Path file) {
        if (!Files.exists(file)) {
            return null;
        }
        try {
            JsonElement parsed = JsonParser.parseString(Files.readString(file));
            return parsed.isJsonObject() ? parsed.getAsJsonObject().getAsJsonObject(ROOT) : null;
        } catch (IOException | JsonSyntaxException e) {
            return null;
        }
    }

    /** Windows gives the same file two spellings; a registration must not depend on which one. */
    private static String normalize(final String path) {
        return path.replace('\\', '/').toLowerCase(Locale.ROOT);
    }
}
