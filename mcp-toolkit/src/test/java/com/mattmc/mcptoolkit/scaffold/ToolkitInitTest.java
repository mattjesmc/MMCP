package com.mattmc.mcptoolkit.scaffold;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The adopt-a-scratch-directory arbiter (RELEASE_1.md section J4): port/URL agreement, the merge
 * that leaves every other server as found, write-once for the human's files, and every client
 * shape written from one number.
 */
class ToolkitInitTest {

    private static Path fakeServer(final Path dir) throws IOException {
        Path index = dir.resolve("srv").resolve("index.mjs");
        Files.createDirectories(index.getParent());
        Files.writeString(index, "// stub\n");
        return index;
    }

    private static ToolkitInit.Request req(final Path repo, final int port, final Set<String> clients, final Path server, final boolean check) {
        return new ToolkitInit.Request(repo, port, clients, null, null, server, check);
    }

    @Test
    void adoptsARepositoryAndKeepsTheOtherServers(@TempDir final Path dir) throws IOException {
        Path repo = Files.createDirectories(dir.resolve("repo"));
        Path server = fakeServer(dir);
        // The repository already registers Blockbench and OUR server on the WRONG port - the B0 trap.
        Files.writeString(repo.resolve(".mcp.json"), "{\n  \"mcpServers\": {\n"
            + "    \"blockbench\": { \"type\": \"http\", \"url\": \"http://localhost:3000/bb-mcp\" },\n"
            + "    \"mcptoolkit\": { \"command\": \"node\", \"args\": [\"" + server.toString().replace('\\', '/') + "\"], \"env\": { \"MCPTK_URL\": \"http://127.0.0.1:25599\" } }\n"
            + "  }\n}\n");

        ToolkitInit.Report r = ToolkitInit.run(req(repo, 25642, ToolkitInit.CLIENTS, null, false), null);

        assertEquals(ToolkitInit.Fate.CORRECTED, r.files().get(".mcp.json"), r.files().toString());
        assertTrue(r.disagreed(), "the URL disagreed with mcmod.port and the run says so");
        JsonObject mcp = JsonParser.parseString(Files.readString(repo.resolve(".mcp.json"))).getAsJsonObject().getAsJsonObject("mcpServers");
        assertTrue(mcp.has("blockbench"), "the other server is written back as found");
        assertEquals("http://localhost:3000/bb-mcp", mcp.getAsJsonObject("blockbench").get("url").getAsString());
        assertEquals("http://127.0.0.1:25642", mcp.getAsJsonObject("mcptoolkit").getAsJsonObject("env").get("MCPTK_URL").getAsString());
        assertTrue(mcp.getAsJsonObject("mcptoolkit").getAsJsonArray("args").get(0).getAsString().endsWith("index.mjs"),
            "the server the file already named is kept, not replaced by an extraction");
        assertTrue(r.notes().stream().anyMatch(n -> n.contains("keeping the one .mcp.json already names")), r.notes().toString());

        // Every other client shape, from the same number.
        for (String f : new String[] {".cursor/mcp.json", ".gemini/settings.json", ".vscode/mcp.json", ".codex/config.toml"}) {
            assertEquals(ToolkitInit.Fate.WRITTEN, r.files().get(f), f + ": " + r.files());
            assertTrue(Files.readString(repo.resolve(f)).contains("http://127.0.0.1:25642"), f);
        }
        JsonObject vs = JsonParser.parseString(Files.readString(repo.resolve(".vscode/mcp.json"))).getAsJsonObject();
        assertEquals("stdio", vs.getAsJsonObject("servers").getAsJsonObject("mcptoolkit").get("type").getAsString());
        String toml = Files.readString(repo.resolve(".codex/config.toml"));
        assertTrue(toml.contains("[mcp_servers.mcptoolkit]") && toml.contains("command = \"node\""), toml);

        // The charter, the loop file, the Claude extras - written once.
        assertEquals(ToolkitInit.Fate.WRITTEN, r.files().get("AGENTS.md"));
        String agents = Files.readString(repo.resolve("AGENTS.md"), StandardCharsets.UTF_8);
        assertTrue(agents.startsWith("# Agent session charter"), agents.substring(0, 60));
        assertFalse(agents.contains("written to be\npasted"), "the charter's own preamble is stripped");
        assertTrue(agents.contains("mechanism: observe"), "the charter body is the session charter");
        assertEquals("@AGENTS.md\n", Files.readString(repo.resolve("CLAUDE.md")));
        assertTrue(Files.readString(repo.resolve(".claude/settings.json")).contains("mcp__mcptoolkit__*"));
        String loop = Files.readString(repo.resolve(".mcptoolkit/loop.json"));
        assertTrue(loop.contains("checkAssets"), loop);
        JsonParser.parseString(loop);

        // A second run changes nothing and says so; the human's files are never rewritten.
        Files.writeString(repo.resolve("AGENTS.md"), "# mine\n");
        Files.writeString(repo.resolve("CLAUDE.md"), "# my notes, no import\n");
        ToolkitInit.Report again = ToolkitInit.run(req(repo, 25642, ToolkitInit.CLIENTS, null, false), null);
        assertEquals(ToolkitInit.Fate.UNCHANGED, again.files().get(".mcp.json"), again.files().toString());
        assertEquals(ToolkitInit.Fate.UNCHANGED, again.files().get(".vscode/mcp.json"));
        assertEquals(ToolkitInit.Fate.PRESENT, again.files().get(".codex/config.toml"));
        assertEquals(ToolkitInit.Fate.PRESENT, again.files().get("AGENTS.md"));
        assertEquals("# mine\n", Files.readString(repo.resolve("AGENTS.md")));
        assertFalse(again.disagreed());
        assertTrue(again.yours().stream().anyMatch(y -> y.contains("@AGENTS.md")), "a CLAUDE.md without the import is named as still yours: " + again.yours());
    }

