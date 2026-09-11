package com.mattmc.mcptoolkit.mcp;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.Mechanism;
import org.jspecify.annotations.Nullable;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * The surfaces this game serves, built-in and declared, and the {@code config/mcptoolkit-surfaces.json}
 * that declares the second kind.
 *
 * <p><b>Three built-ins, and only one of them is a list.</b> {@code full} is the registry; {@code observe}
 * is computed from the {@link Mechanism} stamp every tool already carries, so it cannot go stale. Only
 * {@code modding} is an allow-list, and it is a SEED — copied from the Node shim's {@code MODDING_KEEP}
 * on 2026-09-11 (shim 0.73.0), minus the names that are the shim's own tools and do not exist in this
 * JVM ({@code mem_*}, {@code launch_game}, {@code bot_scan}). <b>The two are independent from that date
 * on.</b> They are not synchronized, nothing checks them against each other, and they are allowed to
 * differ — the shim's is per-session policy for a process a session starts, this one is a path on a
 * port. Where they agree it is because a modder's surface is a modder's surface; where they drift, each
 * is still the truth about the door it belongs to.
 *
 * <p><b>Declared surfaces are the real answer for a project</b>, and they are why the seed above is not
 * load-bearing: a workspace that wants its own slice writes one into the config file and dials
 * {@code /mcp/<its name>}. That file is the operator's, so a declaration may also REPLACE a built-in of
 * the same name; the replacement is logged, because a surface silently meaning something other than what
 * this class documents is the one confusing outcome here.
 */
public final class Surfaces {

    /** Where a game's own surfaces are declared, beside {@code mcptoolkit.properties}. */
    public static final String CONFIG_FILE = "mcptoolkit-surfaces.json";

    /** The surface {@code /mcp} serves when the config names none. */
    public static final String DEFAULT_SURFACE = "full";

    /**
     * The modder's slice, seeded from the shim. Read the class javadoc before editing: this list's
     * failure mode is silent (a name that is not a tool is never served and nobody is told), and a new
     * toolkit tool does NOT enter it by existing — somebody has to add the line.
     */
    private static final List<String> MODDING = List.of(
        // orient: which game is this, what has it been saying, and say something back
        "ping", "get_world_info", "get_events", "get_log", "send_chat",
        // the dev loop — code, and the two questions you ask about a running one
        "hotswap_class", "query_class", "get_perf", "open_world", "create_world",
        // what a stack SAYS
        "get_tooltip",
        // data: push it, reload it, see what is loaded, and roll/preview the two kinds you cannot
        // read back by looking
        "push_data", "reload_data", "list_data", "clear_data", "capture_structure", "place_structure",
        "roll_loot", "preview_worldgen", "query_registry",
        // write the world
        "set_blocks", "place_shape", "place_shapes", "run_command", "undo_edit", "list_edits",
        // ...and read it back
        "describe_box", "get_blocks_at", "get_surface", "get_region_summary", "scene_summary",
        "locate", "resolve_anchor", "anchors", "check_site", "check_path",
        // author a SCREEN
        "ui_doc",
        // look at it, and hot-reload the assets you are looking at
        "screenshot", "render", "push_asset", "reload_resources", "list_assets", "studio",
        // who else is on this bridge right now
        "session_list"
    );

    private static final String DEFAULT_CONFIG = """
        {
          "//": [
            "Tool surfaces for this game's OWN MCP server - the one in the mod jar, at",
            "http://127.0.0.1:<bridge port>/mcp. A surface is named by the URL: /mcp serves the",
            "default (mcp.surface in mcptoolkit.properties), /mcp/<name> serves that one.",
            "",
            "Built in, and available without declaring anything here:",
            "  full     - every tool this game registers. The default.",
            "  observe  - every tool whose mechanism is observe: reads, and nothing that acts.",
            "  modding  - the modder's slice: author blocks, data, structures and assets, read them back.",
            "",
            "Declare your own inside 'surfaces' below. Each is an object:",
            "  base          the surface to start from (default 'full')",
            "  keep          [names] - serve only these. A name that is not a tool is never served,",
            "                and is never complained about, so check your spelling against /tools.",
            "  hide          [names] - remove these, applied after keep",
            "  instructions  a paragraph served to the model as this server's `instructions`",
            "  description   one line, for /mmcp mcp",
            "",
            "A name here that matches a built-in REPLACES it (and says so in the log).",
            "This file is read once, at game start."
          ],
          "surfaces": {}
        }
        """;

    private final Map<String, McpSurface> surfaces;
    private final String defaultName;

    private Surfaces(final Map<String, McpSurface> surfaces, final String defaultName) {
        this.surfaces = surfaces;
        this.defaultName = defaultName;
    }

    // ---- the installed set ---------------------------------------------------

    private static volatile Surfaces installed = new Surfaces(builtins(), DEFAULT_SURFACE);

    /** Read the config (writing the documented default if it is absent) and install the result. */
    public static Surfaces install(final @Nullable Path configFile, final String defaultName) {
        if (configFile != null) {
            ensureDefaultFile(configFile);
        }
        installed = load(configFile, defaultName);
        return installed;
    }

    public static Surfaces installed() {
        return installed;
    }

