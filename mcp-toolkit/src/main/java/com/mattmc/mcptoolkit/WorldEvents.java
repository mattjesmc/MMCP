package com.mattmc.mcptoolkit;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;

/**
 * Native world-event watcher: emits {@code weather_changed} and {@code time_of_day} transitions into the
 * {@link EventLog} by diffing overworld state once per server tick — events over snapshots, because a
 * planner reasons better over "sun set" than over three identical scene summaries. Also wires the log's
 * game-tick supplier to the running server's overworld clock.
 *
 * <p>The first tick after server start only records the baseline, so booting into rain emits no spurious
 * "weather changed" event.
 */
public final class WorldEvents {
    private WorldEvents() {}

    private static boolean baseline;
    private static boolean lastRaining;
    private static boolean lastThundering;
    private static String lastTimeLabel = "";

    public static void register() {
        ServerHooks.SERVER_STARTED.register(s -> {
            EventLog.setTickSupplier(() -> s.overworld().getGameTime());
            baseline = false;
        });
        ServerHooks.SERVER_STOPPING.register(s -> {
            EventLog.setTickSupplier(null);
            // Edits are only restorable into the level they were recorded against; on the integrated
            // server the process outlives worlds, so the journal must not carry across (EditJournal.clear).
            EditJournal.clear();
            // Same world-boundary rule for the event stream: world A's events (with world A's ticks)
            // must not serve to get_events after world B opens as if they happened there. The clear
            // emits a world_closed boundary event so the loss is announced, never silent.
            EventLog.clearForWorldClose(s.overworld().dimension().identifier().toString());
            // A block watch's de-dup memory is a set of POSITIONS, which only mean anything in the
            // world they were seen in. The watches themselves survive (they are the agent's standing
            // question); only what they have already reported is forgotten, so the first sighting in
            // the next world reads as new instead of being silently swallowed as a repeat.
            com.mattmc.mcptoolkit.drone.Watch.clearSeenForWorldClose();
        });
        ServerHooks.END_SERVER_TICK.register(WorldEvents::tick);
    }

    private static void tick(final MinecraftServer server) {
        ServerLevel ow = server.overworld();
        boolean raining = ow.isRaining();
        boolean thundering = ow.isThundering();
        long tod = ((ow.getDefaultClockTime() % 24000L) + 24000L) % 24000L;
        String label = WorldPerceptionTools.timeLabel(tod);

        if (baseline) {
            if (raining != lastRaining || thundering != lastThundering) {
                JsonObject d = new JsonObject();
                d.addProperty("raining", raining);
                d.addProperty("thundering", thundering);
                EventLog.emit("weather_changed", d);
            }
            if (!label.equals(lastTimeLabel)) {
                JsonObject d = new JsonObject();
                d.addProperty("label", label);
                d.addProperty("timeOfDay", tod);
                EventLog.emit("time_of_day", d);
            }
        }
        baseline = true;
        lastRaining = raining;
        lastThundering = thundering;
        lastTimeLabel = label;
    }
}
