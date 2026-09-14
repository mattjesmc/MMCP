package com.mattmc.mcptoolkit;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The one declaration on this bridge that is checked rather than trusted.
 *
 * <p>These cases were written for the MCP door and are here because the rule outgrew it: the private
 * {@code POST /cmd} carries the whole manifest with no surface slicing, and for one release it made
 * no origin check at all while the newer door spent code refusing exactly this caller. Two doors into
 * one process disagreeing about who may knock is not a policy.
 */
class BridgeOriginTest {

    @Test
    void aLoopbackOriginIsAllowedAndSoIsNoOriginAtAll() {
        // No browser, no Origin. Every real MCP client, the shim, and curl are this case.
        assertTrue(BridgeOrigin.isLoopback(null));
        assertTrue(BridgeOrigin.isLoopback(""));
        assertTrue(BridgeOrigin.isLoopback("null"));
        assertTrue(BridgeOrigin.isLoopback("http://127.0.0.1:25600"));
        assertTrue(BridgeOrigin.isLoopback("http://localhost"));
        assertTrue(BridgeOrigin.isLoopback("https://LOCALHOST:3000"));
        assertTrue(BridgeOrigin.isLoopback("http://[::1]:8080"));
    }

    @Test
    void aPageOnTheInternetIsNotAllowedToDriveSomebodysGame() {
        // The DNS-rebinding case the spec's origin rule exists for: a name that RESOLVES to
        // 127.0.0.1 is still not a loopback ORIGIN, and the origin is the half a page cannot forge.
        assertFalse(BridgeOrigin.isLoopback("http://evil.example"));
        assertFalse(BridgeOrigin.isLoopback("https://localhost.evil.example"));
        assertFalse(BridgeOrigin.isLoopback("http://127.0.0.1.evil.example"));
        assertFalse(BridgeOrigin.isLoopback("file://127.0.0.1"));
    }

    @Test
    void theRefusalSaysWhatWasRefusedRatherThanJustNo() {
        // A person who hits this from a browser tab on purpose gets to find out why in one line;
        // the alternative is a bare 403 that reads as a bug in the bridge.
        assertTrue(BridgeOrigin.REFUSAL.contains("loopback"));
        assertTrue(BridgeOrigin.REFUSAL.contains("web page"));
    }
}
