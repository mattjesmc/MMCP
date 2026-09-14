package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.sun.tools.attach.VirtualMachine;
import org.jspecify.annotations.Nullable;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.instrument.ClassDefinition;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.lang.instrument.UnmodifiableClassException;
import java.net.URL;
import java.net.URLConnection;
import java.security.ProtectionDomain;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.jar.Attributes;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import java.util.jar.Manifest;

/**
 * Live code push, method-body tier: swap the bytecode of an already-loaded class in place via
 * {@link Instrumentation#redefineClasses}. Works on stock HotSpot — the JVM itself enforces the limit
 * (changed method bodies only; adding/removing fields or methods is rejected and needs a restart).
 *
 * <p>Instrumentation is obtained lazily by self-attaching a runtime-assembled agent jar, which requires
 * {@code -Djdk.attach.allowAttachSelf=true} on the game JVM — set on both loom runs in this project's
 * {@code build.gradle} and, so that a consumer's game has it too, in {@code gradle-conventions}. The
 * mixin tier's {@code -Dmixin.hotSwap=true} rides beside it in both places.
 *
 * <p>A class transformed at load (a mixin target, a remapped Minecraft class) cannot be redefined
 * from compiled sources — the transforms are not in those bytes — so a target is <b>refused</b> and
 * told which mixin to swap instead. The mixin itself is swappable: {@link MixinHotswap} arms Mixin's
 * own agent with this instrumentation, and redefining a mixin class makes Mixin re-apply it to its
 * targets. That is why the lookup here is every loaded COPY of a name rather than one: the copy that
 * matters is the SHELL in Mixin's agent classloader, and — confirmed live 2026-09-13 — it is usually
 * the ONLY copy, because a mixin is applied rather than loaded and Knot never defines one at all.
 * {@code Class.forName} does not merely find the wrong copy; it finds none and fails the transform.
 */
public final class HotswapTools {
    private HotswapTools() {}

    private static volatile Instrumentation instrumentation;

    public static void register() {
        McpTools.register(ToolDef.of(
            "hotswap_class",
            "Redefine one or more already-loaded classes from freshly compiled bytecode without restarting "
                + "the game (method-body changes only; structural changes are rejected by the JVM and need a "
                + "restart). Pass \"class\" (binary name, e.g. \"com.example.mymod.ui.MyScreen\") "
                + "for one class, or \"classes\" (array of binary names) to swap several ATOMICALLY in one "
                + "redefine — use the batch form whenever an edit spans classes, so no tick sees a half-"
                + "applied change. Bytes are read from \"file\" (absolute path to a .class; single-class "
                + "only) if given, else \"dir\" (classes root, e.g. \".../build/classes/java/main\") if "
                + "given, else each class's own classpath entry — the default works after `gradlew "
                + "compileJava` when the class was loaded from a classes directory, but NOT for classes "
                + "loaded from a jar (pass \"file\" or \"dir\" for those). \"compile\":true RUNS THE "
                + "COMPILE FIRST, in the project the class's own bytes come from, so the edit-to-game "
                + "loop is this one call - prefer it to a separate `gradlew compileJava` turn, which "
                + "can silently aim at a different project than the swap. MIXINS: swap the MIXIN class "
                + "itself (e.g. \"com.example.mixin.FooMixin\") and Mixin re-applies it to its targets; "
                + "swapping a mixin TARGET is refused, because compiled sources carry none of its "
                + "load-time transforms. Changing what an existing injector does lands; ADDING an "
                + "@Inject adds a method to the target and needs a restart. THE BYTES ARE NEW, THE "
                + "OBJECTS ARE OLD: a redefine does not rebuild what the old code already built (a "
                + "screen's widgets, a mob's goal list, a registered singleton) and does not re-run a "
                + "static initialiser, so a swap can succeed and change nothing visible - the "
                + "`reentry` block in the reply says, per class, what is still holding old state and "
                + "what would make the code run again, and \"reinit\" performs the re-entries that "
                + "are reachable from here. Bytes that are byte-identical to what is already "
                + "running are REFUSED rather than reported as a redefine (a forgotten compileJava "
                + "is the usual cause), and \"status\":true lists every class this JVM has been "
                + "swapped away from its jar.",
            Schemas.objectOpt(
                Schemas.object(
                    "class", Schemas.str("Binary name of the loaded class to redefine."),
                    "classes", Schemas.array(Schemas.str("Binary class name.")),
                    "file", Schemas.str("Absolute path to the replacement .class file (single-class only)."),
                    "dir", Schemas.str("Classes root directory to resolve the .class files under."),
                    "compile", Schemas.bool("Run the Gradle compile task for these classes before "
                        + "swapping, in the project their bytes come from (never `jar` or `build` - "
                        + "those deadlock against the running game). Default false. A failed compile "
                        + "is the reply, and nothing is redefined."),
                    "status", Schemas.bool("List what this JVM is running that its jar is not - "
                        + "every class swapped so far, when, from where and the digest now installed "
                        + "- and do nothing else. Takes no class."),
                    "reinit", Schemas.bool("After the swap, re-enter the live objects the new code "
                        + "cannot reach by itself: rebuild the current screen's widgets (re-runs "
                        + "init()), re-run registerGoals() on every loaded instance of a swapped Mob "
                        + "class. Default false. It is an ACT on the running world - re-registering "
                        + "goals clears any goal added from outside registerGoals().")),
                "class", "classes", "file", "dir", "compile", "reinit", "status"),
            ExecutionContext.ANY,
            Mechanism.PRIVILEGED,
            HotswapTools::hotswap));
    }

