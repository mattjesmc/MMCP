package com.mattmc.mcptoolkit.platform;

import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.McpToolkitEntrypoint;
import com.mattmc.mcptoolkit.platform.LoaderPlatform.Extension;

import java.lang.reflect.InvocationTargetException;
import java.util.ArrayList;
import java.util.List;

/**
 * The loader-neutral half of extension discovery: the service file's name, its grammar, and the
 * lazy construction of what it names. Each {@link LoaderPlatform} supplies only the loader-specific
 * half — walking its own list of loaded mods and handing over the text of that file, with the mod id
 * it came from (see {@code CROSS_LOADER_DESIGN.md} §5.2, Stage 3).
 *
 * <h2>Why the file is read by hand rather than by {@code ServiceLoader}</h2>
 *
 * <p>Three reasons, and the first is the one this subsystem exists for.
 *
 * <p><b>Containment.</b> {@code ServiceLoader} resolves each provider inside {@code hasNext()} and
 * throws {@code ServiceConfigurationError} out of the iterator, so one unloadable provider aborts the
 * whole iteration — every later extension loses its tools because an unrelated mod was built against
 * a different toolkit version. Here, discovery reads text and nothing else: <b>no extension class is
 * loaded during the scan at all</b>. Loading happens inside the {@link Extension}'s supplier, which
 * {@code Extensions.discover()} already calls inside a per-mod {@code try}. A {@code LinkageError}
 * from one mod's class therefore costs exactly that mod's tools, through the containment that was
 * already there, rather than through a second guard that has to be kept in step with it.
 *
 * <p><b>Attribution.</b> {@code ServiceLoader} hands back instances and no idea who provided them.
 * {@code ping}'s {@code extensions} array — the place you look when a mod's tool is missing from the
 * manifest — is keyed by mod id. Reading the file out of one mod's own contents means the id is
 * where the file is, rather than something recovered afterwards from a URL or declared a second time
 * by the modder and able to disagree.
 *
 * <p><b>Module declarations.</b> NeoForge loads mods as real modules; a genuine {@code ServiceLoader}
 * lookup across them drags in {@code provides}/{@code uses} declarations (the {@code usesServices}
 * key in {@code neoforge.mods.toml}). {@code Class.forName} on a shared classloader needs none of it.
 *
 * <p>The file keeps {@code META-INF/services/} and {@code ServiceLoader}'s grammar anyway, because
 * that is the shape every modder already recognises, and because a mod that also wants to be found
 * by a real {@code ServiceLoader} for its own reasons loses nothing.
 */
public final class ServiceExtensions {
    private ServiceExtensions() {}

    /**
     * Where an extension mod declares itself, on any loader:
     * {@code META-INF/services/com.mattmc.mcptoolkit.McpToolkitEntrypoint}, one implementation class
     * per line. Derived from the interface rather than written out, so renaming it cannot leave the
     * two halves of the contract disagreeing.
     */
    public static final String SERVICE_FILE = "META-INF/services/" + McpToolkitEntrypoint.class.getName();

    /**
     * Turn one mod's service file into its extensions, appending to {@code out}.
     *
     * <p>Nothing here touches the named classes. The {@link Extension} supplier carries the name and
     * resolves it on demand, which is both the containment above and the promise {@code EXTENDING.md}
     * makes to modders: an extension class is loaded only when the toolkit asks for it, so a mod that
     * ships one needs no "is the toolkit present" guard.
     */
    public static void collect(final String modId, final String fileText, final List<Extension> out) {
        for (String className : classNames(fileText)) {
            out.add(new Extension(modId, () -> instantiate(className)));
        }
    }

    /**
     * {@code ServiceLoader}'s own grammar: one binary class name per line, {@code #} starts a comment
     * to end of line, blank lines ignored.
     */
    static List<String> classNames(final String fileText) {
        List<String> out = new ArrayList<>();
        for (String raw : fileText.split("\\R")) {
            int comment = raw.indexOf('#');
            String line = (comment < 0 ? raw : raw.substring(0, comment)).trim();
            if (!line.isEmpty()) {
                out.add(line);
            }
        }
        return out;
    }

    /**
     * The toolkit's own classloader, deliberately: on both loaders every mod shares it with the
     * toolkit, and it is the same loader Fabric's entrypoint mechanism resolves against. The thread
     * context classloader would be a different question with a different answer depending on which
     * thread ran init.
     */
    private static McpToolkitEntrypoint instantiate(final String className) {
        try {
            Class<?> type = Class.forName(className, true, ServiceExtensions.class.getClassLoader());
            return (McpToolkitEntrypoint) type.getDeclaredConstructor().newInstance();
        } catch (InvocationTargetException e) {
            // The mod's constructor threw. Report ITS failure, not the reflection wrapper's - the
            // recorded reason ends up in ping, where "InvocationTargetException" says nothing.
            Throwable cause = e.getCause() == null ? e : e.getCause();
            throw new IllegalStateException(className + " threw from its constructor", cause);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(
                className + " is declared in " + SERVICE_FILE + " but could not be instantiated"
                    + " (it must be public, implement McpToolkitEntrypoint, and have a no-argument"
                    + " constructor)", e);
        }
    }

    /** Shared by both platforms: a service file that cannot be read is that mod's problem alone. */
    public static void warnUnreadable(final String modId, final Throwable t) {
        McpToolkit.LOGGER.warn("[MCP Toolkit] mod '{}' declares {} but it could not be read: {}",
            modId, SERVICE_FILE, t.toString());
    }
}
