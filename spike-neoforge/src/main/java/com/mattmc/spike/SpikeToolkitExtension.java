package com.mattmc.spike;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpToolkitEntrypoint;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import com.mattmc.mcptoolkit.ToolRegistrar;

/**
 * CROSS_LOADER_DESIGN.md §7 Stage 3 — the arbiter for extension discovery on NeoForge.
 *
 * <p>The question this answers is not "does the code compile": it is whether one mod can hand another
 * mod's class to the toolkit at all on this loader. Fabric's entrypoint mechanism has no NeoForge
 * analogue, so 0.83.0 reads {@code META-INF/services/com.mattmc.mcptoolkit.McpToolkitEntrypoint} out
 * of every loaded mod's own contents and resolves the name with {@code Class.forName} on the toolkit's
 * classloader. Both halves of that are claims about NeoForge that no Fabric boot can test:
 *
 * <ul>
 *   <li>that a source-set dev mod's resources are visible through {@code JarContents}, and</li>
 *   <li>that the toolkit's classloader can resolve a class belonging to a different mod, which on
 *       NeoForge is a different named module.</li>
 * </ul>
 *
 * <p>Green looks like {@code spike_toolkit_probe} in {@code GET /tools} with
 * {@code "source": "spike"}, and {@code ping}'s {@code extensions} array carrying one entry for
 * {@code spike}. Red — if the class cannot be resolved — is that same entry with a populated
 * {@code failures} list, because discovery failures are contained per mod rather than thrown.
 *
 * <p>This class is never referenced from {@link SpikeMod}, deliberately: that is the rule
 * {@code EXTENDING.md} states, and it is what keeps the spike bootable with no toolkit jar in
 * a toolkit jar in the run directory's {@code mods/}.
 */
public final class SpikeToolkitExtension implements McpToolkitEntrypoint {

    @Override
    public void registerTools(final ToolRegistrar registrar) {
        registrar.register(ToolDef.of(
            "spike_toolkit_probe",
            "Cross-loader spike: confirm that an extension mod's tool reached the toolkit on this "
                + "loader. Returns {loader, ok}.",
            Schemas.object(),
            ExecutionContext.ANY,
            Mechanism.OBSERVE,
            (ctx, args) -> {
                JsonObject r = new JsonObject();
                r.addProperty("ok", true);
                r.addProperty("registeredBy", "spike");
                return r;
            }));
    }
}