    private static JsonObject hotswap(ToolContext ctx, JsonObject args) {
        if (args.has("status") && !args.get("status").isJsonNull() && args.get("status").getAsBoolean()) {
            // The one question this tool could always have answered and never did: what is this JVM
            // running that its jar is not. Read first, because it takes no class and no bytes.
            return SwapLedger.status();
        }
        List<String> names = new ArrayList<>();
        if (args.has("classes") && !args.get("classes").isJsonNull()) {
            args.getAsJsonArray("classes").forEach(el -> names.add(el.getAsString()));
        }
        if (args.has("class") && !args.get("class").isJsonNull()) {
            names.add(args.get("class").getAsString());
        }
        if (names.isEmpty()) {
            throw new IllegalArgumentException(
                "provide 'class' or a non-empty 'classes' array (or 'status':true to list what this "
                + "JVM has already been swapped away from its jar)");
        }
        boolean reinit = args.has("reinit") && !args.get("reinit").isJsonNull()
            && args.get("reinit").getAsBoolean();
        boolean compile = args.has("compile") && !args.get("compile").isJsonNull()
            && args.get("compile").getAsBoolean();
        boolean hasFile = args.has("file") && !args.get("file").isJsonNull();
        if (hasFile && names.size() > 1) {
            throw new IllegalArgumentException("'file' names one .class file — use 'dir' for a batch");
        }

        String source = hasFile ? "file"
            : args.has("dir") && !args.get("dir").isJsonNull() ? "dir"
            : "classpath";

        // The agent comes FIRST, because the lookup below is its loaded-class list and because
        // arming mixin's agent has to happen before the redefine that is supposed to trigger it.
        Instrumentation inst = instrumentation();
        String mixinState = MixinHotswap.arm(inst);

        List<ClassDefinition> defs = new ArrayList<>();
        // In call order, and the PRIMARY copy of each: the re-entry account is asked of the same
        // class the swap was asked of, and a caller reads its answers in the order it named them.
        Map<String, Class<?>> primaries = new LinkedHashMap<>();
        // name -> why these bytes are not new, for the classes where they are not.
        Map<String, String> unchanged = new LinkedHashMap<>();
        // name -> the bytes actually pushed, kept so the ledger records what landed and not what
        // was asked for.
        Map<String, byte[]> pushed = new LinkedHashMap<>();
        // name -> when the bytes being pushed were compiled, the only staleness signal a FIRST swap
        // of a class has.
        Map<String, String> compiledAt = new LinkedHashMap<>();
        long totalBytes = 0;
        int mixinShells = 0;

        // Which classes are loaded, and which copy of each answers questions - resolved for every
        // name BEFORE anything else, because both refusals below are cheaper than a compile and a
        // caller who is about to be refused should not have waited twenty seconds for it.
        Map<String, List<Class<?>>> copiesByName = new LinkedHashMap<>();
        for (String name : names) {
            copiesByName.put(name, loadedCopies(inst, name));
        }
        JsonArray compiled = null;

        for (String name : names) {
            List<Class<?>> copies = copiesByName.get(name);
            if (copies.isEmpty()) {
                // "it will read the new bytes when it loads" is true of an ordinary class and FALSE
                // of a mixin, which is never loaded at all: on a game without the flag there is no
                // shell, so this is the refusal a mixin swap actually gets, and left alone it sends
                // the caller away reassured. Name the flag whenever we know it is missing.
                String unarmed = MixinHotswap.ARMED.equals(mixinState) ? null : MixinHotswap.why(mixinState);
                throw new IllegalArgumentException("class not loaded: " + name + " — there is nothing "
                    + "to redefine, and a class that loads later reads the new bytes off the classpath "
                    + "by itself" + (unarmed == null ? ""
                        : ". If " + name + " is a MIXIN, that is the reason it is not loaded and the "
                        + "sentence before does NOT apply - a mixin is applied, never loaded, and its "
                        + "targets keep the old injector until a restart: " + unarmed));
            }
            Class<?> primary = primary(copies);
            primaries.put(name, primary);
            String merged = ClassTools.anyMergedMixin(primary);
            if (merged != null) {
                throw new IllegalArgumentException(name + " is a mixin TARGET (" + merged + " merged "
                    + "methods into it). Compiled sources carry none of its load-time transforms, so "
                    + "redefining it from them would silently drop them. Swap " + merged + " instead — "
                    + "Mixin re-applies it to this class.");
            }
        }

        if (compile) {
            // §6: the compile belongs INSIDE this call, not in the turn before it. Everything above
            // is a refusal that costs nothing; everything below reads bytes, so this is the last
            // moment at which running the compiler is still the same act as swapping its output.
            compiled = compileFor(args, source, primaries);
        }

        for (String name : names) {
            List<Class<?>> copies = copiesByName.get(name);
            Class<?> primary = primaries.get(name);
            byte[] bytes;
            try {
                bytes = switch (source) {
                    case "file" -> Files.readAllBytes(Path.of(args.get("file").getAsString()));
                    case "dir" -> Files.readAllBytes(
                        Path.of(args.get("dir").getAsString(), name.replace('.', '/') + ".class"));
                    default -> readFromClasspath(primary, name);
                };
            } catch (Exception e) {
                throw new IllegalArgumentException("could not read replacement bytes for " + name + ": " + e);
            }
            // Are these bytes actually NEW? Everything below reports success for a redefine with
            // byte-identical bytes, which is what a forgotten (or misdirected) compileJava produces
            // - the most common failure of this loop, reported as its success (HOTSWAP_CEILING.md
            // section 4). Two sources, and LIVE 2026-09-13 taught which one answers when:
            //
            //   - What the JVM is running, read back through a capturing retransform. Exact, and the
            //     one that catches a no-op on any class this session has already swapped.
            //   - What WE pushed last time, from the ledger. The fallback, and on a FIRST swap it is
            //     the only one there is - because the bytes a Fabric dev run holds for a mod class
            //     are NOT the bytes on its .class file. Knot rewrites every mod class as it loads it
            //     (same length, different content, measured on an untouched class straight after a
            //     clean build), so a first swap's file-vs-loaded comparison says "changed" about a
            //     file nobody recompiled. From the second swap on they agree exactly, because the
            //     first redefine installed the file's bytes verbatim.
            //
            // Which is why `compiled_at` is in the reply: on the one swap neither source can decide,
            // the mtime of the bytes just installed is what tells a caller whether their edit is in
            // them.
            String digest = SwapLedger.digest(bytes);
            SwapLedger.Entry previous = SwapLedger.last(name);
            byte[] installed = previous == null ? null : installedBytes(inst, primary);
            if (installed != null ? java.util.Arrays.equals(installed, bytes)
                : previous != null && previous.digest().equals(digest)) {
                unchanged.put(name, installed != null
                    ? "byte-identical to what this JVM is running right now"
                    : "byte-identical to the bytes pushed at " + previous.at());
            }
            compiledAt.put(name, compiledAt(args, source, primary, name));
            pushed.put(name, bytes);

            // Every loaded COPY of the name, not just the one our own loader sees: a mixin lives twice
            // over, once in Knot and once as the shell in Mixin's agent classloader, and it is the
            // shell's redefinition that makes the agent re-apply it. Redefining one and not the other
            // is the difference between a mixin edit landing and a mixin edit reporting success.
            for (Class<?> cls : copies) {
                if (MixinHotswap.isAgentShell(cls)) {
                    mixinShells++;
                }
                defs.add(new ClassDefinition(cls, bytes));
            }
            totalBytes += bytes.length;
        }

        boolean nothingNew = unchanged.size() == names.size();
        if (nothingNew && reinit) {
            // The flow the live run walked into: swap, look, see nothing change, ask for the
            // re-entry - and the second call carries the SAME bytes, so a bare refusal would answer
            // "nothing to redefine" to a caller who was not asking for a redefine. Nothing is
            // redefined (there is nothing to install), the re-entry runs, and the reply says both.
            JsonObject r = new JsonObject();
            r.add("redefined", new JsonArray());
            r.addProperty("count", 0);
            JsonObject same = new JsonObject();
            unchanged.forEach(same::addProperty);
            r.add("unchanged", same);
            r.addProperty("note", "no bytes were redefined - every class named is already installed. "
                + "The re-entry below ran anyway, which is what reinit was asked for.");
            if (compiled != null) {
                r.add("compiled", compiled);
            }
            r.add("reentry", Reentry.block(primaries, ctx.server(), true));
            return r;
        }
        if (nothingNew) {
            // A refusal, not a note, when NOTHING in the batch is new: the caller's next move is to
            // compile, and a reply that said `redefined: 1` would send them looking at the game
            // instead. A batch where one class did change still goes through - the swap is real -
            // and says which of them were already installed.
            StringBuilder why = new StringBuilder();
            unchanged.forEach((n, reason) -> why.append(why.isEmpty() ? "" : "; ").append(n)
                .append(" is ").append(reason));
            // The diagnosis depends on whether WE compiled. "you forgot to compile" is the right
            // guess for a caller who compiled in some other turn, and exactly the wrong one for a
            // caller who just watched this call run the compiler - for them the compile succeeded
            // and produced the same bytes, which says the edit is not in the source tree that
            // project compiles. Gradle's own UP-TO-DATE says it harder still.
            throw new IllegalStateException("nothing to redefine: " + why + ". "
                + (compiled == null
                    ? "These bytes came from " + source + " (" + describeSource(args, source, names)
                        + "), so the usual cause is that `gradlew compileJava` has not run since the "
                        + "edit, or ran in a different project than the one this class is loaded "
                        + "from - pass compile:true and this call runs it in the right project itself."
                    : "The compile ran here first (" + summarise(compiled) + ") and produced these "
                        + "same bytes, so a missing compile is NOT the cause: the edit is not in the "
                        + "source tree that project compiles. Check that the file you edited is the "
                        + "one under it.")
                + " Nothing was redefined and the game is unchanged. (If you meant to RE-ENTER a swap "
                + "that already landed, pass reinit:true - that is allowed on unchanged bytes.)");
        }

        try {
            inst.redefineClasses(defs.toArray(new ClassDefinition[0]));
        } catch (UnsupportedOperationException e) {
            throw new IllegalStateException(
                "structural change rejected (" + e.getMessage() + ") — method-body edits only; restart for this one");
        } catch (LinkageError e) {
            // How a DECLINED mixin re-apply arrives. Mixin's agent returns ERROR_BYTECODE when
            // reload() throws, the JVM rejects that as a malformed class, and a ClassFormatError has
            // no message - so the right outcome (nothing was redefined) reported itself as five words
            // naming no mixin, no cause and no fix. The Error also escapes `catch (Exception)`, which
            // is why it reached the caller raw at all.
            throw new IllegalStateException(mixinShells > 0
                ? "Mixin DECLINED the re-apply and returned error bytecode, which the JVM rejected ("
                    + e.getClass().getSimpleName() + "). NOTHING was redefined and the targets are "
                    + "still running the old injectors. The usual cause is a STRUCTURAL change to the "
                    + "mixin: a new @Inject or @Redirect adds a handler method to the TARGET, and a "
                    + "loaded class cannot gain one - changing what an EXISTING injector does is what "
                    + "lands. Mixin's own reason, naming the member it could not conform, is in "
                    + "get_log {level:\"error\", logger:\"Mixin/agent\"}. Restart for this edit."
                : "the replacement bytes were rejected by the JVM as malformed ("
                    + e.getClass().getSimpleName() + ": " + e.getMessage() + ") - nothing was "
                    + "redefined. Check that 'file'/'dir' points at classes compiled from THIS "
                    + "source tree for the version this game is running.");
        } catch (Exception e) {
            throw new IllegalStateException("redefine failed: " + e);
        }

        pushed.forEach((name, bytes) -> SwapLedger.record(name, source, bytes));

        JsonObject r = new JsonObject();
        JsonArray redefined = new JsonArray();
        names.forEach(redefined::add);
        r.add("redefined", redefined);
        r.addProperty("count", names.size());
        r.addProperty("bytes", totalBytes);
        r.addProperty("source", source);
        if (compiled != null) {
            r.add("compiled", compiled);
        }
        if (defs.size() > names.size()) {
            r.addProperty("definitions", defs.size());
        }
        JsonObject when = new JsonObject();
        compiledAt.forEach((n, at) -> {
            if (at != null) {
                when.addProperty(n, at);
            }
        });
        if (!when.isEmpty()) {
            r.add("compiled_at", when);
        }
        if (!unchanged.isEmpty()) {
            // Part of the batch was already installed. The swap landed for the rest, so this is a
            // line in a successful reply rather than a refusal - but it is the line that explains a
            // class whose behaviour did not move.
            JsonObject same = new JsonObject();
            unchanged.forEach(same::addProperty);
            r.add("unchanged", same);
        }
        if (mixinShells > 0) {
            // Only said when a mixin was actually in the batch: this is a per-call token cost on the
            // most frequent privileged tool there is, and on a plain mod class it says nothing.
            JsonObject mixin = new JsonObject();
            mixin.addProperty("reapplied", true);
            mixin.addProperty("note", "Mixin's agent reloaded " + mixinShells + " mixin class(es) and "
                + "retransformed their targets; check the log for 'Redefining mixin' and for a "
                + "'cannot be reloaded' error, which is how a REFUSED re-apply reports itself");
            r.add("mixin", mixin);
        } else if (!MixinHotswap.ARMED.equals(mixinState)) {
            r.addProperty("mixin_note", MixinHotswap.why(mixinState));
        }
        // Said on EVERY swap, because the false belief it closes is available on every swap: the
        // redefine above is as true for a screen nobody will re-open as for a method about to be
        // called, and `redefined: 1` reads identically in both (HOTSWAP_CEILING.md section 3).
        r.add("reentry", Reentry.block(primaries, ctx.server(), reinit));
        return r;
    }

