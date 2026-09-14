package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.lang.annotation.Annotation;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.net.URL;
import java.security.CodeSource;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.TreeMap;

/**
 * {@code query_class} - what a class ACTUALLY is in this JVM (RELEASE_1.md section D5, promoted out
 * of TODO section 4.4).
 *
 * <p>The one place a running game beats static tooling. A decompiled tree and an IDE both answer
 * from source: they can tell you what a {@code @Mixin} class <em>intends</em> to do. This answers
 * from the loaded class - which mixins were merged into it, what its post-transform method table
 * looks like, what its fields are typed as, and <b>which file on disk it came from</b>.
 *
 * <p><b>It pairs with {@code hotswap_class}, and the pairing is the {@code hotswap} block.</b>
 * Hotswap's classpath default re-reads the bytes the class was loaded from; when that is a JAR, the
 * redefine "succeeds" and changes nothing, so the tool refuses. Whether you are in that case is a
 * property of the loaded class, knowable BEFORE the call - so it is reported here, by name, with the
 * argument that fixes it.
 *
 * <p><b>The lookup never loads a class in order to describe it - unless it has to say so.</b> If a
 * hotswap has already attached the instrumentation agent, the loaded-class list is the authority and
 * a class that is not in it is reported as <em>not loaded</em>, which is a real and useful answer (a
 * class loads only when something touches it). Without the agent there is no way to ask that
 * question without answering it: {@code Class.forName(name, false, loader)} loads the class if it is
 * not loaded, so that path is taken, {@code lookup} says which one ran, and the reply says plainly
 * that the class may have been loaded by the query. Self-attaching an agent from a read would be a
 * larger act than the read.
 *
 * <p><b>Mixin detection is by annotation, deliberately.</b> Every method a mixin merges into a target
 * carries {@code @MixinMerged(mixin = "...")}, which survives to runtime; the applied set is read off
 * the method table rather than out of mixin's internals, so it needs no compile dependency on them
 * and does not care that NeoForge relocates the package. What it can see is METHODS: a mixin that
 * only injects a callback into an existing method body leaves an injector method behind (visible), a
 * mixin that only adds an interface does not (reported as the absence it is - {@code detection}
 * names the mechanism so an empty list is read as "no merged methods", not as "no mixins").
 */
public final class ClassTools {
    private ClassTools() {}

    private static final int DEFAULT_LIMIT = 40;
    private static final int MAX_LIMIT = 400;
    /** Mixin's own marker on a merged method. Matched by NAME - no dependency on mixin internals. */
    private static final String MIXIN_MERGED = "MixinMerged";

    public static void register() {
        McpTools.register(ToolDef.of(
            "query_class",
            "What a class ACTUALLY is in the running JVM, after mixins and remapping: its "
                + "post-transform method table and field types, its superclass/interface chain, the "
                + "class loader and the FILE ON DISK it was loaded from, and which mixins have merged "
                + "methods into it (read off the @MixinMerged markers those methods carry - a mixin "
                + "that adds only an interface leaves no method and cannot be seen this way). Source "
                + "says what a @Mixin INTENDS; this says what happened. The `hotswap` block prechecks "
                + "hotswap_class: a class loaded from a jar cannot use its classpath default, and "
                + "that is knowable before the call rather than after it.",
            Schemas.objectOpt(
                Schemas.object(
                    "class", Schemas.str("Binary name, e.g. net.minecraft.server.MinecraftServer."),
                    "contains", Schemas.str("Only members whose name contains this (case-insensitive)."),
                    "inherited", Schemas.bool("Include inherited members too (default false: declared "
                        + "only, which is what a mixin target's own table is)."),
                    "limit", Schemas.integer("Members listed per table (default " + DEFAULT_LIMIT
                        + ", max " + MAX_LIMIT + "); the count is always exact.")),
                "contains", "inherited", "limit"),
            ExecutionContext.ANY,
            Mechanism.OBSERVE,
            (ctx, a) -> query(a)));
    }