    /** Build a set from a config file (or none) without installing it — the unit tests' door. */
    public static Surfaces load(final @Nullable Path configFile, final String defaultName) {
        Map<String, McpSurface> all = builtins();
        if (configFile != null && Files.exists(configFile)) {
            try {
                readInto(all, Files.readString(configFile), configFile.toString());
            } catch (IOException e) {
                McpToolkit.LOGGER.warn("[MCP Toolkit] could not read {} ({}); built-in surfaces only",
                    configFile, e.toString());
            }
        }
        String chosen = defaultName;
        if (!all.containsKey(chosen)) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] mcp.surface \"{}\" is not a surface (known: {}); "
                + "serving \"{}\" at /mcp", chosen, String.join(", ", all.keySet()), DEFAULT_SURFACE);
            chosen = DEFAULT_SURFACE;
        }
        return new Surfaces(all, chosen);
    }

    /** Parse declared surfaces into {@code all}. Package-private so the test can drive it from a string. */
    static void readInto(final Map<String, McpSurface> all, final String json, final String where) {
        JsonObject root;
        try {
            JsonElement parsed = JsonParser.parseString(json);
            if (!parsed.isJsonObject()) {
                McpToolkit.LOGGER.warn("[MCP Toolkit] {} is not a JSON object; built-in surfaces only", where);
                return;
            }
            root = parsed.getAsJsonObject();
        } catch (RuntimeException e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] {} is not valid JSON ({}); built-in surfaces only",
                where, e.getMessage());
            return;
        }
        if (!root.has("surfaces") || !root.get("surfaces").isJsonObject()) {
            return;
        }
        for (Map.Entry<String, JsonElement> e : root.getAsJsonObject("surfaces").entrySet()) {
            String name = e.getKey();
            if (name.startsWith("//") || !e.getValue().isJsonObject()) {
                continue;
            }
            if (!isLegalName(name)) {
                McpToolkit.LOGGER.warn("[MCP Toolkit] {}: surface name \"{}\" skipped — a surface is a "
                    + "URL path segment, so it must be letters, digits, '-' or '_'", where, name);
                continue;
            }
            McpSurface built = declared(name, e.getValue().getAsJsonObject(), all, where);
            if (built == null) {
                continue;
            }
            if (all.containsKey(name)) {
                McpToolkit.LOGGER.info("[MCP Toolkit] {} REPLACES the built-in surface \"{}\"", where, name);
            }
            all.put(name, built);
        }
    }

    private static @Nullable McpSurface declared(final String name, final JsonObject o,
                                                 final Map<String, McpSurface> all, final String where) {
        String baseName = JsonRpc.str(o, "base");
        McpSurface base = baseName == null ? all.get(DEFAULT_SURFACE) : all.get(baseName);
        if (base == null) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] {}: surface \"{}\" skipped — base \"{}\" is not a "
                + "surface (known: {})", where, name, baseName, String.join(", ", all.keySet()));
            return null;
        }
        Set<String> keep = names(o, "keep");
        Set<String> hide = new LinkedHashSet<>(base.hide());
        Set<String> declaredHide = names(o, "hide");
        if (declaredHide != null) {
            hide.addAll(declaredHide);
        }
        // The base's keep-list is INTERSECTED, not replaced: "base modding, keep these four" must not
        // be a way to get a tool the base does not serve — otherwise a narrow surface built on a
        // narrow base is silently wider than both.
        Set<String> effectiveKeep = keep;
        if (base.keep() != null) {
            if (keep == null) {
                effectiveKeep = base.keep();
            } else {
                Set<String> both = new LinkedHashSet<>(keep);
                both.retainAll(base.keep());
                effectiveKeep = both;
            }
        }
        String description = JsonRpc.str(o, "description");
        return new McpSurface(name,
            description == null ? "declared in " + CONFIG_FILE : description,
            effectiveKeep, hide, base.mechanisms(),
            JsonRpc.str(o, "instructions"));
    }

    /** A string array field, or null when absent. An entry that is not a string is dropped loudly. */
    private static @Nullable Set<String> names(final JsonObject o, final String key) {
        if (!o.has(key) || !o.get(key).isJsonArray()) {
            return null;
        }
        JsonArray arr = o.getAsJsonArray(key);
        Set<String> out = new LinkedHashSet<>();
        for (JsonElement el : arr) {
            if (el.isJsonPrimitive()) {
                out.add(el.getAsString());
            } else {
                McpToolkit.LOGGER.warn("[MCP Toolkit] {}: non-string entry in \"{}\" ignored", CONFIG_FILE, key);
            }
        }
        return out;
    }

    /** A surface is a path segment. Nothing that would have to be escaped, and nothing that can traverse. */
    static boolean isLegalName(final String name) {
        if (name.isEmpty() || name.length() > 40) {
            return false;
        }
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                || c == '-' || c == '_';
            if (!ok) {
                return false;
            }
        }
        return true;
    }

    private static Map<String, McpSurface> builtins() {
        Map<String, McpSurface> m = new LinkedHashMap<>();
        m.put("full", McpSurface.all("full", "every tool this game registers"));
        m.put("observe", new McpSurface("observe",
            "every tool whose mechanism is observe: reads, and nothing that acts",
            null, Set.of(), Set.of(Mechanism.OBSERVE), null));
        m.put("modding", new McpSurface("modding",
            "the modder's slice: author blocks, data, structures and assets against a running game, "
                + "and read them back",
            new LinkedHashSet<>(MODDING), Set.of(), null, null));
        return m;
    }

    private static void ensureDefaultFile(final Path file) {
        if (Files.exists(file)) {
            return;
        }
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, DEFAULT_CONFIG);
        } catch (IOException e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] could not write default {}: {}", file, e.toString());
        }
    }

    // ---- reading -------------------------------------------------------------

    /** The surface that path segment names, or null. {@code null}/empty means the default. */
    public @Nullable McpSurface resolve(final @Nullable String name) {
        if (name == null || name.isEmpty()) {
            return surfaces.get(defaultName);
        }
        return surfaces.get(name.toLowerCase(Locale.ROOT));
    }

    public String defaultName() {
        return defaultName;
    }

    public List<String> names() {
        return new ArrayList<>(surfaces.keySet());
    }

    public Map<String, McpSurface> all() {
        return Map.copyOf(surfaces);
    }
}
