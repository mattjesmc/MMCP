package com.mattmc.mcptoolkit.mcp;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * The decision the transport makes before any of MCP happens: which surface the URL named.
 *
 * <p>The OTHER pre-MCP decision — whether the caller is allowed to be asking at all — moved to
 * {@code BridgeOriginTest} when the check moved to {@code BridgeOrigin}, because the private
 * {@code /cmd} door needs the same one and a second copy is how two doors into one process end up
 * disagreeing about who may knock.
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

}