    private static JsonElement query(final JsonObject a) {
        String name = str(a, "class");
        int limit = Math.max(1, Math.min(MAX_LIMIT, a.has("limit") && !a.get("limit").isJsonNull()
            ? a.get("limit").getAsInt() : DEFAULT_LIMIT));
        String contains = a.has("contains") && !a.get("contains").isJsonNull()
            ? a.get("contains").getAsString().toLowerCase(java.util.Locale.ROOT) : null;
        boolean inherited = a.has("inherited") && !a.get("inherited").isJsonNull()
            && a.get("inherited").getAsBoolean();

        JsonObject r = new JsonObject();
        r.addProperty("class", name);
        Class<?> cls = findLoaded(name);
        if (cls != null) {
            r.addProperty("lookup", "loaded_class_list");
        } else {
            if (HotswapTools.instrumentationIfAttached() != null) {
                // The authority said no, so this is a fact rather than a failure.
                r.addProperty("loaded", false);
                r.addProperty("lookup", "loaded_class_list");
                String note = "this JVM has not loaded " + name + " - a class loads when "
                    + "something first touches it, so this is an answer about the run, not about "
                    + "whether the class exists";
                // Said only when a hotswap has already established the state, which is the only way
                // this class knows it: a MIXIN on a game without the flag is never loaded at all, and
                // "not loaded yet" reads like a class that simply has not been touched.
                String state = MixinHotswap.state();
                if (state != null && !MixinHotswap.ARMED.equals(state)) {
                    note += ". If it is a MIXIN it will never load here: " + MixinHotswap.why(state);
                }
                r.addProperty("note", note);
                return r;
            }
            try {
                cls = Class.forName(name, false, ClassTools.class.getClassLoader());
            } catch (ClassNotFoundException | LinkageError e) {
                throw new IllegalArgumentException("no such class on this classpath: " + name
                    + " (" + e.getClass().getSimpleName() + ")");
            } catch (RuntimeException e) {
                // A MIXIN class cannot be loaded through Knot at all - the transformer refuses it,
                // because a mixin is meant to be applied and not run. Class.forName is therefore the
                // wrong instrument for exactly the classes 0.149.0 made swappable, and the right one
                // needs the agent this read will not attach by itself.
                throw new IllegalArgumentException(name + " could not be loaded to be read (" + e
                    + "). If it is a MIXIN, that is expected: mixin classes are applied, not loaded, "
                    + "and the only copy that exists at runtime is the shell inside Mixin's hot-swap "
                    + "agent - which this read can see only once an agent is attached. hotswap_class "
                    + "attaches one, so query it again after any swap.");
            }
            r.addProperty("lookup", "class_forname");
            r.addProperty("lookup_note", "no instrumentation agent is attached (hotswap_class "
                + "attaches one), so this lookup CANNOT distinguish 'already loaded' from 'loaded "
                + "just now, without initialising' - it may have loaded the class itself");
        }
        r.addProperty("loaded", true);

        r.addProperty("kind", kind(cls));
        r.add("modifiers", modifiers(cls.getModifiers()));
        r.addProperty("superclass", cls.getSuperclass() == null ? null : cls.getSuperclass().getName());
        JsonArray ifaces = new JsonArray();
        for (Class<?> i : cls.getInterfaces()) {
            ifaces.add(i.getName());
        }
        r.add("interfaces", ifaces);
        r.addProperty("class_loader", cls.getClassLoader() == null
            ? "bootstrap" : cls.getClassLoader().getClass().getName());
        if (MixinHotswap.isAgentShell(cls)) {
            // Everything below is read off the loaded class, and for a shell the honest reading of
            // an empty table is "this class is a stand-in", not "this mixin declares nothing".
            r.addProperty("mixin_shell", true);
            r.addProperty("shell_note", "this is the SHELL Mixin's hot-swap agent holds for the mixin "
                + "- an empty class carrying its name, which is what a swap redefines to trigger the "
                + "re-apply. Its method and field tables are empty BY CONSTRUCTION and say nothing "
                + "about the mixin's source; read the TARGET class to see what the mixin merged.");
        }

        URL source = sourceOf(cls);
        r.addProperty("source", source == null ? null : source.toString());
        boolean fromJar = source != null && !"file".equals(source.getProtocol());
        boolean fromJarFile = source != null && source.getPath() != null
            && source.getPath().toLowerCase(java.util.Locale.ROOT).endsWith(".jar");

        // Scanned ONCE and handed on: the hotswap verdict turns on the same annotation sweep, and
        // a second pass over a 275-method table to re-derive a number already computed is the kind
        // of thing that is invisible until the class is Minecraft-sized.
        JsonObject mixins = mixins(cls);
        r.add("mixins", mixins);
        r.add("methods", methods(cls, inherited, contains, limit));
        r.add("fields", fields(cls, inherited, contains, limit));
        r.add("hotswap", hotswap(cls, fromJar || fromJarFile, mixins.get("count").getAsInt()));
        return r;
    }

