package com.mattmc.mcptoolkit.ui.emit;

import com.mattmc.mcptoolkit.ui.doc.PartLibrary;
import com.mattmc.mcptoolkit.ui.doc.UiDocument;
import com.mattmc.mcptoolkit.ui.doc.UiParseException;
import com.mattmc.mcptoolkit.ui.doc.UiParser;

import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;

/**
 * The Gradle-task caller of the emitter (SCREEN_AUTHORING_DESIGN.md section 7.1): every
 * {@code *.ui.json} in a directory, compiled into a mod's source tree. No game, no Minecraft on the
 * classpath - only this toolkit's {@code ui.doc} and {@code ui.emit} packages and Gson.
 *
 * <pre>
 *   --mod &lt;id&gt;       the mod's namespace
 *   --package &lt;pkg&gt;  the mod's root package; output lands in .menu and .client under it
 *   --docs &lt;dir&gt;     where the documents are (assets/&lt;mod&gt;/ui)
 *   --common &lt;dir&gt;   the common source root (src/main/java)
 *   --client &lt;dir&gt;   the client source root (src/client/java, or the same as --common)
 *   --target fabric  the loader dialect (default fabric)
 *   --check          write nothing; exit 1 if any machine file differs from what would be written
 *                    or any human stub is missing - the staleness guarantee a build runs
 * </pre>
 *
 * <p>Machine files are overwritten whenever their content changed; human stubs are written only
 * when absent, and never touched again. Exit codes: 0 done, 1 drift (check) or a document with
 * problems, 2 bad arguments.
 */
public final class UiGenerate {
    private UiGenerate() {}

    /** One machine file's fate, for the report and the exit code. */
    public enum Fate { UNCHANGED, WRITTEN, STALE, STUB_WRITTEN, STUB_PRESENT, STUB_MISSING }

    /** The outcome of one run: what happened to every file, and the registration notes per screen. */
    public record Report(Map<Path, Fate> files, Map<String, List<String>> notes, List<String> problems) {
        public boolean drifted() {
            return files.containsValue(Fate.STALE) || files.containsValue(Fate.STUB_MISSING);
        }

        public boolean failed() {
            return !problems.isEmpty();
        }
    }

