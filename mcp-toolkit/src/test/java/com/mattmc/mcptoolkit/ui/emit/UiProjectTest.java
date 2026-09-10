package com.mattmc.mcptoolkit.ui.emit;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The emitter's arguments, derived rather than typed (SCREEN_AUTHORING_DESIGN.md section 7.1).
 *
 * <p>What is actually at stake: {@code ui_doc op:"generate"} and {@code gradlew generateUi} run the
 * SAME emitter, and if they disagreed about the package they would write two copies of every class
 * into two places, one of which nothing registers. They cannot disagree if neither of them decides -
 * so the mod comes from the document's own path and the package comes from the one
 * {@code gradle.properties} key the convention plugin reads. These cases pin that derivation.
 */
class UiProjectTest {

    /** A project the way a mod's checkout looks, with one document in it. */
    private static Path project(final Path root, final String modId, final String properties) throws IOException {
        Files.writeString(root.resolve("build.gradle"), "// a project\n");
        if (properties != null) {
            Files.writeString(root.resolve("gradle.properties"), properties);
        }
        Files.createDirectories(root.resolve("src/main/java"));
        Path ui = root.resolve("src/main/resources/assets/" + modId + "/ui");
        Files.createDirectories(ui);
        Path doc = ui.resolve("thing.ui.json");
        Files.writeString(doc, "{\"format\":1,\"title\":\"t\",\"width\":176,\"height\":166,\"elements\":[]}");
        return doc;
    }

    @Test
    void thePathStatesTheModAndTheProject(@TempDir final Path root) throws Exception {
        Path doc = project(root, "probeui", "mcmod.ui.package=com.example.probeui\n");
        UiProject p = UiProject.of(doc);
        assertEquals("probeui", p.modId(), "the mod is the directory under assets");
        assertEquals("com.example.probeui", p.basePackage());
        assertEquals(doc.getParent(), p.docs());
        assertEquals(root.resolve("src/main/java"), p.common());
        assertEquals(root, p.root(), "the project is the nearest ancestor with a build script");
    }

    @Test
    void clientCodeFollowsWhetherTheModSplitsItsSourceSets(@TempDir final Path root) throws Exception {
        Path doc = project(root, "probeui", "mcmod.ui.package=com.example.probeui\n");
        assertEquals(root.resolve("src/main/java"), UiProject.of(doc).client(),
            "a mod that does not split keeps everything in main");
        Files.createDirectories(root.resolve("src/client/java"));
        assertEquals(root.resolve("src/client/java"), UiProject.of(doc).client(),
            "Loom's split source sets put client code in src/client/java, and the plugin decides this"
                + " on the same test");
    }

    @Test
    void aProjectThatNeverOptedInIsRefusedByTheKeyItWouldSet(@TempDir final Path root) throws Exception {
        Path doc = project(root, "probeui", "org.gradle.parallel=true\n");
        IOException e = assertThrows(IOException.class, () -> UiProject.of(doc));
        assertTrue(e.getMessage().contains(UiProject.PACKAGE_KEY),
            "the refusal must name the key to set, or it is not actionable: " + e.getMessage());
        assertTrue(e.getMessage().contains("gradle.properties"), e.getMessage());
    }

    @Test
    void aDocumentOutsideAssetsHasNoModToGenerateFor(@TempDir final Path root) throws Exception {
        Files.createDirectories(root.resolve("ui"));
        Path stray = root.resolve("ui/thing.ui.json");
        Files.writeString(stray, "{}");
        IOException e = assertThrows(IOException.class, () -> UiProject.of(stray));
        assertTrue(e.getMessage().contains("assets"), e.getMessage());
    }

    /**
     * The end-to-end claim, run rather than asserted about: derive, generate, and then find drift
     * after the document changes. This is {@code checkUi}'s staleness guarantee, proved without a
     * build.
     */
    @Test
    void generateThenCheckReportsDriftAfterTheDocumentChanges(@TempDir final Path root) throws Exception {
        Path doc = project(root, "probeui", "mcmod.ui.package=com.example.probeui\n");
        Files.writeString(doc, "{\"format\":1,\"title\":\"t\",\"width\":176,\"height\":166,"
            + "\"actions\":[\"go\"],\"elements\":["
            + "{\"kind\":\"button\",\"id\":\"go\",\"x\":8,\"y\":8,\"w\":50,\"text\":\"Go\",\"action\":\"go\"}]}");
        UiProject p = UiProject.of(doc);
        UiGenerate.Report first = p.run(Target.FABRIC, false);
        assertTrue(first.problems().isEmpty(), first.problems().toString());
        assertTrue(first.files().values().stream().anyMatch(f -> f == UiGenerate.Fate.WRITTEN),
            "the first run writes the machine files: " + first.files());
        assertTrue(p.run(Target.FABRIC, true).drifted() == false, "a second check right after finds nothing");

        Files.writeString(doc, "{\"format\":1,\"title\":\"t\",\"width\":176,\"height\":166,"
            + "\"actions\":[\"go\"],\"elements\":["
            + "{\"kind\":\"button\",\"id\":\"go\",\"x\":9,\"y\":8,\"w\":50,\"text\":\"Go\",\"action\":\"go\"}]}");
        assertTrue(p.run(Target.FABRIC, true).drifted(),
            "one pixel in the document must make the checked-in code stale");
    }
}
