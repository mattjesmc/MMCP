package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.platform.LoaderPlatform.LoadedMod;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@code ping.build} as a pure function (RELEASE_1.md section K1): which origins are LISTED (a
 * directory, a jar in {@code mods/}), which only ride the hash (a jar anywhere else - the loader's
 * libraries), the {@code classes} sibling a Fabric dev origin does not name, and {@code stale} when
 * an origin is newer than the JVM. No loader here; the live half is
 * {@code probes/headless-surface.test.mjs}.
 */
class BuildIdentityTest {

    private static Path touch(final Path p, final Instant at) throws IOException {
        Files.createDirectories(p.getParent());
        Files.writeString(p, "x");
        Files.setLastModifiedTime(p, FileTime.from(at));
        return p;
    }

    @Test
    void listsOnlyBuildableOriginsAndHashesAll(@TempDir final Path dir) throws IOException {
        Instant started = Instant.parse("2026-09-06T10:00:00Z");
        Instant older = started.minusSeconds(3600);
        Path game = dir.resolve("run");
        Path modJar = touch(game.resolve("mods").resolve("armorpieces-0.4.0.jar"), older);
        Path libJar = touch(dir.resolve("caches").resolve("fabric-api-0.100.0.jar"), older);
        Path resources = dir.resolve("build").resolve("resources").resolve("main");
        touch(resources.resolve("fabric.mod.json"), older);
        Path classes = dir.resolve("build").resolve("classes").resolve("java").resolve("main");
        touch(classes.resolve("A.class"), older);
        Files.setLastModifiedTime(resources, FileTime.from(older));
        Files.setLastModifiedTime(classes, FileTime.from(older));

        List<LoadedMod> mods = List.of(
            new LoadedMod("mcptoolkit", "0.129.0", List.of(resources)),
            new LoadedMod("armorpieces", "0.4.0", List.of(modJar)),
            new LoadedMod("fabric-api", "0.100.0", List.of(libJar)),
            new LoadedMod("minecraft", "26.2", List.of()),
            // The JDK is a DIRECTORY origin on both loaders; a pseudo-mod is never buildable.
            new LoadedMod("java", "25", List.of(dir.resolve("jdk"))));
        Files.createDirectories(dir.resolve("jdk"));

        JsonObject r = BuildIdentity.report(mods, game, started);
        assertEquals(started.toString(), r.get("started_at").getAsString());
        assertEquals(12, r.get("mods_hash").getAsString().length());
        assertFalse(r.get("stale").getAsBoolean());

        JsonArray list = r.getAsJsonArray("mods");
        assertEquals(2, list.size(), "a library jar and the pseudo-mods are hashed, not listed: " + list);
        JsonObject toolkit = list.get(0).getAsJsonObject();
        assertEquals("mcptoolkit", toolkit.get("id").getAsString());
        assertEquals("0.129.0", toolkit.get("version").getAsString());
        JsonArray origins = toolkit.getAsJsonArray("origins");
        assertEquals(2, origins.size(), "the resources origin AND its classes sibling: " + origins);
        assertEquals(classes.toAbsolutePath().normalize().toString(),
            origins.get(1).getAsJsonObject().get("path").getAsString());
        assertEquals(older.toString(), origins.get(0).getAsJsonObject().get("mtime").getAsString());
        JsonObject armor = list.get(1).getAsJsonObject();
        assertEquals(modJar.toAbsolutePath().normalize().toString(),
            armor.getAsJsonArray("origins").get(0).getAsJsonObject().get("path").getAsString());

        // The hash is over EVERY mod, so the library nobody lists still changes it.
        List<LoadedMod> bumped = List.of(mods.get(0), mods.get(1),
            new LoadedMod("fabric-api", "0.101.0", List.of(libJar)), mods.get(3), mods.get(4));
        assertNotEquals(r.get("mods_hash").getAsString(), BuildIdentity.modsHash(bumped));
        assertEquals(r.get("mods_hash").getAsString(), BuildIdentity.modsHash(mods));
    }

    @Test
    void staleWhenAnOriginIsNewerThanTheJvm(@TempDir final Path dir) throws IOException {
        Instant started = Instant.parse("2026-09-06T10:00:00Z");
        Path game = dir.resolve("run");
        Path resources = dir.resolve("build").resolve("resources").resolve("main");
        touch(resources.resolve("fabric.mod.json"), started.minusSeconds(60));
        // A deeper file rebuilt after the JVM started: the directory's own mtime does not move for
        // a rewrite two levels down, which is why the newest FILE is what is read.
        touch(resources.resolve("assets").resolve("m").resolve("lang").resolve("en_us.json"),
            started.plusSeconds(60));
        Files.setLastModifiedTime(resources, FileTime.from(started.minusSeconds(60)));

        JsonObject r = BuildIdentity.report(
            List.of(new LoadedMod("m", "1.0.0", List.of(resources))), game, started);
        assertTrue(r.get("stale").getAsBoolean(), r.toString());
        assertEquals(started.plusSeconds(60).toString(),
            r.getAsJsonArray("mods").get(0).getAsJsonObject().getAsJsonArray("origins")
                .get(0).getAsJsonObject().get("mtime").getAsString());
    }

    @Test
    void classesSiblingOnlyForAResourcesSet() {
        Path resources = Path.of("proj", "build", "resources", "main");
        assertEquals(Path.of("proj", "build", "classes", "java", "main"),
            BuildIdentity.classesSibling(resources));
        assertEquals(null, BuildIdentity.classesSibling(Path.of("proj", "build", "libs")));
    }
}
