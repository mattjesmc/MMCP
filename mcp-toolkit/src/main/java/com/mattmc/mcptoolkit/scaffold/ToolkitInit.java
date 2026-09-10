package com.mattmc.mcptoolkit.scaffold;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mattmc.mcptoolkit.agent.McpServersFile;
import com.mattmc.mcptoolkit.agent.ServerSpec;

import java.io.IOException;
import java.io.InputStream;
import java.io.PrintStream;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.CodeSource;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * {@code gradlew toolkitInit} (RELEASE_1.md section J4): adopt an existing mod repository for agent
 * sessions, from the jar, with no game and no clone of the workbench.
 *
 * <p>The cold start this replaces was ten steps across three repositories, two of them "build
 * somebody else's project" - and the per-repository half of it was four hand-copied files. This
 * writes those files, from ONE implementation, into whichever client shapes are asked for:
 * <ul>
 *   <li>the MCP server registration - {@code mcpServers} JSON for Claude Code ({@code .mcp.json}),
 *   Cursor ({@code .cursor/mcp.json}) and Gemini CLI ({@code .gemini/settings.json}), all through
 *   {@link McpServersFile} so every other server in the file is written back as found; VS Code's
 *   {@code .vscode/mcp.json}, the same JSON under a {@code servers} key; Codex's
 *   {@code .codex/config.toml}, the one TOML shape;</li>
 *   <li>{@code AGENTS.md} - the session charter, once (the cross-client name; Claude Code reads it
 *   through an {@code @AGENTS.md} line in {@code CLAUDE.md}, written when that file is absent);</li>
 *   <li>{@code .mcptoolkit/loop.json} - once, with {@code checkAssets} as the after-session gate;</li>
 *   <li>the MCP server itself, extracted from this jar into {@code .mcptoolkit/mcp-server/} when no
 *   registration already names one - {@code ServerExtract} does the same into a game directory, and
 *   a repository needs no workbench checkout for it.</li>
 * </ul>
 *
 * <p><b>The port is the project constant, and this is the only place both halves are written from
 * one number.</b> {@code mcmod.port} in {@code gradle.properties} is what the game binds; the
 * registration's {@code MCPTK_URL} must name the same port, and section B0's trap is exactly the
 * two disagreeing. An existing registration whose URL names another port is corrected and the
 * correction reported; {@code --check} reports and exits 1 instead of writing.
 *
 * <p>Everything here is write-if-absent or reconcile-one-key: a file the human owns is never
 * rewritten, and the reply says what is still theirs (an {@code @AGENTS.md} line in a CLAUDE.md
 * that already exists, a permissions entry in a settings file that already exists).
 */
public final class ToolkitInit {
    private ToolkitInit() {}

    public static final Set<String> CLIENTS = new LinkedHashSet<>(List.of("claude", "cursor", "gemini", "vscode", "codex"));
    static final String CHARTER_RESOURCE = "/mcptoolkit/bootstrap/AGENTS.md";
    static final String DIST_PREFIX = "mcp-server-dist/";
    static final String PLUGIN_PREFIX = "blockbench-dist/";

    public enum Fate {
        WRITTEN, PRESENT, CORRECTED, UNCHANGED, EXTRACTED, WOULD_WRITE, WOULD_CORRECT,
        /**
         * There is nothing to write it FROM, so no run could produce it and its absence is not a
         * disagreement. Only the Blockbench plugins can be this: a jar built before 0.141.0 carries
         * no {@code blockbench-dist/}, and neither does a dev classes directory. Reporting
         * WOULD_WRITE there made {@code --check} fail forever on a state no real run could fix.
         */
        UNAVAILABLE
    }

    public record Report(Map<String, Fate> files, List<String> yours, List<String> notes, boolean disagreed) {}

    public record Request(Path repo, int port, Set<String> clients, String profile, Path jar, Path serverIndex, boolean check) {}

    // ---- the run --------------------------------------------------------------------------------

