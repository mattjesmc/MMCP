package com.mattmc.mcptoolkit.ui.interp;

import com.mattmc.mcptoolkit.ui.doc.PartLibrary;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.resources.Identifier;
import net.minecraft.server.packs.resources.Resource;

import java.io.BufferedReader;
import java.io.IOException;
import java.util.List;
import java.util.Optional;

/**
 * The dev game's part library: <b>every loaded mod's</b> {@code assets/<ns>/ui/parts/*.part.json},
 * through the resource manager (UI_PARTS_LIBRARY_DESIGN.md section 5).
 *
 * <p>Which is the whole point of a shared library: a screen in villagejobs writes
 * {@code "part": "mcptoolkit:player_inventory"} and the toolkit's copy is the one that answers.
 * Chained BEHIND the classpath so a part edited in the source tree beats the packaged one, and
 * ahead of nothing - a part that is on neither is a refusal naming both places it looked.
 *
 * <p>Lives in {@code ui.interp} rather than {@code ui.doc} for the reason that whole split exists
 * (section 7.1): the model imports no Minecraft, and a resource manager is Minecraft.
 */
@Environment(EnvType.CLIENT)
public final class ResourceParts {
    private ResourceParts() {}

    /** Install the client's library: the classpath first, then whatever packs are loaded. */
    public static void install() {
        PartLibrary.install(PartLibrary.chain(PartLibrary.classpath(), resourceManager()));
    }

    public static PartLibrary resourceManager() {
        return new PartLibrary() {
            @Override
            public String read(final String namespace, final String name) throws IOException {
                Minecraft mc = Minecraft.getInstance();
                if (mc == null || mc.getResourceManager() == null) {
                    return null; // before the first pack load there is nothing to read
                }
                Identifier file = Identifier.fromNamespaceAndPath(namespace, "ui/parts/" + name + ".part.json");
                Optional<Resource> r = mc.getResourceManager().getResource(file);
                if (r.isEmpty()) {
                    return null;
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

            @Override
            public List<String> describe(final String namespace, final String name) {
                return List.of("the loaded resource packs (" + PartLibrary.pathOf(namespace, name) + ")");
            }
        };
    }
}
