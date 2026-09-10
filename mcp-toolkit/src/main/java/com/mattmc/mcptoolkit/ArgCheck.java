package com.mattmc.mcptoolkit;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;

/**
 * The argument gate every bridge call passes through — <b>an argument the tool does not have is a
 * refusal, not a shrug</b>.
 *
 * <p>Silently dropping an unknown argument is the {@code succeeds-falsely} class (ARCHITECTURE,
 * "Act verdicts are verified") with an argument name as the vector: the call runs, answers a
 * DIFFERENT question than the one asked, and the reply — computed honestly from the arguments that
 * did apply — reads back exactly like agreement. {@code locate} learned this the expensive way (see
 * {@code LocateTools.rejectUnknownArgs}: thirteen live calls carrying a {@code center} that was not
 * an argument, both models continuing for a whole session because the echo looked like confirmation)
 * and grew a hand-maintained refusal. This generalizes that one tool's lesson to all ~70, from the
 * schema each tool already declares — the toolkit is the schema authority, so nothing new has to be
 * maintained alongside the tools for this to stay true.
 *
 * <p>Two shapes are caught, both observed live in survival session w1-85918:
 * <ol>
 *   <li><b>Unknown key.</b> {@code locate {center: …}} — refused, naming the nearest real argument
 *       and the full list. That message worked: the model corrected itself on the very next call.</li>
 *   <li><b>A JSON-encoded string where an object belongs.</b> {@code bot_place {target: "{\"at\":
 *       {\"x\":-44,…}}"}} — the same model, twice in a row, got only "missing `at`" and had to go
 *       read the schema. The value is not just the wrong key here, it is double-encoded: saying so
 *       is the difference between one more failed call and a fix.</li>
 * </ol>
 *
 * <p><b>What it deliberately does not do:</b> type checking, range checking, or required-argument
 * checking. Those verdicts belong to the handlers, which own the semantics and already phrase them
 * better than a schema walker could ("give `to` OR `reach`, not both"). This gate answers exactly
 * one question — is this argument real — because that is the one no handler can answer for itself,
 * an unknown key having no handler to reach.
 */
public final class ArgCheck {

    private ArgCheck() {}

    /**
     * Confusions that are about the SURFACE, not about one tool — a caller reaching for the
     * vocabulary of a different tool family, or of Minecraft generally. Edit distance cannot find
     * these ({@code center} is four edits from {@code near}) and they are the ones that actually
     * happen: {@code center} alone accounted for thirteen silently-wrong live locate calls.
     *
     * <p>A hint is only ever offered when the target IS a declared argument of the tool being
     * called, so a wrong guess here misleads nobody — it simply goes unmentioned.
     */
    private static final java.util.Map<String, String[]> HINTS = java.util.Map.ofEntries(
        java.util.Map.entry("center", new String[] {"near", "at", "from"}),
        java.util.Map.entry("centre", new String[] {"near", "at", "from"}),
        java.util.Map.entry("origin", new String[] {"near", "at", "from"}),
        java.util.Map.entry("pos", new String[] {"at", "to", "near"}),
        java.util.Map.entry("position", new String[] {"at", "to", "near"}),
        java.util.Map.entry("location", new String[] {"at", "to", "near"}),
        java.util.Map.entry("coords", new String[] {"at", "to"}),
        java.util.Map.entry("coordinates", new String[] {"at", "to"}),
        java.util.Map.entry("target", new String[] {"at", "to", "entity"}),
        java.util.Map.entry("destination", new String[] {"to", "at"}),
        java.util.Map.entry("range", new String[] {"radius", "within", "distance"}),
        java.util.Map.entry("distance", new String[] {"radius", "within"}),
        java.util.Map.entry("max", new String[] {"limit", "max_length"}),
        java.util.Map.entry("count", new String[] {"limit", "amount"}),
        java.util.Map.entry("amount", new String[] {"count"}),
        java.util.Map.entry("type", new String[] {"what", "kind", "block"}),
        java.util.Map.entry("block", new String[] {"what", "item", "at"}),
        java.util.Map.entry("name", new String[] {"id", "what", "player"}),
        java.util.Map.entry("op", new String[] {"action"}),
        java.util.Map.entry("mode", new String[] {"action"}),
        java.util.Map.entry("command", new String[] {"action"}),
        java.util.Map.entry("text", new String[] {"message"}),
        java.util.Map.entry("msg", new String[] {"message"}),
        java.util.Map.entry("query", new String[] {"what", "message"}),
        java.util.Map.entry("tool", new String[] {"item"}),
        java.util.Map.entry("timeout", new String[] {"wait_ms", "seconds", "ticks"}),
        java.util.Map.entry("wait_ticks", new String[] {"ticks", "wait_ms"}),
        java.util.Map.entry("dim", new String[] {"dimension"}),
        java.util.Map.entry("world", new String[] {"dimension"}));