    public static Report run(final Request r, final PrintStream out) throws IOException {
        if (!Files.isDirectory(r.repo())) {
            throw new IllegalArgumentException("no such repository directory: " + r.repo());
        }
        Map<String, Fate> files = new LinkedHashMap<>();
        List<String> yours = new ArrayList<>();
        List<String> notes = new ArrayList<>();
        boolean[] disagreed = {false};
        String url = "http://127.0.0.1:" + r.port();

        // 1. Which server the registrations point at: the caller's, the one already registered, or
        // the one this jar carries.
        Path index = r.serverIndex();
        if (index == null) {
            McpServersFile.Entry existing = McpServersFile.find(r.repo().resolve(".mcp.json"), null);
            if (existing != null && existing.serverIndex() != null && Files.isRegularFile(Path.of(existing.serverIndex()))) {
                index = Path.of(existing.serverIndex());
                notes.add("MCP server: keeping the one .mcp.json already names, " + index);
            }
        }
        if (index == null) {
            Path dir = r.repo().resolve(".mcptoolkit").resolve("mcp-server");
            index = dir.resolve("index.mjs");
            if (Files.isRegularFile(index)) {
                files.put(rel(r, index), Fate.PRESENT);
            } else if (r.check()) {
                files.put(rel(r, index), Fate.WOULD_WRITE);
            } else {
                int n = extractServer(r.jar(), dir);
                files.put(rel(r, index), Fate.EXTRACTED);
                notes.add("MCP server: " + n + " files extracted from the jar into " + rel(r, dir)
                    + "; run `npm install --omit=dev` there once (Node >= 18)");
                yours.add("npm install --omit=dev in " + rel(r, dir) + " (the extracted MCP server's dependencies)");
            }
        }

        // 2. Registrations, one per client shape.
        Map<String, String> env = new LinkedHashMap<>();
        env.put("MCPTK_URL", url);
        if (r.profile() != null && !r.profile().isBlank()) {
            env.put("MCPTK_PROFILE", r.profile());
        }
        ServerSpec spec = new ServerSpec(McpServersFile.CANONICAL, r.repo(), "node", List.of(fs(index)), env, url, r.profile());
        for (String client : r.clients()) {
            switch (client) {
                case "claude" -> {
                    mcpServersJson(r, r.repo().resolve(".mcp.json"), spec, url, files, disagreed);
                    claudeExtras(r, url, files, yours);
                }
                case "cursor" -> mcpServersJson(r, r.repo().resolve(".cursor").resolve("mcp.json"), spec, url, files, disagreed);
                case "gemini" -> mcpServersJson(r, r.repo().resolve(".gemini").resolve("settings.json"), spec, url, files, disagreed);
                case "vscode" -> vscodeJson(r, r.repo().resolve(".vscode").resolve("mcp.json"), spec, url, files, disagreed);
                case "codex" -> codexToml(r, r.repo().resolve(".codex").resolve("config.toml"), spec, url, files, yours, disagreed);
                default -> throw new IllegalArgumentException("unknown client '" + client + "'; one of " + CLIENTS);
            }
        }

        // 3. The Blockbench plugins, beside the server they are a release unit with (TODO.md 1.10).
        // Write-if-absent, exactly like the extracted shim above and for the same reason: a file
        // already sitting there may be one a modder has edited or hand-loaded, and this task's whole
        // contract is that it writes each file once and never rewrites yours. A refresh is the DEV
        // BOOT's job - ServerExtract re-extracts both halves together under one stamp, so the pair
        // cannot drift there, which is the only place it could.
        Path plugins = r.repo().resolve(".mcptoolkit").resolve("blockbench");
        boolean pluginsThere = false;
        if (Files.isDirectory(plugins)) {
            try (java.util.stream.Stream<Path> in = Files.list(plugins)) {
                pluginsThere = in.findAny().isPresent();
            }
        }
        if (pluginsThere) {
            files.put(rel(r, plugins), Fate.PRESENT);
        } else if (r.check()) {
            // Ask whether a real run COULD write them before promising that it would: a check that
            // reports work no run can do is a check that never goes green.
            files.put(rel(r, plugins), pluginsAvailable(r.jar()) ? Fate.WOULD_WRITE : Fate.UNAVAILABLE);
        } else {
            try {
                int n = extractPlugins(r.jar(), plugins);
                files.put(rel(r, plugins), Fate.EXTRACTED);
                notes.add("Blockbench plugins: " + n + " written into " + rel(r, plugins)
                    + "; load them with File > Plugins > Load Plugin from File (LIVE_MODDING.md)");
            } catch (IOException e) {
                // Not fatal: a repository with no Blockbench in its workflow still wants everything
                // above. Say what did not happen rather than failing a run that otherwise succeeded.
                files.put(rel(r, plugins), Fate.UNAVAILABLE);
                notes.add("Blockbench plugins: not written (" + e.getMessage() + ")");
            }
        }

        // 4. The charter and the loop file, once each.
        Path agents = r.repo().resolve("AGENTS.md");
        writeIfAbsent(r, agents, charter(), files);
        Path loop = r.repo().resolve(".mcptoolkit").resolve("loop.json");
        writeIfAbsent(r, loop, loopJson(), files);

        if (r.check() && files.values().stream().anyMatch(f -> f == Fate.WOULD_WRITE || f == Fate.WOULD_CORRECT)) {
            disagreed[0] = true;
        }
        Report report = new Report(files, yours, notes, disagreed[0]);
        if (out != null) {
            print(r, report, url, out);
        }
        return report;
    }

