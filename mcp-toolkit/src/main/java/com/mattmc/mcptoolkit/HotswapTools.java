package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.sun.tools.attach.VirtualMachine;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.instrument.ClassDefinition;
import java.lang.instrument.Instrumentation;
import java.net.URL;
import java.net.URLConnection;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
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
 * {@code -Djdk.attach.allowAttachSelf=true} on the game JVM (set in the root project's loom client AND
 * server runs).
 *
 * <p>Mod classes only: redefining a class that was transformed at load (mixin targets, remapped
 * Minecraft classes) with freshly compiled bytes would silently drop those transforms.
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
                + "loaded from a jar (pass \"file\" or \"dir\" for those). MOD CLASSES ONLY: redefining a "
                + "mixin-transformed or remapped Minecraft class from compiled sources would silently drop "
                + "its load-time transforms.",
            Schemas.objectOpt(
                Schemas.object(
                    "class", Schemas.str("Binary name of the loaded class to redefine."),
                    "classes", Schemas.array(Schemas.str("Binary class name.")),
                    "file", Schemas.str("Absolute path to the replacement .class file (single-class only)."),
                    "dir", Schemas.str("Classes root directory to resolve the .class files under.")),
                "class", "classes", "file", "dir"),
            ExecutionContext.ANY,
            Mechanism.PRIVILEGED,
            (ctx, args) -> hotswap(args)));
    }

    private static JsonObject hotswap(JsonObject args) {
        List<String> names = new ArrayList<>();
        if (args.has("classes") && !args.get("classes").isJsonNull()) {
            args.getAsJsonArray("classes").forEach(el -> names.add(el.getAsString()));
        }
        if (args.has("class") && !args.get("class").isJsonNull()) {
            names.add(args.get("class").getAsString());
        }
        if (names.isEmpty()) {
            throw new IllegalArgumentException("provide 'class' or a non-empty 'classes' array");
        }
        boolean hasFile = args.has("file") && !args.get("file").isJsonNull();
        if (hasFile && names.size() > 1) {
            throw new IllegalArgumentException("'file' names one .class file — use 'dir' for a batch");
        }

        String source = hasFile ? "file"
            : args.has("dir") && !args.get("dir").isJsonNull() ? "dir"
            : "classpath";
        ClassDefinition[] defs = new ClassDefinition[names.size()];
        long totalBytes = 0;
        for (int i = 0; i < names.size(); i++) {
            String name = names.get(i);
            Class<?> cls;
            try {
                cls = Class.forName(name, false, HotswapTools.class.getClassLoader());
            } catch (ClassNotFoundException e) {
                throw new IllegalArgumentException("class not loaded (or unknown): " + name);
            }
            byte[] bytes;
            try {
                bytes = switch (source) {
                    case "file" -> Files.readAllBytes(Path.of(args.get("file").getAsString()));
                    case "dir" -> Files.readAllBytes(
                        Path.of(args.get("dir").getAsString(), name.replace('.', '/') + ".class"));
                    default -> readFromClasspath(cls, name);
                };
            } catch (Exception e) {
                throw new IllegalArgumentException("could not read replacement bytes for " + name + ": " + e);
            }
            defs[i] = new ClassDefinition(cls, bytes);
            totalBytes += bytes.length;
        }

        try {
            instrumentation().redefineClasses(defs);
        } catch (UnsupportedOperationException e) {
            throw new IllegalStateException(
                "structural change rejected (" + e.getMessage() + ") — method-body edits only; restart for this one");
        } catch (Exception e) {
            throw new IllegalStateException("redefine failed: " + e);
        }

        JsonObject r = new JsonObject();
        JsonArray redefined = new JsonArray();
        names.forEach(redefined::add);
        r.add("redefined", redefined);
        r.addProperty("count", names.size());
        r.addProperty("bytes", totalBytes);
        r.addProperty("source", source);
        return r;
    }

    /**
     * Read the class's bytes from wherever its loader finds them, with URL caching off so a classes
     * DIRECTORY yields the post-recompile bytes. A jar: URL yields the (stale) jar contents — redefining
     * with them would report success while changing nothing, so refuse loudly instead.
     */
    private static byte[] readFromClasspath(Class<?> cls, String name) throws Exception {
        String res = name.replace('.', '/') + ".class";
        ClassLoader cl = cls.getClassLoader();
        URL url = cl != null ? cl.getResource(res) : ClassLoader.getSystemResource(res);
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