    /** Max edit distance at which a misspelling is confidently the caller's intent. */
    private static final int NEAR_MISS_DISTANCE = 2;
    /** Beyond this many declared arguments, listing them all is noise rather than help. */
    private static final int MAX_LISTED = 24;

    /**
     * Refuse the call if {@code args} carries a key the tool does not declare, or a JSON-encoded
     * string where the schema declares an object/array.
     *
     * @throws IllegalArgumentException naming what was wrong, the nearest real argument, and the
     *     tool's actual argument list.
     */
    public static void validate(final ToolDef def, final JsonObject args) {
        if (args == null || args.isEmpty()) {
            return;
        }
        // A tool an EXTENSION MOD contributed is that mod's contract, and its schema is written by
        // someone who never saw this gate. Refusing on their behalf would turn a toolkit upgrade
        // into a break in a third-party tool the toolkit does not own (the extension seam's whole
        // premise, ARCHITECTURE §extension seam). Their handlers keep answering for themselves.
        if (def.source() != null) {
            return;
        }
        JsonObject schema = def.inputSchema();
        if (schema == null || !schema.has("properties") || !schema.get("properties").isJsonObject()) {
            return; // free-form or undeclared: nothing to check against
        }
        JsonObject properties = schema.getAsJsonObject("properties");
        Set<String> declared = properties.keySet();
        if (declared.isEmpty()) {
            return; // a no-argument tool: let the handler speak for itself
        }

        List<String> unknown = new ArrayList<>();
        List<String> encoded = new ArrayList<>();
        for (String key : new TreeSet<>(args.keySet())) {
            if (!declared.contains(key)) {
                unknown.add(key);
                continue;
            }
            if (looksDoubleEncoded(properties.getAsJsonObject(key), args.get(key))) {
                encoded.add(key);
            }
        }
        if (!unknown.isEmpty()) {
            throw new IllegalArgumentException(unknownMessage(def, declared, unknown));
        }
        if (!encoded.isEmpty()) {
            throw new IllegalArgumentException(encodedMessage(def, encoded));
        }
    }

    /**
     * A value that arrived as a STRING containing JSON, for a property declared object or array.
     *
     * <p>Conservative on purpose: only when the schema says object/array (so a genuinely string-typed
     * argument that happens to start with a brace is never touched) and the text actually parses.
     * A string that merely looks like JSON but is not is somebody's data, not a mistake.
     */
    private static boolean looksDoubleEncoded(final @Nullable JsonObject propSchema,
                                              final JsonElement value) {
        if (propSchema == null || value == null || !value.isJsonPrimitive()
            || !value.getAsJsonPrimitive().isString()) {
            return false;
        }
        String declaredType = propSchema.has("type") && propSchema.get("type").isJsonPrimitive()
            ? propSchema.get("type").getAsString() : "";
        if (!"object".equals(declaredType) && !"array".equals(declaredType)) {
            return false;
        }
        String text = value.getAsString().trim();
        if (text.length() < 2
            || !((text.startsWith("{") && text.endsWith("}"))
                || (text.startsWith("[") && text.endsWith("]")))) {
            return false;
        }
        try {
            JsonElement parsed = com.google.gson.JsonParser.parseString(text);
            return parsed.isJsonObject() || parsed.isJsonArray();
        } catch (RuntimeException e) {
            return false;
        }
    }

