package com.mattmc.mcptoolkit.scaffold;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import java.io.IOException;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The scaffold's arbiter (RELEASE_1.md section J1): the emitted Java COMPILES against the toolkit's
 * own Loom compile classpath - a real "compiles against 26.2" with no game - the JSON matches the
 * sibling mods' idiom byte for byte, the once-only rule holds, and the merges keep the bytes of
 * the file they merge into. {@code mcptk.compileClasspath} is set by build.gradle's test task.
 */
class ScaffoldTest {

    private static final Scaffold.Request BLOCK = new Scaffold.Request("mymod", "com.example.mymod", "my_stone",
        Scaffold.Kind.BLOCK, true, null);
    private static final Scaffold.Request ITEM = new Scaffold.Request("mymod", "com.example.mymod", "moon_dust",
        Scaffold.Kind.ITEM, false, "Dust of the Moon");

    @Test
    void namesAndDisplayNames() {
        assertEquals("MyStone", BLOCK.pascal());
        assertEquals("RegisterMyStone", BLOCK.registerClass());
        assertEquals("MyStoneBlock", BLOCK.behaviourClass());
        assertEquals("My Stone", BLOCK.displayName());
        assertEquals("Dust of the Moon", ITEM.displayName());
        assertThrows(IllegalArgumentException.class,
            () -> new Scaffold.Request("mymod", "com.example", "MyStone", Scaffold.Kind.BLOCK, false, null));
    }

    @Test
    void blockFilesAreTheSiblingsIdiom() {
        List<Scaffold.File> files = Scaffold.emit(BLOCK);
        List<String> paths = files.stream().map(Scaffold.File::path).toList();
        assertEquals(List.of(
            "com/example/mymod/registry/RegisterMyStone.java",
            "com/example/mymod/block/MyStoneBlock.java",
            "assets/mymod/blockstates/my_stone.json",
            "assets/mymod/models/block/my_stone.json",
            "assets/mymod/models/item/my_stone.json",
            "assets/mymod/items/my_stone.json",
            "assets/mymod/textures/block/my_stone.png",
            "assets/mymod/lang/en_us.json",
            "data/mymod/loot_table/blocks/my_stone.json",
            "data/minecraft/tags/block/mineable/pickaxe.json"), paths);
        // rocketeer's enderrite_ore, with the names swapped - the fixture is the sibling's own file.
        assertEquals("{\n  \"variants\": {\n    \"\": { \"model\": \"mymod:block/my_stone\" }\n  }\n}\n", text(files, 2));
        assertEquals("{\n  \"parent\": \"minecraft:block/cube_all\",\n  \"textures\": {\n    \"all\": \"mymod:block/my_stone\"\n  }\n}\n", text(files, 3));
        assertEquals("{\n  \"parent\": \"mymod:block/my_stone\"\n}\n", text(files, 4));
        assertEquals("{\n  \"model\": {\n    \"type\": \"minecraft:model\",\n    \"model\": \"mymod:item/my_stone\"\n  }\n}\n", text(files, 5));
        assertTrue(text(files, 8).contains("\"name\": \"mymod:my_stone\"") && text(files, 8).contains("minecraft:survives_explosion"));
        assertEquals("block.mymod.my_stone", files.get(7).mergeKey());
        assertEquals("mymod:my_stone", files.get(9).mergeValue());
        String java = text(files, 0);
        assertTrue(java.contains("Identifier.fromNamespaceAndPath(\"mymod\", \"my_stone\")"), java);
        assertTrue(java.contains("ResourceKey.create(Registries.BLOCK, ID)"), java);
        assertTrue(java.contains("BlockBehaviour.Properties.of()"), java);
        assertTrue(java.contains(".setId(BLOCK_KEY)"), java);
        assertTrue(java.contains("Registry.register(BuiltInRegistries.BLOCK, BLOCK_KEY, new MyStoneBlock(props))"), java);
        assertTrue(java.contains("new BlockItem(BLOCK, new Item.Properties().useBlockDescriptionPrefix().setId(ITEM_KEY))"), java);
        assertTrue(java.contains("CreativeModeTabEvents"), "the creative-tab line is in the Javadoc");
        assertFalse(java.contains("import net.fabricmc"), "no loader import: the file must compile on either loader");
    }

