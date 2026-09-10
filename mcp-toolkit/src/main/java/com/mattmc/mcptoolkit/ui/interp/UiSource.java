package com.mattmc.mcptoolkit.ui.interp;

import com.mattmc.mcptoolkit.ui.doc.PartLibrary;
import com.mattmc.mcptoolkit.ui.doc.UiDocument;
import com.mattmc.mcptoolkit.ui.doc.UiParseException;
import com.mattmc.mcptoolkit.ui.doc.UiParser;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.resources.Identifier;
import net.minecraft.server.packs.resources.Resource;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;

/**
 * Where a document comes from, re-readable: the screen re-reads on every {@code init()}
 * (SCREEN_AUTHORING_DESIGN.md section 1 - "make the destination the document, have init() re-read
 * it, and the objection is gone").
 *
 * <ul>
 *   <li>{@link Res}: {@code mymod:catalog} names {@code assets/mymod/ui/catalog.ui.json} through the
 *       resource manager, which is what gives {@code /reload} (then reopen) the new file for free -
 *       the reason section 4 puts the document in {@code resources/}.</li>
 *   <li>{@link File}: a path on disk, for a document that is not on any resource pack yet - the
 *       toolkit's own dev game previewing a file in a sibling checkout, or a test fixture.</li>
 * </ul>
 */
@Environment(EnvType.CLIENT)
public sealed interface UiSource {
    /** A human-readable name for replies and the screen's own error line. */
    String describe();

    /** The document's text, fresh. */
    String read() throws IOException;

    /**
     * Where THIS document's parts come from (UI_PARTS_LIBRARY_DESIGN.md section 5).
     *
     * <p>The ambient library by default - in the dev game that is the classpath plus the resource
     * manager, so every loaded mod's parts resolve. A document opened by PATH may live in a checkout
     * this game never loaded, so it adds its own resources root in front: the preview would otherwise
     * refuse a part that is sitting right beside the file it was told to open.
     */
    default PartLibrary library() {
        return PartLibrary.current();
    }

    default UiDocument load() throws IOException, UiParseException {
        try (PartLibrary.Scope scope = PartLibrary.scoped(library())) {
            return UiParser.parse(read());
        }
    }

    /** {@code <ns>:<screen>} → {@code assets/<ns>/ui/<screen>.ui.json}. */
    static Identifier resourceFor(final Identifier screen) {
        return Identifier.fromNamespaceAndPath(screen.getNamespace(), "ui/" + screen.getPath() + ".ui.json");
    }

    record Res(Identifier screen) implements UiSource {
        @Override
        public String describe() {
            return screen.toString();
        }

        @Override
        public String read() throws IOException {
            Identifier file = resourceFor(screen);
            Optional<Resource> r = Minecraft.getInstance().getResourceManager().getResource(file);
            if (r.isEmpty()) {
                throw new IOException("no resource " + file + " (assets/" + screen.getNamespace()
                    + "/ui/" + screen.getPath() + ".ui.json on any loaded pack)");
            }
            try (BufferedReader in = r.get().openAsReader()) {
                StringBuilder sb = new StringBuilder();
                char[] buf = new char[4096];
                int n;
                while ((n = in.read(buf)) >= 0) {
                    sb.append(buf, 0, n);
                }
                return sb.toString();
            }
        }
    }

    record File(Path path) implements UiSource {
        @Override
        public String describe() {
            return path.toAbsolutePath().toString();
        }

        @Override
        public PartLibrary library() {
            // <root>/assets/<mod>/ui/<screen>.ui.json - the same derivation UiProject makes, for the
            // same reason: the path already states it.
            Path ui = path.toAbsolutePath().getParent();
            Path mod = ui == null ? null : ui.getParent();
            Path assets = mod == null ? null : mod.getParent();
            Path root = assets == null ? null : assets.getParent();
            return root == null ? PartLibrary.current()
                : PartLibrary.chain(PartLibrary.assets(root), PartLibrary.current());
        }

        @Override
        public String read() throws IOException {
            return Files.readString(path, StandardCharsets.UTF_8);
        }
    }
}
