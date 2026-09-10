package com.mattmc.mcptoolkit.wm;

import com.mattmc.mcptoolkit.McpToolkit;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.player.Input;

/**
 * §15 phase-2 C2S payload (HUMAN_RIG_PLAN.md channel 2): the TRUE client input frame for one client
 * tick, sampled by {@code HumanCapture} at END_CLIENT_TICK and sent unconditionally while connected
 * to a local server — zeroed frames are explicit idle rows (§13.1), so the stream has no holes to
 * interpret. Sent AFTER the tick's vanilla input packets on the same TCP stream, so by connection
 * FIFO the server consumes it after {@code lastClientInput} already reflects the same client tick —
 * the ordering property that makes the {@code WmHuman} cross-check a measured zero, not an
 * assumption.
 *
 * <p>What the server-side channel cannot see and this carries: analog {@code moveVector} magnitudes
 * (sneak/use slowdowns baked in — the analog speed supervision), sub-tick mouse deltas (the §12.6
 * attention-prior signal; record-only in v1 per decision 7), resolved effective sprint/sneak
 * (decision 2), keybind-level attack/use held + press-edge counts, and the crosshair entity at the
 * latest press edge (the §15 obs-gap join key).
 *
 * <p>~35 bytes on the wire. {@code schema} leads so a future client against an old server is
 * ignorable, not misparsed; unknown ids on a vanilla server fall to {@code DiscardedPayload}
 * harmlessly (the client gates on local servers anyway).
 */
public record HumanFramePayload(
    int schema,
    long clientTick,
    float fwd,
    float strafe,
    int keys,
    int state,
    float yaw,
    float pitch,
    float mouseDx,
    float mouseDy,
    int mouseSamples,
    int atkEdges,
    int useEdges,
    int hotbar,
    int targetEid
) implements CustomPacketPayload {

    public static final int SCHEMA = 1;

    /** {@code keys} bits, mirroring vanilla {@link Input}'s flag order exactly. */
    public static final int KEY_FORWARD = 1;
    public static final int KEY_BACKWARD = 2;
    public static final int KEY_LEFT = 4;
    public static final int KEY_RIGHT = 8;
    public static final int KEY_JUMP = 16;
    public static final int KEY_SHIFT = 32;
    public static final int KEY_SPRINT = 64;

    /** {@code state} bits: resolved effective holds (decision 2) + attack/use keybind held. */
    public static final int ST_SPRINT = 1;
    public static final int ST_SNEAK = 2;
    public static final int ST_ATK_HELD = 4;
    public static final int ST_USE_HELD = 8;

    /** No entity under the crosshair at any press edge this tick. */
    public static final int NO_TARGET = -1;

    public static final CustomPacketPayload.Type<HumanFramePayload> TYPE =
        new CustomPacketPayload.Type<>(Identifier.fromNamespaceAndPath(McpToolkit.MOD_ID, "human_frame"));

    public static final StreamCodec<FriendlyByteBuf, HumanFramePayload> STREAM_CODEC =
        CustomPacketPayload.codec(HumanFramePayload::write, HumanFramePayload::new);

    private HumanFramePayload(final FriendlyByteBuf buf) {
        this(buf.readByte(), buf.readVarLong(), buf.readFloat(), buf.readFloat(),
            buf.readUnsignedByte(), buf.readUnsignedByte(), buf.readFloat(), buf.readFloat(),
            buf.readFloat(), buf.readFloat(), buf.readVarInt(), buf.readUnsignedByte(),
            buf.readUnsignedByte(), buf.readByte(), buf.readVarInt());
    }

    private void write(final FriendlyByteBuf buf) {
        buf.writeByte(schema);
        buf.writeVarLong(clientTick);
        buf.writeFloat(fwd);
        buf.writeFloat(strafe);
        buf.writeByte(keys);
        buf.writeByte(state);
        buf.writeFloat(yaw);
        buf.writeFloat(pitch);
        buf.writeFloat(mouseDx);
        buf.writeFloat(mouseDy);
        buf.writeVarInt(mouseSamples);
        buf.writeByte(Math.min(atkEdges, 255));
        buf.writeByte(Math.min(useEdges, 255));
        buf.writeByte(hotbar);
        buf.writeVarInt(targetEid);
    }

    public boolean key(final int flag) {
        return (keys & flag) != 0;
    }

    public boolean st(final int flag) {
        return (state & flag) != 0;
    }

    /** The payload's key booleans as a vanilla {@link Input}, for the equality cross-check against
     *  {@code ServerPlayer.getLastClientInput()} — {@link Input} is a record, so {@code equals}
     *  compares all seven channels at once. */
    public Input asInput() {
        return new Input(key(KEY_FORWARD), key(KEY_BACKWARD), key(KEY_LEFT), key(KEY_RIGHT),
            key(KEY_JUMP), key(KEY_SHIFT), key(KEY_SPRINT));
    }

    @Override
    public CustomPacketPayload.Type<HumanFramePayload> type() {
        return TYPE;
    }
}
