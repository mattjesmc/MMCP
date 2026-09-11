package com.mattmc.mcptoolkit.mcp;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.ToolDef;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** What a surface serves, and what {@code config/mcptoolkit-surfaces.json} can and cannot say. */
class SurfacesTest {

    private static final ToolDef READ = tool("get_surface", Mechanism.OBSERVE);
    private static final ToolDef WRITE = tool("set_blocks", Mechanism.WORLD_EDIT);
    private static final ToolDef COMMAND = tool("run_command", Mechanism.PRIVILEGED);

    // ---- the built-ins -------------------------------------------------------

    @Test
    void fullServesEverything() {
        McpSurface full = builtin("full");
        assertTrue(full.serves(READ));
        assertTrue(full.serves(WRITE));
        assertTrue(full.serves(COMMAND));
    }

    @Test
    void observeIsComputedFromTheMechanismStampSoItCannotGoStale() {
        McpSurface observe = builtin("observe");
        assertTrue(observe.serves(READ));
        assertFalse(observe.serves(WRITE));
        assertFalse(observe.serves(COMMAND));
        // The point of the computed kind: a tool nobody has heard of is still classified correctly.
        assertTrue(observe.serves(tool("a_read_shipped_tomorrow", Mechanism.OBSERVE)));
        assertFalse(observe.serves(tool("an_edit_shipped_tomorrow", Mechanism.WORLD_EDIT)));
    }

    @Test
    void moddingIsAnAllowListAndANewToolIsNotInIt() {
        McpSurface modding = builtin("modding");
        assertTrue(modding.serves(WRITE));
        assertTrue(modding.serves(COMMAND));
        assertFalse(modding.serves(tool("a_read_shipped_tomorrow", Mechanism.OBSERVE)),
            "a keep-list's failure mode is silent and this is it — the surface's javadoc says so");
    }

    // ---- the config file -----------------------------------------------------

    @Test
    void aDeclaredSurfaceNarrowsItsBase() {
        Map<String, McpSurface> all = load("""
            { "surfaces": { "quarry": { "base": "full", "keep": ["set_blocks"],
              "description": "digging only", "instructions": "Only the quarry." } } }
            """);
        McpSurface quarry = all.get("quarry");
        assertNotNull(quarry);
        assertTrue(quarry.serves(WRITE));
        assertFalse(quarry.serves(READ));
        assertEquals("digging only", quarry.description());
        assertEquals("Only the quarry.", quarry.instructions());
    }

    @Test
    void aDeclaredSurfaceCannotWidenTheBaseItNamed() {
        Map<String, McpSurface> all = load("""
            { "surfaces": { "sneaky": { "base": "modding", "keep": ["set_blocks", "bot_mine"] } } }
            """);
        McpSurface sneaky = all.get("sneaky");
        assertTrue(sneaky.serves(WRITE));
        assertFalse(sneaky.serves(tool("bot_mine", Mechanism.EMBODIED)),
            "modding does not serve bot_mine, so a surface built on modding must not either");
    }

    @Test
    void hideIsAppliedAfterKeep() {
        Map<String, McpSurface> all = load("""
            { "surfaces": { "careful": { "base": "full", "hide": ["run_command"] } } }
            """);
        assertTrue(all.get("careful").serves(WRITE));
        assertFalse(all.get("careful").serves(COMMAND));
    }

    @Test
    void anEmptyKeepListMeansEmptyRatherThanEverything() {
        Map<String, McpSurface> all = load("""
            { "surfaces": { "nothing": { "keep": [] } } }
            """);
        assertFalse(all.get("nothing").serves(READ));
        assertFalse(all.get("nothing").serves(WRITE));
    }

    @Test
    void anUnknownBaseIsSkippedRatherThanGuessedAt() {
        Map<String, McpSurface> all = load("""
            { "surfaces": { "broken": { "base": "typo", "keep": ["set_blocks"] } } }
            """);
        assertNull(all.get("broken"));
        assertEquals(3, all.size(), "the built-ins survive a bad declaration");
    }

    @Test
    void aNameThatIsNotAPathSegmentIsSkipped() {
        Map<String, McpSurface> all = load("""
            { "surfaces": { "../escape": { "keep": ["set_blocks"] } } }
            """);
        assertNull(all.get("../escape"));
        assertFalse(Surfaces.isLegalName("../escape"));
        assertFalse(Surfaces.isLegalName("has space"));
        assertTrue(Surfaces.isLegalName("rocketeer_authoring"));
    }

    @Test
    void malformedJsonLeavesTheBuiltInsAlone() {
        Map<String, McpSurface> all = load("{ not json at all ");
        assertEquals(3, all.size());
        assertNotNull(all.get("full"));
    }

    @Test
    void aDeclarationMayReplaceABuiltIn() {
        Map<String, McpSurface> all = load("""
            { "surfaces": { "observe": { "base": "full", "keep": ["run_command"] } } }
            """);
        assertTrue(all.get("observe").serves(COMMAND), "the config file is the operator's word");
    }

