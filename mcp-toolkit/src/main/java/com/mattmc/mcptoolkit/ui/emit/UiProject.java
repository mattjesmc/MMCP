package com.mattmc.mcptoolkit.ui.emit;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

/**
 * <b>The emitter's arguments, derived from where a document sits rather than typed.</b>
 *
 * <p>{@link UiGenerate} takes {@code --mod --package --docs --common --client}. The Gradle task
 * fills them from the project (SCREEN_AUTHORING_DESIGN.md section 7.1's third caller); the editor's
 * save and {@code ui_doc op:"generate"} run the SAME emitter in-process and would otherwise have to
 * be told the same five things by hand - and a hand-typed package that disagrees with the build's
 * generates a second copy of every class into a package nothing registers.
 *
 * <p>So they are not typed. A document lives at
 * {@code <project>/src/main/resources/assets/<mod>/ui/<screen>.ui.json}, and that path already
 * states four of the five: the mod is the directory under {@code assets}, the documents directory is
 * the one it is in, and the project is the nearest ancestor holding a build script. The fifth, the
 * mod's root package, is read from <b>the same {@code gradle.properties} key the convention plugin
 * reads</b> ({@code mcmod.ui.package}) - so an in-session generate and a build's {@code generateUi}
 * cannot disagree about where the code goes, because there is one place that says.
 *
 * <p>Imports no Minecraft (section 7.1): paths and a properties file, so the Gradle-side caller
 * could use it too.
 */
public record UiProject(Path root, String modId, String basePackage, Path docs, Path common, Path client) {

    /** The property the {@code com.mattmc.mcmod} convention plugin opts screen authoring in with. */
    public static final String PACKAGE_KEY = "mcmod.ui.package";

    /**
     * Derive everything from one document's path.
     *
     * @param document an existing {@code *.ui.json}
     * @throws IOException with a sentence naming what is missing and where to put it
     */
    public static UiProject of(final Path document) throws IOException {
        Path doc = document.toAbsolutePath().normalize();
        Path ui = doc.getParent();
        if (ui == null || !"ui".equals(ui.getFileName().toString())) {
            throw new IOException(doc + " is not in a ui directory; a generatable document lives at"
                + " src/main/resources/assets/<mod>/ui/<screen>.ui.json");
        }
        Path modDir = ui.getParent();
        Path assets = modDir == null ? null : modDir.getParent();
        if (assets == null || !"assets".equals(assets.getFileName().toString())) {
            throw new IOException(doc + " is not under an assets/<mod>/ui directory, so there is no mod"
                + " id to generate for");
        }
        String modId = modDir.getFileName().toString();
        Path root = projectRoot(assets);
        if (root == null) {
            throw new IOException("no build script above " + assets + ", so there is no project to"
                + " generate into (looked for build.gradle / build.gradle.kts / settings.gradle)");
        }
        Path common = root.resolve("src/main/java");
        if (!Files.isDirectory(common)) {
            throw new IOException("no " + common + " to generate into");
        }
        // Loom's split source sets put client code in src/client/java; a mod that does not split
        // keeps everything in main. The plugin decides this the same way, on the same test.
        Path split = root.resolve("src/client/java");
        Path client = Files.isDirectory(split) ? split : common;
        return new UiProject(root, modId, packageOf(root, modId), ui, common, client);
    }

    /** The nearest ancestor that looks like a Gradle project. */
    private static Path projectRoot(final Path from) {
        for (Path p = from.getParent(); p != null; p = p.getParent()) {
            if (Files.isRegularFile(p.resolve("build.gradle"))
                || Files.isRegularFile(p.resolve("build.gradle.kts"))
                || Files.isRegularFile(p.resolve("settings.gradle"))
                || Files.isRegularFile(p.resolve("settings.gradle.kts"))) {
                return p;
            }
        }
        return null;
    }

    /**
     * {@code mcmod.ui.package} from the project's own {@code gradle.properties}.
     *
     * <p>Absent is not an error a caller can act on unless it says what to write, so it says it -
     * this is the same refusal the plugin prints when the property is missing, at the same key.
     */
    private static String packageOf(final Path root, final String modId) throws IOException {
        Path file = root.resolve("gradle.properties");
        Properties props = new Properties();
        if (Files.isRegularFile(file)) {
            try (InputStream in = Files.newInputStream(file)) {
                props.load(in);
            }
        }
        String pkg = props.getProperty(PACKAGE_KEY);
        if (pkg == null || pkg.isBlank()) {
            throw new IOException("screen authoring is not opted in for " + root + ": set " + PACKAGE_KEY
                + "=<the mod's root package> in " + file + " (the same property `gradlew generateUi`"
                + " reads, so a generate here and a generate in the build agree). Mod '" + modId + "'.");
        }
        return pkg.trim();
    }

    /** Generate (or, with {@code check}, only report drift) every document of this mod. */
    public UiGenerate.Report run(final Target target, final boolean check) throws IOException {
        return UiGenerate.run(modId, basePackage, docs, common, client, target, check, null);
    }
}
