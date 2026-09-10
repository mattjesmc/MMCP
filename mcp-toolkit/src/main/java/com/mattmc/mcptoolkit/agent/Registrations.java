package com.mattmc.mcptoolkit.agent;

import com.mattmc.mcptoolkit.BridgeServer;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.ServerExtract;
import com.mattmc.mcptoolkit.platform.Platform;
import org.jspecify.annotations.Nullable;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Which directories this game's bridge is registered in, and whether each registration is still
 * true — the state {@code /mmcp server} prints (the MMCP menu that also showed it is archived).
 *
 * <h2>Scope: our own registrations, not the host's server list</h2>
 *
 * <p>§B1 asked whether "manage the client's MCP servers" meant the toolkit's own entry or the whole
 * list, and the narrow answer is the one the adapter seam can carry: {@link AgentClient} has one
 * write method and no vocabulary for third-party servers, and giving it one would make every adapter
 * a JSON config manager for servers that have nothing to do with Minecraft. What a human needs from
 * a game is the answer to "is my session going to reach THIS world?", which is exactly this list.
 *
 * <h2>The sites are DERIVED, not remembered</h2>
 *
 * <p>The game's own directory is a pure function of the instance, so that row needs no state at all
 * and cannot go stale. (Until 0.143.0 every KIT's workspace was derived the same way; the kits are
 * archived, and this is what is left of that discipline.) Only a directory a human typed has to be
 * remembered, and that is one path per line in {@code <gameDir>/mcptoolkit/registrations.txt}: a
 * format a person can read, edit and delete without us, holding nothing that is not already on disk
 * somewhere else.
 *
 * <p><b>A site whose file no longer holds our entry is kept, not dropped.</b> Forgetting it on read
 * would erase the one row that says something went wrong.
 */
public final class Registrations {
    private Registrations() {}

    private static final String LEDGER = "registrations.txt";

    /** How a workspace came to be on the list. */
    public enum Source {
        /** This game's own directory — always worth looking in, always first. */
        GAME,
        /** A directory a human registered by hand with {@code /mmcp server register}. */
        MANUAL
    }

    /** Where a registration would live, and why we are looking there. */
    public record Site(Path workspace, Source source, String label) {}

    /** What the file at a site actually says, measured against what this game is serving now. */
    public enum State {
        /** Registered, dialing the port this game bound, with the profile the site implies. */
        CURRENT,
        /** Registered, but at another port or another profile — a session started here reaches the wrong game, or none. */
        STALE,
        /** Registered to a DIFFERENT game's extract. Another install owns this workspace. */
        FOREIGN,
        /** No toolkit entry here (the file may not exist at all). */
        ABSENT,
        /** The configured client does not keep registrations in files, so there is nothing to read. */
        UNREADABLE
    }

    /**
     * One row: the site, what is written there, and the sentence that says why it is not CURRENT.
     *
     * @param others how many OTHER servers share the file — the number that used to go to zero
     */
    public record Status(Site site, State state, McpServersFile.@Nullable Entry entry,
                         int others, @Nullable String detail) {}

    // ---- the list --------------------------------------------------------------------------------

    /** Every directory worth looking in, this game's own first, without duplicates. */
    public static List<Site> sites() {
        Path gameDir = Platform.gameDir().toAbsolutePath().normalize();
        Map<Path, Site> out = new LinkedHashMap<>();
        out.put(gameDir, new Site(gameDir, Source.GAME, "this game's directory"));
        for (Path ws : manual()) {
            out.putIfAbsent(ws, new Site(ws, Source.MANUAL, "registered by hand"));
        }
        return List.copyOf(out.values());
    }

    /** Every site with the state of its registration, read fresh from disk. */
    public static List<Status> survey() {
        List<Status> out = new ArrayList<>();
        for (Site site : sites()) {
            out.add(status(site));
        }
        return out;
    }

    public static Status status(final Site site) {
        Path file = configFile(site.workspace());
        Path index = serverIndex();
        McpServersFile.Entry entry = McpServersFile.find(file, index);
        int others = (int) McpServersFile.all(file).stream()
            .filter(e -> entry == null || !e.key().equals(entry.key()))
            .count();
        if (entry == null) {
            return new Status(site, State.ABSENT, null, others, null);
        }
        if (!McpServersFile.runs(entry, index)) {
            return new Status(site, State.FOREIGN, entry, others,
                "it runs " + entry.serverIndex() + ", which belongs to another game directory");
        }
        String want = bridgeUrl();
        String have = entry.bridgeUrl();
        if (want == null) {
            return new Status(site, State.STALE, entry, others,
                "this game has no bridge bound, so nothing here can be current");
        }
        if (!want.equals(have)) {
            return new Status(site, State.STALE, entry, others,
                "it dials " + have + "; this game is serving " + want);
        }
        // The profile is NOT compared. Nothing on this side derives an expected one any more, and a
        // MCPTK_PROFILE somebody typed into their own file is their decision, not drift from ours.
        return new Status(site, State.CURRENT, entry, others, null);
    }

    // ---- changing it -----------------------------------------------------------------------------

