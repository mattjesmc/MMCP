package com.mattmc.mcptoolkit.drone;

import io.netty.channel.ChannelFutureListener;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import net.minecraft.network.Connection;
import net.minecraft.network.DisconnectionDetails;
import net.minecraft.network.PacketListener;
import net.minecraft.network.ProtocolInfo;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.PacketFlow;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;

/**
 * A {@link Connection} with no socket behind it — the half of {@link FakePlayerEntity} that lets a
 * {@code ServerPlayer} exist with nobody on the other end (BOT_SURFACE_DESIGN.md §11.4, "the
 * genuinely hard, orthogonal part"; the Carpet {@code EntityPlayerMPFake} trick, re-derived against
 * the 26.2 sources rather than ported blind).
 *
 * <p>Vanilla's {@code Connection} keeps its netty {@code Channel} in a private field that is only
 * ever assigned by {@code channelActive} — i.e. by a real pipeline. Everything that touches that
 * field is either null-guarded already or overridden here:
 *
 * <ul>
 *   <li><b>{@code setupInbound/OutboundProtocol}</b> — vanilla calls {@code channel.writeAndFlush}
 *       <em>unconditionally</em>; with no channel that is an immediate NPE the moment
 *       {@code PlayerList.placeNewPlayer} runs. Both are no-ops here: protocol negotiation is
 *       meaningless without a peer.
 *   <li><b>{@code send}</b> (all three overloads) — vanilla's not-connected branch parks the packet
 *       in an unbounded {@code pendingActions} queue. Left alone, every clientbound packet aimed at
 *       this player would accumulate there forever: a slow leak that a long-lived bench session
 *       would eventually feel. Dropping them is the honest behaviour — there is no client to inform.
 *   <li><b>{@code flushChannel}</b> — same unbounded-queue path.
 *   <li><b>{@code isConnected}</b> — reports {@code true}. The listener treats a disconnected player
 *       as one to reap, and the body must stay alive until the toolkit despawns it.
 * </ul>
 *
 * <p>{@code disconnect}, {@code setReadOnly}, {@code handleDisconnection} and {@code tick} are all
 * already null-channel-safe in vanilla, so they are left inherited — the smaller the override
 * surface, the less there is to drift when the game updates.
 *
 * <p>This connection is deliberately NOT registered with {@code ServerConnectionListener}, so it is
 * never ticked by the network thread: no keep-alive timer, no read timeout, nothing that would
 * disconnect a player who can never answer. The cost is that {@code ServerGamePacketListenerImpl
 * .tick()} never runs either — which is why {@link FakePlayerEntity} pumps {@code doTick()} itself.
 */
final class FakeConnection extends Connection {

    /** A loopback address so {@code getLoggableAddress} has something sane to print in the log line. */
    private static final SocketAddress ADDRESS = new InetSocketAddress("127.0.0.1", 0);

    FakeConnection() {
        super(PacketFlow.SERVERBOUND);
    }

    @Override
    public <T extends PacketListener> void setupInboundProtocol(final ProtocolInfo<T> protocol,
                                                                final T packetListener) {
        // No pipeline to configure.
    }

    @Override
    public void setupOutboundProtocol(final ProtocolInfo<?> protocol) {
        // No pipeline to configure.
    }

    @Override
    public void send(final Packet<?> packet) {
        // Dropped: no peer.
    }

    @Override
    public void send(final Packet<?> packet, final @Nullable ChannelFutureListener listener) {
        // Dropped: no peer. The listener is not run — nothing was ever written to succeed or fail.
    }

    @Override
    public void send(final Packet<?> packet, final @Nullable ChannelFutureListener listener,
                     final boolean flush) {
        // Dropped: no peer.
    }

    @Override
    public void flushChannel() {
        // Nothing buffered.
    }

    @Override
    public boolean isConnected() {
        return true;
    }

    @Override
    public SocketAddress getRemoteAddress() {
        return ADDRESS;
    }

    @Override
    public String getLoggableAddress(final boolean logIPs) {
        return "fake";
    }

    @Override
    public void disconnect(final Component reason) {
        // A fake player leaves when the toolkit despawns it, never because the network said so.
    }

    @Override
    public void disconnect(final DisconnectionDetails details) {
        // As above.
    }
}
