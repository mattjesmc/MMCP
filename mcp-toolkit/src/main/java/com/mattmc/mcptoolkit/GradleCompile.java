package com.mattmc.mcptoolkit;

import com.mattmc.mcptoolkit.platform.Platform;
import org.jspecify.annotations.Nullable;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

/**
 * <b>The compile step, inside the loop.</b>
 * ({@code docs/platform/HOTSWAP_CEILING.md} §6 — "there is no compile step inside the loop".)
 *
 * <p>Every swap used to be two turns and a guess: {@code gradlew compileJava} through Bash, then
 * {@code hotswap_class} with a class name and a {@code dir} whose binary-name-to-path mapping was
 * worked out by hand. The two turns are the cost; the guess is the defect — a compile aimed at one
 * project and a swap aimed at another report success separately and change nothing together, which
 * is exactly the no-op §4 had to build a byte comparison to catch.
 *
 * <p>So nothing is typed here either. A loaded class states its own classes root (the classpath URL
 * the swap would read its bytes from, minus the package path), and a Gradle classes root
 * <em>states the project and the task</em>: {@code <project>/build/classes/<lang>/<sourceSet>} is
 * compiled by {@code compile[SourceSet]Lang} in {@code <project>}. Both halves of the loop are then
 * derived from the same path, and the two cannot aim at different projects.
 *
 * <p><b>Only a compile task, never {@code jar} or {@code build}.</b> That is the standing rule of
 * this workbench ({@code tools/rebuild.ps1} exists because a running game holds {@code
 * build/libs/*.jar} open on Windows), and it is structural here: the task name is derived from a
 * classes directory, so there is no input that produces a packaging task. When some other project's
 * jar is dragged in anyway — a multi-project mod whose {@code compileJava} needs a sibling's jar —
 * the Windows lock message is translated rather than passed through, because "Could not delete
 * ...jar" reads like a broken build and means "your game is running".
 */
public final class GradleCompile {
    private GradleCompile() {}

    /** Long enough for a cold daemon on a loom project, short enough to fit the bridge's 390s. */
    static final long TIMEOUT_SECONDS = 240;

    /** Kept small on purpose: what is wanted is the compiler's complaint, not Gradle's banner. */
    private static final int TAIL_LIMIT = 4000;

    /** What one classes root says: which project to run, which task, where the wrapper is. */
    public record Target(Path project, Path wrapper, String task) {}

    /** What running it said. {@code status} is Gradle's own word for the task, or null if unstated. */
    public record Result(Path project, String task, @Nullable String status, long ms) {}

    /**
     * The project and task that produce this classes root.
     *
     * <p>{@code build/classes/java/main} → {@code compileJava}; {@code build/classes/java/client} →
     * {@code compileClientJava} (loom's split source set); {@code build/classes/kotlin/main} →
     * {@code compileKotlin}. That is Gradle's own naming rule, not a table, so a source set this
     * workbench has never seen still resolves.
     *
     * @throws IllegalArgumentException with a sentence naming what was seen, when the directory is
     *     not a Gradle classes root — a class loaded from a jar or from somewhere hand-assembled has
     *     no task that rebuilds it, and guessing one would compile the wrong thing.
     */
    public static Target of(final Path classesRoot) {
        Path root = classesRoot.toAbsolutePath().normalize();
        Path lang = root.getParent();
        Path classes = lang == null ? null : lang.getParent();
        Path build = classes == null ? null : classes.getParent();
        Path project = build == null ? null : build.getParent();
        if (project == null || !"classes".equals(name(classes)) || !"build".equals(name(build))) {
            throw new IllegalArgumentException("cannot compile for " + root + ": that is not a Gradle "
                + "classes root (expected <project>/build/classes/<language>/<sourceSet>), so there is "
                + "no project to run and no task to run in it. Compile it yourself and swap without "
                + "'compile'.");
        }
        String sourceSet = name(root);
        String language = name(lang);
        String task = "compile"
            + ("main".equals(sourceSet) ? "" : capitalise(sourceSet))
            + capitalise(language);
        return new Target(project, wrapper(project), task);
    }

    /**
     * The nearest wrapper at or above the project. A subproject has none of its own and its build
     * root's is the right one: Gradle takes the project to build from the working directory, so the
     * wrapper's location decides nothing except which Gradle runs.
     */
    private static Path wrapper(final Path project) {
        String script = Platform.isWindows() ? "gradlew.bat" : "gradlew";
        for (Path p = project; p != null; p = p.getParent()) {
            Path candidate = p.resolve(script);
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
        }
        throw new IllegalStateException("no " + script + " at or above " + project + ", so this "
            + "project cannot be compiled from here. Compile it yourself and swap without 'compile'.");
    }