    /**
     * <b>Compile what is about to be swapped, in the project it comes from.</b>
     * ({@code docs/platform/HOTSWAP_CEILING.md} §6.)
     *
     * <p>One Gradle run per distinct project-and-task, in the order the classes were named: a batch
     * that spans a mod's {@code main} and {@code client} source sets is two tasks, and a batch of
     * five classes in one source set is one.
     *
     * @return an entry per task run, for the reply — {@code project}, {@code task}, Gradle's own
     *     {@code status} word, and the wall time it took
     */
    private static JsonArray compileFor(final JsonObject args, final String source,
                                        final Map<String, Class<?>> primaries) {
        Map<String, GradleCompile.Target> targets = new LinkedHashMap<>();
        primaries.forEach((name, primary) -> {
            GradleCompile.Target target = GradleCompile.of(classesRoot(args, source, name, primary));
            targets.putIfAbsent(target.project() + " " + target.task(), target);
        });
        JsonArray out = new JsonArray();
        for (GradleCompile.Target target : targets.values()) {
            GradleCompile.Result result = GradleCompile.run(target);
            JsonObject one = new JsonObject();
            one.addProperty("project", result.project().toString());
            one.addProperty("task", result.task());
            if (result.status() != null) {
                one.addProperty("status", result.status());
            }
            one.addProperty("ms", result.ms());
            out.add(one);
        }
        return out;
    }