    @Test
    void itemFiles() {
        List<Scaffold.File> files = Scaffold.emit(ITEM);
        List<String> paths = files.stream().map(Scaffold.File::path).toList();
        assertEquals(List.of(
            "com/example/mymod/registry/RegisterMoonDust.java",
            "assets/mymod/models/item/moon_dust.json",
            "assets/mymod/items/moon_dust.json",
            "assets/mymod/textures/item/moon_dust.png",
            "assets/mymod/lang/en_us.json"), paths);
        assertEquals("{\n  \"parent\": \"minecraft:item/generated\",\n  \"textures\": {\n    \"layer0\": \"mymod:item/moon_dust\"\n  }\n}\n", text(files, 1));
        assertEquals("Dust of the Moon", files.get(4).mergeValue());
        String java = text(files, 0);
        assertTrue(java.contains("new Item(new Item.Properties().setId(ITEM_KEY))"), java);
        assertFalse(java.contains("BlockBehaviour"), java);
    }

    @Test
    void emittedJavaCompilesAgainstTheLoomClasspath(@TempDir final Path dir) throws IOException {
        String classpath = System.getProperty("mcptk.compileClasspath");
        assertNotNull(classpath, "build.gradle must hand the test the main compile classpath");
        assertTrue(classpath.contains("minecraft-merged") || classpath.contains("minecraft"),
            "the classpath must carry the Loom minecraft jar: " + classpath);
        Path java = dir.resolve("java");
        Path res = dir.resolve("resources");
        for (Scaffold.Request r : List.of(BLOCK, ITEM,
            new Scaffold.Request("mymod", "com.example.mymod", "plain_slab", Scaffold.Kind.BLOCK, false, null),
            new Scaffold.Request("mymod", "com.example.mymod", "odd_tool", Scaffold.Kind.ITEM, true, null))) {
            Scaffold.apply(r, Scaffold.emit(r), java, res, null);
        }
        List<Path> sources = new ArrayList<>();
        try (Stream<Path> s = Files.walk(java)) {
            s.filter(p -> p.toString().endsWith(".java")).forEach(sources::add);
        }
        assertEquals(6, sources.size(), sources.toString());

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        StringWriter log = new StringWriter();
        Path out = Files.createDirectories(dir.resolve("classes"));
        try (StandardJavaFileManager fm = javac.getStandardFileManager(diags, null, StandardCharsets.UTF_8)) {
            Iterable<? extends JavaFileObject> units = fm.getJavaFileObjectsFromPaths(sources);
            boolean ok = javac.getTask(log, fm, diags,
                List.of("-classpath", classpath, "-d", out.toString(), "-proc:none", "-Xlint:none"), null, units).call();
            assertTrue(ok, "the scaffolded Java did not compile against 26.2:\n" + diags.getDiagnostics() + "\n" + log);
        }
        assertTrue(Files.isRegularFile(out.resolve("com/example/mymod/registry/RegisterMyStone.class")));
    }

