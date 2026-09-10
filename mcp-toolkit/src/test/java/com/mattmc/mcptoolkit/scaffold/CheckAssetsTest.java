package com.mattmc.mcptoolkit.scaffold;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The checker's arbiter with its built-in falsifier (RELEASE_1.md section J2): a fixture tree with
 * ONE of each defect, asserted by name, and the same tree with the defects repaired asserted clean.
 * A checker that always finds something is as useless as one that never does.
 */
class CheckAssetsTest {

    private static void write(final Path root, final String rel, final String text) throws IOException {
        Path p = root.resolve(rel);
        Files.createDirectories(p.getParent());
        Files.writeString(p, text, StandardCharsets.UTF_8);
    }

    private static void png(final Path root, final String rel) throws IOException {
        Path p = root.resolve(rel);
        Files.createDirectories(p.getParent());
        Files.write(p, Scaffold.placeholderTexture(rel));
    }

    /** A mod with one good block, one good item, and one defect of each class. */
    private static void fixture(final Path res, final boolean broken) throws IOException {
        // good block: ore
        write(res, "assets/fx/blockstates/ore.json", "{\"variants\":{\"\":{\"model\":\"fx:block/ore\"}}}");
        write(res, "assets/fx/models/block/ore.json", "{\"parent\":\"minecraft:block/cube_all\",\"textures\":{\"all\":\"fx:block/ore\"}}");
        write(res, "assets/fx/models/item/ore.json", "{\"parent\":\"fx:block/ore\"}");
        write(res, "assets/fx/items/ore.json", "{\"model\":{\"type\":\"minecraft:model\",\"model\":\"fx:item/ore\"}}");
        png(res, "assets/fx/textures/block/ore.png");
        write(res, "data/fx/loot_table/blocks/ore.json", "{\"type\":\"minecraft:block\",\"pools\":[{\"rolls\":1,\"entries\":[{\"type\":\"minecraft:item\",\"name\":\"fx:ore\"}]}]}");
        // good item: gem, with a recipe from the ore and a tag
        write(res, "assets/fx/models/item/gem.json", "{\"parent\":\"minecraft:item/generated\",\"textures\":{\"layer0\":\"fx:item/gem\"}}");
        write(res, "assets/fx/items/gem.json", "{\"model\":{\"type\":\"minecraft:model\",\"model\":\"fx:item/gem\"}}");
        png(res, "assets/fx/textures/item/gem.png");
        write(res, "data/fx/recipe/gem.json", "{\"type\":\"minecraft:smelting\",\"ingredient\":\"fx:ore\",\"result\":{\"id\":\"fx:gem\"}}");
        write(res, "data/minecraft/tags/block/mineable/pickaxe.json", "{\"values\":[\"fx:ore\"]}");
        write(res, "data/fx/tags/item/gems.json", "{\"values\":[\"fx:gem\",\"#c:gems\"]}");
        String lang = "{\"block.fx.ore\":\"Ore\",\"item.fx.gem\":\"Gem\"" + (broken ? "" : ",\"block.fx.lamp\":\"Lamp\"") + "}";
        write(res, "assets/fx/lang/en_us.json", lang);
        if (!broken) {
            return;
        }
        // DEFECT 1 blockstate -> missing model.        DEFECT 2 model -> missing texture.
        write(res, "assets/fx/blockstates/lamp.json", "{\"variants\":{\"\":{\"model\":\"fx:block/lamp_on\"}}}");
        write(res, "assets/fx/models/block/lamp.json", "{\"parent\":\"minecraft:block/cube_all\",\"textures\":{\"all\":\"fx:block/lamp_lit\"}}");
        // DEFECT 3 item definition -> missing model.
        write(res, "assets/fx/items/lamp.json", "{\"model\":{\"type\":\"minecraft:model\",\"model\":\"fx:item/lamp\"}}");
        // DEFECT 4 loot table -> item nothing defines.   DEFECT 5 (warn) the lamp has no loot table.
        write(res, "data/fx/loot_table/chests/prize.json", "{\"type\":\"minecraft:chest\",\"pools\":[{\"rolls\":1,\"entries\":[{\"type\":\"minecraft:item\",\"name\":\"fx:crown\"}]}]}");
        // DEFECT 6 tag -> block nothing defines.
        write(res, "data/minecraft/tags/block/mineable/axe.json", "{\"values\":[\"fx:plank\"]}");
        // DEFECT 7 (lang) block.fx.lamp missing - the lang file above omits it when broken.
        // DEFECT 8 (unused) a texture nothing names, and a model nothing names.
        png(res, "assets/fx/textures/block/forgotten.png");
        write(res, "assets/fx/models/block/orphan.json", "{\"parent\":\"minecraft:block/cube_all\",\"textures\":{\"all\":\"fx:block/ore\"}}");
        // DEFECT 9 unparseable JSON.
        write(res, "data/fx/recipe/broken.json", "{\"type\": ");
    }