    /** The compile block as one clause, for a refusal that has to fit in a sentence. */
    private static String summarise(final JsonArray compiled) {
        StringBuilder sb = new StringBuilder();
        compiled.forEach(el -> {
            JsonObject one = el.getAsJsonObject();
            sb.append(sb.isEmpty() ? "" : "; ").append(one.get("task").getAsString());
            if (one.has("status")) {
                sb.append(' ').append(one.get("status").getAsString());
            }
        });
        return sb.toString();
    }

    /**
     * The classes root the swap's bytes come from — which is the directory that names the project
     * and the task to rebuild it.
     *
     * <p>Derived from the same three sources the byte read uses, so a compile and the swap that
     * follows it can never aim at different trees. A {@code file} or a classpath entry states its
     * root by having the class's package path on the end of it; strip that and what is left is the
     * root. A path that does not end in the package path is not refused for being odd — it is
     * refused because nothing about it says which project produced it.
     */
    private static Path classesRoot(final JsonObject args, final String source, final String name,
                                    final Class<?> primary) {
        String resource = name.replace('.', '/') + ".class";
        switch (source) {
            case "dir":
                return Path.of(args.get("dir").getAsString());
            case "file": {
                Path file = Path.of(args.get("file").getAsString()).toAbsolutePath().normalize();
                Path root = stripPackagePath(file, resource);
                if (root == null) {
                    throw new IllegalArgumentException("cannot compile for 'file' " + file + ": it does "
                        + "not sit at " + resource + " under a classes root, so there is no project it "
                        + "names. Pass 'dir' (the classes root) instead, or compile it yourself.");
                }
                return root;
            }
            default: {
                URL url = classpathResource(primary, name);
                if (url == null || !"file".equals(url.getProtocol())) {
                    throw new IllegalArgumentException("cannot compile for " + name + ": its loader "
                        + "resolves " + resource + " to " + (url == null ? "nothing" : url) + ", not a "
                        + "file on disk, so there is no project to compile. Pass 'dir'.");
                }
                Path file;
                try {
                    file = Path.of(url.toURI()).toAbsolutePath().normalize();
                } catch (Exception e) {
                    throw new IllegalArgumentException("cannot compile for " + name + ": " + url
                        + " is not a usable path (" + e + ")");
                }
                Path root = stripPackagePath(file, resource);
                if (root == null) {
                    throw new IllegalArgumentException("cannot compile for " + name + ": it loads from "
                        + file + ", which does not end in its package path, so no classes root can be "
                        + "read off it. Pass 'dir'.");
                }
                return root;
            }
        }
    }