    /**
     * The loaded-class list, but only if a hotswap has ALREADY attached the agent. Deliberately does
     * not attach one: the whole point of this lookup is to answer "is this loaded" without changing
     * the answer, and attaching an agent to find out is a larger act than the read.
     *
     * <p>Takes the same first-non-shell copy {@code hotswap_class} does. The list has no defined
     * order, so taking the first match would report a MIXIN SHELL's empty method table as the class's
     * own whenever the real copy happened to sort later.
     */
    private static Class<?> findLoaded(final String name) {
        var inst = HotswapTools.instrumentationIfAttached();
        return inst == null ? null : HotswapTools.primary(HotswapTools.loadedCopies(inst, name));
    }

    private static String kind(final Class<?> cls) {
        if (cls.isAnnotation()) {
            return "annotation";
        }
        if (cls.isInterface()) {
            return "interface";
        }
        if (cls.isEnum()) {
            return "enum";
        }
        if (cls.isRecord()) {
            return "record";
        }
        return "class";
    }

    private static JsonArray modifiers(final int m) {
        JsonArray arr = new JsonArray();
        if (Modifier.isPublic(m)) {
            arr.add("public");
        }
        if (Modifier.isProtected(m)) {
            arr.add("protected");
        }
        if (Modifier.isPrivate(m)) {
            arr.add("private");
        }
        if (Modifier.isStatic(m)) {
            arr.add("static");
        }
        if (Modifier.isFinal(m)) {
            arr.add("final");
        }
        if (Modifier.isAbstract(m)) {
            arr.add("abstract");
        }
        if (Modifier.isSynchronized(m)) {
            arr.add("synchronized");
        }
        if (Modifier.isNative(m)) {
            arr.add("native");
        }
        return arr;
    }

    /**
     * Which mixins have merged methods into this class, and which methods each brought. Read off
     * {@code @MixinMerged} rather than out of mixin's registry - see the class note for what that
     * mechanism can and cannot see.
     */
    private static JsonObject mixins(final Class<?> cls) {
        JsonObject o = new JsonObject();
        o.addProperty("detection", "@MixinMerged markers on declared methods");
        TreeMap<String, List<String>> byMixin = new TreeMap<>();
        for (Method m : cls.getDeclaredMethods()) {
            String owner = mergedFrom(m);
            if (owner != null) {
                byMixin.computeIfAbsent(owner, k -> new ArrayList<>()).add(m.getName());
            }
        }
        JsonArray applied = new JsonArray();
        for (var e : byMixin.entrySet()) {
            JsonObject one = new JsonObject();
            one.addProperty("mixin", e.getKey());
            JsonArray ms = new JsonArray();
            e.getValue().stream().sorted().forEach(ms::add);
            one.add("methods", ms);
            applied.add(one);
        }
        o.add("applied", applied);
        o.addProperty("count", applied.size());
        if (applied.isEmpty()) {
            o.addProperty("note", "no merged methods - a mixin that only adds an interface, or only "
                + "injects into a method WITHOUT leaving a handler on this class, is invisible here");
        }
        return o;
    }

    /**
     * The first mixin that merged a method into this class, or null if none did — the same reading as
     * {@link #mixins}, reduced to the one fact a caller about to redefine the class needs. Shared with
     * {@link HotswapTools}, which refuses a mixin TARGET and names this mixin as the route instead.
     */
    static String anyMergedMixin(final Class<?> cls) {
        try {
            for (Method m : cls.getDeclaredMethods()) {
                String owner = mergedFrom(m);
                if (owner != null) {
                    return owner;
                }
            }
        } catch (RuntimeException | LinkageError e) {
            return null; // a class whose method table will not resolve is not a mixin target finding
        }
        return null;
    }

