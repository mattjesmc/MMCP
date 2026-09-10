package com.mattmc.mcptoolkit.client;

import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.renderer.entity.state.LivingEntityRenderState;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/** Per-frame render snapshot for the drone. The base carries position/rotation/light we need. */
@Environment(EnvType.CLIENT)
public class DroneRenderState extends LivingEntityRenderState {
    /** Beam mode byte ({@code DroneEntity.BEAM_*}); {@code BEAM_NONE} when the laser is off. */
    public byte beamMode;
    /** Eye→target vector in world axes (render-relative), or null when the beam is off. */
    public @Nullable Vec3 beamVector;
    /** Attack lunge strength in [0,1], 0 when idle. */
    public float lunge;
}