    /** {@code .../classes/java/main/com/x/Y.class} minus {@code com/x/Y.class}, or null if it isn't that. */
    static @Nullable Path stripPackagePath(final Path file, final String resource) {
        Path at = file;
        String[] segments = resource.split("/");
        for (int i = segments.length - 1; i >= 0; i--) {
            Path segment = at == null ? null : at.getFileName();
            if (segment == null || !segments[i].equals(segment.toString())) {
                return null;
            }
            at = at.getParent();
        }
        return at;
    }

    /**
     * <b>The bytes this JVM is running for this class right now</b>, or null when they cannot be had
     * without a side effect. This is the only exact answer to "would this swap change anything", and
     * §4 of the ceiling record exists because nothing was asking it.
     *
     * <p>The agent already declares {@code Can-Retransform-Classes}, so the way to see the installed
     * bytes is to ask for a retransformation and keep what the JVM hands the transformer. Returning
     * null from it means no new bytes are installed, which makes this a READ: the class is left
     * exactly as it was.
     *
     * <p><b>Never asked of a mixin shell.</b> A retransformation re-runs every retransform-capable
     * transformer, and Mixin's agent is one — on a shell it would re-apply the mixin to its targets,
     * which is a real act performed in the course of answering a question. Mixin TARGETS are refused
     * before this point for a different reason, so the only classes that reach here are ordinary
     * ones, whose retransformation no transformer touches.
     */
    static byte @Nullable [] installedBytes(final Instrumentation inst, final Class<?> cls) {
        if (MixinHotswap.isAgentShell(cls) || !inst.isRetransformClassesSupported()
            || !inst.isModifiableClass(cls)) {
            return null;
        }
        byte[][] box = new byte[1][];
        ClassFileTransformer capture = new ClassFileTransformer() {
            @Override
            public byte[] transform(Module module, ClassLoader loader, String name,
                                    Class<?> beingRedefined, ProtectionDomain domain, byte[] buffer) {
                if (beingRedefined == cls) {
                    box[0] = buffer;
                }
                return null;
            }
        };
        inst.addTransformer(capture, true);
        try {
            inst.retransformClasses(cls);
        } catch (RuntimeException | LinkageError | UnmodifiableClassException e) {
            return null; // an unanswerable question is not a swap failure; the check simply abstains
        } finally {
            inst.removeTransformer(capture);
        }
        return box[0];
    }