    /**
     * The {@code mixin} value of a method's {@code @MixinMerged}, or null. Matched on the annotation
     * type's SIMPLE NAME and read reflectively: mixin's internals are not a compile dependency of
     * this file, and NeoForge relocates the package.
     */
    private static String mergedFrom(final Method m) {
        for (Annotation ann : m.getDeclaredAnnotations()) {
            Class<? extends Annotation> t = ann.annotationType();
            if (!t.getSimpleName().equals(MIXIN_MERGED)) {
                continue;
            }
            try {
                Object v = t.getMethod("mixin").invoke(ann);
                return v == null ? t.getName() : v.toString();
            } catch (ReflectiveOperationException | RuntimeException e) {
                return t.getName(); // the marker is the finding; its shape is not
            }
        }
        return null;
    }

    private static JsonObject methods(final Class<?> cls, final boolean inherited,
                                      final String contains, final int limit) {
        Method[] all = inherited ? cls.getMethods() : cls.getDeclaredMethods();
        List<Method> keep = new ArrayList<>();
        for (Method m : all) {
            if (contains == null || m.getName().toLowerCase(java.util.Locale.ROOT).contains(contains)) {
                keep.add(m);
            }
        }
        keep.sort(Comparator.comparing(Method::getName).thenComparing(Method::getParameterCount));
        JsonObject o = new JsonObject();
        o.addProperty("count", keep.size());
        JsonArray arr = new JsonArray();
        for (int i = 0; i < Math.min(limit, keep.size()); i++) {
            Method m = keep.get(i);
            JsonObject one = new JsonObject();
            one.addProperty("name", m.getName());
            one.addProperty("returns", m.getReturnType().getSimpleName());
            JsonArray params = new JsonArray();
            for (Class<?> p : m.getParameterTypes()) {
                params.add(p.getSimpleName());
            }
            one.add("params", params);
            one.add("modifiers", modifiers(m.getModifiers()));
            String owner = mergedFrom(m);
            if (owner != null) {
                one.addProperty("mixin", owner);
            }
            if (inherited && !m.getDeclaringClass().equals(cls)) {
                one.addProperty("declared_by", m.getDeclaringClass().getName());
            }
            arr.add(one);
        }
        o.add("shown", arr);
        if (keep.size() > arr.size()) {
            o.addProperty("truncated", keep.size() - arr.size());
        }
        return o;
    }

    private static JsonObject fields(final Class<?> cls, final boolean inherited,
                                     final String contains, final int limit) {
        Field[] all = inherited ? cls.getFields() : cls.getDeclaredFields();
        List<Field> keep = new ArrayList<>();
        for (Field f : all) {
            if (contains == null || f.getName().toLowerCase(java.util.Locale.ROOT).contains(contains)) {
                keep.add(f);
            }
        }
        keep.sort(Comparator.comparing(Field::getName));
        JsonObject o = new JsonObject();
        o.addProperty("count", keep.size());
        JsonArray arr = new JsonArray();
        for (int i = 0; i < Math.min(limit, keep.size()); i++) {
            Field f = keep.get(i);
            JsonObject one = new JsonObject();
            one.addProperty("name", f.getName());
            // The REAL type, which is the half a decompiled tree gets wrong after remapping: the
            // erased type is what the JVM holds, the generic string is what the source said.
            one.addProperty("type", f.getType().getName());
            String generic = f.getGenericType().getTypeName();
            if (!generic.equals(f.getType().getName())) {
                one.addProperty("generic", generic);
            }
            one.add("modifiers", modifiers(f.getModifiers()));
            if (inherited && !f.getDeclaringClass().equals(cls)) {
                one.addProperty("declared_by", f.getDeclaringClass().getName());
            }
            arr.add(one);
        }
        o.add("shown", arr);
        if (keep.size() > arr.size()) {
            o.addProperty("truncated", keep.size() - arr.size());
        }
        return o;
    }