    private static String unknownMessage(final ToolDef def, final Set<String> declared,
                                         final List<String> unknown) {
        StringBuilder msg = new StringBuilder(def.name())
            .append(unknown.size() > 1 ? " has no arguments " : " has no argument ");
        for (int i = 0; i < unknown.size(); i++) {
            String key = unknown.get(i);
            msg.append(i > 0 ? ", " : "").append('`').append(key).append('`');
            String hint = nearest(key, declared);
            if (hint != null) {
                msg.append(" (did you mean `").append(hint).append("`?)");
            }
        }
        // WHY the refusal, not just the fact of it: the argument was dropped, so the call would have
        // answered a different question — and its reply would have looked like agreement.
        msg.append(". The call was NOT run — it would have silently ignored ")
            .append(unknown.size() > 1 ? "them" : "it")
            .append(" and answered a different question. Arguments here: ")
            .append(list(declared))
            .append('.');
        return msg.toString();
    }

    private static String encodedMessage(final ToolDef def, final List<String> encoded) {
        StringBuilder msg = new StringBuilder(def.name()).append(": ");
        for (int i = 0; i < encoded.size(); i++) {
            msg.append(i > 0 ? ", " : "").append('`').append(encoded.get(i)).append('`');
        }
        msg.append(encoded.size() > 1 ? " arrived as JSON-ENCODED STRINGS" : " arrived as a "
            + "JSON-ENCODED STRING").append(" — the value is a string whose CONTENTS are JSON, so "
            + "the tool sees text where it expects a structure. Pass the object itself, not a "
            + "stringified copy of it: {\"at\": {\"x\": 1, \"y\": 2, \"z\": 3}}, never "
            + "{\"at\": \"{\\\"x\\\": 1, …}\"}.");
        return msg.toString();
    }

    /** The declared arguments as a readable list, truncated when a tool has a great many. */
    private static String list(final Set<String> declared) {
        List<String> all = new ArrayList<>(declared);
        if (all.size() <= MAX_LISTED) {
            return String.join(" | ", all);
        }
        return String.join(" | ", all.subList(0, MAX_LISTED))
            + " | … (" + (all.size() - MAX_LISTED) + " more)";
    }

    /**
     * The declared argument the caller most likely meant, or null when nothing is close enough.
     * Case-insensitive equality first (a capitalisation slip is certain, not a guess), then a bounded
     * edit distance scaled to the word's length so short names cannot match each other by accident.
     */
    private static @Nullable String nearest(final String key, final Set<String> declared) {
        String lower = key.toLowerCase(Locale.ROOT);
        for (String candidate : declared) {
            if (candidate.toLowerCase(Locale.ROOT).equals(lower)) {
                return candidate;
            }
        }
        // Surface-wide confusions first: these are the ones a distance metric cannot reach, and the
        // ones worth naming. Only suggested when this tool really has that argument.
        String[] aliases = HINTS.get(lower);
        if (aliases != null) {
            for (String alias : aliases) {
                if (declared.contains(alias)) {
                    return alias;
                }
            }
        }
        String best = null;
        int bestDistance = Integer.MAX_VALUE;
        for (String candidate : declared) {
            int limit = Math.min(NEAR_MISS_DISTANCE, Math.max(1, candidate.length() / 3));
            int d = distance(lower, candidate.toLowerCase(Locale.ROOT), limit);
            if (d <= limit && d < bestDistance) {
                bestDistance = d;
                best = candidate;
            }
        }
        return best;
    }

    /** Levenshtein distance, abandoned once it exceeds {@code limit} (returns limit + 1). */
    private static int distance(final String a, final String b, final int limit) {
        if (Math.abs(a.length() - b.length()) > limit) {
            return limit + 1;
        }
        int[] previous = new int[b.length() + 1];
        int[] current = new int[b.length() + 1];
        for (int j = 0; j <= b.length(); j++) {
            previous[j] = j;
        }
        for (int i = 1; i <= a.length(); i++) {
            current[0] = i;
            int rowBest = current[0];
            for (int j = 1; j <= b.length(); j++) {
                int cost = a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1;
                current[j] = Math.min(Math.min(current[j - 1] + 1, previous[j] + 1),
                    previous[j - 1] + cost);
                rowBest = Math.min(rowBest, current[j]);
            }
            if (rowBest > limit) {
                return limit + 1;
            }
            int[] swap = previous;
            previous = current;
            current = swap;
        }
        return previous[b.length()];
    }
}
