package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.jspecify.annotations.Nullable;

import java.security.MessageDigest;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * <b>What this JVM diverges from the jar it was built from.</b>
 * ({@code docs/platform/HOTSWAP_CEILING.md} §5 — "no ledger of what diverges from the built jar".)
 *
 * <p>{@code LIVE_MODDING.md} used to state the gap and prescribe amnesia: <em>"there is no tool that
 * lists live divergence from the built jar — if you've lost track, restart."</em> Every swap is
 * already a {@link Mechanism#PRIVILEGED} call and already lands in the audit log; nothing surfaced
 * it, so the advice for a session that had lost count was a four-minute restart to recover a fact the
 * process was holding all along.
 *
 * <p>It earns its keep twice. The obvious way is {@code hotswap_class {status:true}}: class, when,
 * from where, how many times, and the digest of the bytes now running. The second is the one that
 * makes §4 possible — <b>a swap whose bytes are byte-identical to the ones already installed changed
 * nothing</b>, and the ledger remembers exactly what was installed, so "you already pushed these
 * bytes at 17:04" is a sentence this tool can say instead of reporting a success.
 *
 * <p>Deliberately in-memory and per-JVM: the divergence it describes ends when the JVM does. A
 * restart resets every swap, which is the one part of the old advice that was true.
 */
public final class SwapLedger {
    private SwapLedger() {}

    /** One class's live divergence: the last swap that landed, and how many have landed in all. */
    public record Entry(String className, Instant at, String source, int bytes, String digest, int count) {}

    private static final Map<String, Entry> ENTRIES = Collections.synchronizedMap(new LinkedHashMap<>());

    /** Record a landed swap. Called only after {@code redefineClasses} returns. */
    static void record(final String className, final String source, final byte[] bytes) {
        String digest = digest(bytes);
        ENTRIES.compute(className, (k, prev) -> new Entry(className, Instant.now(), source,
            bytes.length, digest, prev == null ? 1 : prev.count() + 1));
    }

    /** The last swap of this class in this JVM, or null if it has never been swapped. */
    static @Nullable Entry last(final String className) {
        return ENTRIES.get(className);
    }

    /** Everything this JVM is running that its jar is not, newest swap first. */
    static JsonObject status() {
        JsonObject out = new JsonObject();
        JsonArray arr = new JsonArray();
        synchronized (ENTRIES) {
            ENTRIES.values().stream()
                .sorted((a, b) -> b.at().compareTo(a.at()))
                .forEach(e -> {
                    JsonObject one = new JsonObject();
                    one.addProperty("class", e.className());
                    one.addProperty("at", e.at().toString());
                    one.addProperty("source", e.source());
                    one.addProperty("bytes", e.bytes());
                    one.addProperty("digest", e.digest());
                    if (e.count() > 1) {
                        one.addProperty("swaps", e.count());
                    }
                    arr.add(one);
                });
        }
        out.add("swapped", arr);
        out.addProperty("count", arr.size());
        out.addProperty("note", arr.isEmpty()
            ? "nothing has been hot-swapped in this JVM: it is running exactly what it was built from"
            : "these classes are running bytes this JVM was NOT built from. A restart resets all of "
            + "it; nothing else does, and a rebuilt jar on disk does not change what is already loaded");
        return out;
    }

    /** SHA-256, hex, first 16 chars — an identity for a class file, not a security claim. */
    static String digest(final byte[] bytes) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder sb = new StringBuilder(16);
            for (int i = 0; i < 8; i++) {
                sb.append(Character.forDigit((hash[i] >> 4) & 0xf, 16));
                sb.append(Character.forDigit(hash[i] & 0xf, 16));
            }
            return sb.toString();
        } catch (Exception e) {
            // A JVM without SHA-256 is not a case; a digest that throws must still not take a swap
            // down, so the fallback is a value that can never collide into a false "unchanged".
            return "nodigest-" + System.nanoTime();
        }
    }

    /** Test seam: forget everything, so one test's swaps are not another's history. */
    static void clearForTest() {
        ENTRIES.clear();
    }
}
