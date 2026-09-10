package com.mattmc.mcptoolkit.client;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;

/**
 * Client-only tools. Registered from the client entrypoint, so they appear in the manifest only when a
 * client is present (never on a dedicated server).
 */
@Environment(EnvType.CLIENT)
public final class ClientTools {
    private ClientTools() {}

    public static void register() {
        McpTools.register(ToolDef.of(
            "get_chat",
            "Read recent chat and system messages the client has received (oldest first, most recent last). Use it to read command feedback, player chat, and game notifications. The result carries coverage: buffered vs total_received (the ring holds the last 200 and is wiped on disconnect), so dropped>0 means older messages are gone, not that they never happened.",
            Schemas.objectOpt(Schemas.object("limit", Schemas.integer("Max messages to return (default 50).")), "limit"),
            ExecutionContext.CLIENT,
            Mechanism.OBSERVE,
            (ctx, a) -> {
                int limit = a.has("limit") && !a.get("limit").isJsonNull() ? a.get("limit").getAsInt() : 50;
                if (limit <= 0) {
                    limit = 50;
                }
                JsonObject r = new JsonObject();
                r.add("messages", ChatLog.tail(limit));
                JsonObject stats = ChatLog.stats();
                for (var en : stats.entrySet()) {
                    r.add(en.getKey(), en.getValue());
                }
                return r;
            }));
    }
}
