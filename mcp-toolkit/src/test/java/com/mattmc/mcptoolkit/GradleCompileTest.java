package com.mattmc.mcptoolkit;

import com.mattmc.mcptoolkit.platform.Platform;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The compile step's derivations and its account of a failure — everything about §6 that does not
 * need a Gradle to answer.
 *
 * <p>Running the compiler is Gradle's; what is ours is <b>which</b> project and task a classes
 * directory names, and what a caller is told when the run does not end in a compile. Both are the
 * places this could aim at the wrong tree and report success, which is the defect §6 exists to
 * close: a compile in one project and a swap in another agree about nothing and say so to nobody.
 */
class GradleCompileTest {

    /** A wrapper has to exist for a project to be compilable, so every fixture lays one down. */
    private static Path project(final Path dir, final String sourceSet) throws IOException {
        return project(dir, "java", sourceSet);
    }

    private static Path project(final Path dir, final String language, final String sourceSet)
            throws IOException {
        Files.createFile(dir.resolve(Platform.isWindows() ? "gradlew.bat" : "gradlew"));
        Path classes = dir.resolve("build/classes/" + language + "/" + sourceSet);
        Files.createDirectories(classes);
        return classes;
    }

    @Test
    void aClassesRootNamesItsProjectAndItsTask(@TempDir final Path dir) throws IOException {
        GradleCompile.Target target = GradleCompile.of(project(dir, "main"));
        assertEquals(dir.toAbsolutePath().normalize(), target.project());
        assertEquals("compileJava", target.task());
        assertEquals(dir.resolve(Platform.isWindows() ? "gradlew.bat" : "gradlew").toAbsolutePath()
            .normalize(), target.wrapper().toAbsolutePath().normalize());
    }

    @Test
    void theTaskFollowsGradlesNamingRuleRatherThanATableOfKnownSourceSets(@TempDir final Path dir)
            throws IOException {
        // Loom's split client source set - the one a mod's screens and renderers live in, and the
        // one a hand-typed `gradlew compileJava` silently does not build.
        Files.createFile(dir.resolve(Platform.isWindows() ? "gradlew.bat" : "gradlew"));
        Path client = dir.resolve("build/classes/java/client");
        Files.createDirectories(client);
        assertEquals("compileClientJava", GradleCompile.of(client).task());
        // A language this workbench has never compiled still resolves, because the rule is the rule.
        Path kotlin = dir.resolve("build/classes/kotlin/main");
        Files.createDirectories(kotlin);
        assertEquals("compileKotlin", GradleCompile.of(kotlin).task());
        Path kotlinTest = dir.resolve("build/classes/kotlin/test");
        Files.createDirectories(kotlinTest);
        assertEquals("compileTestKotlin", GradleCompile.of(kotlinTest).task());
    }