    /**
     * Run the task and return what Gradle said about it, or throw with the compiler's own complaint.
     *
     * <p>Runs on the HTTP handler thread ({@link ExecutionContext#ANY}), which is why a swap can
     * afford to wait for it: the game keeps ticking, and a compile that hangs cannot trip the
     * server's watchdog.
     */
    public static Result run(final Target target) {
        List<String> cmd = new ArrayList<>();
        if (Platform.isWindows()) {
            // Same reason as ServerExtract's npm: a .bat is not an executable image, and the failure
            // when it is treated as one is an IOException naming nothing a caller can act on.
            cmd.add("cmd");
            cmd.add("/c");
        }
        cmd.add(target.wrapper().toString());
        cmd.add("--console=plain");
        cmd.add(target.task());

        long started = System.nanoTime();
        Process process;
        try {
            process = new ProcessBuilder(cmd)
                .directory(target.project().toFile())
                .redirectErrorStream(true)
                .start();
        } catch (IOException e) {
            throw new IllegalStateException("could not start " + target.wrapper() + ": " + e);
        }
        // Drained by a thread of its own, and the wait is the timeout's. Both halves matter: an
        // undrained pipe fills and stops the subprocess dead (a hang we caused), and draining it on
        // THIS thread would make the read the wait — readAllBytes returns at EOF, which a hung
        // Gradle never reaches, so the timeout below would never fire.
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        Thread drain = new Thread(() -> {
            try (InputStream in = process.getInputStream()) {
                in.transferTo(buffer);
            } catch (IOException ignored) {
                // The process was killed out from under the read; what was captured still explains it.
            }
        }, "mcptoolkit-gradle-out");
        drain.setDaemon(true);
        drain.start();
        boolean finished;
        try {
            finished = process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            drain.join(finished ? 5_000 : 1_000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
            throw new IllegalStateException(target.task() + " was interrupted");
        }
        String output = buffer.toString(StandardCharsets.UTF_8);
        long ms = (System.nanoTime() - started) / 1_000_000;
        if (!finished) {
            process.destroyForcibly();
            throw new IllegalStateException(target.task() + " in " + target.project() + " did not "
                + "finish within " + TIMEOUT_SECONDS + "s and was killed. Nothing was redefined. A "
                + "Gradle waiting on another Gradle's lock looks exactly like this — check whether "
                + "tools/rebuild.ps1 or another shell is building the same project.");
        }
        if (process.exitValue() != 0) {
            throw new IllegalStateException(explain(target, output));
        }
        return new Result(target.project(), target.task(), status(output, target.task()), ms);
    }

    /**
     * Gradle's own word for what the task did — {@code UP-TO-DATE}, {@code NO-SOURCE}, or
     * {@code executed} — or null when the task line is not in the output.
     *
     * <p>It is worth carrying because of what it explains one step later: a swap whose bytes turn
     * out to be byte-identical is a mystery after a compile and not a mystery at all after an
     * {@code UP-TO-DATE} compile, which says in Gradle's own voice that no source file changed.
     */
    static @Nullable String status(final String output, final String task) {
        for (String line : output.split("\r?\n")) {
            String trimmed = line.strip();
            if (!trimmed.startsWith("> Task :")) {
                continue;
            }
            String[] parts = trimmed.substring("> Task ".length()).split("\\s+", 2);
            String path = parts[0];
            if (path.equals(":" + task) || path.endsWith(":" + task)) {
                return parts.length > 1 && !parts[1].isBlank() ? parts[1].strip() : "executed";
            }
        }
        return null;
    }

    /**
     * The failed compile, said as the thing the caller has to fix.
     *
     * <p>Two shapes. A Windows jar lock is not a compile error and reads like one, so it is named:
     * this is the deadlock the whole no-{@code jar} rule exists for, and the fix is a restart loop,
     * not a source edit. Everything else is javac's own text, tail-first — Gradle's failure banner
     * repeats what the compiler already said, and the compiler said it better.
     */
    static String explain(final Target target, final String output) {
        String lower = output.toLowerCase(Locale.ROOT);
        boolean lockedJar = (lower.contains("build/libs") || lower.contains("build\\libs"))
            && (lower.contains("could not delete") || lower.contains("unable to delete")
                || lower.contains("being used by another process"));
        if (lockedJar) {
            return target.task() + " in " + target.project() + " needs a jar that the RUNNING GAME is "
                + "holding open, so it cannot be rebuilt from inside that game. Nothing was compiled "
                + "and nothing was redefined. This is the four-minute loop: stop the game and use "
                + "tools/rebuild.ps1. (A compile task alone never packages a jar; some other project "
                + "in this build depends on one.)\n" + tail(output);
        }
        return target.task() + " FAILED in " + target.project() + " — nothing was redefined, and the "
            + "game is still running the code it was running before:\n" + tail(output);
    }

    /**
     * What Gradle said, minus what it said twice.
     *
     * <p>Measured on the live run: a one-line syntax error came back as javac's report, then
     * Gradle's {@code FAILURE:} banner repeating the same report indented, then advice to run with
     * {@code --scan}. The compiler's own block is the one a caller acts on and the banner adds
     * nothing to it — but only when the compiler produced one, so the banner is dropped only if
     * there is an {@code error:} above it. A jar lock, which says its piece in the banner and
     * nowhere else, keeps everything.
     *
     * <p>Then the last {@value #TAIL_LIMIT} characters, whole lines, which is where a compiler that
     * printed a hundred errors put the count.
     */
    private static String tail(final String output) {
        String text = output.strip();
        int banner = text.indexOf("\nFAILURE: Build failed with an exception.");
        if (banner > 0 && text.lastIndexOf("error:", banner) >= 0) {
            text = text.substring(0, banner).strip();
        }
        if (text.contains("[Incubating]")) {
            StringBuilder kept = new StringBuilder(text.length());
            for (String line : text.split("\n", -1)) {
                if (!line.startsWith("[Incubating]")) {
                    kept.append(kept.isEmpty() ? "" : "\n").append(line);
                }
            }
            text = kept.toString().strip();
        }
        if (text.length() <= TAIL_LIMIT) {
            return text;
        }
        String cut = text.substring(text.length() - TAIL_LIMIT);
        int nl = cut.indexOf('\n');
        return "... (" + (text.length() - TAIL_LIMIT) + " earlier characters omitted)\n"
            + (nl >= 0 ? cut.substring(nl + 1) : cut);
    }

    private static String name(final @Nullable Path path) {
        Path file = path == null ? null : path.getFileName();
        return file == null ? "" : file.toString();
    }

    private static String capitalise(final String s) {
        return s.isEmpty() ? s : Character.toUpperCase(s.charAt(0)) + s.substring(1);
    }
}