    // ---- writers --------------------------------------------------------------------------------

    private static void mcpServersJson(final Request r, final Path file, final ServerSpec spec, final String url,
                                       final Map<String, Fate> files, final boolean[] disagreed) throws IOException {
        McpServersFile.Entry before = McpServersFile.find(file, null);
        boolean existed = Files.isRegularFile(file);
        if (r.check()) {
            if (before == null) {
                files.put(rel(r, file), Fate.WOULD_WRITE);
            } else if (!url.equals(before.bridgeUrl())) {
                files.put(rel(r, file), Fate.WOULD_CORRECT);
                disagreed[0] = true;
            } else {
                files.put(rel(r, file), Fate.UNCHANGED);
            }
            return;
        }
        McpServersFile.Result res = McpServersFile.write(file, spec);
        if (res.error() != null) {
            throw new IOException(res.error());
        }
        if (!res.changed()) {
            files.put(rel(r, file), Fate.UNCHANGED);
        } else if (before != null && !url.equals(before.bridgeUrl())) {
            files.put(rel(r, file), Fate.CORRECTED);
            disagreed[0] = true;
        } else {
            files.put(rel(r, file), existed && before != null ? Fate.UNCHANGED : Fate.WRITTEN);
        }
    }

    /** {@code .claude/settings.json} permissions and the {@code @AGENTS.md} import, write-if-absent. */
    private static void claudeExtras(final Request r, final String url, final Map<String, Fate> files,
                                     final List<String> yours) throws IOException {
        Path settings = r.repo().resolve(".claude").resolve("settings.json");
        String allow = "mcp__" + McpServersFile.CANONICAL + "__*";
        if (Files.isRegularFile(settings)) {
            files.put(rel(r, settings), Fate.PRESENT);
            if (!Files.readString(settings, StandardCharsets.UTF_8).contains(allow)) {
                yours.add(rel(r, settings) + " exists: add \"" + allow + "\" to permissions.allow, or every tool call asks first");
            }
        } else {
            JsonObject root = new JsonObject();
            root.addProperty("enableAllProjectMcpServers", true);
            JsonObject permissions = new JsonObject();
            var arr = new com.google.gson.JsonArray();
            arr.add(allow);
            permissions.add("allow", arr);
            root.add("permissions", permissions);
            writeIfAbsent(r, settings, new GsonBuilder().setPrettyPrinting().create().toJson(root) + "\n", files);
        }
        Path claudeMd = r.repo().resolve("CLAUDE.md");
        if (Files.isRegularFile(claudeMd)) {
            files.put(rel(r, claudeMd), Fate.PRESENT);
            if (!Files.readString(claudeMd, StandardCharsets.UTF_8).contains("@AGENTS.md")) {
                yours.add("CLAUDE.md exists: add a line `@AGENTS.md` so Claude Code reads the charter");
            }
        } else {
            writeIfAbsent(r, claudeMd, "@AGENTS.md\n", files);
        }
    }

