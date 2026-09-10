package com.mattmc.mcptoolkit.scaffold;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.stream.Stream;
import java.util.zip.ZipFile;

/**
 * {@code checkAssets} (RELEASE_1.md section J2): dangling references and unused assets in a mod's
 * resources tree, before a game exists.
 *
 * <p>The class of bug this catches is the one {@code get_log} and the reload {@code problems}
 * catch AFTER the game has loaded and skipped the file: a blockstate naming a model that is not
 * there, a model naming a texture that is not there, a loot table dropping an item nothing defines,
 * a block with no lang key. Vanilla's loaders are forgiving, so every one of those is a log line
 * and a pink-and-black cube rather than a crash. This walks the same edges from the files alone, so
 * the answer arrives at {@code gradlew check} rather than at the first render.
 *
 * <p>Three buckets, and the split is the honesty rule:
 * <ul>
 *   <li><b>dangling</b> (fails the check): a reference to something in a namespace this tree
 *   defines, or in vanilla when the vanilla jar was given, that does not exist.</li>
 *   <li><b>unused</b> (warns): a block or item texture no model names, a model nothing names.
 *   Only {@code textures/block} and {@code textures/item} are judged, because entity, GUI and
 *   particle textures are referenced from code and a checker that flagged them would make every
 *   mod noisy - and a warning is never a failure, or every work-in-progress branch would be red.</li>
 *   <li><b>unchecked</b> (counted): a reference into {@code minecraft:} with no vanilla jar to
 *   resolve against, or into any other namespace (another mod, {@code c:} tags). Counted, never
 *   silently passed: {@code push_data}'s {@code checked_by} rule.</li>
 * </ul>
 *
 * <p>Vanilla resolves against the Loom merged jar when {@code --vanilla} names it (the convention
 * plugin finds it under {@code .gradle/loom-cache/minecraftMaven}); that jar carries vanilla's
 * blockstates, models, textures, items, lang, loot tables and tags, so a {@code minecraft:} model
 * parent or texture is a real check there.
 *
 * <p>Both loaders, one layout: the files are the game's, not the loader's. The last line of the
 * report is a JSON object with {@code text}, {@code problems} and {@code notes}, which is what a
 * loop file's {@code checks[].run} reads.
 */
public final class CheckAssets {
    private CheckAssets() {}

    /** A reference from one file to a thing that should exist. */
    record Ref(String from, String kind, String target) {}

    public static final class Report {
        public final List<Ref> dangling = new ArrayList<>();
        public final List<String> unused = new ArrayList<>();
        public final List<Ref> unchecked = new ArrayList<>();
        public final List<String> warnings = new ArrayList<>();
        public final Map<String, Integer> counts = new TreeMap<>();
        public int files;
        public int references;

        public boolean failed() {
            return !dangling.isEmpty();
        }
    }

    /** What the tree defines, by kind, as {@code ns:path} (models and textures without extension). */
    static final class Index {
        final Set<String> blocks = new HashSet<>();
        final Set<String> items = new HashSet<>();
        final Set<String> models = new HashSet<>();
        final Set<String> textures = new HashSet<>();
        final Set<String> lootTables = new HashSet<>();
        final Map<String, Set<String>> tags = new LinkedHashMap<>(); // type -> ns:path
        /** Every other data category ({@code enchantment}, {@code worldgen/biome}, ...) -> ns:path: what a tag member of that type resolves against. */
        final Map<String, Set<String>> data = new LinkedHashMap<>();
        final Map<String, Set<String>> langKeys = new LinkedHashMap<>(); // ns -> keys
        final Set<String> namespaces = new TreeSet<>();

        boolean has(final String kind, final String target) {
            return switch (kind) {
                case "block" -> blocks.contains(target);
                case "item" -> items.contains(target);
                case "model" -> models.contains(target);
                case "texture" -> textures.contains(target);
                case "loot_table" -> lootTables.contains(target);
                default -> kind.startsWith("tag/") ? tags.getOrDefault(kind.substring(4), Set.of()).contains(target)
                    : kind.startsWith("tag-member/") && data.getOrDefault(kind.substring(11), Set.of()).contains(target);
            };
        }

