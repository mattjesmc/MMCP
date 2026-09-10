package com.mattmc.mcptoolkit.wm;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.ToolDef;
import org.jspecify.annotations.Nullable;

import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/**
 * The §14.3 step-1 normalization layer: every act tool call becomes an intent record — the §16.2
 * request envelope {@code {verb, selector|at, shape, item, rights, persistence, priority}} — in the
 * episodes stream, BEFORE the call reaches GoalRunner. The LLM-facing surface does not change;
 * this proves the grammar covers the real traffic, and any act call that cannot normalize is a
 * grammar bug found for free (loud log, {@code intent_unnormalizable} row).
 *
 * <p>Verbs are the §14.1 closed set (+{@code scan} per §16.1). Two deliberate v1 accommodations,
 * both §16.4 micro-tool artifacts that fold into the executor later: {@code bot_look} normalizes
 * as verb {@code look}, {@code bot_select} as {@code equip} with {@code meta.micro} — recorded
 * rather than logged forever, dropped when the surface folds them. Surface artifacts that are not
 * §16.2 fields (cancel, wait, micro provenance) ride a {@code meta} object so the envelope proper
 * stays clean.
 */
public final class WmIntents {
    private WmIntents() {}

    /** Tools that are embodied but not §14 acts: lifecycle, senses, operator surface.
     *  <p>{@code wm_perturb} belongs here for the same reason and a sharper one: it is EMBODIED by
     *  a correct declaration (it drives input frames) but it is the OPPOSITE of an agent act — the
     *  hijacked ticks are recorded as actor {@code perturb} and deliberately never supervised. Left
     *  out, it trips the coverage tripwire once per perturbation, and taskgen fires one every
     *  30-60s, so a 55-minute chunk writes ~60-100 {@code intent_unnormalizable} rows and the
     *  "zero grammar warnings" signal — which has caught two real bugs — reads as noise for the
     *  whole v3 campaign. */
    private static final Set<String> SKIP = Set.of(
        "bot_body", "bot_profile", "bot_status", "bot_watch", "sense_entities", "bot_point",
        "bot_give", "wm_perturb");

    private static final Map<String, Function<JsonObject, JsonObject>> ACTS = Map.ofEntries(
        Map.entry("bot_goto", WmIntents::goTo),
        Map.entry("bot_target", WmIntents::target),
        Map.entry("bot_tunnel", WmIntents::tunnel),
        Map.entry("bot_mine", a -> once("destroy", a, at(a), item(a, "item"))),
        Map.entry("bot_place", a -> once("place", a, at(a),
            item(a, "state") != null ? item(a, "state") : item(a, "item"))),
        Map.entry("bot_use", WmIntents::use),
        Map.entry("bot_attack", a -> once("attack", a, entitySelector(a), item(a, "item"))),
        Map.entry("bot_shoot", a -> once("shoot", a, entitySelector(a), item(a, "item"))),
        Map.entry("bot_eat", a -> once("eat", a, null, item(a, "item"))),
        Map.entry("bot_drink", a -> once("drink", a, null, item(a, "item"))),
        Map.entry("bot_craft", WmIntents::craft),
        Map.entry("bot_equip", WmIntents::equip),
        Map.entry("bot_select", WmIntents::select),
        Map.entry("bot_look", WmIntents::look),
        Map.entry("bot_follow", WmIntents::follow),
        Map.entry("bot_run", WmIntents::run),
        Map.entry("bot_container", WmIntents::container),
        Map.entry("bot_surface", WmIntents::surface),
        Map.entry("bot_reactions", WmIntents::reactions));