    /**
     * When the .class file these bytes came from was last written, ISO-8601, or null if it cannot be
     * asked. It is in every reply because of what the live run found: on the FIRST swap of a class,
     * comparing the file against the loaded bytes cannot decide whether anything changed (Knot's
     * load-time rewrite makes them differ either way), so the compile time is the only thing that
     * separates "I recompiled" from "I forgot to".
     */
    private static @Nullable String compiledAt(final JsonObject args, final String source,
                                               final Class<?> cls, final String name) {
        try {
            Path path = switch (source) {
                case "file" -> Path.of(args.get("file").getAsString());
                case "dir" -> Path.of(args.get("dir").getAsString(), name.replace('.', '/') + ".class");
                default -> {
                    URL url = classpathResource(cls, name);
                    yield url == null || !"file".equals(url.getProtocol())
                        ? null : Path.of(url.toURI());
                }
            };
            return path == null ? null : Files.getLastModifiedTime(path).toInstant().toString();
        } catch (Exception e) {
            return null;
        }
    }

    /** Where the refused bytes came from, in the terms the caller passed them. */
    private static String describeSource(final JsonObject args, final String source,
                                         final List<String> names) {
        return switch (source) {
            case "file" -> args.get("file").getAsString();
            case "dir" -> args.get("dir").getAsString();
            default -> {
                URL url = null;
                Instrumentation inst = instrumentationIfAttached();
                if (inst != null && !names.isEmpty()) {
                    List<Class<?>> copies = loadedCopies(inst, names.get(0));
                    Class<?> primary = primary(copies);
                    url = primary == null ? null : classpathResource(primary, names.get(0));
                }
                yield url == null ? "each class's own classpath entry" : url.toString();
            }
        };
    }

