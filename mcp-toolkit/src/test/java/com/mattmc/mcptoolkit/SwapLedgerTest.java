package com.mattmc.mcptoolkit;

import com.google.gson.JsonObject;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The divergence ledger ({@code HOTSWAP_CEILING.md} §5) and the identity it lends to §4.
 *
 * <p>What a test JVM can reach is the bookkeeping, which is the whole of §5: the manual used to say
 * "if you've lost track, restart", and a restart was being spent to recover a fact the process had
 * the whole time. The digest is here because §4 leans on it — two pushes of the same bytes have to
 * be recognisable as the same bytes, or "nothing to redefine" cannot be said at all.
 */
class SwapLedgerTest {

    @BeforeEach
    void forget() {
        SwapLedger.clearForTest();
    }

    @Test
    void anUntouchedJvmSaysItIsRunningWhatItWasBuiltFrom() {
        JsonObject status = SwapLedger.status();
        assertEquals(0, status.get("count").getAsInt());
        assertTrue(status.get("note").getAsString().contains("running exactly what it was built from"),
            status.toString());
        assertNull(SwapLedger.last("com.example.Nothing"));
    }

    @Test
    void aSwappedClassIsListedWithWhereItCameFromAndWhatIsNowInstalled() {
        SwapLedger.record("com.example.Foo", "classpath", new byte[] {1, 2, 3});
        JsonObject status = SwapLedger.status();
        assertEquals(1, status.get("count").getAsInt());
        JsonObject one = status.getAsJsonArray("swapped").get(0).getAsJsonObject();
        assertEquals("com.example.Foo", one.get("class").getAsString());
        assertEquals("classpath", one.get("source").getAsString());
        assertEquals(3, one.get("bytes").getAsInt());
        assertEquals(SwapLedger.digest(new byte[] {1, 2, 3}), one.get("digest").getAsString());
        // One swap is the usual case and costs no extra field; a second is worth saying.
        assertTrue(!one.has("swaps"), one.toString());
        assertTrue(status.get("note").getAsString().contains("NOT built from"), status.toString());
    }

    @Test
    void swappingTheSameClassAgainCountsItOnceAndKeepsTheNewestBytes() {
        SwapLedger.record("com.example.Foo", "classpath", new byte[] {1});
        SwapLedger.record("com.example.Foo", "dir", new byte[] {2, 2});
        JsonObject status = SwapLedger.status();
        assertEquals(1, status.get("count").getAsInt());
        JsonObject one = status.getAsJsonArray("swapped").get(0).getAsJsonObject();
        assertEquals(2, one.get("swaps").getAsInt());
        assertEquals("dir", one.get("source").getAsString());
        assertEquals(SwapLedger.digest(new byte[] {2, 2}), SwapLedger.last("com.example.Foo").digest());
    }

    @Test
    void theDigestIsTheSameBytesTwiceAndDifferentBytesNever() {
        // The whole of §4's second source rests on this: "you already pushed these bytes" is only
        // sayable if identical bytes digest identically and a one-byte edit does not.
        assertEquals(SwapLedger.digest(new byte[] {1, 2, 3}), SwapLedger.digest(new byte[] {1, 2, 3}));
        assertNotEquals(SwapLedger.digest(new byte[] {1, 2, 3}), SwapLedger.digest(new byte[] {1, 2, 4}));
        assertEquals(16, SwapLedger.digest(new byte[] {1}).length());
    }
}