    /** The bridge-dispatch hook: record the intent for an act call, warn once about embodied tools
     *  the grammar has never heard of (a coverage tripwire for future tools). */
    public static void record(final ToolDef def, final JsonObject args, final @Nullable String session) {
        Function<JsonObject, JsonObject> normalizer = ACTS.get(def.name());
        if (normalizer == null) {
            if (def.mechanism() == Mechanism.EMBODIED && !SKIP.contains(def.name())) {
                Wm.intent(session, def.name(), null); // embodied act with no mapping: loud
            }
            return;
        }
        JsonObject intent;
        try {
            intent = normalizer.apply(args);
        } catch (RuntimeException e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] wm intent normalization threw for '{}': {}",
                def.name(), e.toString());
            intent = null;
        }
        if (intent == null && !isSurfaceManagement(def.name(), args)) {
            Wm.intent(session, def.name(), null);
        } else if (intent != null) {
            Wm.intent(session, def.name(), intent);
        }
    }

    /** bot_mine action:"cancel", bot_reactions list/clear/disarm, bot_follow stop:true — surface
     *  management of a running/armed intent, not a new act; no record, no grammar complaint. */
    private static boolean isSurfaceManagement(final String tool, final JsonObject a) {
        return switch (tool) {
            case "bot_mine" -> "cancel".equals(str(a, "action"));
            case "bot_reactions" -> !"arm".equals(str(a, "action"));
            case "bot_follow" -> a.has("stop") && !a.get("stop").isJsonNull()
                && a.get("stop").getAsBoolean();
            default -> false;
        };
    }

    // ---- per-tool normalizers --------------------------------------------------

    private static JsonObject goTo(final JsonObject a) {
        JsonObject at = a.has("reach") && a.get("reach").isJsonObject()
            ? a.getAsJsonObject("reach") : a.has("to") && a.get("to").isJsonObject()
            ? a.getAsJsonObject("to") : null;
        if (at == null) {
            return null;
        }
        JsonObject i = envelope("move", "until_done");
        i.add("at", at.deepCopy());
        if (a.has("reach") && a.get("reach").isJsonObject()) {
            i.addProperty("arrive", "reach");
        }
        rights(i, a);
        return i;
    }

    private static JsonObject target(final JsonObject a) {
        String action = str(a, "action");
        if (action == null || !a.has("target") || !a.get("target").isJsonObject()) {
            return null;
        }
        // The goal actions ARE grammar verbs (§14.1) — bot_target was always the closest tool to
        // the envelope; `vantage` included.
        JsonObject i = envelope(action, "until_done");
        i.add("selector", a.getAsJsonObject("target").deepCopy());
        String item = item(a, "item");
        if (item != null) {
            i.addProperty("item", item);
        }
        rights(i, a);
        return i;
    }

    private static JsonObject tunnel(final JsonObject a) {
        // bot_tunnel = move + break rights + corridor shape (§14.1's flagship example).
        JsonObject i = envelope("move", "until_done");
        JsonObject shape = new JsonObject();
        shape.addProperty("kind", "corridor");
        for (String k : new String[] { "direction", "length", "height", "slope", "to_y",
                "until_sky", "torch_every" }) {
            if (a.has(k) && !a.get(k).isJsonNull()) {
                shape.add(k, a.get(k).deepCopy());
            }
        }
        i.add("shape", shape);
        JsonObject r = new JsonObject();
        r.addProperty("may_modify", "break");
        i.add("rights", r);
        return i;
    }

    private static JsonObject use(final JsonObject a) {
        JsonObject i = once("use", a, at(a), item(a, "item"));
        if (i != null && str(a, "face") != null) {
            JsonObject shape = new JsonObject();
            shape.addProperty("face", str(a, "face"));
            i.add("shape", shape);
        }
        return i;
    }

    private static JsonObject craft(final JsonObject a) {
        JsonObject i = once("craft", a, null, item(a, "item"));
        if (i != null && a.has("count") && !a.get("count").isJsonNull()) {
            i.addProperty("count", a.get("count").getAsInt());
        }
        return i;
    }

    private static JsonObject equip(final JsonObject a) {
        JsonObject i = envelope("equip", "once");
        JsonObject items = new JsonObject();
        for (String slot : new String[] { "head", "chest", "legs", "feet", "mainhand", "offhand" }) {
            if (a.has(slot) && !a.get(slot).isJsonNull()) {
                items.addProperty(slot, a.get(slot).getAsString());
            }
        }
        i.add("item", items);
        return i;
    }

    private static JsonObject select(final JsonObject a) {
        // §16.4: hotbar selection is an equip in micro clothing; folds into the executor with §2.2.
        JsonObject i = envelope("equip", "once");
        if (a.has("slot") && !a.get("slot").isJsonNull()) {
            i.addProperty("slot", a.get("slot").getAsInt());
        }
        String item = item(a, "item");
        if (item != null) {
            i.addProperty("item", item);
        }
        meta(i, "micro", "select");
        return i;
    }

    private static JsonObject look(final JsonObject a) {
        // §16.4 micro-tool, kept a verb in the v1 normalization: aiming the perception origin is a
        // do (it spends ticks under sweep_ticks) and the gaze fan follows it (§13.2).
        JsonObject i = envelope("look", "once");
        if (a.has("at") && a.get("at").isJsonObject()) {
            i.add("at", a.getAsJsonObject("at").deepCopy());
        } else if (a.has("yaw") || a.has("pitch")) {
            JsonObject dir = new JsonObject();
            if (a.has("yaw") && !a.get("yaw").isJsonNull()) {
                dir.addProperty("yaw", a.get("yaw").getAsDouble());
            }
            if (a.has("pitch") && !a.get("pitch").isJsonNull()) {
                dir.addProperty("pitch", a.get("pitch").getAsDouble());
            }
            i.add("direction", dir);
        } else {
            return null;
        }
        meta(i, "micro", "look");
        return i;
    }

    private static JsonObject follow(final JsonObject a) {
        JsonObject sel = entitySelector(a);
        if (sel == null && str(a, "player") != null) {
            sel = new JsonObject();
            sel.addProperty("player", str(a, "player"));
        }
        if (sel == null) {
            return null;
        }
        JsonObject i = envelope("follow", "until_done");
        i.add("selector", sel);
        return i;
    }

    private static JsonObject run(final JsonObject a) {
        // A queue is an intent SEQUENCE (§14.1). v1 echoes the steps; per-step normalization
        // lands with the surface consolidation A/B, not before.
        if (!a.has("steps") || !a.get("steps").isJsonArray()) {
            return null;
        }
        JsonObject i = envelope("sequence", "until_done");
        i.add("steps", a.getAsJsonArray("steps").deepCopy());
        return i;
    }

    private static JsonObject container(final JsonObject a) {
        // The §12.6 container ceremony, caught by the coverage tripwire 2026-08-09. `read` is an
        // embodied look INSIDE a block — scan is a verb (§16.1). `put`/`take` are the transfer
        // pair, closed-set additions mirroring eat/drink: same shape, opposite direction,
        // different gates (put needs the item carried, take needs the container to hold it).
        JsonObject at = at(a);
        if (at == null) {
            return null;
        }
        String action = str(a, "action");
        String verb = action == null || "read".equals(action) ? "scan"
            : "put".equals(action) || "take".equals(action) ? action : null;
        if (verb == null) {
            return null;
        }
        JsonObject i = envelope(verb, "once");
        i.add("at", at);
        String item = item(a, "item");
        if (item != null) {
            i.addProperty("item", item);
        }
        if (a.has("count") && !a.get("count").isJsonNull()) {
            i.addProperty("count", a.get("count").getAsInt());
        }
        if (a.has("slot") && !a.get("slot").isJsonNull()) {
            i.addProperty("slot", a.get("slot").getAsInt());
        }
        JsonObject shape = new JsonObject();
        shape.addProperty("kind", "container");
        i.add("shape", shape);
        return i;
    }

    private static JsonObject surface(final JsonObject a) {
        JsonObject i = envelope("move", "once");
        JsonObject shape = new JsonObject();
        shape.addProperty("kind", "surface");
        if (a.has("ticks") && !a.get("ticks").isJsonNull()) {
            shape.addProperty("ticks", a.get("ticks").getAsInt());
        }
        i.add("shape", shape);
        return i;
    }

    private static JsonObject reactions(final JsonObject a) {
        // A reflex IS a while-intent (§14.1): {verb: response-op, persistence: while:<trigger>}.
        // Normalized per armed reaction; a preset is a server-defined bundle recorded by name (its
        // expansion is the server's table — duplicated here it would drift; v2 normalizes the
        // expansion at the arm site instead).
        if (!"arm".equals(str(a, "action"))) {
            return null; // list/clear/disarm are surface management, filtered upstream
        }
        JsonObject i = envelope("arm", "standing");
        if (str(a, "preset") != null) {
            i.addProperty("preset", str(a, "preset"));
        }
        if (a.has("reactions") && a.get("reactions").isJsonArray()) {
            JsonArray rows = new JsonArray();
            for (var el : a.getAsJsonArray("reactions")) {
                if (!el.isJsonObject()) {
                    continue;
                }
                JsonObject rx = el.getAsJsonObject();
                JsonObject w = new JsonObject();
                String op = rx.has("response") && rx.get("response").isJsonObject()
                    ? str(rx.getAsJsonObject("response"), "op") : null;
                w.addProperty("verb", op);
                String trigger = rx.has("trigger") && rx.get("trigger").isJsonObject()
                    ? str(rx.getAsJsonObject("trigger"), "kind") : null;
                w.addProperty("persistence", "while:" + trigger);
                if (rx.has("trigger")) {
                    w.add("trigger", rx.get("trigger").deepCopy());
                }
                if (rx.has("priority") && !rx.get("priority").isJsonNull()) {
                    w.add("priority", rx.get("priority").deepCopy());
                }
                if (rx.has("id") && !rx.get("id").isJsonNull()) {
                    w.add("id", rx.get("id").deepCopy());
                }
                rows.add(w);
            }
            i.add("while_intents", rows);
        }
        return i;
    }

    // ---- envelope helpers ------------------------------------------------------

    private static JsonObject envelope(final String verb, final String persistence) {
        JsonObject i = new JsonObject();
        i.addProperty("verb", verb);
        i.addProperty("persistence", persistence);
        return i;
    }

    private static @Nullable JsonObject once(final String verb, final JsonObject a,
                                             final @Nullable JsonObject at, final @Nullable String item) {
        JsonObject i = envelope(verb, "once");
        if (at != null) {
            i.add("at", at);
        } else if (a.has("nearest") && !a.get("nearest").isJsonNull()
            && a.get("nearest").getAsBoolean()) {
            JsonObject sel = new JsonObject();
            sel.addProperty("nearest", true);
            i.add("selector", sel);
        }
        if (item != null) {
            i.addProperty("item", item);
        }
        return i;
    }

    private static void rights(final JsonObject i, final JsonObject a) {
        JsonObject r = new JsonObject();
        String mm = str(a, "may_modify");
        if (mm != null) {
            r.addProperty("may_modify", mm);
        }
        if (a.has("budget") && a.get("budget").isJsonObject()) {
            r.add("budgets", a.getAsJsonObject("budget").deepCopy());
        }
        if (r.size() > 0) {
            i.add("rights", r);
        }
        if (a.has("swim") && !a.get("swim").isJsonNull()) {
            JsonObject caps = new JsonObject();
            caps.addProperty("swim", a.get("swim").getAsBoolean());
            i.add("capabilities", caps);
        }
    }

    private static void meta(final JsonObject i, final String key, final String value) {
        JsonObject m = i.has("meta") && i.get("meta").isJsonObject()
            ? i.getAsJsonObject("meta") : new JsonObject();
        m.addProperty(key, value);
        i.add("meta", m);
    }

    private static @Nullable JsonObject at(final JsonObject a) {
        return a.has("at") && a.get("at").isJsonObject() ? a.getAsJsonObject("at").deepCopy() : null;
    }

    private static @Nullable JsonObject entitySelector(final JsonObject a) {
        if (a.has("target") && !a.get("target").isJsonNull() && a.get("target").isJsonPrimitive()) {
            JsonObject sel = new JsonObject();
            sel.addProperty("entity", a.get("target").getAsLong());
            return sel;
        }
        if (a.has("nearest") && !a.get("nearest").isJsonNull() && a.get("nearest").getAsBoolean()) {
            JsonObject sel = new JsonObject();
            sel.addProperty("nearest", true);
            return sel;
        }
        return null;
    }

    private static @Nullable String item(final JsonObject a, final String key) {
        return str(a, key);
    }

    private static @Nullable String str(final JsonObject a, final String key) {
        return a.has(key) && !a.get(key).isJsonNull() && a.get(key).isJsonPrimitive()
            ? a.get(key).getAsString() : null;
    }
}
