package com.mattmc.mcptoolkit.hooks;

import com.mattmc.mcptoolkit.McpToolkit;
import net.minecraft.locale.Language;

import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * The toolkit's own {@code en_us} strings, loaded from its jar so that vanilla's bootstrap validator
 * can be told about them.
 *
 * <p><b>Why this exists at all.</b> {@code Language.DEFAULT_INSTANCE} is built by
 * {@code Language.loadDefault()}, which reads exactly one file — {@code /assets/minecraft/lang/en_us.json},
 * out of the game's own jar, through {@code Language.class.getResourceAsStream}. No mod's
 * {@code assets/} is on that path and none can be: a mod that won that single-resource lookup would
 * REPLACE vanilla's whole map rather than add to it. So the map that
 * {@code Bootstrap.getMissingTranslations} checks against is structurally blind to modded strings,
 * and shipping {@code assets/mcptoolkit/lang/en_us.json} — which is the right fix for everything a
 * player actually sees, since {@code ToolkitResourcePack} mounts it on Fabric and NeoForge exposes it
 * itself — cannot silence that check.
 *
 * <p>It only bites this mod because of WHEN the toolkit registers. An ordinary mod's entity types are
 * registered from a mod entrypoint, which runs after {@code Bootstrap.validate()}, so the validator
 * never sees them. {@code BuiltInRegistriesMixin} deliberately registers the bodies during vanilla's
 * own bootstrap (that is what makes the toolkit loader-only), which puts {@code mcptoolkit:drone} and
 * {@code mcptoolkit:walker} in {@code BuiltInRegistries.ENTITY_TYPE} while the validator is still to
 * come. {@code BootstrapMixin} closes the loop by filtering the keys this file DOES provide out of the
 * missing set.
 *
 * <p>The keys are read from the shipped file rather than listed here on purpose: a hardcoded copy is a
 * second place to keep in step, and it would silence a key whose translation had been deleted.
 *
 * <p>Scoped to the toolkit's own strings, not every loaded mod's. An extension mod registers through
 * the normal entrypoint path, which is past {@code validate()}, so it never has this problem.
 */
public final class ToolkitTranslations {
    private ToolkitTranslations() {}

    /** Classloader-relative, so this is the same lookup on every loader — the toolkit's own jar. */
    private static final String PATH = "/assets/mcptoolkit/lang/en_us.json";

    private static volatile Map<String, String> entries;

    /** The toolkit's shipped en_us map; empty (never null) if the file is missing or unreadable. */
    public static Map<String, String> entries() {
        Map<String, String> local = entries;
        if (local == null) {
            synchronized (ToolkitTranslations.class) {
                local = entries;
                if (local == null) {
                    local = load();
                    entries = local;
                }
            }
        }
        return local;
    }

    /** Whether the toolkit ships a string for this translation key. */
    public static boolean has(final String key) {
        return entries().containsKey(key);
    }

    private static Map<String, String> load() {
        Map<String, String> out = new HashMap<>();
        try (InputStream in = ToolkitTranslations.class.getResourceAsStream(PATH)) {
            if (in == null) {
                McpToolkit.LOGGER.warn("[MCP Toolkit] no {} in the jar — the bodies will show raw"
                    + " translation keys", PATH);
                return Map.of();
            }
            // Vanilla's own parser, so this file is read with exactly the semantics the game would
            // use for it — including how it handles a malformed entry.
            Language.loadFromJson(in, out::put);
        } catch (Exception e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] could not read {}: {}", PATH, e.toString());
            return Map.of();
        }
        return Map.copyOf(out);
    }
}