        /** Whether this index knows the data category a tag member of {@code type} would live in. */
        boolean hasCategory(final String type) {
            return data.containsKey(type);
        }

        /** One entry of the tree or the jar, as a relative path with forward slashes. */
        void add(final String rel) {
            String[] p = rel.split("/");
            if (p.length < 4) {
                return;
            }
            String ns = p[1];
            if (p[0].equals("assets")) {
                String cat = p[2];
                String rest = String.join("/", java.util.Arrays.copyOfRange(p, 3, p.length));
                switch (cat) {
                    case "blockstates" -> { if (rest.endsWith(".json")) { blocks.add(ns + ":" + strip(rest)); namespaces.add(ns); } }
                    case "items" -> { if (rest.endsWith(".json")) { items.add(ns + ":" + strip(rest)); namespaces.add(ns); } }
                    case "models" -> { if (rest.endsWith(".json")) { models.add(ns + ":" + strip(rest)); namespaces.add(ns); } }
                    case "textures" -> { if (rest.endsWith(".png")) { textures.add(ns + ":" + strip(rest)); namespaces.add(ns); } }
                    case "lang" -> namespaces.add(ns);
                    default -> { }
                }
            } else if (p[0].equals("data")) {
                String cat = p[2];
                if (cat.equals("loot_table") && rel.endsWith(".json")) {
                    lootTables.add(ns + ":" + strip(String.join("/", java.util.Arrays.copyOfRange(p, 3, p.length))));
                    namespaces.add(ns);
                } else if (cat.equals("tags") && p.length >= 5 && rel.endsWith(".json")) {
                    String[] tt = tagType(p);
                    if (tt != null) {
                        tags.computeIfAbsent(tt[0], k -> new HashSet<>()).add(ns + ":" + strip(tt[1]));
                        namespaces.add(ns);
                    }
                } else if (rel.endsWith(".json") && p.length >= 4) {
                    // worldgen/<sub>/<path> is a two-level category; everything else is one level.
                    boolean wg = cat.equals("worldgen") && p.length >= 5;
                    String category = wg ? "worldgen/" + p[3] : cat;
                    String rest = strip(String.join("/", java.util.Arrays.copyOfRange(p, wg ? 4 : 3, p.length)));
                    data.computeIfAbsent(category, k -> new HashSet<>()).add(ns + ":" + rest);
                    namespaces.add(ns);
                }
            }
        }

        /** {tags type, path} for a {@code data/<ns>/tags/...} split; worldgen tags carry a second level. */
        static String[] tagType(final String[] p) {
            if (p[3].equals("worldgen")) {
                return p.length >= 6 ? new String[] {"worldgen/" + p[4], String.join("/", java.util.Arrays.copyOfRange(p, 5, p.length))} : null;
            }
            return new String[] {p[3], String.join("/", java.util.Arrays.copyOfRange(p, 4, p.length))};
        }

        static String strip(final String s) {
            int dot = s.lastIndexOf('.');
            return dot < 0 ? s : s.substring(0, dot);
        }
    }

    // ---- running --------------------------------------------------------------------------------

    public static Report check(final Path resources, final Path vanillaJar) throws IOException {
        return check(resources, vanillaJar == null ? List.of() : List.of(vanillaJar));
    }