    /**
     * Register this game in {@code workspace}, refreshing the extracted server first.
     *
     * <p>It writes the de-facto {@code .mcp.json} in that directory, as one member of its
     * {@code mcpServers} object and nothing else. This is the whole inbound path: a session started
     * in that directory reaches this game, with no agent client, launcher or kit anywhere in it.
     *
     * @return a human sentence saying what happened, or what stopped it
     */
    public static String register(final Path workspace, final boolean remember) {
        Path ws = workspace.toAbsolutePath().normalize();
        if (!Files.isDirectory(ws)) {
            return "refused: " + ws + " is not a directory";
        }
        int port = BridgeServer.boundPort();
        if (port <= 0) {
            return "refused: this game has no bridge bound, so any registration written now would "
                + "name a port nothing serves. Fix the bind first (see the log) and try again.";
        }
        Path gameDir = Platform.gameDir().toAbsolutePath();
        String extractErr = ServerExtract.ensureFresh(gameDir);
        if (extractErr != null) {
            return "refused: the MCP server could not be extracted — " + extractErr;
        }
        String url = "http://127.0.0.1:" + port;
        ServerSpec spec = ServerSpec.forWorkspace(ws, serverIndex(),
            gameDir.resolve("mcptoolkit").resolve("memory-data"), url, null, Map.of());

        // Read before and compare after rather than trusting a return value: "already current" is a
        // different sentence from "registered" for the person reading it.
        Path file = configFile(ws);
        String before = slurp(file);
        String error = McpServersFile.write(file, spec).error();
        if (error != null) {
            return "failed: " + error;
        }
        if (remember) {
            remember(ws);
        }
        boolean unchanged = before != null && before.equals(slurp(file));
        return (unchanged ? "already current in " : "registered in ")
            + file + " (bridge " + url + ")";
    }

    /** Take our entry back out, leaving every other server in the file. */
    public static String unregister(final Path workspace) {
        Path ws = workspace.toAbsolutePath().normalize();
        Path file = configFile(ws);
        McpServersFile.Result r = McpServersFile.remove(file, serverIndex());
        forget(ws);
        if (r.error() != null) {
            return "failed: " + r.error();
        }
        return r.changed()
            ? "removed this game's entry from " + file + "; every other server there is untouched"
            : "nothing to remove: " + file + " holds no registration for this game";
    }

    // ---- the manual ledger -----------------------------------------------------------------------

    /** Directories a human added, in the order they were added. */
    public static List<Path> manual() {
        Path ledger = ledger();
        List<Path> out = new ArrayList<>();
        if (!Files.exists(ledger)) {
            return out;
        }
        try {
            for (String line : Files.readAllLines(ledger)) {
                String s = line.trim();
                if (s.isEmpty() || s.startsWith("#")) {
                    continue;
                }
                try {
                    out.add(Path.of(s).toAbsolutePath().normalize());
                } catch (InvalidPathException e) {
                    McpToolkit.LOGGER.warn("[MCP Toolkit] {}: '{}' is not a path — ignoring the line",
                        ledger, s);
                }
            }
        } catch (IOException e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] could not read {}: {}", ledger, e.toString());
        }
        return out;
    }

    private static void remember(final Path workspace) {
        List<Path> current = manual();
        if (current.contains(workspace)) {
            return;
        }
        current.add(workspace);
        writeLedger(current);
    }

    private static void forget(final Path workspace) {
        List<Path> current = manual();
        if (current.remove(workspace)) {
            writeLedger(current);
        }
    }

    private static void writeLedger(final List<Path> paths) {
        Path ledger = ledger();
        StringBuilder sb = new StringBuilder("""
            # Directories this game has been registered in by hand (MMCP > MCP servers, or
            # /mmcp server register <dir>). One absolute path per line; edit or delete freely — the
            # registrations themselves live in each directory's own .mcp.json, not here.
            """);
        for (Path p : paths) {
            sb.append(p).append(System.lineSeparator());
        }
        try {
            Files.createDirectories(ledger.getParent());
            Files.writeString(ledger, sb.toString());
        } catch (IOException e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] could not write {}: {}", ledger, e.toString());
        }
    }

    // ---- shared facts ----------------------------------------------------------------------------

    /** The extracted server every registration this game writes points at. */
    public static Path serverIndex() {
        return Platform.gameDir().toAbsolutePath()
            .resolve("mcptoolkit").resolve("mcp-server").resolve("index.mjs");
    }

    /** The bridge URL a current registration must name, or null when nothing is bound. */
    public static @Nullable String bridgeUrl() {
        int port = BridgeServer.boundPort();
        return port > 0 ? "http://127.0.0.1:" + port : null;
    }

    /** Where this site's registration lives: the de-facto {@code .mcp.json} in the directory. */
    public static Path configFile(final Path workspace) {
        return workspace.resolve(".mcp.json");
    }

    /** A file's contents, or null when it is not there or cannot be read. */
    private static @Nullable String slurp(final Path file) {
        try {
            return Files.exists(file) ? Files.readString(file) : null;
        } catch (IOException e) {
            return null;
        }
    }

    private static String describe(final @Nullable String profile) {
        return profile == null || profile.isBlank() ? "the default surface" : profile;
    }

    private static Path ledger() {
        return Platform.gameDir().toAbsolutePath().resolve("mcptoolkit").resolve(LEDGER);
    }
}
