package com.mattmc.mcptoolkit.mcp;

import com.mattmc.mcptoolkit.Mechanism;
import org.junit.jupiter.api.Test;

import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The live connection table, and the reap that keeps it honest.
 *
 * <p>The reap is the one piece of this door whose failure is INVISIBLE at the time: a client that
 * exits without a DELETE leaves an entry behind, an entry costs a toolkit session, and a toolkit
 * session is a thing the drone reaper and {@code /mmcp mcp}'s count both go on believing in. Nothing
 * goes wrong for thirty minutes and then nothing goes wrong loudly afterwards either — it just
 * accumulates. That is why it is tested against a stated clock rather than left to a live run, which
 * could only ever have confirmed it by sitting still for half an hour.
 */
class McpConnTest {

    private static final McpSurface FULL = McpSurface.all("full", "everything");
    private static final McpSurface OBSERVE = new McpSurface("observe", "reads",
        null, Set.of(), Set.of(Mechanism.OBSERVE), null);

    // Every case ages its OWN connection into the past and reaps at the real now, rather than
    // reaping at a future now: the table is static and shared with every other test in this JVM, and
    // a reap far enough in the future would take their connections with it.

    @Test
    void aConnectionNothingHasSpokenOnForThirtyMinutesIsReaped() {
        long now = System.currentTimeMillis();
        McpConn conn = McpConn.open(FULL, "x-idle");
        conn.touch(now - McpConn.IDLE_MS - 1);
        McpConn.reap(now);
        assertNull(McpConn.get(conn.id), "an entry the client will never come back for");
    }

    @Test
    void aConnectionInsideTheIdleWindowSurvives() {
        long now = System.currentTimeMillis();
        McpConn conn = McpConn.open(FULL, "x-quiet");
        conn.touch(now - McpConn.IDLE_MS + 5_000);
        McpConn.reap(now);
        assertSame(conn, McpConn.get(conn.id), "quiet is not gone; a client may simply be thinking");
    }

    @Test
    void aRequestKeepsTheConnectionAliveNoMatterHowOldItIs() {
        long now = System.currentTimeMillis();
        McpConn conn = McpConn.open(FULL, "x-busy");
        conn.touch(now - McpConn.IDLE_MS - 1);
        // The lookup every request makes IS the liveness signal — there is no separate heartbeat on
        // this door, so if get() did not touch, a session busy for an hour would be reaped mid-call.
        assertNotNull(McpConn.get(conn.id));
        McpConn.reap(now);
        assertSame(conn, McpConn.get(conn.id));
    }

    @Test
    void liveReapsBeforeItAnswersSoTheCountInMmcpMcpIsTheTruth() {
        long now = System.currentTimeMillis();
        McpConn conn = McpConn.open(FULL, "x-stale");
        conn.touch(now - McpConn.IDLE_MS - 1);
        assertTrue(McpConn.live().stream().noneMatch(c -> c.id.equals(conn.id)),
            "`/mmcp mcp` reports live().size() as clients connected; a stale entry would be a lie");
    }

    @Test
    void aClosedConnectionIsGoneAndClosingSomethingElseIsNotAnError() {
        McpConn conn = McpConn.open(FULL, "x-closing");
        assertSame(conn, McpConn.close(conn.id));
        assertNull(McpConn.get(conn.id));
        assertNull(McpConn.close(conn.id), "DELETE twice is a client being careful, not a fault");
        assertNull(McpConn.close(null));
        assertNull(McpConn.get(null));
    }

    @Test
    void twoConnectionsAreTwoIdentitiesAndTwoSurfaces() {
        McpConn a = McpConn.open(FULL, "x-a");
        McpConn b = McpConn.open(OBSERVE, "x-b");
        assertNotEquals(a.id, b.id);
        assertEquals("full", a.surface.name());
        assertEquals("observe", b.surface.name(), "the surface is fixed at connect, per connection");
        assertSame(a, McpConn.get(a.id));
        assertSame(b, McpConn.get(b.id));
        // Closing one leaves the other entirely alone — they share a table and nothing else.
        McpConn.close(a.id);
        assertNull(McpConn.get(a.id));
        assertSame(b, McpConn.get(b.id));
        McpConn.close(b.id);
    }

    @Test
    void anAnonymousConnectionHasNoToolkitSession() {
        // The live-run finding: a sessionless POST is served, but it mints nothing. The audit log's
        // way of saying "nobody introduced themselves" is the absence of the field, and this is it.
        McpConn conn = McpConn.open(FULL, null);
        assertNull(conn.toolkitSession);
        McpConn.close(conn.id);
    }
}
