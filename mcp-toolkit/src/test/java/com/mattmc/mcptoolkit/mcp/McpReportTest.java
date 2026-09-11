package com.mattmc.mcptoolkit.mcp;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.ToolDef;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * What {@code /mmcp mcp} prints.
 *
 * <p>Worth testing rather than looking at once, for one reason: the per-surface count is the only
 * check a keep-list gets anywhere in this system. {@code observe} can be falsified against the
 * registry because it is computed; {@code modding} and every declared surface can only be compared
 * to a copy of themselves, so the number a human reads out of this command is the whole verification
 * story for them. A count that is quietly wrong takes the last check with it.
 */
class McpReportTest {

    private static final List<ToolDef> REGISTRY = List.of(
        tool("ping", Mechanism.OBSERVE),
        tool("get_surface", Mechanism.OBSERVE),
        tool("set_blocks", Mechanism.WORLD_EDIT),
        tool("run_command", Mechanism.PRIVILEGED));

    @Test
    void theFirstLineIsTheAddressAndTheSecondIsHowToGiveItToAClient() {
        List<McpReport.Line> lines = report(Surfaces.load(null, "full"));
        assertEquals(McpReport.Kind.URL, lines.get(0).kind());
        assertTrue(lines.get(0).text().startsWith("http://127.0.0.1:25611/mcp"), lines.get(0).text());
        assertTrue(lines.get(0).text().contains("\"full\""), "which surface the bare URL is");
        assertEquals(McpReport.Kind.HINT, lines.get(1).kind());
        assertTrue(lines.get(1).text().contains("claude mcp add --transport http mcptoolkit "
            + "http://127.0.0.1:25611/mcp"), lines.get(1).text());
    }

    @Test
    void everySurfaceIsPrintedWithTheToolsItActuallyServesRightNow() {
        List<McpReport.Line> lines = report(Surfaces.load(null, "full"));
        assertEquals("/mcp/full  4 tool(s)  every tool this game registers", surface(lines, "full"));
        // Two of the four are reads, and observe is computed from the stamp rather than listed.
        assertTrue(surface(lines, "observe").startsWith("/mcp/observe  2 tool(s)"),
            surface(lines, "observe"));
        // modding is a keep-list: it names set_blocks, run_command, ping and get_surface among many
        // that this registry does not hold, and a keep-list serves only what is BOTH.
        assertTrue(surface(lines, "modding").startsWith("/mcp/modding  4 tool(s)"),
            surface(lines, "modding"));
    }

    @Test
    void aTypoInADeclaredSurfaceShowsUpHereAsANumberOneShort(@TempDir final Path dir) throws IOException {
        // The failure this command exists to catch, played out. The author meant set_blocks, and
        // nothing anywhere else will ever mention it: a name that is not a tool is simply never
        // served, and is never complained about.
        Path file = dir.resolve(Surfaces.CONFIG_FILE);
        Files.writeString(file, "{ \"surfaces\": { \"quarry\": "
            + "{ \"keep\": [\"set_block\", \"run_command\"] } } }");
        List<McpReport.Line> lines = McpReport.lines(true, 25611, 25611,
            Surfaces.load(file, "full"), REGISTRY, 0);
        assertTrue(surface(lines, "quarry").startsWith("/mcp/quarry  1 tool(s)"),
            "two names kept, one of them spelt wrong: " + surface(lines, "quarry"));
    }

    @Test
    void theDefaultSurfaceIsTheOneSaidLoudest() {
        List<McpReport.Line> lines = McpReport.lines(true, 25611, 25611,
            Surfaces.load(null, "observe"), REGISTRY, 0);
        assertEquals(McpReport.Kind.SURFACE_DEFAULT, kindOf(lines, "observe"));
        assertEquals(McpReport.Kind.SURFACE, kindOf(lines, "full"));
        assertEquals(McpReport.Kind.SURFACE, kindOf(lines, "modding"));
    }

    @Test
    void theLastLineCountsTheClientsAndSaysSoInWordsWhenThereAreNone() {
        List<McpReport.Line> none = report(Surfaces.load(null, "full"));
        assertEquals(McpReport.Kind.NOTE, none.get(none.size() - 1).kind());
        assertEquals("no client is connected to it right now", none.get(none.size() - 1).text());

        List<McpReport.Line> two = McpReport.lines(true, 25611, 25611,
            Surfaces.load(null, "full"), REGISTRY, 2);
        assertEquals("2 client(s) connected", two.get(two.size() - 1).text());
    }

    @Test
    void aDoorThatIsOffSaysHowItWasTurnedOff() {
        List<McpReport.Line> lines = McpReport.lines(false, 25611, 25611,
            Surfaces.load(null, "full"), REGISTRY, 0);
        assertEquals(1, lines.size(), "no URL, because there is nothing at one");
        assertEquals(McpReport.Kind.OFF, lines.get(0).kind());
        assertTrue(lines.get(0).text().contains("mcp.enabled=false"), lines.get(0).text());
        assertTrue(lines.get(0).text().contains("-Dmcptoolkit.mcp=false"), lines.get(0).text());
    }

    @Test
    void anUnboundBridgeNamesThePortItAskedForRatherThanPrintingAUrlThatIsNotThere() {
        // The commonest real cause: another game in the workspace already holds the number, and the
        // number is the fact that identifies which one.
        List<McpReport.Line> lines = McpReport.lines(true, 0, 25611,
            Surfaces.load(null, "full"), REGISTRY, 0);
        assertEquals(1, lines.size());
        assertEquals(McpReport.Kind.UNBOUND, lines.get(0).kind());
        assertTrue(lines.get(0).text().contains("25611"), lines.get(0).text());
        assertFalse(lines.get(0).text().contains("http://"), "there is no address to hand anybody");
    }

    // ---- helpers -------------------------------------------------------------

    private static List<McpReport.Line> report(final Surfaces surfaces) {
        return McpReport.lines(true, 25611, 25611, surfaces, REGISTRY, 0);
    }

    private static String surface(final List<McpReport.Line> lines, final String name) {
        return lines.stream().map(McpReport.Line::text)
            .filter(t -> t.startsWith("/mcp/" + name + " "))
            .findFirst().orElseThrow(() -> new AssertionError("no line for surface " + name));
    }

    private static McpReport.Kind kindOf(final List<McpReport.Line> lines, final String name) {
        return lines.stream().filter(l -> l.text().startsWith("/mcp/" + name + " "))
            .findFirst().orElseThrow(() -> new AssertionError("no line for surface " + name)).kind();
    }

    private static ToolDef tool(final String name, final Mechanism mechanism) {
        JsonObject schema = new JsonObject();
        schema.addProperty("type", "object");
        return ToolDef.of(name, name, schema, ExecutionContext.ANY, mechanism,
            (ctx, args) -> new JsonObject());
    }
}