    /** VS Code: the same JSON under {@code servers}, with {@code type: stdio}. Other servers kept as found. */
    private static void vscodeJson(final Request r, final Path file, final ServerSpec spec, final String url,
                                   final Map<String, Fate> files, final boolean[] disagreed) throws IOException {
        JsonObject root = new JsonObject();
        String before = null;
        if (Files.isRegularFile(file)) {
            before = Files.readString(file, StandardCharsets.UTF_8);
            try {
                JsonElement parsed = JsonParser.parseString(before);
                if (!parsed.isJsonObject()) {
                    throw new IOException(file + " is not a JSON object - refusing to overwrite it");
                }
                root = parsed.getAsJsonObject();
            } catch (RuntimeException e) {
                throw new IOException(file + " is not valid JSON (" + e.getMessage() + ") - refusing to overwrite it");
            }
        }
        JsonObject servers = root.has("servers") && root.get("servers").isJsonObject() ? root.getAsJsonObject("servers") : new JsonObject();
        root.add("servers", servers);
        JsonObject old = servers.has(spec.name()) && servers.get(spec.name()).isJsonObject() ? servers.getAsJsonObject(spec.name()) : null;
        String oldUrl = old != null && old.has("env") && old.getAsJsonObject("env").has("MCPTK_URL")
            ? old.getAsJsonObject("env").get("MCPTK_URL").getAsString() : null;
        JsonObject entry = new JsonObject();
        entry.addProperty("type", "stdio");
        entry.addProperty("command", spec.command());
        var args = new com.google.gson.JsonArray();
        spec.args().forEach(args::add);
        entry.add("args", args);
        JsonObject env = new JsonObject();
        spec.env().forEach(env::addProperty);
        entry.add("env", env);
        servers.add(spec.name(), entry);
        String after = new GsonBuilder().setPrettyPrinting().create().toJson(root) + "\n";
        Fate fate = before == null ? Fate.WRITTEN : before.trim().equals(after.trim()) ? Fate.UNCHANGED
            : oldUrl != null && !oldUrl.equals(url) ? Fate.CORRECTED : old == null ? Fate.WRITTEN : Fate.CORRECTED;
        if (fate == Fate.CORRECTED) {
            disagreed[0] = true;
        }
        if (r.check()) {
            files.put(rel(r, file), fate == Fate.UNCHANGED ? Fate.UNCHANGED : fate == Fate.CORRECTED ? Fate.WOULD_CORRECT : Fate.WOULD_WRITE);
            return;
        }
        if (fate != Fate.UNCHANGED) {
            Files.createDirectories(file.getParent());
            Files.writeString(file, after, StandardCharsets.UTF_8);
        }
        files.put(rel(r, file), fate);
    }

    /** Codex: one TOML table, appended when absent; an existing table is the human's and is reported. */
    private static void codexToml(final Request r, final Path file, final ServerSpec spec, final String url,
                                  final Map<String, Fate> files, final List<String> yours, final boolean[] disagreed) throws IOException {
        String header = "[mcp_servers." + spec.name() + "]";
        String before = Files.isRegularFile(file) ? Files.readString(file, StandardCharsets.UTF_8) : null;
        if (before != null && before.contains(header)) {
            files.put(rel(r, file), Fate.PRESENT);
            if (!before.contains(url)) {
                disagreed[0] = true;
                yours.add(rel(r, file) + " has a " + header + " table whose MCPTK_URL is not " + url + " - a TOML file is not rewritten; fix the port by hand");
            }
            return;
        }
        if (r.check()) {
            files.put(rel(r, file), Fate.WOULD_WRITE);
            return;
        }
        StringBuilder sb = new StringBuilder();
        if (before != null && !before.isEmpty() && !before.endsWith("\n")) {
            sb.append('\n');
        }
        sb.append('\n').append(header).append('\n')
            .append("command = \"").append(spec.command()).append("\"\n")
            .append("args = [");
        for (int i = 0; i < spec.args().size(); i++) {
            sb.append(i > 0 ? ", " : "").append('"').append(spec.args().get(i).replace("\\", "\\\\")).append('"');
        }
        sb.append("]\n").append("env = { ");
        int i = 0;
        for (Map.Entry<String, String> e : spec.env().entrySet()) {
            sb.append(i++ > 0 ? ", " : "").append(e.getKey()).append(" = \"").append(e.getValue()).append('"');
        }
        sb.append(" }\n");
        Files.createDirectories(file.getParent());
        Files.writeString(file, (before == null ? "" : before) + sb, StandardCharsets.UTF_8);
        files.put(rel(r, file), Fate.WRITTEN);
    }

    private static void writeIfAbsent(final Request r, final Path file, final String content, final Map<String, Fate> files) throws IOException {
        if (Files.isRegularFile(file)) {
            files.put(rel(r, file), Fate.PRESENT);
            return;
        }
        if (r.check()) {
            files.put(rel(r, file), Fate.WOULD_WRITE);
            return;
        }
        Files.createDirectories(file.getParent());
        Files.writeString(file, content, StandardCharsets.UTF_8);
        files.put(rel(r, file), Fate.WRITTEN);
    }

