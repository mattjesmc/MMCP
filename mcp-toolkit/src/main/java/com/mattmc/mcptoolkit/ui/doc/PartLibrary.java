package com.mattmc.mcptoolkit.ui.doc;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * <b>Where a {@code part} element's fragment comes from</b> (UI_PARTS_LIBRARY_DESIGN.md section 5).
 *
 * <p>A part lives at {@code assets/<namespace>/ui/parts/<name>.part.json}, and there are three hosts
 * that have to find one, none of which can use the other's mechanism:
 *
 * <ul>
 *   <li>the <b>dev game</b>, where every loaded mod's parts are on the resource manager - including
 *       another mod's, which is the whole point of a shared library ({@code mcptoolkit:player_inventory}
 *       used from villagejobs);</li>
 *   <li>the <b>Gradle task</b>, which runs {@code UiGenerate} in a JVM whose classpath is the toolkit
 *       jar plus Gson - so the toolkit's own parts are on {@link #classpath()} and the mod's own are
 *       in its source tree ({@link #assets});</li>
 *   <li>the <b>unit battery</b>, which hands over {@link #of} and needs no files at all.</li>
 * </ul>
 *
 * <p><b>Why the ambient default is a thread-local and not a parameter.</b> {@link UiEdit} re-parses
 * the whole document on every mutation and {@link UiLint} parses to check one - threading a library
 * through both would put it in a dozen signatures that have nothing to do with parts. Instead a host
 * declares its library for the duration of a call ({@link #scoped}), and the process-wide
 * {@link #install} names the one every thread falls back to. The failure mode of getting it wrong is
 * loud rather than silent: an unresolvable part is a parse problem naming the file it looked for.
 *
 * <p>Imports no Minecraft (section 7.1). The resource-manager library is the client's, installed
 * from there.
 */
@FunctionalInterface
public interface PartLibrary {

    /** The part file's text, or {@code null} when this library does not have it. */
    String read(String namespace, String name) throws IOException;

    /** Where this library looked, for the sentence a refusal prints. Empty is fine. */
    default List<String> describe(final String namespace, final String name) {
        return List.of();
    }

    /** {@code <ns>:<name>} to the resource path every host resolves relative to. */
    static String pathOf(final String namespace, final String name) {
        return "assets/" + namespace + "/ui/parts/" + name + ".part.json";
    }

    // ---------------------------------------------------------------------------------------------
    // The implementations

    /** Nothing at all: every part is missing. The default before a host installs one. */
    static PartLibrary empty() {
        return new PartLibrary() {
            @Override
            public String read(final String namespace, final String name) {
                return null;
            }

            @Override
            public List<String> describe(final String namespace, final String name) {
                return List.of("no part library is installed in this process");
            }
        };
    }

    /**
     * The running JVM's classpath: {@code /assets/<ns>/ui/parts/<name>.part.json}.
     *
     * <p>This is what makes the toolkit's own seed library reachable from a consumer mod's
     * {@code generateUi}, whose classpath is exactly the toolkit jar - no wiring, no new task input.
     */
    static PartLibrary classpath() {
        return new PartLibrary() {
            @Override
            public String read(final String namespace, final String name) throws IOException {
                try (InputStream in = PartLibrary.class.getResourceAsStream("/" + pathOf(namespace, name))) {
                    return in == null ? null : new String(in.readAllBytes(), StandardCharsets.UTF_8);
                }
            }

            @Override
            public List<String> describe(final String namespace, final String name) {
                return List.of("the classpath (/" + pathOf(namespace, name) + ")");
            }
        };
    }

    /**
     * A resources root on disk - the directory {@code assets/} sits in.
     *
     * <p>A mod's own parts, from its own source tree, which is the copy a save writes and git keeps.
     */
    static PartLibrary assets(final Path resourcesRoot) {
        return new PartLibrary() {
            @Override
            public String read(final String namespace, final String name) throws IOException {
                Path p = resourcesRoot.resolve(pathOf(namespace, name));
                return Files.isRegularFile(p) ? Files.readString(p, StandardCharsets.UTF_8) : null;
            }

            @Override
            public List<String> describe(final String namespace, final String name) {
                return List.of(resourcesRoot.resolve(pathOf(namespace, name)).toString());
            }
        };
    }

    /** A fixed set, for a test or a caller that already has the text. Keys are {@code ns:name}. */
    static PartLibrary of(final java.util.Map<String, String> parts) {
        return new PartLibrary() {
            @Override
            public String read(final String namespace, final String name) {
                return parts.get(namespace + ":" + name);
            }

            @Override
            public List<String> describe(final String namespace, final String name) {
                return List.of("the supplied parts " + new java.util.TreeSet<>(parts.keySet()));
            }
        };
    }

    /** The first library that has it wins; a refusal lists everywhere all of them looked. */
    static PartLibrary chain(final PartLibrary... libraries) {
        List<PartLibrary> all = List.of(libraries);
        return new PartLibrary() {
            @Override
            public String read(final String namespace, final String name) throws IOException {
                for (PartLibrary l : all) {
                    String text = l.read(namespace, name);
                    if (text != null) {
                        return text;
                    }
                }
                return null;
            }

            @Override
            public List<String> describe(final String namespace, final String name) {
                Set<String> out = new LinkedHashSet<>();
                for (PartLibrary l : all) {
                    out.addAll(l.describe(namespace, name));
                }
                return new ArrayList<>(out);
            }
        };
    }

    // ---------------------------------------------------------------------------------------------
    // The ambient library

    /** Holder rather than a field on the interface, which cannot have one. */
    final class Ambient {
        private Ambient() {}

        private static volatile PartLibrary installed = chain(classpath());
        private static final ThreadLocal<PartLibrary> CURRENT = new ThreadLocal<>();
    }

    /** The library this thread parses against: its scope, else the process-wide one. */
    static PartLibrary current() {
        PartLibrary scoped = Ambient.CURRENT.get();
        return scoped != null ? scoped : Ambient.installed;
    }

    /** Set the process-wide library. The dev game does this once at init; Gradle uses {@link #scoped}. */
    static void install(final PartLibrary library) {
        Ambient.installed = library == null ? empty() : library;
    }

    /**
     * Use {@code library} on this thread until the returned handle is closed.
     *
     * <pre>{@code
     * try (PartLibrary.Scope s = PartLibrary.scoped(PartLibrary.assets(root))) {
     *     doc = UiParser.parse(text);
     * }
     * }</pre>
     */
    static Scope scoped(final PartLibrary library) {
        PartLibrary previous = Ambient.CURRENT.get();
        Ambient.CURRENT.set(library);
        return () -> {
            if (previous == null) {
                Ambient.CURRENT.remove();
            } else {
                Ambient.CURRENT.set(previous);
            }
        };
    }

    /** What {@link #scoped} hands back; closing it puts the previous library back. */
    interface Scope extends AutoCloseable {
        @Override
        void close();
    }
}