    @Test
    void findsOneOfEachDefectByName(@TempDir final Path dir) throws IOException {
        fixture(dir, true);
        CheckAssets.Report r = CheckAssets.check(dir, List.of());
        List<String> dangling = r.dangling.stream().map(d -> d.kind() + " " + d.target()).toList();
        assertTrue(dangling.contains("model fx:block/lamp_on"), dangling.toString());
        assertTrue(dangling.contains("texture fx:block/lamp_lit"), dangling.toString());
        assertTrue(dangling.contains("model fx:item/lamp"), dangling.toString());
        assertTrue(dangling.contains("item fx:crown"), dangling.toString());
        assertTrue(dangling.contains("block fx:plank"), dangling.toString());
        assertTrue(dangling.contains("lang block.fx.lamp"), dangling.toString());
        assertTrue(dangling.stream().anyMatch(d -> d.startsWith("json unparseable")), dangling.toString());
        assertEquals(7, r.dangling.size(), "exactly the seven planted, nothing invented: " + dangling);
        assertTrue(r.warnings.stream().anyMatch(w -> w.contains("no loot table for fx:lamp")), r.warnings.toString());
        assertFalse(r.warnings.stream().anyMatch(w -> w.contains("fx:ore")), "the ore HAS a loot table");
        // The lamp's own block model is unreferenced too: its blockstate names lamp_on, not lamp.
        assertEquals(List.of("texture fx:block/forgotten", "model fx:block/lamp", "model fx:block/orphan"), r.unused);
        // Unchecked: minecraft: without a jar, and the c: tag.
        assertTrue(r.unchecked.stream().anyMatch(u -> u.target().equals("minecraft:block/cube_all")), r.unchecked.toString());
        assertTrue(r.unchecked.stream().anyMatch(u -> u.target().equals("c:gems")), r.unchecked.toString());
        assertTrue(r.failed());

        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        CheckAssets.print(r, dir, false, new PrintStream(bos, true, StandardCharsets.UTF_8));
        String[] lines = bos.toString(StandardCharsets.UTF_8).trim().split("\\r?\\n");
        String last = lines[lines.length - 1];
        assertTrue(last.startsWith("{") && last.contains("\"problems\":7"), "the last line is the loop-check JSON: " + last);
    }

    @Test
    void theRepairedTreeIsClean(@TempDir final Path dir) throws IOException {
        fixture(dir, false);
        CheckAssets.Report r = CheckAssets.check(dir, List.of());
        assertEquals(List.of(), r.dangling);
        assertEquals(List.of(), r.unused);
        assertEquals(List.of(), r.warnings);
        assertFalse(r.failed());
        // The same tree against the vanilla jar, when the build handed us one: cube_all and
        // item/generated resolve, and only the c: tag stays unchecked.
        Path vanilla = ScaffoldTest.vanillaJar();
        if (vanilla != null) {
            CheckAssets.Report v = CheckAssets.check(dir, vanilla);
            assertEquals(List.of(), v.dangling, v.dangling.toString());
            assertEquals(1, v.unchecked.size(), v.unchecked.toString());
            assertEquals("c:gems", v.unchecked.get(0).target());
        }
    }

    @Test
    void aVanillaReferenceThatDoesNotExistDanglesWithTheJar(@TempDir final Path dir) throws IOException {
        Path vanilla = ScaffoldTest.vanillaJar();
        if (vanilla == null) {
            return; // no jar on this run; the claim is only checkable with one
        }
        write(dir, "assets/fx/blockstates/x.json", "{\"variants\":{\"\":{\"model\":\"minecraft:block/no_such_model\"}}}");
        write(dir, "assets/fx/lang/en_us.json", "{\"block.fx.x\":\"X\"}");
        write(dir, "data/fx/loot_table/blocks/x.json", "{\"type\":\"minecraft:block\",\"pools\":[]}");
        CheckAssets.Report r = CheckAssets.check(dir, vanilla);
        assertEquals(1, r.dangling.size(), r.dangling.toString());
        assertEquals("minecraft:block/no_such_model", r.dangling.get(0).target());
    }
}