    /** Several vanilla jars index as one: Loom's split common + clientOnly pair is two files for one game. */
    public static Report check(final Path resources, final List<Path> vanillaJars) throws IOException {
        if (!Files.isDirectory(resources)) {
            throw new IllegalArgumentException("no such resources directory: " + resources);
        }
        Index tree = new Index();
        List<Path> files = new ArrayList<>();
        try (Stream<Path> s = Files.walk(resources)) {
            s.filter(Files::isRegularFile).sorted().forEach(files::add);
        }
        for (Path f : files) {
            tree.add(rel(resources, f));
        }
        // The namespaces THIS tree owns: every assets/<ns> or data/<ns> except minecraft, which a
        // mod only ever contributes to (its mineable tags) and never defines.
        Set<String> own = new TreeSet<>(tree.namespaces);
        own.remove("minecraft");
        Index vanilla = null;
        if (!vanillaJars.isEmpty()) {
            vanilla = new Index();
            for (Path jar : vanillaJars) {
                try (ZipFile zf = new ZipFile(jar.toFile())) {
                    var en = zf.entries();
                    while (en.hasMoreElements()) {
                        String n = en.nextElement().getName();
                        if (n.startsWith("assets/minecraft/") || n.startsWith("data/minecraft/")) {
                            vanilla.add(n);
                        }
                    }
                }
            }
        }
        for (String ns : own) {
            Path lang = resources.resolve("assets/" + ns + "/lang/en_us.json");
            if (Files.isRegularFile(lang)) {
                try {
                    JsonObject o = JsonParser.parseString(Files.readString(lang, StandardCharsets.UTF_8)).getAsJsonObject();
                    tree.langKeys.put(ns, new HashSet<>(o.keySet()));
                } catch (RuntimeException e) {
                    // reported below as a dangling lang file
                }
            }
        }

        Report report = new Report();
        report.files = files.size();
        List<Ref> refs = new ArrayList<>();
        Set<String> referencedTextures = new HashSet<>();
        Set<String> referencedModels = new HashSet<>();
        for (Path f : files) {
            String r = rel(resources, f);
            if (!r.endsWith(".json")) {
                continue;
            }
            JsonElement json;
            try {
                json = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8));
            } catch (RuntimeException | IOException e) {
                report.dangling.add(new Ref(r, "json", "unparseable: " + e.getMessage().lines().findFirst().orElse("")));
                continue;
            }
            collect(r, json, refs);
        }
        for (Ref ref : refs) {
            if (ref.kind().equals("texture")) {
                referencedTextures.add(ref.target());
            } else if (ref.kind().equals("model")) {
                referencedModels.add(ref.target());
            }
        }
        // Every block or item this tree defines is itself a reference: to a lang key, and (blocks) to a loot table.
        for (String ns : own) {
            Set<String> keys = tree.langKeys.getOrDefault(ns, Set.of());
            for (String b : tree.blocks) {
                if (!b.startsWith(ns + ":")) {
                    continue;
                }
                String id = b.substring(ns.length() + 1);
                if (!keys.contains("block." + ns + "." + id)) {
                    report.dangling.add(new Ref("assets/" + ns + "/blockstates/" + id + ".json", "lang", "block." + ns + "." + id));
                }
                if (!tree.lootTables.contains(ns + ":blocks/" + id)) {
                    report.warnings.add("no loot table for " + b + " (data/" + ns + "/loot_table/blocks/" + id + ".json): it drops nothing");
                }
            }
            for (String it : tree.items) {
                if (!it.startsWith(ns + ":")) {
                    continue;
                }
                String id = it.substring(ns.length() + 1);
                if (tree.blocks.contains(it)) {
                    continue; // a BlockItem uses the block's key (useBlockDescriptionPrefix)
                }
                if (!keys.contains("item." + ns + "." + id)) {
                    report.dangling.add(new Ref("assets/" + ns + "/items/" + id + ".json", "lang", "item." + ns + "." + id));
                }
            }
        }
        report.references = refs.size();
        for (Ref ref : refs) {
            String target = ref.target();
            int colon = target.indexOf(':');
            String ns = colon < 0 ? "minecraft" : target.substring(0, colon);
            String full = colon < 0 ? "minecraft:" + target : target;
            Ref normalised = new Ref(ref.from(), ref.kind(), full);
            // A tag member of a type that is a data category (enchantment, worldgen/biome, ...) resolves
            // against that category's files; one of a code registry (entity_type, point_of_interest_type)
            // has no file to resolve against and is counted, not judged.
            if (ref.kind().startsWith("tag-member/")) {
                String type = ref.kind().substring(11);
                boolean known = tree.hasCategory(type) || (vanilla != null && vanilla.hasCategory(type));
                if (!known) {
                    report.unchecked.add(normalised);
                    continue;
                }
            }
            if (own.contains(ns)) {
                if (!tree.has(ref.kind(), full)) {
                    report.dangling.add(normalised);
                }
            } else if (ns.equals("minecraft")) {
                if (vanilla == null) {
                    report.unchecked.add(normalised);
                } else if (!vanilla.has(ref.kind(), full) && !tree.has(ref.kind(), full)) {
                    report.dangling.add(normalised);
                }
            } else {
                report.unchecked.add(normalised);
            }
        }
        // Unused: block/item textures nothing names, models nothing names. Own namespaces only.
        for (String t : new TreeSet<>(tree.textures)) {
            int colon = t.indexOf(':');
            String ns = t.substring(0, colon);
            String path = t.substring(colon + 1);
            if (own.contains(ns) && (path.startsWith("block/") || path.startsWith("item/")) && !referencedTextures.contains(t)) {
                report.unused.add("texture " + t);
            }
        }
        for (String m : new TreeSet<>(tree.models)) {
            int colon = m.indexOf(':');
            if (own.contains(m.substring(0, colon)) && !referencedModels.contains(m)) {
                report.unused.add("model " + m);
            }
        }
        report.counts.put("files", report.files);
        report.counts.put("references", report.references);
        report.counts.put("dangling", report.dangling.size());
        report.counts.put("unused", report.unused.size());
        report.counts.put("unchecked", report.unchecked.size());
        report.counts.put("warnings", report.warnings.size());
        return report;
    }

    private static String rel(final Path root, final Path f) {
        return root.relativize(f).toString().replace('\\', '/');
    }

    /** The references one JSON file makes, by what kind of file it is. */
    static void collect(final String rel, final JsonElement json, final List<Ref> out) {
        String[] p = rel.split("/");
        if (p.length < 4 || !json.isJsonObject()) {
            return;
        }
        JsonObject o = json.getAsJsonObject();
        String top = p[0];
        String cat = p[2];
        if (top.equals("assets")) {
            switch (cat) {
                case "blockstates" -> {
                    if (o.has("variants") && o.get("variants").isJsonObject()) {
                        for (Map.Entry<String, JsonElement> v : o.getAsJsonObject("variants").entrySet()) {
                            modelsOf(v.getValue(), rel, out);
                        }
                    }
                    if (o.has("multipart") && o.get("multipart").isJsonArray()) {
                        for (JsonElement part : o.getAsJsonArray("multipart")) {
                            if (part.isJsonObject() && part.getAsJsonObject().has("apply")) {
                                modelsOf(part.getAsJsonObject().get("apply"), rel, out);
                            }
                        }
                    }
                }
                case "models" -> {
                    if (o.has("parent") && o.get("parent").isJsonPrimitive()) {
                        String parent = o.get("parent").getAsString();
                        if (!parent.startsWith("builtin/")) {
                            out.add(new Ref(rel, "model", parent));
                        }
                    }
                    if (o.has("textures") && o.get("textures").isJsonObject()) {
                        for (Map.Entry<String, JsonElement> t : o.getAsJsonObject("textures").entrySet()) {
                            if (t.getValue().isJsonPrimitive()) {
                                String v = t.getValue().getAsString();
                                if (!v.startsWith("#")) {
                                    out.add(new Ref(rel, "texture", v));
                                }
                            }
                        }
                    }
                }
                case "items" -> walk(o, (key, value) -> {
                    if (key.equals("model") && value.isJsonPrimitive()) {
                        out.add(new Ref(rel, "model", value.getAsString()));
                    }
                });
                default -> { }
            }
        } else if (top.equals("data")) {
            switch (cat) {
                case "loot_table" -> walk(o, (key, value) -> {
                    if (key.equals("name") && value.isJsonPrimitive() && looksLikeId(value.getAsString())) {
                        out.add(new Ref(rel, "item", value.getAsString()));
                    }
                });
                case "recipe" -> walk(o, (key, value) -> {
                    if (value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()) {
                        String s = value.getAsString();
                        if ((key.equals("item") || key.equals("id")) && looksLikeId(s)) {
                            out.add(new Ref(rel, "item", s));
                        } else if (key.equals("tag") && looksLikeId(s)) {
                            out.add(new Ref(rel, "tag/item", s));
                        } else if (s.startsWith("#") && looksLikeId(s.substring(1))) {
                            out.add(new Ref(rel, "tag/item", s.substring(1)));
                        } else if (key.equals("ingredients") || key.equals("ingredient")) {
                            if (looksLikeId(s)) {
                                out.add(new Ref(rel, "item", s));
                            }
                        }
                    } else if (value.isJsonArray() && (key.equals("ingredients") || key.equals("ingredient"))) {
                        for (JsonElement e : value.getAsJsonArray()) {
                            if (e.isJsonPrimitive()) {
                                String s = e.getAsString();
                                if (s.startsWith("#")) {
                                    out.add(new Ref(rel, "tag/item", s.substring(1)));
                                } else if (looksLikeId(s)) {
                                    out.add(new Ref(rel, "item", s));
                                }
                            }
                        }
                    }
                });
                case "tags" -> {
                    if (p.length < 5) {
                        return;
                    }
                    String[] tt = Index.tagType(p);
                    if (tt == null) {
                        return;
                    }
                    String type = tt[0];
                    String kind = switch (type) {
                        case "block" -> "block";
                        case "item" -> "item";
                        default -> null;
                    };
                    if (o.has("values") && o.get("values").isJsonArray()) {
                        for (JsonElement v : o.getAsJsonArray("values")) {
                            String s = v.isJsonPrimitive() ? v.getAsString()
                                : v.isJsonObject() && v.getAsJsonObject().has("id") ? v.getAsJsonObject().get("id").getAsString() : null;
                            if (s == null) {
                                continue;
                            }
                            if (s.startsWith("#")) {
                                out.add(new Ref(rel, "tag/" + type, s.substring(1)));
                            } else if (kind != null) {
                                out.add(new Ref(rel, kind, s));
                            } else {
                                out.add(new Ref(rel, "tag-member/" + type, s));
                            }
                        }
                    }
                }
                default -> { }
            }
        }
    }

    private static void modelsOf(final JsonElement v, final String rel, final List<Ref> out) {
        if (v.isJsonObject()) {
            if (v.getAsJsonObject().has("model") && v.getAsJsonObject().get("model").isJsonPrimitive()) {
                out.add(new Ref(rel, "model", v.getAsJsonObject().get("model").getAsString()));
            }
        } else if (v.isJsonArray()) {
            for (JsonElement e : v.getAsJsonArray()) {
                modelsOf(e, rel, out);
            }
        }
    }

    private interface Visitor {
        void visit(String key, JsonElement value);
    }

    private static void walk(final JsonElement e, final Visitor v) {
        if (e.isJsonObject()) {
            for (Map.Entry<String, JsonElement> en : e.getAsJsonObject().entrySet()) {
                v.visit(en.getKey(), en.getValue());
                walk(en.getValue(), v);
            }
        } else if (e.isJsonArray()) {
            for (JsonElement x : e.getAsJsonArray()) {
                walk(x, v);
            }
        }
    }

    static boolean looksLikeId(final String s) {
        return s.matches("[a-z0-9_.-]+:[a-z0-9_./-]+") || s.matches("[a-z0-9_./-]+");
    }

    // ---- the report -----------------------------------------------------------------------------

    public static void print(final Report r, final Path resources, final boolean vanillaChecked, final PrintStream out) {
        out.println("checkAssets " + resources + " - " + r.files + " files, " + r.references + " references"
            + (vanillaChecked ? ", minecraft: resolved against the vanilla jar" : ", minecraft: NOT resolved (no vanilla jar)"));
        if (!r.dangling.isEmpty()) {
            out.println("\nDANGLING (" + r.dangling.size() + ") - the game will load and skip these:");
            for (Ref d : r.dangling) {
                out.println("  " + d.from() + " -> " + d.kind() + " " + d.target());
            }
        }
        if (!r.warnings.isEmpty()) {
            out.println("\nWARN (" + r.warnings.size() + "):");
            for (String w : r.warnings) {
                out.println("  " + w);
            }
        }
        if (!r.unused.isEmpty()) {
            out.println("\nUNUSED (" + r.unused.size() + ") - nothing names these:");
            for (String u : r.unused) {
                out.println("  " + u);
            }
        }
        if (!r.unchecked.isEmpty()) {
            Map<String, Integer> byNs = new TreeMap<>();
            for (Ref u : r.unchecked) {
                byNs.merge(u.target().substring(0, u.target().indexOf(':')), 1, Integer::sum);
            }
            out.println("\nUNCHECKED (" + r.unchecked.size() + ") - references this run could not resolve: " + byNs);
        }
        String text = r.dangling.isEmpty()
            ? "  ok: no dangling reference" + (r.unused.isEmpty() ? "" : "; " + r.unused.size() + " unused")
                + (r.unchecked.isEmpty() ? "" : "; " + r.unchecked.size() + " unchecked")
            : "  ! " + r.dangling.size() + " dangling reference(s) - see above";
        JsonObject last = new JsonObject();
        last.addProperty("text", text);
        last.addProperty("problems", r.dangling.size());
        last.addProperty("notes", r.unused.size() + r.warnings.size());
        last.addProperty("unchecked", r.unchecked.size());
        JsonArray dl = new JsonArray();
        for (Ref d : r.dangling) {
            dl.add(d.from() + " -> " + d.kind() + " " + d.target());
        }
        last.add("dangling", dl);
        out.println();
        out.println(last);
    }

    /** {@code --resources <dir> [--vanilla <jar>]...} ({@code --vanilla} repeats). Exit 1 when anything dangles, 2 on bad arguments. */
    public static void main(final String[] args) {
        Map<String, String> opts = new LinkedHashMap<>();
        List<Path> vanilla = new ArrayList<>();
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            if ("--vanilla".equals(a) && i + 1 < args.length) {
                Path jar = Path.of(args[++i]);
                if (Files.isRegularFile(jar)) {
                    vanilla.add(jar);
                } else {
                    System.err.println("no such vanilla jar: " + jar + " (skipped; minecraft: references may be counted as unchecked)");
                }
            } else if (a.startsWith("--") && i + 1 < args.length) {
                opts.put(a.substring(2), args[++i]);
            } else {
                System.err.println("unexpected argument: " + a + "\nusage: --resources <dir> [--vanilla <minecraft jar>]...");
                System.exit(2);
            }
        }
        if (!opts.containsKey("resources")) {
            System.err.println("missing --resources\nusage: --resources <dir> [--vanilla <minecraft jar>]...");
            System.exit(2);
        }
        Report r;
        try {
            r = check(Path.of(opts.get("resources")), vanilla);
        } catch (IOException | IllegalArgumentException e) {
            System.err.println(e.getMessage());
            System.exit(2);
            return;
        }
        print(r, Path.of(opts.get("resources")), !vanilla.isEmpty(), System.out);
        System.exit(r.failed() ? 1 : 0);
    }

    static List<String> sorted(final Set<String> s) {
        List<String> l = new ArrayList<>(s);
        Collections.sort(l);
        return l;
    }
}