    /** The charter without its own preamble: everything after the first {@code ---} rule. */
    static String charter() throws IOException {
        try (InputStream in = ToolkitInit.class.getResourceAsStream(CHARTER_RESOURCE)) {
            if (in == null) {
                throw new IOException("the jar carries no " + CHARTER_RESOURCE + " (docs/guides/SESSION_CHARTER.md is copied there at build)");
            }
            String all = new String(in.readAllBytes(), StandardCharsets.UTF_8).replace("\r\n", "\n");
            int rule = all.indexOf("\n---\n");
            String body = rule < 0 ? all : all.substring(rule + 5);
            return "# Agent session charter\n\n"
                + "The MCP Toolkit's session charter for this repository, written once by `gradlew toolkitInit`;\n"
                + "yours to edit. Its site of record is `docs/guides/SESSION_CHARTER.md` in the toolkit.\n\n"
                + body.strip() + "\n";
        }
    }

    static String loopJson() {
        boolean win = System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
        String gradlew = win ? "./gradlew.bat" : "./gradlew";
        return "{\n"
            + "  \"_\": \"The project loop file (docs/guides/LOOPS.md). `checks` run after editing tools and once more after a unit session; `unit.start` runs before one. Written once by toolkitInit; yours.\",\n"
            + "  \"checks\": [\n"
            + "    { \"name\": \"assets\", \"run\": [\"" + gradlew + "\", \"-q\", \"checkAssets\"], \"timeout_ms\": 120000 }\n"
            + "  ]\n"
            + "}\n";
    }

    // ---- the server, out of the jar ------------------------------------------------------------

