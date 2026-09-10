package com.mattmc.mcptoolkit;

import org.junit.jupiter.api.Test;

import java.io.File;
import java.io.IOException;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * What the jar carries beside the classes, checked against what the source tree has — the arbiter
 * for {@code TODO.md} 1.10 and for the trap that produced it.
 *
 * <p>Both bundles in {@code processResources} are copies out of a sibling directory, and both have
 * failed the same way: something present in the tree was absent from the jar, and nothing said so.
 * {@code mcp-server-dist} is an INCLUDE WHITELIST and its own comment records two modules
 * ({@code ablation/view.mjs}, {@code upstream/blockbench.mjs}) that were missing for versions —
 * every fresh extract died at import time. The Blockbench plugins were in NO jar at all through six
 * plugin versions, because there was no copy rule to forget an entry from.
 *
 * <p>This reads the PROCESSED resources (the classpath, which is what {@code jar} zips), so it
 * answers about the artifact rather than about the build script's text. Two claims, one per bundle,
 * each shaped to the way that bundle can go wrong:
 *
 * <ul>
 *   <li>the plugins are an EQUALITY against the {@code .js} files in {@code blockbench/} — a fourth
 *   plugin the glob somehow misses is a red, and so is a stale copy left behind after one is
 *   deleted;</li>
 *   <li>the shim is a REACHABILITY closure — every module {@code index.mjs} imports, transitively,
 *   is in the dist. An equality would be wrong there (the whitelist excludes the probes and the
 *   ablation harnesses on purpose); what must hold is that a fresh extract can be imported.</li>
 * </ul>
 */
class BundledResourcesTest {

    private static Path resourceRoot(final String name) {
        try {
            var url = BundledResourcesTest.class.getResource("/" + name);
            return url == null ? null : Path.of(url.toURI());
        } catch (URISyntaxException e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    void theJarCarriesEveryBlockbenchPluginAndNothingStale() throws IOException {
        Path dist = resourceRoot("blockbench-dist");
        assertTrue(dist != null && Files.isDirectory(dist),
            "blockbench-dist is not on the processed resources - the plugins are in no jar, TODO.md 1.10");

        Set<String> inTree = new TreeSet<>();
        try (Stream<Path> s = Files.list(Path.of("blockbench"))) {
            s.filter(p -> p.getFileName().toString().endsWith(".js"))
                .forEach(p -> inTree.add(p.getFileName().toString()));
        }
        Set<String> inJar = new TreeSet<>();
        try (Stream<Path> s = Files.list(dist)) {
            s.forEach(p -> inJar.add(p.getFileName().toString()));
        }
        assertEquals(inTree, inJar, "the .js files in blockbench/ and in blockbench-dist/ must be the same set");
        assertTrue(inTree.contains("mcptoolkit_bridge.js"), inTree.toString());
        // The harnesses are not plugins; a jar carrying one would offer it on File > Plugins.
        assertTrue(inJar.stream().noneMatch(n -> n.endsWith(".test.mjs")), inJar.toString());
    }

    @Test
    void everyModuleTheShimImportsIsInTheDist() throws IOException {
        Path dist = resourceRoot("mcp-server-dist");
        assertTrue(dist != null && Files.isDirectory(dist), "mcp-server-dist is not on the processed resources");

        Deque<Path> queue = new ArrayDeque<>();
        Set<Path> seen = new LinkedHashSet<>();
        List<String> missing = new ArrayList<>();
        queue.add(dist.resolve("index.mjs"));

        while (!queue.isEmpty()) {
            Path file = queue.poll().normalize();
            if (!seen.add(file)) {
                continue;
            }
            if (!Files.isRegularFile(file)) {
                missing.add(dist.relativize(file).toString().replace(File.separatorChar, '/'));
                continue;
            }
            for (String spec : relativeImports(Files.readString(file, StandardCharsets.UTF_8))) {
                queue.add(file.getParent().resolve(spec));
            }
        }
        if (!missing.isEmpty()) {
            fail("the shim dist is missing modules it imports - a fresh extract dies at IMPORT time,"
                + " not at use time. Add them to the include whitelist in build.gradle: " + missing);
        }
        assertTrue(seen.size() > 5, "the import walk found almost nothing - suspect the walk, not the dist: " + seen.size());
    }

    /**
     * The relative specifiers an ES module imports. Deliberately not a regex: the pattern for this
     * needs four kinds of escape and is the sort of thing that is wrong in a way nobody reads.
     * A bare specifier (no leading dot) is a node_modules dependency, which {@code npm install}
     * provides and the dist is right not to carry.
     */
    private static List<String> relativeImports(final String src) {
        List<String> out = new ArrayList<>();
        for (String raw : src.lines().toList()) {
            // Single and double quotes are the same thing to this reader.
            String line = raw.replace((char) 39, '"');
            String trimmed = line.trim();
            if (!trimmed.startsWith("import") && !trimmed.startsWith("export")) {
                continue;
            }
            int from = line.indexOf("from");
            if (from < 0) {
                continue;
            }
            int open = line.indexOf('"', from);
            int close = open < 0 ? -1 : line.indexOf('"', open + 1);
            if (close < 0) {
                continue;
            }
            String spec = line.substring(open + 1, close);
            if (spec.startsWith(".")) {
                out.add(spec);
            }
        }
        return out;
    }
}
