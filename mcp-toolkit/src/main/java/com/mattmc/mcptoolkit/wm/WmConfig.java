package com.mattmc.mcptoolkit.wm;

import com.mattmc.mcptoolkit.platform.Platform;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

/**
 * World-model recorder switches — an experimental research subsystem's configuration, and every one
 * of these is OFF or inert unless somebody writes it into the properties file by hand.
 *
 * <p>Riding the same {@code config/mcptoolkit.properties} file as the
 * bridge (the world-model project's DESIGN.md §3: off by default, enabled by config flag so normal probe/battery
 * runs double as data collection). Read once at init — recording is a per-run decision, not a
 * per-tick one, and a half-enabled session (streams opened mid-run) would violate the §13.1
 * alignment contract anyway.
 *
 * <ul>
 *   <li>{@code wm.record=true} (or JVM {@code -Dmcptoolkit.wm.record=true}, which wins) — record.</li>
 *   <li>{@code wm.dir=<path>} — where session directories land. Default: {@code <gameDir>/../world-model/data}
 *       in a dev environment — the world-model project's own checkout, which sits beside the game
 *       directory in the workbench and is a SEPARATE repository (see this package's package-info) —
 *       and {@code <gameDir>/mcptoolkit-wm} in production, which depends on no such neighbour.</li>
 *   <li>{@code wm.policy=off|shadow|on} — the Phase-4 learned-policy seam ({@link WmPolicy};
 *       default {@code off} = a null check and nothing else). Requires {@code wm.record=true}.</li>
 *   <li>{@code wm.policy_port=<port>} — where the wmserve sidecar listens (default 25601).</li>
 *   <li>{@code wm.human.capture=true|false} — §15 human-demonstration capture ({@link WmHuman});
 *       default {@code true}, riding {@code wm.record}: recording ON means record what happens,
 *       and a connected human IS what happens. No effect while recording is off.</li>
 * </ul>
 */
public record WmConfig(boolean record, Path dataDir, String policy, int policyPort,
                       boolean humanCapture) {

    public static WmConfig load() {
        Path gameDir = Platform.gameDir();
        Path defaultDir = Platform.isDevelopment()
            ? gameDir.resolve("..").resolve("world-model").resolve("data").normalize()
            : gameDir.resolve("mcptoolkit-wm");

        Properties props = new Properties();
        Path file = Platform.configFile();
        if (Files.exists(file)) {
            try (InputStream in = Files.newInputStream(file)) {
                props.load(in);
            } catch (IOException ignored) {
                // unreadable config = defaults; the bridge's own loader already warned about it
            }
        }
        String sys = System.getProperty("mcptoolkit.wm.record");
        boolean record = sys != null
            ? "true".equalsIgnoreCase(sys.trim())
            : "true".equalsIgnoreCase(props.getProperty("wm.record", "false").trim());
        String dir = props.getProperty("wm.dir");
        Path dataDir = dir != null && !dir.isBlank() ? Path.of(dir.trim()) : defaultDir;
        String policy = props.getProperty("wm.policy", "off").trim().toLowerCase();
        if (!policy.equals("off") && !policy.equals("shadow") && !policy.equals("on")) {
            policy = "off"; // an unknown mode never half-enables anything
        }
        int policyPort = 25601;
        try {
            policyPort = Integer.parseInt(props.getProperty("wm.policy_port", "25601").trim());
        } catch (NumberFormatException ignored) {
            // default stands
        }
        boolean humanCapture = !"false".equalsIgnoreCase(
            props.getProperty("wm.human.capture", "true").trim());
        return new WmConfig(record, dataDir, policy, policyPort, humanCapture);
    }
}