    @Test
    void aDirectoryThatIsNotAClassesRootIsRefusedRatherThanGuessedAt(@TempDir final Path dir) {
        // The case that matters: a class loaded from a jar, or from a hand-assembled directory. There
        // is no task that rebuilds it, and inventing one compiles something else entirely.
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
            () -> GradleCompile.of(dir.resolve("some/where/else")));
        assertTrue(e.getMessage().contains("build/classes"), e.getMessage());
        assertTrue(e.getMessage().contains("without 'compile'"), e.getMessage());
    }

    @Test
    void aProjectWithNoWrapperSaysSoInsteadOfRunningSomeOtherGradle(@TempDir final Path dir)
            throws IOException {
        Path classes = dir.resolve("proj/build/classes/java/main");
        Files.createDirectories(classes);
        IllegalStateException e = assertThrows(IllegalStateException.class,
            () -> GradleCompile.of(classes));
        assertTrue(e.getMessage().contains("gradlew"), e.getMessage());
    }

    @Test
    void aSubprojectBorrowsTheBuildRootsWrapperAndKeepsItsOwnDirectory(@TempDir final Path dir)
            throws IOException {
        Files.createFile(dir.resolve(Platform.isWindows() ? "gradlew.bat" : "gradlew"));
        Path classes = dir.resolve("sub/build/classes/java/main");
        Files.createDirectories(classes);
        GradleCompile.Target target = GradleCompile.of(classes);
        // The wrapper decides which Gradle runs; the working directory decides which project it
        // builds. Only the second is allowed to move.
        assertEquals(dir.resolve("sub").toAbsolutePath().normalize(), target.project());
        assertEquals(dir.toAbsolutePath().normalize(), target.wrapper().getParent());
    }

    @Test
    void gradlesOwnWordForTheTaskIsCarriedThroughAndAMissingLineIsNotInvented() {
        assertEquals("executed", GradleCompile.status(
            "> Configure project :\n> Task :compileJava\n\nBUILD SUCCESSFUL in 4s\n", "compileJava"));
        // The one that explains a byte-identical swap in Gradle's voice: no source file changed.
        assertEquals("UP-TO-DATE", GradleCompile.status(
            "> Task :compileJava UP-TO-DATE\n\nBUILD SUCCESSFUL in 1s\n", "compileJava"));
        assertEquals("NO-SOURCE", GradleCompile.status(
            "> Task :sub:compileClientJava NO-SOURCE\n", "compileClientJava"));
        // Another task's line is not this task's answer, and an answer nobody gave is not guessed.
        assertNull(GradleCompile.status("> Task :processResources\n", "compileJava"));
        assertNull(GradleCompile.status("BUILD SUCCESSFUL in 1s\n", "compileJava"));
    }

    @Test
    void aWindowsJarLockIsNamedAsTheRunningGameAndNotAsABrokenBuild(@TempDir final Path dir)
            throws IOException {
        GradleCompile.Target target = GradleCompile.of(project(dir, "main"));
        String gradle = "> Task :jar FAILED\n\nFAILURE: Build failed with an exception.\n"
            + "* What went wrong:\nCould not delete C:\\x\\build\\libs\\mod-1.0.jar\n";
        String said = GradleCompile.explain(target, gradle);
        assertTrue(said.contains("RUNNING GAME"), said);
        assertTrue(said.contains("rebuild.ps1"), said);
        assertTrue(said.contains("nothing was redefined"), said);
        // And it still hands over what Gradle actually printed - the translation is a heading, not a
        // replacement.
        assertTrue(said.contains("Could not delete"), said);
    }

    @Test
    void aCompilerErrorIsHandedOverAsTheCompilersOwnText(@TempDir final Path dir) throws IOException {
        GradleCompile.Target target = GradleCompile.of(project(dir, "main"));
        String gradle = "> Task :compileJava FAILED\n"
            + "C:\\x\\Foo.java:12: error: cannot find symbol\n        bar();\n";
        String said = GradleCompile.explain(target, gradle);
        assertTrue(said.contains("compileJava FAILED"), said);
        assertTrue(said.contains("cannot find symbol"), said);
        // The sentence a caller acts on: the game is untouched, so nothing has to be undone.
        assertTrue(said.contains("still running the code it was running before"), said);
        assertFalse(said.contains("RUNNING GAME"), said);
    }

    @Test
    void gradlesEchoOfAReportTheCompilerAlreadyMadeIsDropped(@TempDir final Path dir)
            throws IOException {
        // Measured on the live run: one missing symbol came back three times over - javac's report,
        // Gradle's banner repeating it indented, and advice to re-run with --scan. The compiler's
        // block is the one a caller acts on, and this tool is billed per token on every swap.
        GradleCompile.Target target = GradleCompile.of(project(dir, "main"));
        String gradle = "> Task :compileJava FAILED\n"
            + "C:\\x\\Foo.java:12: error: cannot find symbol\n        bar();\n1 error\n\n"
            + "[Incubating] Problems report is available at: file:///C:/x/report.html\n\n"
            + "FAILURE: Build failed with an exception.\n\n* What went wrong:\n"
            + "Execution failed for task ':compileJava'.\n"
            + "  C:\\x\\Foo.java:12: error: cannot find symbol\n\n* Try:\n> Run with --scan\n";
        String said = GradleCompile.explain(target, gradle);
        assertTrue(said.contains("cannot find symbol"), said);
        assertEquals(1, said.split("cannot find symbol", -1).length - 1, said);
        assertFalse(said.contains("--scan"), said);
        assertFalse(said.contains("[Incubating]"), said);
    }

    @Test
    void aFailureTheCompilerSaidNothingAboutKeepsGradlesBanner(@TempDir final Path dir)
            throws IOException {
        // The banner is dropped because it is a repeat, not because it is a banner. A jar lock says
        // its piece there and nowhere else, so cutting on the marker alone would delete the reason.
        GradleCompile.Target target = GradleCompile.of(project(dir, "main"));
        String gradle = "> Task :jar FAILED\n\nFAILURE: Build failed with an exception.\n"
            + "* What went wrong:\nCould not delete C:\\x\\build\\libs\\mod-1.0.jar\n";
        assertTrue(GradleCompile.explain(target, gradle).contains("Could not delete"));
    }

    @Test
    void aClassFileStatesItsOwnClassesRootByHavingItsPackagePathOnTheEnd() {
        // How the swap and the compile are kept aimed at ONE tree: the root is not typed, it is what
        // is left of the file the swap reads once its package path is taken off.
        assertEquals(Path.of("C:/p/build/classes/java/main"),
            HotswapTools.stripPackagePath(Path.of("C:/p/build/classes/java/main/com/x/Y.class"),
                "com/x/Y.class"));
        // A default package, which has no path to strip at all.
        assertEquals(Path.of("C:/p/build/classes/java/main"),
            HotswapTools.stripPackagePath(Path.of("C:/p/build/classes/java/main/Y.class"), "Y.class"));
        // A nested class, whose file name is not its class name's last segment - the resource string
        // is what is stripped, so this works for the same reason.
        assertEquals(Path.of("C:/p/out"),
            HotswapTools.stripPackagePath(Path.of("C:/p/out/com/x/Y$Inner.class"), "com/x/Y$Inner.class"));
        // A file somewhere the package path does not explain says nothing about a project, and null
        // is what makes the caller refuse rather than compile a neighbour.
        assertNull(HotswapTools.stripPackagePath(Path.of("C:/tmp/Y.class"), "com/x/Y.class"));
        assertNull(HotswapTools.stripPackagePath(Path.of("Y.class"), "com/x/Y.class"));
    }

    @Test
    void averyLongFailureKeepsItsEndAndSaysWhatItDropped(@TempDir final Path dir) throws IOException {
        GradleCompile.Target target = GradleCompile.of(project(dir, "main"));
        String noise = "> Task :compileJava\nsome deprecation warning\n".repeat(400);
        String said = GradleCompile.explain(target, noise + "error: THE LAST WORD\n");
        assertTrue(said.contains("THE LAST WORD"), said);
        assertTrue(said.contains("earlier characters omitted"), said);
        // Whole lines only: a tail that starts mid-line reads as corruption.
        assertFalse(said.contains("omitted)\nme deprecation"), said);
    }
}