    @Test
    void runsOnceAndMergesWithoutRewriting(@TempDir final Path dir) throws IOException {
        Path java = dir.resolve("java");
        Path res = dir.resolve("resources");
        // A lang file and a tag file the human already owns, with their own formatting quirks.
        Path lang = res.resolve("assets/mymod/lang/en_us.json");
        Files.createDirectories(lang.getParent());
        String langBefore = "{\r\n    \"itemGroup.mymod\": \"My Mod\",\r\n    \"item.mymod.wand\":   \"Wand\"\r\n}\r\n";
        Files.writeString(lang, langBefore);
        Path tag = res.resolve("data/minecraft/tags/block/mineable/pickaxe.json");
        Files.createDirectories(tag.getParent());
        String tagBefore = "{\n  \"replace\": false,\n  \"values\": [\n    \"mymod:old_ore\"\n  ]\n}\n";
        Files.writeString(tag, tagBefore);
        // One asset already present: it must be left exactly as it is.
        Path model = res.resolve("assets/mymod/models/block/my_stone.json");
        Files.createDirectories(model.getParent());
        Files.writeString(model, "{ \"parent\": \"minecraft:block/cube_column\" }");

        Scaffold.Report first = Scaffold.apply(BLOCK, Scaffold.emit(BLOCK), java, res, "com.example.mymod.MyMod");
        assertEquals(Scaffold.Fate.PRESENT, first.files().get(model));
        assertEquals("{ \"parent\": \"minecraft:block/cube_column\" }", Files.readString(model));
        assertEquals(Scaffold.Fate.MERGED, first.files().get(lang));
        assertEquals(Scaffold.Fate.MERGED, first.files().get(tag));
        assertEquals("{\r\n    \"itemGroup.mymod\": \"My Mod\",\r\n    \"item.mymod.wand\":   \"Wand\",\r\n"
            + "    \"block.mymod.my_stone\": \"My Stone\"\r\n}\r\n", Files.readString(lang),
            "the existing keys keep their bytes, the new key takes the file's indentation and line ending");
        assertEquals("{\n  \"replace\": false,\n  \"values\": [\n    \"mymod:old_ore\",\n    \"mymod:my_stone\"\n  ]\n}\n",
            Files.readString(tag));
        assertTrue(first.yours().get(0).contains("com.example.mymod.MyMod"), first.yours().toString());
        assertTrue(first.next().get(1).contains("query_registry"), first.next().toString());

        // The second run is refused before it writes anything.
        IllegalStateException e = assertThrows(IllegalStateException.class,
            () -> Scaffold.apply(BLOCK, Scaffold.emit(BLOCK), java, res, null));
        assertTrue(e.getMessage().contains("already scaffolded"), e.getMessage());

        // A second block merges beside the first rather than duplicating either file.
        Scaffold.Request second = new Scaffold.Request("mymod", "com.example.mymod", "my_other", Scaffold.Kind.BLOCK, false, null);
        Scaffold.Report r2 = Scaffold.apply(second, Scaffold.emit(second), java, res, null);
        assertEquals(Scaffold.Fate.MERGED, r2.files().get(lang));
        assertTrue(Files.readString(lang).contains("\"block.mymod.my_other\": \"My Other\""));
        assertTrue(Files.readString(tag).contains("\"mymod:my_stone\",\n    \"mymod:my_other\""));
        // And a third time on the same key is a no-op the report names.
        Scaffold.File langFile = Scaffold.emit(second).get(6);
        assertEquals(Scaffold.Fate.ALREADY_MERGED, Scaffold.mergeLang(lang, langFile));
    }

    @Test
    void theScaffoldPassesItsOwnChecker(@TempDir final Path dir) throws IOException {
        Path java = dir.resolve("java");
        Path res = dir.resolve("resources");
        Scaffold.apply(BLOCK, Scaffold.emit(BLOCK), java, res, null);
        Scaffold.apply(ITEM, Scaffold.emit(ITEM), java, res, null);
        Path vanilla = vanillaJar();
        CheckAssets.Report r = CheckAssets.check(res, vanilla);
        assertEquals(List.of(), r.dangling, "a fresh scaffold must not dangle");
        assertEquals(List.of(), r.unused, "everything a scaffold writes is referenced");
        if (vanilla != null) {
            assertEquals(0, r.unchecked.size(), "with the vanilla jar every minecraft: reference resolves: " + r.unchecked);
        } else {
            assertTrue(r.unchecked.size() >= 2, "cube_all and item/generated are unchecked without the jar");
        }
    }

    /** The Loom merged jar off the compile classpath, when the build handed it to us. */
    static Path vanillaJar() {
        String cp = System.getProperty("mcptk.compileClasspath");
        if (cp == null) {
            return null;
        }
        for (String entry : cp.split(java.io.File.pathSeparator)) {
            if (entry.contains("minecraft-merged") && entry.endsWith(".jar")) {
                return Path.of(entry);
            }
        }
        return null;
    }

    private static String text(final List<Scaffold.File> files, final int i) {
        return new String(files.get(i).bytes(), StandardCharsets.UTF_8);
    }
}
