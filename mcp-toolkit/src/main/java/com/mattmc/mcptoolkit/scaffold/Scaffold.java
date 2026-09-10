package com.mattmc.mcptoolkit.scaffold;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The scaffold (RELEASE_1.md section J1): a block or an item into YOUR source tree, once.
 *
 * <p>Two halves, deliberately separable. {@link #emit} is a pure function from a request to the
 * files a registered block or item consists of - the Java that registers it in the sibling mods'
 * own idiom, and the JSON the game needs before it will show it. It writes nothing and imports no
 * Minecraft, so it is the one emitter two callers can share: {@code gradlew scaffold} in the
 * convention plugin (this class's {@link #main}), and a Blockbench-side "geometry first" caller if
 * the asset round trip is ever revived. {@link #apply} is the write, with the one rule that makes
 * this the anti-MCreator decision:
 *
 * <p><b>It runs once and never regenerates.</b> A file it would write that already exists is left
 * exactly as it is and reported {@code present}; if the registration file itself exists the run is
 * refused before anything is written. There is no machine-owned code here because there is no
 * document for it to stay in sync with - a block is not a screen - so ownership is the human's from
 * the first write and nothing ever comes back to eat an edit. The two files it MERGES into (the
 * lang file, the mineable tag) are the two the game keeps as one map per mod; a key or a value is
 * inserted textually, before the closing brace or bracket, so the rest of the file keeps its bytes.
 *
 * <p>Every 26.2 signature here was read from {@code vanilla-src/} and from
 * {@code rocketeer/.../registry/ModBlocks.java}, not from memory: {@code Identifier.fromNamespaceAndPath},
 * {@code ResourceKey.create(Registries.BLOCK, id)}, {@code BlockBehaviour.Properties.of().setId(key)},
 * {@code Registry.register(BuiltInRegistries.BLOCK, key, block)}, {@code new BlockItem(block, new
 * Item.Properties().useBlockDescriptionPrefix().setId(itemKey))}. {@code ScaffoldTest} compiles the
 * emitted Java against the toolkit's own Loom classpath, which is the arbiter for that claim.
 *
 * <p>The creative-tab line is a comment in the emitted Javadoc rather than code, and that is a
 * cross-loader decision: the tab hook is the loader's (Fabric API's {@code CreativeModeTabEvents},
 * NeoForge's {@code BuildCreativeModeTabContentsEvent}), the toolkit compiles against neither, and
 * an import the mod may not have is a scaffold that does not compile. The line is printed where it
 * belongs and the human pastes it.
 */
public final class Scaffold {
    private Scaffold() {}

    public static final String VERSION_NOTE = "scaffolded once by `gradlew scaffold` (mcp-toolkit)";

    public enum Kind {
        BLOCK, ITEM;

        public static Kind forName(final String s) {
            for (Kind k : values()) {
                if (k.name().equalsIgnoreCase(s)) {
                    return k;
                }
            }
            return null;
        }
    }

    /** Which root a file lands under, and how it is written. */
    public enum Root { JAVA, RESOURCES }

    /** {@code CREATE}: written when absent, else left; {@code LANG_KEY} / {@code TAG_VALUE}: inserted when absent. */
    public enum Merge { CREATE, LANG_KEY, TAG_VALUE }

    /**
     * One file the scaffold produces. For {@code CREATE} the bytes are the whole file. For a merge,
     * {@code mergeKey} and {@code mergeValue} are the entry and {@code bytes} the file to create if
     * none exists yet.
     */
    public record File(String path, Root root, Merge merge, byte[] bytes, String mergeKey, String mergeValue) {
        static File create(final String path, final Root root, final String text) {
            return new File(path, root, Merge.CREATE, text.getBytes(StandardCharsets.UTF_8), null, null);
        }

        static File binary(final String path, final byte[] bytes) {
            return new File(path, Root.RESOURCES, Merge.CREATE, bytes, null, null);
        }
    }

    public record Request(String modId, String basePackage, String id, Kind kind, boolean behaviour, String displayName) {
        public Request {
            if (!modId.matches("[a-z0-9_.-]+")) {
                throw new IllegalArgumentException("mod id must be lower-case [a-z0-9_.-]: " + modId);
            }
            if (!id.matches("[a-z0-9_.-]+")) {
                throw new IllegalArgumentException("id must be lower-case [a-z0-9_.-] (it is a registry path): " + id);
            }
            if (!basePackage.matches("[a-z_][a-z0-9_]*(\\.[a-z_][a-z0-9_]*)*")) {
                throw new IllegalArgumentException("package must be a Java package name: " + basePackage);
            }
            if (displayName == null || displayName.isBlank()) {
                displayName = displayNameOf(id);
            }
        }

        /** {@code my_stone} to {@code MyStone}. */
        public String pascal() {
            StringBuilder sb = new StringBuilder();
            for (String part : id.split("[_.-]+")) {
                if (!part.isEmpty()) {
                    sb.append(Character.toUpperCase(part.charAt(0))).append(part.substring(1));
                }
            }
            return sb.toString();
        }

        public String registerClass() {
            return "Register" + pascal();
        }

        public String behaviourClass() {
            return pascal() + (kind == Kind.BLOCK ? "Block" : "Item");
        }

        static String displayNameOf(final String id) {
            StringBuilder sb = new StringBuilder();
            for (String part : id.split("[_.-]+")) {
                if (part.isEmpty()) {
                    continue;
                }
                if (sb.length() > 0) {
                    sb.append(' ');
                }
                sb.append(Character.toUpperCase(part.charAt(0))).append(part.substring(1));
            }
            return sb.toString();
        }
    }

    // ---- the emitter ----------------------------------------------------------------------------

    /** Every file a registered block or item consists of, in write order. Pure. */
    public static List<File> emit(final Request r) {
        List<File> out = new ArrayList<>();
        String pkgPath = r.basePackage().replace('.', '/');
        out.add(File.create(pkgPath + "/registry/" + r.registerClass() + ".java", Root.JAVA, registerJava(r)));
        if (r.behaviour()) {
            String sub = r.kind() == Kind.BLOCK ? "block" : "item";
            out.add(File.create(pkgPath + "/" + sub + "/" + r.behaviourClass() + ".java", Root.JAVA, behaviourJava(r)));
        }
        String mod = r.modId();
        String id = r.id();
        if (r.kind() == Kind.BLOCK) {
            out.add(File.create("assets/" + mod + "/blockstates/" + id + ".json", Root.RESOURCES,
                "{\n  \"variants\": {\n    \"\": { \"model\": \"" + mod + ":block/" + id + "\" }\n  }\n}\n"));
            out.add(File.create("assets/" + mod + "/models/block/" + id + ".json", Root.RESOURCES,
                "{\n  \"parent\": \"minecraft:block/cube_all\",\n  \"textures\": {\n    \"all\": \"" + mod + ":block/" + id + "\"\n  }\n}\n"));
            out.add(File.create("assets/" + mod + "/models/item/" + id + ".json", Root.RESOURCES,
                "{\n  \"parent\": \"" + mod + ":block/" + id + "\"\n}\n"));
            out.add(File.create("assets/" + mod + "/items/" + id + ".json", Root.RESOURCES, itemDefinition(mod, id)));
            out.add(File.binary("assets/" + mod + "/textures/block/" + id + ".png", placeholderTexture(id)));
            out.add(new File("assets/" + mod + "/lang/en_us.json", Root.RESOURCES, Merge.LANG_KEY,
                ("{\n  \"block." + mod + "." + id + "\": " + quote(r.displayName()) + "\n}\n").getBytes(StandardCharsets.UTF_8),
                "block." + mod + "." + id, r.displayName()));
            out.add(File.create("data/" + mod + "/loot_table/blocks/" + id + ".json", Root.RESOURCES,
                "{\n  \"type\": \"minecraft:block\",\n  \"pools\": [\n    {\n      \"rolls\": 1,\n      \"entries\": [\n"
                    + "        {\n          \"type\": \"minecraft:item\",\n          \"name\": \"" + mod + ":" + id + "\"\n        }\n"
                    + "      ],\n      \"conditions\": [\n        { \"condition\": \"minecraft:survives_explosion\" }\n      ]\n    }\n  ]\n}\n"));
            out.add(new File("data/minecraft/tags/block/mineable/pickaxe.json", Root.RESOURCES, Merge.TAG_VALUE,
                ("{\n  \"values\": [\n    \"" + mod + ":" + id + "\"\n  ]\n}\n").getBytes(StandardCharsets.UTF_8),
                null, mod + ":" + id));
        } else {
            out.add(File.create("assets/" + mod + "/models/item/" + id + ".json", Root.RESOURCES,
                "{\n  \"parent\": \"minecraft:item/generated\",\n  \"textures\": {\n    \"layer0\": \"" + mod + ":item/" + id + "\"\n  }\n}\n"));
            out.add(File.create("assets/" + mod + "/items/" + id + ".json", Root.RESOURCES, itemDefinition(mod, id)));
            out.add(File.binary("assets/" + mod + "/textures/item/" + id + ".png", placeholderTexture(id)));
            out.add(new File("assets/" + mod + "/lang/en_us.json", Root.RESOURCES, Merge.LANG_KEY,
                ("{\n  \"item." + mod + "." + id + "\": " + quote(r.displayName()) + "\n}\n").getBytes(StandardCharsets.UTF_8),
                "item." + mod + "." + id, r.displayName()));
        }
        return out;
    }

    private static String itemDefinition(final String mod, final String id) {
        return "{\n  \"model\": {\n    \"type\": \"minecraft:model\",\n    \"model\": \"" + mod + ":item/" + id + "\"\n  }\n}\n";
    }

    static String registerJava(final Request r) {
        String mod = r.modId();
        String id = r.id();
        String cls = r.registerClass();
        StringBuilder sb = new StringBuilder();
        sb.append("package ").append(r.basePackage()).append(".registry;\n\n");
        if (r.behaviour()) {
            sb.append("import ").append(r.basePackage()).append(r.kind() == Kind.BLOCK ? ".block." : ".item.")
                .append(r.behaviourClass()).append(";\n");
        }
        sb.append("import net.minecraft.core.Registry;\n")
            .append("import net.minecraft.core.registries.BuiltInRegistries;\n")
            .append("import net.minecraft.core.registries.Registries;\n")
            .append("import net.minecraft.resources.Identifier;\n")
            .append("import net.minecraft.resources.ResourceKey;\n");
        if (r.kind() == Kind.BLOCK) {
            sb.append("import net.minecraft.world.item.BlockItem;\n");
        }
        sb.append("import net.minecraft.world.item.Item;\n");
        if (r.kind() == Kind.BLOCK) {
            sb.append("import net.minecraft.world.level.block.Block;\n")
                .append("import net.minecraft.world.level.block.state.BlockBehaviour;\n");
        }
        sb.append("\n/**\n")
            .append(" * {@code ").append(mod).append(':').append(id).append("} - ").append(VERSION_NOTE)
            .append(", yours since.\n")
            .append(" *\n")
            .append(" * <p>Call {@link #register()} from your mod initializer, before anything reads the registries.\n")
            .append(" * The creative tab is yours to add, because the hook is the loader's: Fabric API\n")
            .append(" * {@code CreativeModeTabEvents.modifyOutputEvent(CreativeModeTabs.")
            .append(r.kind() == Kind.BLOCK ? "BUILDING_BLOCKS" : "INGREDIENTS")
            .append(").register(o -> o.accept(").append(cls).append(".ITEM))};\n")
            .append(" * NeoForge {@code BuildCreativeModeTabContentsEvent} on the mod bus, {@code event.accept(")
            .append(cls).append(".ITEM)} for that tab key.\n")
            .append(" */\n")
            .append("public final class ").append(cls).append(" {\n")
            .append("    public static final Identifier ID = Identifier.fromNamespaceAndPath(\"").append(mod)
            .append("\", \"").append(id).append("\");\n");
        if (r.kind() == Kind.BLOCK) {
            sb.append("    public static final ResourceKey<Block> BLOCK_KEY = ResourceKey.create(Registries.BLOCK, ID);\n");
        }
        sb.append("    public static final ResourceKey<Item> ITEM_KEY = ResourceKey.create(Registries.ITEM, ID);\n\n");
        if (r.kind() == Kind.BLOCK) {
            sb.append("    public static Block BLOCK;\n");
        }
        sb.append("    public static Item ITEM;\n\n")
            .append("    private ").append(cls).append("() {}\n\n")
            .append("    public static void register() {\n");
        if (r.kind() == Kind.BLOCK) {
            sb.append("        BlockBehaviour.Properties props = BlockBehaviour.Properties.of()\n")
                .append("            .strength(1.5F, 6.0F)\n")
                .append("            .setId(BLOCK_KEY);\n")
                .append("        BLOCK = Registry.register(BuiltInRegistries.BLOCK, BLOCK_KEY, new ")
                .append(r.behaviour() ? r.behaviourClass() : "Block").append("(props));\n")
                .append("        ITEM = Registry.register(BuiltInRegistries.ITEM, ITEM_KEY,\n")
                .append("            new BlockItem(BLOCK, new Item.Properties().useBlockDescriptionPrefix().setId(ITEM_KEY)));\n");
        } else {
            sb.append("        ITEM = Registry.register(BuiltInRegistries.ITEM, ITEM_KEY,\n")
                .append("            new ").append(r.behaviour() ? r.behaviourClass() : "Item")
                .append("(new Item.Properties().setId(ITEM_KEY)));\n");
        }
        sb.append("    }\n}\n");
        return sb.toString();
    }

    static String behaviourJava(final Request r) {
        String cls = r.behaviourClass();
        if (r.kind() == Kind.BLOCK) {
            return "package " + r.basePackage() + ".block;\n\n"
                + "import net.minecraft.world.level.block.Block;\n"
                + "import net.minecraft.world.level.block.state.BlockBehaviour;\n\n"
                + "/** What {@code " + r.modId() + ":" + r.id() + "} does - " + VERSION_NOTE + ", yours since. */\n"
                + "public class " + cls + " extends Block {\n"
                + "    public " + cls + "(final BlockBehaviour.Properties properties) {\n"
                + "        super(properties);\n"
                + "    }\n}\n";
        }
        return "package " + r.basePackage() + ".item;\n\n"
            + "import net.minecraft.world.item.Item;\n\n"
            + "/** What {@code " + r.modId() + ":" + r.id() + "} does - " + VERSION_NOTE + ", yours since. */\n"
            + "public class " + cls + " extends Item {\n"
            + "    public " + cls + "(final Item.Properties properties) {\n"
            + "        super(properties);\n"
            + "    }\n}\n";
    }

    private static String quote(final String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    /**
     * A 16x16 placeholder: a flat colour hashed from the id, a darker 1px border, a lighter diagonal.
     * Recognisably a placeholder in-game and never the same colour as the neighbour's, so two
     * scaffolded blocks side by side tell apart on the first render.
     */
    static byte[] placeholderTexture(final String id) {
        int h = id.hashCode();
        float hue = ((h & 0xffff) % 360) / 360f;
        int base = java.awt.Color.HSBtoRGB(hue, 0.45f, 0.75f);
        int dark = java.awt.Color.HSBtoRGB(hue, 0.55f, 0.45f);
        int light = java.awt.Color.HSBtoRGB(hue, 0.30f, 0.92f);
        BufferedImage img = new BufferedImage(16, 16, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < 16; y++) {
            for (int x = 0; x < 16; x++) {
                int c = base;
                if (x == 0 || y == 0 || x == 15 || y == 15) {
                    c = dark;
                } else if (x == y || x == y + 1) {
                    c = light;
                }
                img.setRGB(x, y, 0xff000000 | (c & 0xffffff));
            }
        }
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            ImageIO.write(img, "png", bos);
            return bos.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException("PNG encoding failed", e);
        }
    }

    // ---- the write ------------------------------------------------------------------------------

    public enum Fate { WRITTEN, PRESENT, MERGED, ALREADY_MERGED }

    public record Report(Map<Path, Fate> files, List<String> yours, List<String> next) {}

    /**
     * Write the files under the two roots with the once-only rule. Refuses (throws) when the
     * registration file already exists: that is the "already scaffolded" signal, and re-running
     * would only be a way to overwrite something.
     */
    public static Report apply(final Request r, final List<File> files, final Path javaRoot, final Path resources,
                               final String entrypoint) throws IOException {
        Path register = javaRoot.resolve(files.get(0).path());
        if (Files.isRegularFile(register)) {
            throw new IllegalStateException(r.modId() + ":" + r.id() + " is already scaffolded - " + register
                + " exists. The scaffold runs once and never regenerates; delete the files it wrote if you mean to redo it.");
        }
        Map<Path, Fate> fates = new LinkedHashMap<>();
        for (File f : files) {
            Path dest = (f.root() == Root.JAVA ? javaRoot : resources).resolve(f.path());
            switch (f.merge()) {
                case CREATE -> {
                    if (Files.isRegularFile(dest)) {
                        fates.put(dest, Fate.PRESENT);
                    } else {
                        Files.createDirectories(dest.getParent());
                        Files.write(dest, f.bytes());
                        fates.put(dest, Fate.WRITTEN);
                    }
                }
                case LANG_KEY -> fates.put(dest, mergeLang(dest, f));
                case TAG_VALUE -> fates.put(dest, mergeTag(dest, f));
            }
        }
        List<String> yours = new ArrayList<>();
        yours.add("call " + r.registerClass() + ".register() from " + (entrypoint != null ? entrypoint : "your mod initializer")
            + " before anything reads the registries (a registration is structural: one rebuild, hotswap_class refuses it)");
        yours.add("the creative-tab line - it is in " + r.registerClass() + "'s Javadoc, because the hook is the loader's");
        yours.add("textures/" + (r.kind() == Kind.BLOCK ? "block/" : "item/") + r.id()
            + ".png is a placeholder: push_asset the real one live, judge it, then clear_assets {promote} it here");
        List<String> next = new ArrayList<>();
        String full = r.modId() + ":" + r.id();
        next.add("launch_game {\"target\": \"client\"}   (or tools/rebuild.ps1) - then poll ping");
        next.add("query_registry {\"registry\": \"" + (r.kind() == Kind.BLOCK ? "block" : "item") + "\", \"entry\": \"" + full + "\"}");
        if (r.kind() == Kind.BLOCK) {
            next.add("set_blocks {\"blocks\": [{\"x\": X, \"y\": Y, \"z\": Z, \"block\": \"" + full + "\"}]}   (pick X,Y,Z from anchors / resolve_anchor)");
            next.add("render {\"look_at\": {\"min\": {\"x\": X, \"y\": Y, \"z\": Z}, \"max\": {\"x\": X, \"y\": Y, \"z\": Z}}, \"distance\": 4}");
        } else {
            next.add("run_command {\"command\": \"give @p " + full + "\"}   then screenshot / render the hand");
        }
        next.add("get_log {\"level\": \"warn\"}   - a model or texture the game skipped is logged, not thrown");
        return new Report(fates, yours, next);
    }

    /** Insert {@code "key": "value"} before the closing brace unless the key is already there. */
    static Fate mergeLang(final Path dest, final File f) throws IOException {
        if (!Files.isRegularFile(dest)) {
            Files.createDirectories(dest.getParent());
            Files.write(dest, f.bytes());
            return Fate.WRITTEN;
        }
        String text = Files.readString(dest, StandardCharsets.UTF_8);
        JsonObject obj;
        try {
            obj = JsonParser.parseString(text).getAsJsonObject();
        } catch (RuntimeException e) {
            throw new IOException(dest + " is not a JSON object; add the lang key by hand: " + f.mergeKey());
        }
        if (obj.has(f.mergeKey())) {
            return Fate.ALREADY_MERGED;
        }
        int close = text.lastIndexOf('}');
        if (close < 0) {
            throw new IOException(dest + " has no closing brace");
        }
        String entry = "\"" + f.mergeKey() + "\": " + quote(f.mergeValue());
        Files.writeString(dest, insertBefore(text, close, entry, obj.size() == 0), StandardCharsets.UTF_8);
        return Fate.MERGED;
    }

    /** Insert the value into the tag's {@code values} array unless it is already listed. */
    static Fate mergeTag(final Path dest, final File f) throws IOException {
        if (!Files.isRegularFile(dest)) {
            Files.createDirectories(dest.getParent());
            Files.write(dest, f.bytes());
            return Fate.WRITTEN;
        }
        String text = Files.readString(dest, StandardCharsets.UTF_8);
        JsonObject obj;
        try {
            obj = JsonParser.parseString(text).getAsJsonObject();
        } catch (RuntimeException e) {
            throw new IOException(dest + " is not a JSON object; add the tag value by hand: " + f.mergeValue());
        }
        if (!obj.has("values") || !obj.get("values").isJsonArray()) {
            throw new IOException(dest + " has no \"values\" array; add the tag value by hand: " + f.mergeValue());
        }
        for (var v : obj.getAsJsonArray("values")) {
            if (v.isJsonPrimitive() && v.getAsString().equals(f.mergeValue())) {
                return Fate.ALREADY_MERGED;
            }
        }
        // The values array's own closing bracket: the last ']' before the object's last '}'.
        int close = text.lastIndexOf(']', text.lastIndexOf('}'));
        if (close < 0) {
            throw new IOException(dest + " has no closing bracket");
        }
        Files.writeString(dest, insertBefore(text, close, quote(f.mergeValue()), obj.getAsJsonArray("values").isEmpty()),
            StandardCharsets.UTF_8);
        return Fate.MERGED;
    }

    /** Textual insertion that keeps every other byte, with the file's own indentation guessed from the line above. */
    private static String insertBefore(final String text, final int close, final String entry, final boolean empty) {
        // Everything before the closing char, trailing whitespace trimmed; the indentation of the
        // previous entry, or two spaces past the closer's own indentation when there is none.
        String head = text.substring(0, close);
        int lastNonWs = head.length() - 1;
        while (lastNonWs >= 0 && Character.isWhitespace(head.charAt(lastNonWs))) {
            lastNonWs--;
        }
        String body = head.substring(0, lastNonWs + 1);
        String closerIndent = indentOfLine(text, close);
        String entryIndent;
        if (empty) {
            entryIndent = closerIndent + "  ";
        } else {
            int prevLineStart = body.lastIndexOf('\n') + 1;
            String prevLine = body.substring(prevLineStart);
            int i = 0;
            while (i < prevLine.length() && (prevLine.charAt(i) == ' ' || prevLine.charAt(i) == '\t')) {
                i++;
            }
            entryIndent = prevLine.substring(0, i);
        }
        String nl = text.contains("\r\n") ? "\r\n" : "\n";
        String between = empty ? nl : "," + nl;
        return body + between + entryIndent + entry + nl + closerIndent + text.substring(close);
    }

    private static String indentOfLine(final String text, final int at) {
        int start = text.lastIndexOf('\n', at) + 1;
        int i = start;
        while (i < at && (text.charAt(i) == ' ' || text.charAt(i) == '\t')) {
            i++;
        }
        return text.substring(start, i);
    }

    // ---- the CLI --------------------------------------------------------------------------------

    /**
     * {@code --kind block|item --id <id> --mod <id> --package <pkg> --resources <dir> --java <dir>
     * [--behaviour] [--name "Display Name"] [--entrypoint <class>]}. Exit 0 written, 1 refused
     * (already scaffolded), 2 bad arguments.
     */
    public static void main(final String[] args) {
        System.setProperty("java.awt.headless", "true");
        Map<String, String> opts = new LinkedHashMap<>();
        boolean behaviour = false;
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            if ("--behaviour".equals(a) || "--behavior".equals(a)) {
                behaviour = true;
            } else if (a.startsWith("--") && i + 1 < args.length) {
                opts.put(a.substring(2), args[++i]);
            } else {
                System.err.println("unexpected argument: " + a);
                System.exit(2);
            }
        }
        for (String required : new String[] {"kind", "id", "mod", "package", "resources", "java"}) {
            if (!opts.containsKey(required)) {
                System.err.println("missing --" + required + "\nusage: --kind block|item --id <id> --mod <modid> --package <pkg>"
                    + " --resources <dir> --java <dir> [--behaviour] [--name \"Display Name\"] [--entrypoint <class>]");
                System.exit(2);
            }
        }
        Kind kind = Kind.forName(opts.get("kind"));
        if (kind == null) {
            System.err.println("unknown kind '" + opts.get("kind") + "'; one of: block, item. A creature is not a kind:"
                + " it has its own door (Blockbench + stage_entity, profile `entity`).");
            System.exit(2);
        }
        Request r;
        try {
            r = new Request(opts.get("mod"), opts.get("package"), opts.get("id"), kind, behaviour, opts.get("name"));
        } catch (IllegalArgumentException e) {
            System.err.println(e.getMessage());
            System.exit(2);
            return;
        }
        Report report;
        try {
            report = apply(r, emit(r), Path.of(opts.get("java")), Path.of(opts.get("resources")), opts.get("entrypoint"));
        } catch (IllegalStateException e) {
            System.err.println(e.getMessage());
            System.exit(1);
            return;
        } catch (IOException e) {
            System.err.println(e.getMessage());
            System.exit(2);
            return;
        }
        print(r, report, System.out);
    }

    /** The reply: a file list, what is still yours, the next calls verbatim, and where the rungs are. */
    public static void print(final Request r, final Report report, final PrintStream out) {
        out.println(r.modId() + ":" + r.id() + " (" + r.kind().name().toLowerCase(Locale.ROOT) + ")");
        for (Map.Entry<Path, Fate> e : report.files().entrySet()) {
            out.println(String.format("  %-15s %s", e.getValue().name().toLowerCase(Locale.ROOT).replace('_', ' '), e.getKey()));
        }
        out.println("\nstill yours:");
        for (String y : report.yours()) {
            out.println("  - " + y);
        }
        out.println("\nnext, in order (the registration is structural, so one rebuild first):");
        for (String n : report.next()) {
            out.println("  " + n);
        }
        out.println("\nrungs from here: a screen for it -> ui_doc {op: \"new\"} (profile `screens`, one tool_surface call);"
            + " a creature -> Blockbench + stage_entity (profile `entity`). A rung the brief did not plan for is a"
            + " Lessons line for the next brief.");
    }
}
