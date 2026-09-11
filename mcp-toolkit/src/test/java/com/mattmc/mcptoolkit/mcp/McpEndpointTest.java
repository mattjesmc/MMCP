package com.mattmc.mcptoolkit.mcp;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The two decisions the transport makes before any of MCP happens: which surface the URL named, and
 * whether the caller is allowed to be asking at all.
 */
class McpEndpointTest {

    @Test
    void theUrlNamesTheSurface() {
        assertNull(McpEndpoint.surfaceOf("/mcp"));
        assertNull(McpEndpoint.surfaceOf("/mcp/"));
        assertEquals("observe", McpEndpoint.surfaceOf("/mcp/observe"));
        assertEquals("observe", McpEndpoint.surfaceOf("/mcp/observe/"));
        assertEquals("rocketeer_authoring", McpEndpoint.surfaceOf("/mcp/rocketeer_authoring"));
    }

    @Test
    void aLoopbackOriginIsAllowedAndSoIsNoOriginAtAll() {
        // No browser, no Origin. Every real MCP client is this case.
        assertTrue(McpEndpoint.isLoopbackOrigin(null));
        assertTrue(McpEndpoint.isLoopbackOrigin(""));
        assertTrue(McpEndpoint.isLoopbackOrigin("null"));
        assertTrue(McpEndpoint.isLoopbackOrigin("http://127.0.0.1:25600"));
        assertTrue(McpEndpoint.isLoopbackOrigin("http://localhost"));
        assertTrue(McpEndpoint.isLoopbackOrigin("https://LOCALHOST:3000"));
        assertTrue(McpEndpoint.isLoopbackOrigin("http://[::1]:8080"));
    }

    @Test
    void aPageOnTheInternetIsNotAllowedToDriveSomebodysGame() {
        // The DNS-rebinding case the spec's origin rule exists for: a name that RESOLVES to
        // 127.0.0.1 is still not a loopback ORIGIN, and the origin is the half a page cannot forge.
        assertFalse(McpEndpoint.isLoopbackOrigin("http://evil.example"));
        assertFalse(McpEndpoint.isLoopbackOrigin("https://localhost.evil.example"));
        assertFalse(McpEndpoint.isLoopbackOrigin("http://127.0.0.1.evil.example"));
        assertFalse(McpEndpoint.isLoopbackOrigin("file://127.0.0.1"));
    }
}