    /**
     * The precheck {@code hotswap_class} cannot perform for itself until it has already failed.
     * Everything here is a property of the LOADED class, so it is knowable before the call.
     */
    private static JsonObject hotswap(final Class<?> cls, final boolean jarish,
                                      final int mergedMixins) {
        JsonObject o = new JsonObject();
        boolean mixed = mergedMixins > 0;
        String vanilla = cls.getName().startsWith("net.minecraft.") ? "a Minecraft class" : null;
        // Asked of the RESOURCE a swap would read, not of the code source: the two disagree on a
        // mixin SHELL, which has no code source at all while its loader still resolves the .class out
        // of the classes directory. Reading the code source sent callers to 'dir' for a swap the
        // default already handles - a precheck that contradicts the tool it prechecks.
        URL res = HotswapTools.classpathResource(cls, cls.getName());
        if (res == null) {
            o.addProperty("classpath_default", false);
            o.addProperty("note", "this class's loader resolves no .class resource for it (a "
                + "generated or bootstrap class) - hotswap_class has nowhere to re-read bytes from; "
                + "pass 'file' or 'dir'");
        } else if (jarish || !"file".equals(res.getProtocol())) {
            o.addProperty("classpath_default", false);
            o.addProperty("note", "loaded from a jar, so hotswap_class' classpath default would "
                + "re-read the ALREADY-LOADED bytes and report success having changed nothing - pass "
                + "'file' or 'dir' pointing at freshly compiled classes");
        } else {
            o.addProperty("classpath_default", true);
        }
        if (mixed || vanilla != null) {
            o.addProperty("safe", false);
            o.addProperty("safety_note", (mixed ? "this class carries merged mixin methods"
                : "this is " + vanilla) + " - redefining it from compiled sources would silently drop "
                + "its load-time transforms, and hotswap_class refuses it.");
            String route = mergedOwner(cls);
            if (route != null) {
                o.addProperty("route", "swap " + route + " instead: since 0.149.0 redefining a MIXIN "
                    + "class makes Mixin's own agent re-apply it to this target. Changing what an "
                    + "existing injector does lands; adding one is structural and needs a restart.");
            }
        } else {
            o.addProperty("safe", true);
            if (isMixinClass(cls)) {
                o.addProperty("mixin_class", true);
                o.addProperty("route", "this IS a mixin and Mixin's hot-swap agent is watching it: "
                    + "redefining it re-applies it to its targets (0.149.0).");
            }
        }
        return o;
    }

    /** The mixin named in this class's merged methods, for the {@code route} line. */
    private static String mergedOwner(final Class<?> cls) {
        return anyMergedMixin(cls);
    }

    /**
     * Whether Mixin's agent is holding a shell for this class, which is the exact and only proof that
     * it is a registered mixin AND that the agent is armed to re-apply it. Needs the instrumentation,
     * so it answers false in a session that has not swapped anything yet - the same honest silence
     * {@code lookup} already reports.
     */
    private static boolean isMixinClass(final Class<?> cls) {
        if (MixinHotswap.isAgentShell(cls)) {
            // The usual case, and the one the first cut missed: a mixin is normally never defined in
            // Knot at all, so the shell is not a SECOND copy to be found beside the real one - it is
            // the only copy there is, and it is the one being asked about.
            return true;
        }
        Instrumentation inst = HotswapTools.instrumentationIfAttached();
        if (inst == null) {
            return false;
        }
        for (Class<?> other : inst.getAllLoadedClasses()) {
            if (other != cls && cls.getName().equals(other.getName()) && MixinHotswap.isAgentShell(other)) {
                return true;
            }
        }
        return false;
    }

    private static URL sourceOf(final Class<?> cls) {
        try {
            CodeSource cs = cls.getProtectionDomain().getCodeSource();
            return cs == null ? null : cs.getLocation();
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String str(final JsonObject a, final String key) {
        if (!a.has(key) || a.get(key).isJsonNull()) {
            throw new IllegalArgumentException("missing argument '" + key + "'");
        }
        return a.get(key).getAsString();
    }
}
