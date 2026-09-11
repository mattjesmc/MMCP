package com.mattmc.mcptoolkit;

import com.mattmc.mcptoolkit.platform.LoaderPlatform;
import com.mattmc.mcptoolkit.platform.Platform;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@code config/mcptoolkit.properties} — what each key means, what an absent one means, and whether
 * the commented file the toolkit writes for you says what this parser reads.
 *
 * <p>The class had no test until 0.146.0, on the reasoning that it resolves its path through
 * {@link Platform} and so needs a mod loader. It does not: {@link Platform#install} exists for
 * exactly this, and a stub that answers two of the interface's questions is enough. That matters
 * more than the coverage number, because the pairing this file checks — the DEFAULTS a missing key
 * takes and the VALUES the shipped default file states — is one nobody can check by reading, and its
 * failure is a key that silently means the opposite of what the comment above it promises.
 *
 * <p>Ordering note: {@link Platform#install} is one-shot per JVM by design (a platform that changed
 * mid-run would leave earlier answers stale). The stub below therefore reads a MUTABLE directory, so
 * every case here can have its own config file without a second install.
 */
class BridgeConfigTest {

    private static volatile Path configDir = Path.of("nowhere");
    private static volatile boolean development = false;

    @BeforeEach
    void installTheStubPlatform(@TempDir final Path dir) {
        configDir = dir;
        development = false;
        Platform.install(new StubPlatform());
    }

    private static Path write(final String contents) throws IOException {
        Path file = configDir.resolve("mcptoolkit.properties");
        Files.writeString(file, contents);
        return file;
    }

    // ---- the two keys 0.146.0 added ------------------------------------------

    @Test
    void aFileWrittenBeforeThisVersionInheritsBothMcpDefaults() throws IOException {
        // The compatibility claim in load()'s own comment, and the one an existing install meets:
        // somebody's config file has had `enabled` and `port` in it for months and neither mcp key.
        write("enabled=true\nport=25611\n");
        BridgeConfig cfg = BridgeConfig.load();
        assertEquals(25611, cfg.port());
        assertTrue(cfg.mcpEnabled(), "the new door is on with the bridge — same port, same authority");
        assertEquals("full", cfg.mcpSurface());
    }

    @Test
    void mcpEnabledFalseTurnsTheNewDoorOffWithoutTouchingTheBridge() throws IOException {
        write("enabled=true\nport=25611\nmcp.enabled=false\n");
        BridgeConfig cfg = BridgeConfig.load();
        assertTrue(cfg.enabled(), "the private API is a separate decision and stays on");
        assertFalse(cfg.mcpEnabled());
    }

    @Test
    void onlyTheWordFalseTurnsItOff() throws IOException {
        write("mcp.enabled=FALSE\n");
        assertFalse(BridgeConfig.load().mcpEnabled(), "case is not the operator's problem");
        write("mcp.enabled= false \n");
        assertFalse(BridgeConfig.load().mcpEnabled(), "nor is a stray space");
        write("mcp.enabled=no\n");
        assertTrue(BridgeConfig.load().mcpEnabled(),
            "anything else is on: a door that turned itself off on a typo would be the worse failure");
    }

    @Test
    void theSurfaceIsTakenVerbatimAndAnEmptyOneIsNotASurface() throws IOException {
        write("mcp.surface=observe\n");
        assertEquals("observe", BridgeConfig.load().mcpSurface());
        write("mcp.surface=  rocketeer_authoring  \n");
        assertEquals("rocketeer_authoring", BridgeConfig.load().mcpSurface(),
            "a name is not validated here — Surfaces does that, and says so when it falls back");
        write("mcp.surface=\n");
        assertEquals("full", BridgeConfig.load().mcpSurface(),
            "an empty value is a key somebody cleared, not a request to serve nothing");
    }

    // ---- the rest of the file ------------------------------------------------

    @Test
    void noFileAtAllMeansEveryDefaultAndTheEnvironmentsPort() {
        assertEquals(BridgeConfig.PRODUCTION_DEFAULT_PORT, BridgeConfig.load().port());
        development = true;
        BridgeConfig dev = BridgeConfig.load();
        assertEquals(BridgeConfig.DEV_DEFAULT_PORT, dev.port());
        assertTrue(dev.enabled());
        assertTrue(dev.mcpEnabled());
        assertEquals("full", dev.mcpSurface());
    }

    @Test
    void enabledFalseTurnsTheWholeBridgeOff() throws IOException {
        write("enabled=false\nport=25611\n");
        assertFalse(BridgeConfig.load().enabled());
    }

    @Test
    void aPortThatIsNotANumberFallsBackToTheEnvironmentsRatherThanFailingTheBoot() throws IOException {
        write("port=twenty-five-six-hundred\n");
        assertEquals(BridgeConfig.PRODUCTION_DEFAULT_PORT, BridgeConfig.load().port());
    }

    // ---- the gate: this file, and the JVM arg that overrules it --------------

    @Test
    void withNoJvmArgTheFileDecides() throws IOException {
        write("mcp.enabled=true\n");
        assertTrue(BridgeConfig.load().mcpEnabledWith(null));
        write("mcp.enabled=false\n");
        assertFalse(BridgeConfig.load().mcpEnabledWith(null));
    }

    @Test
    void theJvmArgOverrulesTheFileInBothDirections() throws IOException {
        write("mcp.enabled=false\n");
        assertTrue(BridgeConfig.load().mcpEnabledWith("true"),
            "-Dmcptoolkit.mcp=true turns the door on for one run without editing anybody's config");
        write("mcp.enabled=true\n");
        assertFalse(BridgeConfig.load().mcpEnabledWith("false"));
        assertFalse(BridgeConfig.load().mcpEnabledWith(" FALSE "));
    }

    @Test
    void aValueThatIsNotFalseLeavesTheDoorOpen() throws IOException {
        // Deliberately asymmetric. A door that closed on a typo would present as a connection
        // refused with a live game behind it and nothing anywhere saying why; a door that opens when
        // you did not mean it to is a thing you can see.
        write("mcp.enabled=true\n");
        assertTrue(BridgeConfig.load().mcpEnabledWith("no"));
        assertTrue(BridgeConfig.load().mcpEnabledWith("0"));
        assertTrue(BridgeConfig.load().mcpEnabledWith(""), "-Dmcptoolkit.mcp= is set, and is not false");
    }

    // ---- the file the toolkit writes for you ---------------------------------

    @Test
    void theDefaultFileStatesWhatThisParserThenReadsBackOutOfIt() throws IOException {
        // The file is a commented document, so its keys are separated from the code that reads them
        // by sixty lines of prose. This is the round trip that keeps the prose honest: write it,
        // read it, and get the port it was written with and the defaults its comments promise.
        BridgeConfig.ensureDefaultFile(25611);
        BridgeConfig cfg = BridgeConfig.load();
        assertEquals(25611, cfg.port(), "the EFFECTIVE port is written, so a later hand-run lands here");
        assertTrue(cfg.enabled());
        assertTrue(cfg.mcpEnabled());
        assertEquals("full", cfg.mcpSurface());

        String written = Files.readString(configDir.resolve("mcptoolkit.properties"));
        assertTrue(written.contains("/mcp"), "the URL is in the file, which is the whole feature");
        assertTrue(written.contains("mcp.surface=full"), written);
    }

    @Test
    void theDefaultFileIsNeverWrittenOverSomebodysOwn() throws IOException {
        String mine = "enabled=true\nport=25999\nmcp.enabled=false\n";
        write(mine);
        BridgeConfig.ensureDefaultFile(25611);
        assertEquals(mine, Files.readString(configDir.resolve("mcptoolkit.properties")),
            "this is documentation, not state — it never overwrites");
        assertEquals(25999, BridgeConfig.load().port());
    }

    // ---- the stub ------------------------------------------------------------

    /**
     * Two real answers and eleven refusals. Every method that throws is one {@link BridgeConfig}
     * must not be reaching for: if one of them ever starts being called, this test says so by
     * failing rather than by quietly answering something plausible.
     */
    private static final class StubPlatform implements LoaderPlatform {
        @Override public Path configDir() {
            return configDir;
        }

        @Override public boolean isDevelopment() {
            return development;
        }

        @Override public String loaderName() {
            throw new UnsupportedOperationException();
        }

        @Override public Path gameDir() {
            throw new UnsupportedOperationException();
        }

        @Override public boolean isDedicatedServer() {
            throw new UnsupportedOperationException();
        }

        @Override public Optional<String> modVersion(final String modId) {
            throw new UnsupportedOperationException();
        }

        @Override public List<Path> modRoots(final String modId) {
            throw new UnsupportedOperationException();
        }

        @Override public Optional<Path> findModResource(final String modId, final String path) {
            throw new UnsupportedOperationException();
        }

        @Override public List<LoadedMod> loadedMods() {
            throw new UnsupportedOperationException();
        }

        @Override public List<Extension> extensions() {
            throw new UnsupportedOperationException();
        }

        @Override public boolean needsOwnAssetPack() {
            throw new UnsupportedOperationException();
        }

        @Override public boolean canSendCustomPayloads() {
            throw new UnsupportedOperationException();
        }

        @Override public boolean dispatchesCustomPayloads() {
            throw new UnsupportedOperationException();
        }
    }
}