    /** Copy every {@code mcp-server-dist/} entry of the jar under {@code dir}; returns the file count. */
    static int extractServer(final Path jar, final Path dir) throws IOException {
        Path source = jar != null ? jar : ownJar();
        if (source == null || !Files.isRegularFile(source)) {
            throw new IOException("cannot find the toolkit jar to extract the MCP server from (pass --jar)");
        }
        int n = 0;
        try (ZipFile zf = new ZipFile(source.toFile())) {
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                if (!e.getName().startsWith(DIST_PREFIX) || e.isDirectory()) {
                    continue;
                }
                Path dest = dir.resolve(e.getName().substring(DIST_PREFIX.length()));
                Files.createDirectories(dest.getParent());
                try (InputStream in = zf.getInputStream(e)) {
                    Files.copy(in, dest, StandardCopyOption.REPLACE_EXISTING);
                }
                n++;
            }
        }
        if (n == 0) {
            throw new IOException(source + " carries no " + DIST_PREFIX + " - not a toolkit jar, or a dev classes directory");
        }
        return n;
    }

    /**
     * Copy every {@code blockbench-dist/} entry of the jar under {@code dir}; returns the file count.
     * Split from {@link #extractServer} rather than generalised, because the two differ in what an
     * EMPTY result means: a jar with no server is not a toolkit jar, while a jar with no plugins is
     * one built before 0.141.0 — a sentence the caller turns into a note, not a failure.
     */
    /** Whether a source carrying the plugins exists at all — the check-mode half of {@link #extractPlugins}. */
    static boolean pluginsAvailable(final Path jar) {
        Path source = jar != null ? jar : ownJar();
        if (source == null || !Files.isRegularFile(source)) {
            return false;
        }
        try (ZipFile zf = new ZipFile(source.toFile())) {
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                if (e.getName().startsWith(PLUGIN_PREFIX) && !e.isDirectory()) {
                    return true;
                }
            }
        } catch (IOException e) {
            return false;
        }
        return false;
    }

    static int extractPlugins(final Path jar, final Path dir) throws IOException {
        Path source = jar != null ? jar : ownJar();
        if (source == null || !Files.isRegularFile(source)) {
            throw new IOException("cannot find the toolkit jar to extract the Blockbench plugins from (pass --jar)");
        }
        int n = 0;
        try (ZipFile zf = new ZipFile(source.toFile())) {
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                if (!e.getName().startsWith(PLUGIN_PREFIX) || e.isDirectory()) {
                    continue;
                }
                Path dest = dir.resolve(e.getName().substring(PLUGIN_PREFIX.length()));
                Files.createDirectories(dest.getParent());
                try (InputStream in = zf.getInputStream(e)) {
                    Files.copy(in, dest, StandardCopyOption.REPLACE_EXISTING);
                }
                n++;
            }
        }
        if (n == 0) {
            throw new IOException(source + " carries no " + PLUGIN_PREFIX + " - a jar built before 0.141.0");
        }
        return n;
    }

    static Path ownJar() {
        try {
            CodeSource cs = ToolkitInit.class.getProtectionDomain().getCodeSource();
            if (cs == null) {
                return null;
            }
            Path p = Path.of(cs.getLocation().toURI());
            return Files.isRegularFile(p) ? p : null;
        } catch (URISyntaxException | RuntimeException e) {
            return null;
        }
    }

    // ---- reporting ------------------------------------------------------------------------------

    private static String rel(final Request r, final Path p) {
        try {
            return r.repo().toAbsolutePath().relativize(p.toAbsolutePath()).toString().replace('\\', '/');
        } catch (IllegalArgumentException e) {
            return p.toString();
        }
    }

    private static String fs(final Path p) {
        return p.toAbsolutePath().toString().replace('\\', '/');
    }

    public static void print(final Request r, final Report report, final String url, final PrintStream out) {
        out.println("toolkitInit " + r.repo() + " - bridge " + url + " (mcmod.port " + r.port() + "), clients " + r.clients()
            + (r.check() ? " [check only]" : ""));
        for (Map.Entry<String, Fate> e : report.files().entrySet()) {
            out.println(String.format("  %-14s %s", e.getValue().name().toLowerCase(Locale.ROOT).replace('_', ' '), e.getKey()));
        }
        for (String n : report.notes()) {
            out.println("  " + n);
        }
        if (!report.yours().isEmpty()) {
            out.println("\nstill yours:");
            for (String y : report.yours()) {
                out.println("  - " + y);
            }
        }
        if (report.disagreed()) {
            out.println(r.check()
                ? "\nDISAGREEMENT: a registration names another port than mcmod.port, or a file is missing - run `gradlew toolkitInit` to write"
                : "\nCORRECTED: a registration named another port than mcmod.port (section B0's trap: a session that drives the wrong game); it now names " + url);
        }
        out.println("\nnext: gradlew runClient (or launch_game from a session), then `ping` - it reports port " + r.port()
            + " and gameDir. Off Windows, run the game yourself; everything after ping is identical.");
    }

    // ---- the CLI --------------------------------------------------------------------------------

    /**
     * {@code --repo <dir> --port <n> [--jar <toolkit jar>] [--server <index.mjs>] [--clients a,b|all]
     * [--profile <p>] [--check]}. Exit 0 written or agreed; 1 on {@code --check} disagreement; 2 bad arguments.
     */
    public static void main(final String[] args) {
        Map<String, String> opts = new LinkedHashMap<>();
        boolean check = false;
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            if ("--check".equals(a)) {
                check = true;
            } else if (a.startsWith("--") && i + 1 < args.length) {
                opts.put(a.substring(2), args[++i]);
            } else {
                System.err.println("unexpected argument: " + a);
                System.exit(2);
            }
        }
        for (String required : new String[] {"repo", "port"}) {
            if (!opts.containsKey(required)) {
                System.err.println("missing --" + required + "\nusage: --repo <dir> --port <n> [--jar <toolkit jar>]"
                    + " [--server <index.mjs>] [--clients claude,cursor,gemini,vscode,codex|all] [--profile <p>] [--check]");
                System.exit(2);
            }
        }
        int port;
        try {
            port = Integer.parseInt(opts.get("port").trim());
            if (port < 1 || port > 65535) {
                throw new NumberFormatException();
            }
        } catch (NumberFormatException e) {
            System.err.println("--port must be a TCP port, got " + opts.get("port"));
            System.exit(2);
            return;
        }
        Set<String> clients = new LinkedHashSet<>();
        String want = opts.getOrDefault("clients", "claude");
        if (want.equalsIgnoreCase("all")) {
            clients.addAll(CLIENTS);
        } else {
            for (String c : want.split(",")) {
                if (!c.isBlank()) {
                    clients.add(c.trim().toLowerCase(Locale.ROOT));
                }
            }
        }
        for (String c : clients) {
            if (!CLIENTS.contains(c)) {
                System.err.println("unknown client '" + c + "'; one of " + CLIENTS + " or all");
                System.exit(2);
            }
        }
        Request r = new Request(Path.of(opts.get("repo")), port, clients, opts.get("profile"),
            opts.containsKey("jar") ? Path.of(opts.get("jar")) : null,
            opts.containsKey("server") ? Path.of(opts.get("server")) : null, check);
        Report report;
        try {
            report = run(r, System.out);
        } catch (IOException | IllegalArgumentException e) {
            System.err.println(e.getMessage());
            System.exit(2);
            return;
        }
        System.exit(check && report.disagreed() ? 1 : 0);
    }
}