    /**
     * The copy of a name that every question about the class should be asked of. {@code
     * getAllLoadedClasses} has no defined order and one of the copies may be Mixin's SHELL — an empty
     * class, with no code source and an empty method table, that exists only so the JVM has something
     * redefinable to hand the agent. Answering "is this a mixin target" or "what methods does it have"
     * from the shell is answering from a stand-in, so the shell goes last. When the shell is the ONLY
     * copy — which is the common case, because a mixin is normally never defined in Knot at all — it
     * is returned, and the caller is told what it is holding.
     */
    static Class<?> primary(final List<Class<?>> copies) {
        return copies.stream().filter(c -> !MixinHotswap.isAgentShell(c))
            .findFirst().orElse(copies.isEmpty() ? null : copies.get(0));
    }

    /**
     * The URL a classpath-default swap would read this class's bytes from, or null if its loader
     * resolves none. Shared with {@code query_class}' precheck so the precheck reads exactly what the
     * swap reads: a code source and a resource lookup can disagree, and on a mixin shell they DO — it
     * has no code source at all, while its loader still delegates the resource to the classes
     * directory the mixin was compiled into. The precheck that guessed from the code source told
     * callers to pass 'dir' for a swap the default handles.
     */
    static URL classpathResource(final Class<?> cls, final String name) {
        String res = name.replace('.', '/') + ".class";
        try {
            ClassLoader cl = cls.getClassLoader();
            return cl != null ? cl.getResource(res) : ClassLoader.getSystemResource(res);
        } catch (RuntimeException | LinkageError e) {
            return null;
        }
    }

    /**
     * Every loaded class with this binary name, from any loader. {@code Class.forName} answers with
     * ONE copy — our own loader's — and would also LOAD a class that was not loaded, in order to
     * redefine bytes nobody is running. The loaded-class list answers the question actually being
     * asked, and it is the only way to reach the second copy of a mixin: the shell Mixin's agent
     * keeps in its own classloader, which is the copy whose redefinition re-applies the mixin.
     */
    static List<Class<?>> loadedCopies(final Instrumentation inst, final String name) {
        List<Class<?>> found = new ArrayList<>(2);
        for (Class<?> cls : inst.getAllLoadedClasses()) {
            if (name.equals(cls.getName())) {
                found.add(cls);
            }
        }
        return found;
    }