    @Test
    void checkModeWritesNothingAndExitsOnDisagreement(@TempDir final Path dir) throws IOException {
        Path repo = Files.createDirectories(dir.resolve("repo"));
        Path server = fakeServer(dir);
        Files.writeString(repo.resolve(".mcp.json"), "{ \"mcpServers\": { \"mcptoolkit\": { \"command\": \"node\", \"args\": [\""
            + server.toString().replace('\\', '/') + "\"], \"env\": { \"MCPTK_URL\": \"http://127.0.0.1:25599\" } } } }\n");
        String before = Files.readString(repo.resolve(".mcp.json"));
        ToolkitInit.Report r = ToolkitInit.run(req(repo, 25642, Set.of("claude"), null, true), null);
        assertEquals(ToolkitInit.Fate.WOULD_CORRECT, r.files().get(".mcp.json"), r.files().toString());
        assertEquals(ToolkitInit.Fate.WOULD_WRITE, r.files().get("AGENTS.md"));
        assertTrue(r.disagreed());
        assertEquals(before, Files.readString(repo.resolve(".mcp.json")), "check mode writes nothing");
        assertFalse(Files.exists(repo.resolve("AGENTS.md")));
        // Agreed and complete: nothing to do.
        ToolkitInit.run(req(repo, 25642, Set.of("claude"), null, false), null);
        ToolkitInit.Report ok = ToolkitInit.run(req(repo, 25642, Set.of("claude"), null, true), null);
        assertFalse(ok.disagreed(), ok.files().toString());
    }

    @Test
    void aFreshRepositoryGetsAServerFromTheJarOrANamedOne(@TempDir final Path dir) throws IOException {
        Path repo = Files.createDirectories(dir.resolve("repo"));
        Path server = fakeServer(dir);
        // With --server: registered as given, nothing extracted.
        ToolkitInit.Report r = ToolkitInit.run(req(repo, 25650, Set.of("claude"), server, false), null);
        assertEquals(ToolkitInit.Fate.WRITTEN, r.files().get(".mcp.json"));
        assertFalse(Files.exists(repo.resolve(".mcptoolkit/mcp-server")), "a named server is not extracted over");
        assertFalse(r.disagreed(), "a fresh registration is not a correction");
        // Without one and without a jar (this is a classes directory, not a jar): an honest refusal.
        Path repo2 = Files.createDirectories(dir.resolve("repo2"));
        IOException e = org.junit.jupiter.api.Assertions.assertThrows(IOException.class,
            () -> ToolkitInit.run(req(repo2, 25650, Set.of("claude"), null, false), null));
        assertTrue(e.getMessage().contains("--jar") || e.getMessage().contains("mcp-server-dist"), e.getMessage());
    }
}
