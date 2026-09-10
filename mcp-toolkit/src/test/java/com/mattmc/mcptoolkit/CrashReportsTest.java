package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The parse half of the crash fold (RELEASE_1.md section J3), on a report a real game wrote:
 * ArmorPieces' client, 2026-09-03, a {@code NoClassDefFoundError} out of a screen's {@code init}.
 * No loader is present here, so the mod list is empty and attribution can only reach its
 * fallbacks - which is a useful thing to pin on its own: a vanilla frame still says
 * {@code minecraft}, a frame of a mod this JVM never loaded says {@code unresolved} rather than
 * guessing, and neither is the {@code suspect}. The live half (a frame resolving to a mod id
 * through the loader) is {@code probes/crash-summary.test.mjs}.
 */
class CrashReportsTest {

    private static Path fixture(final Path dir, final String name) throws IOException {
        try (InputStream in = CrashReportsTest.class.getResourceAsStream("/crash/" + name)) {
            assertNotNull(in, "missing test resource /crash/" + name);
            Path p = dir.resolve("crash-2026-09-03_23.47.35-client.txt");
            Files.copy(in, p);
            return p;
        }
    }

    @Test
    void frameParsingStripsLoaderAndModulePrefixes() {
        assertEquals("com.mattjesmc.armorpieces.client.screen.AdvancedSmithingScreen.init(AdvancedSmithingScreen.java:213)",
            CrashReports.stripLoaderPrefix("knot//com.mattjesmc.armorpieces.client.screen.AdvancedSmithingScreen.init(AdvancedSmithingScreen.java:213)"));
        assertEquals("java.lang.Thread.run(Thread.java:1474)",
            CrashReports.stripLoaderPrefix("java.base/java.lang.Thread.run(Thread.java:1474)"));
        assertEquals("sun.net.httpserver.ServerImpl$Dispatcher.run(ServerImpl.java:516)",
            CrashReports.stripLoaderPrefix("platform/jdk.httpserver@25.0.3/sun.net.httpserver.ServerImpl$Dispatcher.run(ServerImpl.java:516)"));
        assertEquals("com.mattjesmc.armorpieces.client.screen.AdvancedSmithingScreen",
            CrashReports.classOf("knot//com.mattjesmc.armorpieces.client.screen.AdvancedSmithingScreen.init(AdvancedSmithingScreen.java:213)"));
        assertEquals("java.lang.Thread",
            CrashReports.classOf("java.base@25.0.3/java.lang.Thread.run(Thread.java:1474)"));
    }

    @Test
    void summarisesARealReport(@TempDir final Path dir) throws IOException {
        JsonObject r = CrashReports.summarize(fixture(dir, "armorpieces-noclassdef.txt"));

        assertEquals("Unexpected error", r.get("title").getAsString());
        assertEquals("2026-09-03 23:47:35", r.get("at").getAsString());
        assertTrue(r.get("exception").getAsString().startsWith("java.lang.NoClassDefFoundError: com/mattjesmc"),
            r.get("exception").getAsString());
        assertEquals("Render thread", r.get("thread").getAsString());

        JsonArray frames = r.getAsJsonArray("frames");
        assertEquals(10, frames.size(), "the head trace is capped at ten frames");
        assertEquals(17 - 10, r.get("frames_omitted").getAsInt(), "the report's head trace has 17 frames");
        JsonObject top = frames.get(0).getAsJsonObject();
        assertTrue(top.get("at").getAsString().startsWith("com.mattjesmc.armorpieces"), top.toString());
        assertEquals("unresolved", top.get("mod").getAsString(),
            "a class no jar in THIS JVM provides must be unresolved, not guessed");
        JsonObject vanilla = frames.get(1).getAsJsonObject();
        assertTrue(vanilla.get("at").getAsString().startsWith("net.minecraft.client.gui.screens.Screen.init"));
        assertEquals("minecraft", vanilla.get("mod").getAsString());

        JsonArray causes = r.getAsJsonArray("causes");
        assertEquals(1, causes.size());
        JsonObject cause = causes.get(0).getAsJsonObject();
        assertTrue(cause.get("exception").getAsString().startsWith("java.lang.ClassNotFoundException"));
        assertEquals(4, cause.getAsJsonArray("frames").size(), "cause frames are capped at four");
        assertEquals("java", cause.getAsJsonArray("frames").get(0).getAsJsonObject().get("mod").getAsString());

        JsonObject att = r.getAsJsonObject("attribution");
        assertTrue(att.has("unresolved") && att.get("unresolved").getAsInt() >= 1, att.toString());
        assertTrue(att.has("minecraft") && att.get("minecraft").getAsInt() >= 5, att.toString());
        assertNull(r.get("suspect"), "nothing here is somebody's mod: " + r.get("suspect"));
        assertTrue(r.has("unresolved_means"), "an unresolved frame must be explained beside the table");
        assertFalse(r.has("loader_suspected_mods"), "Fabric wrote no Suspected Mods section in this report");
    }

    @Test
    void carriesALoaderSuspectedModsSectionWhenPresent(@TempDir final Path dir) throws IOException {
        JsonObject r = CrashReports.summarize(fixture(dir, "toolkit-frame.txt"));
        JsonArray suspected = r.getAsJsonArray("loader_suspected_mods");
        assertNotNull(suspected, "the fixture carries a -- Suspected Mods -- section");
        assertEquals(2, suspected.size(), suspected.toString());
        assertTrue(suspected.get(0).getAsString().contains("armorpieces"), suspected.toString());
        // The toolkit's own class resolves here (it is on the test classpath) but no loader claims
        // its directory, so attribution names the location rather than a mod - and a location is
        // not a suspect. Live, the same frame says `mcptoolkit`; the probe asserts that half.
        String who = r.getAsJsonArray("frames").get(1).getAsJsonObject().get("mod").getAsString();
        assertTrue(who.startsWith("?:"), "expected a bare location without a loader, got " + who);
        assertNull(r.get("suspect"));
    }
}