    public static void main(final String[] args) {
        Map<String, String> opts = new LinkedHashMap<>();
        boolean check = false;
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            if ("--check".equals(a)) {
                check = true;
            } else if (a.startsWith("--") && i + 1 < args.length) {
                opts.put(a.substring(2), args[++i]);
            } else {
                System.err.println("unexpected argument: " + a);
                System.exit(2);
            }
        }
        for (String required : new String[] {"mod", "package", "docs", "common", "client"}) {
            if (!opts.containsKey(required)) {
                System.err.println("missing --" + required + "\nusage: --mod <id> --package <pkg> --docs <dir> --common <dir>"
                    + " --client <dir> [--target fabric] [--check]");
                System.exit(2);
            }
        }
        Target target = Target.forName(opts.getOrDefault("target", "fabric"));
        if (target == null) {
            System.err.println("unknown target '" + opts.get("target") + "'; one of: fabric, neoforge");
            System.exit(2);
        }
        Report r;
        try {
            r = run(opts.get("mod"), opts.get("package"), Path.of(opts.get("docs")), Path.of(opts.get("common")),
                Path.of(opts.get("client")), target, check, System.out);
        } catch (IOException | IllegalArgumentException e) {
            System.err.println(e.getMessage());
            System.exit(2);
            return;
        }
        if (r.failed()) {
            System.exit(1);
        }
        if (check && r.drifted()) {
            System.err.println("\nGenerated screen code is out of date with its documents. Run `gradlew generateUi`"
                + " (or `ui_doc op:\"generate\"` in a live session) and commit the result.");
            System.exit(1);
        }
    }

    /** The whole run, reusable in-process. Prints a line per file to {@code out} when it is not null. */
    public static Report run(final String modId, final String basePackage, final Path docs, final Path common,
                             final Path client, final Target target, final boolean check, final PrintStream out) throws IOException {
        if (!Files.isDirectory(docs)) {
            throw new IllegalArgumentException("no such documents directory: " + docs);
        }
        List<Path> documents = new ArrayList<>();
        try (Stream<Path> s = Files.list(docs)) {
            s.filter(p -> p.getFileName().toString().endsWith(".ui.json")).sorted().forEach(documents::add);
        }
        // assets/<mod>/ui -> the resources root the mod's own parts and generated sheets live under.
        // Derived, not an argument: the documents directory already states it, and one more --flag is
        // one more place for the build and an in-session generate to disagree (UiProject's argument).
        Path resources = docs.getParent() == null || docs.getParent().getParent() == null
            ? null : docs.getParent().getParent().getParent();
        // The mod's own parts first, then the classpath - which in the Gradle task is the toolkit jar,
        // so the seed library resolves with no wiring at all (PartLibrary).
        PartLibrary library = resources == null ? PartLibrary.classpath()
            : PartLibrary.chain(PartLibrary.assets(resources), PartLibrary.classpath());
        Map<Path, Fate> files = new TreeMap<>();
        Map<String, List<String>> notes = new LinkedHashMap<>();
        List<String> problems = new ArrayList<>();
        if (documents.isEmpty() && out != null) {
            out.println("no *.ui.json in " + docs + " - nothing to generate");
        }
        for (Path d : documents) {
            String name = d.getFileName().toString();
            String stem = name.substring(0, name.length() - ".ui.json".length());
            UiDocument doc;
            try {
                doc = UiParser.parse(Files.readString(d, StandardCharsets.UTF_8), library);
            } catch (UiParseException e) {
                problems.add(d + ": " + e.getMessage());
                continue;
            }
            EmitRequest req;
            try {
                req = new EmitRequest(modId, basePackage, stem, target);
            } catch (IllegalArgumentException e) {
                problems.add(d + ": " + e.getMessage());
                continue;
            }
            Emission em = UiEmitter.emit(doc, req);
            notes.put(stem, em.notes());
            for (GeneratedFile f : em.files()) {
                Path root = switch (f.side()) {
                    case COMMON -> common;
                    case CLIENT -> client;
                    case RESOURCES -> resources;
                };
                if (root == null) {
                    problems.add(d + ": cannot place " + f.path() + " - no resources root above " + docs);
                    continue;
                }
                Path dest = root.resolve(f.path());
                if (files.containsKey(dest)) {
                    continue; // the vendored file, already handled for an earlier screen of this mod
                }
                files.put(dest, place(f, dest, check));
            }
        }
        if (out != null) {
            for (Map.Entry<Path, Fate> e : files.entrySet()) {
                out.println(String.format("%-13s %s", e.getValue().name().toLowerCase().replace('_', ' '), e.getKey()));
            }
            for (Map.Entry<String, List<String>> e : notes.entrySet()) {
                out.println("\n" + e.getKey() + ".ui.json - still yours to do:");
                for (String n : e.getValue()) {
                    out.println("  " + n);
                }
            }
            for (String p : problems) {
                out.println("\nPROBLEM " + p);
            }
        }
        return new Report(files, notes, problems);
    }

    private static Fate place(final GeneratedFile f, final Path dest, final boolean check) throws IOException {
        boolean exists = Files.isRegularFile(dest);
        if (!f.isMachine()) {
            if (exists) {
                return Fate.STUB_PRESENT;
            }
            if (check) {
                return Fate.STUB_MISSING;
            }
            write(dest, f);
            return Fate.STUB_WRITTEN;
        }
        if (exists && same(dest, f)) {
            return Fate.UNCHANGED;
        }
        if (check) {
            return Fate.STALE;
        }
        write(dest, f);
        return Fate.WRITTEN;
    }

    /** Source is compared line-ending-agnostically; a generated asset is compared byte for byte. */
    private static boolean same(final Path dest, final GeneratedFile f) throws IOException {
        if (f.isBinary()) {
            return java.util.Arrays.equals(Files.readAllBytes(dest), f.bytes());
        }
        return normalise(Files.readString(dest, StandardCharsets.UTF_8)).equals(normalise(f.content()));
    }

    private static void write(final Path dest, final GeneratedFile f) throws IOException {
        Files.createDirectories(dest.getParent());
        Files.write(dest, f.bytes());
    }

    /** Line endings are git's business, not drift. */
    static String normalise(final String s) {
        return s.replace("\r\n", "\n");
    }
}