    /**
     * Read the class's bytes from wherever its loader finds them, with URL caching off so a classes
     * DIRECTORY yields the post-recompile bytes. A jar: URL yields the (stale) jar contents — redefining
     * with them would report success while changing nothing, so refuse loudly instead.
     */
    private static byte[] readFromClasspath(Class<?> cls, String name) throws Exception {
        String res = name.replace('.', '/') + ".class";
        URL url = classpathResource(cls, name);
        if (url == null) throw new IllegalStateException("no classpath resource " + res);
        if (!"file".equals(url.getProtocol())) {
            throw new IllegalStateException(name + " was loaded from " + url.getProtocol() + ": ("
                + url + ") — the classpath default would re-read those already-loaded bytes and "
                + "\"succeed\" without changing anything. Pass 'file' or 'dir' pointing at freshly "
                + "compiled classes.");
        }
        URLConnection conn = url.openConnection();
        conn.setUseCaches(false);
        try (InputStream in = conn.getInputStream()) {
            return in.readAllBytes();
        }
    }

    /**
     * The instrumentation agent IF one is already attached, and <b>null rather than an attach</b> if
     * not. {@code query_class} uses it to ask whether a class is loaded without loading it, and that
     * question is worth exactly nothing if asking it self-attaches an agent: a read may not be the
     * reason the JVM changed. The agent is a hotswap's side effect, so this returns non-null in any
     * session that has already swapped a class.
     */
    static Instrumentation instrumentationIfAttached() {
        if (instrumentation != null) {
            return instrumentation;
        }
        return System.getProperties().get(HotswapAgentMain.PROPERTY_KEY) instanceof Instrumentation i
            ? i : null;
    }

    private static synchronized Instrumentation instrumentation() {
        if (instrumentation != null) return instrumentation;
        Object parked = System.getProperties().get(HotswapAgentMain.PROPERTY_KEY);
        if (parked == null) {
            selfAttach();
            parked = System.getProperties().get(HotswapAgentMain.PROPERTY_KEY);
        }
        if (!(parked instanceof Instrumentation inst)) {
            throw new IllegalStateException("agent attached but no Instrumentation appeared");
        }
        if (!inst.isRedefineClassesSupported()) {
            throw new IllegalStateException("this JVM does not support class redefinition");
        }
        instrumentation = inst;
        return inst;
    }

    private static void selfAttach() {
        try {
            Path jar = writeAgentJar();
            VirtualMachine vm = VirtualMachine.attach(String.valueOf(ProcessHandle.current().pid()));
            try {
                vm.loadAgent(jar.toString());
            } finally {
                vm.detach();
            }
        } catch (Exception e) {
            throw new IllegalStateException(
                "self-attach failed (is -Djdk.attach.allowAttachSelf=true set on the game JVM?): " + e);
        }
    }

    /** Assemble the one-class agent jar the attach API requires; the class bytes come off our own classpath. */
    private static Path writeAgentJar() throws Exception {
        String res = HotswapAgentMain.class.getName().replace('.', '/') + ".class";
        byte[] classBytes;
        try (InputStream in = HotswapTools.class.getClassLoader().getResourceAsStream(res)) {
            if (in == null) throw new IllegalStateException("cannot find own resource " + res);
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            in.transferTo(buf);
            classBytes = buf.toByteArray();
        }

        Manifest mf = new Manifest();
        Attributes attrs = mf.getMainAttributes();
        attrs.put(Attributes.Name.MANIFEST_VERSION, "1.0");
        attrs.putValue("Agent-Class", HotswapAgentMain.class.getName());
        attrs.putValue("Can-Redefine-Classes", "true");
        attrs.putValue("Can-Retransform-Classes", "true");

        Path jar = Files.createTempFile("mcptoolkit-hotswap-agent", ".jar");
        jar.toFile().deleteOnExit();
        try (JarOutputStream out = new JarOutputStream(Files.newOutputStream(jar), mf)) {
            out.putNextEntry(new JarEntry(res));
            out.write(classBytes);
            out.closeEntry();
        }
        return jar;
    }
}