    // ---- resolution ----------------------------------------------------------

    @Test
    void theBarePathResolvesToTheConfiguredDefaultAndAnUnknownNameToNothing() {
        Surfaces s = Surfaces.load(null, "observe");
        assertEquals("observe", s.defaultName());
        assertEquals("observe", s.resolve(null).name());
        assertEquals("full", s.resolve("full").name());
        assertNull(s.resolve("nope"));
    }

    @Test
    void aDefaultThatIsNotASurfaceFallsBackLoudlyRatherThanServingNothing() {
        assertEquals("full", Surfaces.load(null, "typo").defaultName());
    }

    // ---- install: the file that is written FOR you ---------------------------

    /**
     * {@link Surfaces#install} is the only method here with two side effects — it writes a file and
     * it sets a static — and the static is shared with every other test in this JVM
     * ({@code McpEndpoint} resolves every request's surface through {@link Surfaces#installed()}).
     * Put it back afterwards.
     */
    @AfterEach
    void restoreTheInstalledSet() {
        Surfaces.install(null, Surfaces.DEFAULT_SURFACE);
    }

    @Test
    void installWritesTheDocumentedDefaultWhenThereIsNoFile(@TempDir final Path dir) throws IOException {
        Path file = dir.resolve("config").resolve(Surfaces.CONFIG_FILE);
        Surfaces installed = Surfaces.install(file, "full");

        assertTrue(Files.exists(file), "the config directory is created too — a first run has neither");
        assertSame(installed, Surfaces.installed());
        // The file is documentation before it is configuration: it is written so somebody who has
        // never read IN_JAR_MCP_DESIGN.md can find out what a surface is by opening it.
        String written = Files.readString(file);
        assertTrue(written.contains("\"surfaces\""), written);
        assertTrue(written.contains("/mcp/<name>"), written);
        for (String builtin : List.of("full", "observe", "modding")) {
            assertTrue(written.contains(builtin), "the built-ins are named in the file: " + builtin);
        }
    }

    @Test
    void theFileInstallWritesIsOneThisParserAccepts(@TempDir final Path dir) throws IOException {
        // The one way the shipped default could be wrong and nobody find out: it is only ever READ
        // on a later boot, in somebody else's game. A trailing comma in that text would mean
        // "built-in surfaces only" and a warning in a log nobody is watching.
        Path file = dir.resolve(Surfaces.CONFIG_FILE);
        Surfaces.install(file, "full");
        Map<String, McpSurface> all = new LinkedHashMap<>(Surfaces.load(null, "full").all());
        Surfaces.readInto(all, Files.readString(file), file.toString());
        assertEquals(3, all.size(), "the default file declares nothing, and must break nothing");
        assertEquals(3, Surfaces.load(file, "full").names().size());
    }

    @Test
    void installNeverOverwritesAFileSomebodyHasWritten(@TempDir final Path dir) throws IOException {
        Path file = dir.resolve(Surfaces.CONFIG_FILE);
        String mine = "{ \"surfaces\": { \"quarry\": { \"base\": \"full\", \"keep\": [\"set_blocks\"] } } }\n";
        Files.writeString(file, mine);
        Surfaces installed = Surfaces.install(file, "quarry");

        assertEquals(mine, Files.readString(file), "the file is the operator's once it exists");
        assertEquals("quarry", installed.defaultName());
        assertTrue(installed.resolve(null).serves(WRITE), "/mcp serves the declared default");
        assertFalse(installed.resolve(null).serves(READ));
    }

    @Test
    void aFileThatCannotBeReadLeavesTheGameServingTheBuiltIns(@TempDir final Path dir) throws IOException {
        // A directory where a file should be: unreadable in a way no platform disagrees about, and
        // the answer must be three built-in surfaces rather than a boot that dies on a config file.
        Path file = dir.resolve(Surfaces.CONFIG_FILE);
        Files.createDirectories(file);
        Surfaces installed = Surfaces.install(file, "full");
        assertEquals(3, installed.names().size());
        assertEquals("full", installed.defaultName());
    }

    // ---- helpers -------------------------------------------------------------

    private static Map<String, McpSurface> load(final String json) {
        Map<String, McpSurface> all = new LinkedHashMap<>(Surfaces.load(null, "full").all());
        Surfaces.readInto(all, json, "test");
        return all;
    }

    private static McpSurface builtin(final String name) {
        McpSurface s = Surfaces.load(null, "full").resolve(name);
        assertNotNull(s, name);
        return s;
    }

    private static ToolDef tool(final String name, final Mechanism mechanism) {
        JsonObject schema = new JsonObject();
        schema.addProperty("type", "object");
        return ToolDef.of(name, name, schema, ExecutionContext.ANY, mechanism,
            (ctx, args) -> new JsonObject());
    }
}
