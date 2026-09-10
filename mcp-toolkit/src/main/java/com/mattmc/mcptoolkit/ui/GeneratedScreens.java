package com.mattmc.mcptoolkit.ui;

import com.mattmc.mcptoolkit.ui.doc.UiDocument;
import net.minecraft.world.MenuProvider;
import org.jspecify.annotations.Nullable;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/**
 * The documents that have a GENERATED counterpart loaded in this JVM, by resource id - the other
 * side of SCREEN_AUTHORING_DESIGN.md section 12's comparison.
 *
 * <p>The interpreter can show any document; the generated screen exists only where a mod compiled
 * it in. This registry is how {@code open_screen {ui, generated:true}} finds a provider for the
 * document's real menu, and how {@code get_screen} recognises a generated screen class as that
 * document's. The toolkit's own sample ({@code ui.sample}, the shipped example) registers here at
 * init; a mod under development can register its own from its {@code mcptoolkit} entrypoint so the
 * conformance battery (slice 3) can run against it.
 */
public final class GeneratedScreens {
    private GeneratedScreens() {}

    /**
     * @param docId           the document's resource id, e.g. {@code mcptoolkit:example}
     * @param provider        builds a server-side menu provider for the document - the sample fills
     *                        its containers from the document's placeholders and answers bindings
     *                        from their preview values, so the two renderers show the same state
     * @param screenClassName the generated screen's class, so {@code get_screen} can name the document
     */
    public record Entry(String docId, Function<UiDocument, MenuProvider> provider, String screenClassName) {}

    private static final Map<String, Entry> BY_DOC = new LinkedHashMap<>();
    private static final Map<String, Entry> BY_SCREEN = new LinkedHashMap<>();
    private static volatile @Nullable String lastAction;

    public static synchronized void register(final String docId, final Function<UiDocument, MenuProvider> provider,
                                             final String screenClassName) {
        Entry e = new Entry(docId, provider, screenClassName);
        BY_DOC.put(docId, e);
        BY_SCREEN.put(screenClassName, e);
    }

    public static synchronized @Nullable Entry forDocument(final String docId) {
        return BY_DOC.get(docId);
    }

    public static synchronized @Nullable Entry forScreenClass(final String className) {
        return BY_SCREEN.get(className);
    }

    public static synchronized Set<String> documents() {
        return Collections.unmodifiableSet(new java.util.LinkedHashSet<>(BY_DOC.keySet()));
    }

    /** The last action a generated sample menu received on the server - what a probe reads to prove the channel. */
    public static void recordAction(final String action) {
        lastAction = action;
    }

    public static @Nullable String lastAction() {
        return lastAction;
    }
}
