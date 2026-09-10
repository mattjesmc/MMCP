package com.mattmc.mcptoolkit;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import com.mattmc.mcptoolkit.platform.Platform;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

/**
 * The localhost HTTP bridge and dispatcher. Serves the tool manifest at {@code GET /tools} and runs tools
 * at {@code POST /cmd} with body {@code {tool, args}}, returning {@code {ok:true,result}} or
 * {@code {ok:false,error}} (always HTTP 200).
 *
 * <p><b>Threading.</b> The HTTP handler runs on its own thread; each tool is marshalled onto the loop its
 * {@link ExecutionContext} names, and the handler thread blocks on the result future (15s cap).
 *
 * <p><b>Lifecycle.</b> The HTTP server starts at mod init and stays up for the whole process (so client
 * and title-screen tools work before any world loads); it tracks the current {@link MinecraftServer} via
 * lifecycle events for server-context tools.
 *
 * <p><b>Gating.</b> On by default: port 25599 in a dev environment, 25600 in production (disable via
 * {@code config/mcptoolkit.properties}, see {@link BridgeConfig}). {@code -Dmcptoolkit.port=<port>}
 * overrides everything ({@code <=0} disables). Always bound to {@code 127.0.0.1}.
 */
public final class BridgeServer {
    private BridgeServer() {}

    // serializeNulls: an explicit JsonNull is always a deliberate tri-state verdict (line_of_sight,
    // check_* predicates, over-cap undo_id) — dropping it on the wire turned "observed as unknown"
    // into an absent key indistinguishable from "field doesn't exist". Absent keys stay absent.
    private static final Gson GSON = new com.google.gson.GsonBuilder().serializeNulls().create();
    /** Results above this serialized size get a warning: oversized outputs bloat the model's context
     * AND risk the client harness rewriting history (cache invalidation) — fix the tool, not the log. */
    private static final int RESULT_SIZE_WARN_BYTES = 8 * 1024;

    // volatile like its siblings: written on the bind-retry daemon thread, read by stop() from the
    // shutdown hook / SERVER_STOPPED — a stale read here is exactly the zombie-port failure mode.
    private static volatile @Nullable HttpServer http;
    private static volatile @Nullable MinecraftServer server;
    private static volatile @Nullable Consumer<Runnable> clientExecutor;
    /** Client-side observation-envelope stamper, installed by the client entrypoint. See
     * {@code client.ClientEnvelope} — kept behind a functional interface so this common-code
     * chokepoint never names a client class. */
    private static volatile @Nullable BiConsumer<String, JsonObject> clientEnvelope;
    /**
     * The port the socket is ACTUALLY listening on, or -1 until one is. Deliberately not set from
     * {@code init()}: it used to be, which made it the port the bridge INTENDED to bind, and a bind
     * that lost the race left every reader — the workspace writer among them — cheerfully reporting
     * a port nothing was serving.
     */
    private static volatile int boundPort = -1;
    /** What {@code init()} asked for, kept apart from what was got, so a failure can name both. */
    private static volatile int requestedPort = -1;

    private static final ToolContext CONTEXT = new ToolContext() {
        @Override public @Nullable MinecraftServer server() { return server; }
        @Override public MinecraftServer serverOrThrow() {
            MinecraftServer s = server;
            if (s == null) throw new IllegalStateException("no server running");
            return s;
        }
    };

    public static void init() {
        // Precedence: explicit -Dmcptoolkit.port (a value <= 0 disables) → config file → env default.
        Integer sysProp = Integer.getInteger("mcptoolkit.port");
        int port;
        if (sysProp != null) {
            port = sysProp;
        } else {
            BridgeConfig cfg = BridgeConfig.load();
            if (!cfg.enabled()) {
                McpToolkit.LOGGER.info("[MCP Toolkit] bridge disabled via config/mcptoolkit.properties");
                return;
            }
            port = cfg.port();
        }
        if (port <= 0) {
            return;
        }
        // The one call site that knows the port that actually governs, which is why the writer lives
        // here rather than in load(): with -Dmcptoolkit.port set — every Gradle dev run — load() is
        // never reached, and that is precisely the environment the file was undiscoverable in.
        BridgeConfig.ensureDefaultFile(port);
        requestedPort = port;
        // Track the running server for SERVER-context tools; the HTTP server itself stays up regardless.
        ServerHooks.SERVER_STARTED.register(s -> server = s);
        ServerHooks.SERVER_STOPPING.register(s -> server = null);
        // On a DEDICATED server the process should end when the game server stops — but the HTTP
        // dispatcher thread is non-daemon and would pin the JVM forever (zombie process holding the port
        // and the built jar's file lock). On a client the bridge outlives WORLDS by design (title-screen
        // tools), so nothing is registered here; it is closed at client shutdown instead, from
        // McpToolkitClient via ClientHooks.CLIENT_STOPPING. That half went missing when fabric-api was
        // removed in 0.79.0 and cost every dev-client quit a bogus crash report — see stop().
        if (Platform.isDedicatedServer()) {
            ServerHooks.SERVER_STOPPED.register(s -> stop());
            // Keep <gameDir>/mcptoolkit/mcp-server current on a HEADLESS server too.
            //
            // ServerExtract's own javadoc records the 2026-07-30 version of this bug and fixed it for
            // toolkit-SPAWNED sessions (the agent launcher and its adapters). A Claude session started
            // BY HAND in a workspace whose .mcp.json points at that copy — which is how the survival
            // lane runs — touches neither call site, so the extract only ever refreshed when someone
            // launched the client. Found live 2026-08-10: the deployed copy sat at 0.63.0 against a
            // 0.69.0 game. The hide-sets live in that Node layer while the tool list comes from the
            // live Java layer, so the drift did not merely withhold new tools — it LEAKED six dev
            // tools (wm_session_tag, wm_perturb, wm_verdict, wm_obsgap, human_task/_cancel) into the
            // restricted survival profile, i.e. straight into the hands of the embodied agent.
            //
            // Off-thread on purpose: a first-boot npm install would otherwise stall world load for up
            // to its 180s budget. Nothing can consume the extract before a client connects, which is
            // always later than this, so the brief race costs nothing.
            ServerHooks.SERVER_STARTED.register(s -> {
                Thread t = new Thread(() -> {
                    String err = ServerExtract.ensureFresh(Platform.gameDir());
                    if (err != null) {
                        McpToolkit.LOGGER.warn("[MCP Toolkit] headless extract refresh: {}", err);
                    }
                }, "mcptoolkit-extract");
                t.setDaemon(true);
                t.start();
            });
        }
        start(port);
    }

    /** Called from the client entrypoint with a client-thread executor. Absent on a dedicated server. */
    public static void setClientExecutor(Consumer<Runnable> exec) {
        clientExecutor = exec;
    }

    /**
     * Called from the client entrypoint with the client observation-envelope stamper. Absent on a
     * dedicated server, where no CLIENT-context tool is registered in the first place.
     */
    public static void setClientEnvelopeStamper(BiConsumer<String, JsonObject> stamp) {
        clientEnvelope = stamp;
    }

    /** Whether a client (and therefore CLIENT-context tools) is available in this environment. */
    public static boolean hasClient() {
        return clientExecutor != null;
    }

    /** The port the bridge is listening on, or -1 while it is not — disabled, still retrying a
     * contested bind, or given up on one. Bootstrap uses this so a generated workspace points at a
     * port this instance actually serves, and refuses to write one when there is none. */
    public static int boundPort() {
        return boundPort;
    }

    /** The port {@code init()} asked for, whether or not it was granted. For diagnosis only. */
    public static int requestedPort() {
        return requestedPort;
    }

    /** How many times to retry binding the port, and the gap between attempts. */
    private static final int BIND_ATTEMPTS = 45;
    private static final long BIND_RETRY_MS = 2000;
    /** Attempts that are plausibly the dev bootstrap JVM still exiting. Past this it is a rival game. */
    private static final int TRANSIENT_ATTEMPTS = 5;

    private static void start(final int port) {
        start(port, BIND_ATTEMPTS);
    }

    private static void start(final int port, final int attemptsLeft) {
        try {
            HttpServer h = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
            h.createContext("/cmd", BridgeServer::handleCmd);
            h.createContext("/tools", BridgeServer::handleTools);
            h.createContext("/hello", BridgeServer::handleHello);
            h.createContext("/heartbeat", BridgeServer::handleHeartbeat);
            h.createContext("/activity", BridgeServer::handleActivity);
            h.createContext("/humantask", BridgeServer::handleHumanTask);
            h.createContext("/review", BridgeServer::handleReview);
            // Cached daemon pool (not the serial default executor, not a small fixed pool): a
            // get_events long-poll now parks its handler thread up to 60s, and parked pollers must
            // never queue other tool calls behind them. Localhost-only, so unbounded is safe.
            h.setExecutor(java.util.concurrent.Executors.newCachedThreadPool(r -> {
                Thread t = new Thread(r, "mcptoolkit-http");
                t.setDaemon(true);
                return t;
            }));
            h.start();
            http = h;
            boundPort = port;   // only now is it true
            Runtime.getRuntime().addShutdownHook(new Thread(BridgeServer::stop, "mcptoolkit-shutdown"));
            McpToolkit.LOGGER.info("[MCP Toolkit] bridge listening on http://127.0.0.1:{} (/cmd, /tools)", port);
        } catch (java.net.BindException e) {
            // In dev, `runClient` spins up a short-lived bootstrap JVM alongside the real client; whichever
            // wins the bind holds the port until it exits. Retry so the long-lived process claims the port
            // once the transient one releases it, instead of giving up and leaving a live game with no bridge.
            if (attemptsLeft > 0) {
                // Past the transient window the cause is almost never the bootstrap JVM — it is
                // another dev game holding the port, which for most of this workspace's life meant
                // "you are about to run with no bridge while a session drives the OTHER game and
                // never finds out". Said once, at the transition, rather than 45 times.
                if (attemptsLeft == BIND_ATTEMPTS - TRANSIENT_ATTEMPTS) {
                    McpToolkit.LOGGER.warn("[MCP Toolkit] port {} has been held by another process for {}s — "
                        + "this is no longer the dev bootstrap JVM releasing it. Another game is almost "
                        + "certainly on this port; give this project one of its own (mcmod.port in "
                        + "gradle.properties, matched by MCPTK_URL in its .mcp.json).",
                        port, (BIND_RETRY_MS * TRANSIENT_ATTEMPTS) / 1000);
                }
                McpToolkit.LOGGER.info("[MCP Toolkit] port {} in use, retrying in {}ms ({} attempts left)…",
                    port, BIND_RETRY_MS, attemptsLeft);
                Thread t = new Thread(() -> {
                    try {
                        Thread.sleep(BIND_RETRY_MS);
                    } catch (InterruptedException ignored) {
                        return;
                    }
                    start(port, attemptsLeft - 1);
                }, "mcptoolkit-bind-retry");
                t.setDaemon(true);
                t.start();
            } else {
                // ERROR, not WARN. This game now has NO BRIDGE for the rest of its life, and the
                // observable symptom is somebody else's game answering perfectly on this port — a
                // wrong answer that looks right, which is the expensive kind.
                McpToolkit.LOGGER.error("[MCP Toolkit] NO BRIDGE: port {} was still held after {} attempts "
                    + "({}s). This game is running WITHOUT the MCP bridge; a session pointed at {} is "
                    + "talking to whichever game won that port, not to this one. Fix: give this project "
                    + "its own port (mcmod.port in gradle.properties + MCPTK_URL in .mcp.json), or "
                    + "-Pport=<n> for a one-off run.",
                    port, BIND_ATTEMPTS, (BIND_RETRY_MS * BIND_ATTEMPTS) / 1000, port);
            }
        } catch (IOException e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] bridge failed to start: {}", e.toString());
        }
    }

    /**
     * Close the HTTP server so its non-daemon dispatcher thread can end.
     *
     * <p>Public because both sides have to call it and they reach it from different places: a
     * dedicated server from {@code SERVER_STOPPED} just above, a client from
     * {@code ClientHooks.CLIENT_STOPPING} (registered in {@code McpToolkitClient}, which is the only
     * side where that class exists at all).
     *
     * <p><b>Not optional on either side.</b> {@code sun.net.httpserver}'s dispatcher is a non-daemon
     * thread that only {@code HttpServer.stop} ends, so a JVM that never calls this does not exit:
     * on a server it lingers holding the port and the jar's file lock, and on a client Minecraft's
     * shutdown watchdog eventually fires and writes a crash report for a game that did not crash.
     * Idempotent, so a double call (quit while stopping) is harmless.
     */
    public static void stop() {
        if (http != null) {
            http.stop(0);
            http = null;
        }
    }

    // ---- HTTP handlers -------------------------------------------------------

    private static void handleTools(final HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            respond(ex, 405, "{\"error\":\"use GET\"}");
            return;
        }
        respond(ex, 200, GSON.toJson(McpTools.manifest()));
    }

    /** The OBS record-supervisor's poll: is anything watchable happening right now? Serves the
     *  volatile snapshot {@code ActivitySnapshot} rebuilds each server tick — lock-free, no
     *  game-thread hop, safe at any poll rate. */
    private static void handleActivity(final HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            respond(ex, 405, "{\"error\":\"use GET\"}");
            return;
        }
        respond(ex, 200, com.mattmc.mcptoolkit.drone.ActivitySnapshot.json());
    }

    /** The task presenter's client poll (HUMAN_RIG_PLAN.md phase 4): the active human tasks as one
     *  volatile pre-serialized snapshot — goal-token content only, never waypoints. Pull, not push:
     *  the client tailer re-fetches state, so a restart mid-task re-presents the live task. */
    private static void handleHumanTask(final HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            respond(ex, 405, "{\"error\":\"use GET\"}");
            return;
        }
        respond(ex, 200, com.mattmc.mcptoolkit.wm.HumanTasks.snapshotJson());
    }

    /**
     * The review card's state, pulled by the client tailer — the same shape and the same reason as
     * {@code /humantask}: state-sync rather than fire-once, so a client that restarts mid-walk
     * re-fetches the live question, and one code path serves the integrated server and a localhost
     * dedicated one alike.
     */
    private static void handleReview(final HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            respond(ex, 405, "{\"error\":\"use GET\"}");
            return;
        }
        respond(ex, 200, com.mattmc.mcptoolkit.review.ReviewWalk.snapshotJson());
    }

    private static void handleCmd(final HttpExchange ex) throws IOException {
        JsonObject out = new JsonObject();
        ToolDef def = null;
        JsonObject args = new JsonObject();
        // Session identity: the shim stamps every call with its id (env-inherited or /hello-minted).
        // Absent header = anonymous legacy caller; everything still works, just unattributed.
        String session = ex.getRequestHeaders().getFirst("X-MCPTK-Session");
        if (session != null && session.isBlank()) {
            session = null;
        }
        // The caller's tool profile, so stream-level rules that depend on the session's ROLE can be
        // applied where the stream lives (EventTools keeps audit records out of player-legal senses).
        // Per-request rather than registry state: get_events is called by the session it describes,
        // so the request itself is the exact scope — nothing to go stale, nothing to reap.
        String profile = ex.getRequestHeaders().getFirst("X-MCPTK-Profile");
        if (profile != null && profile.isBlank()) {
            profile = null;
        }
        Sessions.touch(session);
        ToolContext ctx = requestContext(session, profile);
        try {
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            JsonObject req = GSON.fromJson(body.isBlank() ? "{}" : body, JsonObject.class);
            String tool = req.has("tool") ? req.get("tool").getAsString() : "";
            if (req.has("args") && req.get("args").isJsonObject()) {
                args = req.getAsJsonObject("args");
            }

            def = McpTools.get(tool);
            if (def == null) {
                throw new IllegalArgumentException("unknown tool: " + tool);
            }
            // Arguments are checked at the SAME chokepoint the mechanism stamp and the audit use,
            // and for the same reason: a contract enforced in tool bodies is a contract each new
            // tool can forget. See ArgCheck — an argument a tool does not have is a refusal.
            ArgCheck.validate(def, args);
            // Intent normalization (world-model DESIGN.md §14.3 step 1): every act call becomes an
            // intent record in the wm episodes stream BEFORE it reaches GoalRunner — this write
            // happens-before the dispatch below, which is the ordering the spec demands. No-op
            // unless the recorder is on.
            if (com.mattmc.mcptoolkit.wm.Wm.recording()) {
                com.mattmc.mcptoolkit.wm.WmIntents.record(def, args, session);
            }
            java.util.concurrent.atomic.AtomicBoolean started = new java.util.concurrent.atomic.AtomicBoolean(false);
            CompletableFuture<JsonElement> fut = dispatch(def, args, ctx, started);
            JsonElement result;
            try {
                result = fut.get(def.timeoutSeconds(), TimeUnit.SECONDS);
            } catch (java.util.concurrent.TimeoutException t) {
                // Cancel so a not-yet-started game-thread task is skipped (supplyOn checks) — a tool
                // the caller was already told failed must not go on to mutate the world later.
                fut.cancel(false);
                // A handler that began JUST before the timeout keeps running after ok:false is
                // returned — the one case where "it failed" and the world can disagree. Say so
                // instead of asserting nothing happened; the audit record carries the same message.
                if (started.get()) {
                    throw new java.util.concurrent.TimeoutException("timed out after "
                        + def.timeoutSeconds() + "s, but the handler had already STARTED — it may "
                        + "still complete and mutate the world; check get_events (audit) / "
                        + "list_edits before assuming nothing happened");
                }
                throw t;
            }
            // Contract stamp: every object result declares the authority class of the act it reports.
            // Stamped here at the dispatch chokepoint (inside `result`, so it survives the Node passthrough
            // to the MCP client), not in tool bodies — a declared-but-unchecked contract is no contract.
            if (result != null && result.isJsonObject() && !result.getAsJsonObject().has("mechanism")) {
                result.getAsJsonObject().addProperty("mechanism", def.mechanism().id());
            }
            // Embodied envelope (SURVIVAL_MODE_PLAN.md §4), same chokepoint doctrine: every embodied
            // result is datable/placeable from the BODY's own level, so Node capture never has to
            // refuse it. Stamped only when a body exists and the tool didn't already stamp (async
            // waited verdicts carry their completion-time stamp, which is the honest one). Reading
            // gameTime off-thread is a benign long read — the stamp is a date, not a mutation.
            if (result != null && result.isJsonObject() && def.mechanism() == Mechanism.EMBODIED) {
                com.mattmc.mcptoolkit.drone.DroneTools.stampEnvelopeFor(
                    result.getAsJsonObject(), session);
                // ATTENTION MUST NOT COST A TURN. 18% of session w2-56123 — 191 of 1085 calls —
                // were identical zero-argument polls: bot_watch{list} x100 to read a sightings
                // counter, bot_status{} x52, bot_scan{} x39. A standing attention primitive that
                // has to be POLLED is the one thing it should never be, and "am I at my goal yet"
                // had no cheap read at all, so a movement GOAL was being spent as one (58
                // already_there replies). Both now ride whatever act was already round-tripping —
                // the same doctrine as the survival digest's "danger rides the acts", and the
                // body's own report asked for exactly this in preference to a new event.
                com.mattmc.mcptoolkit.drone.DroneTools.stampBodyStateFor(
                    result.getAsJsonObject(), session);
            }
            // Client observation envelope (ARCHITECTURE.md's "remaining backfill: non-ladder observe
            // tools"): a CLIENT-context read is an observation too, and the rule that made the
            // server ladder carry a date is not about the world side — an observation nothing can
            // date is uncapturable. get_screen and its siblings were arriving with a mechanism tag
            // and nothing else, so a screen tree read this tick and one read three minutes ago were
            // the same object in a transcript. Stamped here rather than in eight tool bodies, for
            // the same reason the mechanism tag is: a contract each handler must remember is one the
            // next handler will forget. The stamper knows what a client-side envelope means (its
            // clock is the CLIENT's, and a title screen honestly has no clock at all).
            if (result != null && result.isJsonObject() && def.context() == ExecutionContext.CLIENT
                    && def.mechanism() == Mechanism.OBSERVE) {
                BiConsumer<String, JsonObject> stamp = clientEnvelope;
                if (stamp != null) {
                    stamp.accept(def.name(), result.getAsJsonObject());
                }
            }
            audit(def, args, true, null, session);
            out.addProperty("ok", true);
            out.add("result", result);
            warnOversized(def, result);
        } catch (Exception e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            String message = cause.getMessage() == null ? cause.toString() : cause.getMessage();
            audit(def, args, false, message, session);
            out.addProperty("ok", false);
            out.addProperty("error", message);
        }
        respond(ex, 200, GSON.toJson(out));
    }

    /**
     * Emit an audit event for consequential ({@code world_edit}/{@code privileged}) calls — successes AND
     * failed attempts. Emitted at the dispatch chokepoint so no tool can change the world unrecorded.
     * With concurrent sessions the record also names WHICH session acted ({@code session}), so the audit
     * trail stays attributable — anonymous callers are recorded as such by the field's absence.
     */
    private static void audit(final @Nullable ToolDef def, final JsonObject args, final boolean ok,
                              final @Nullable String error, final @Nullable String session) {
        if (def == null
            || (def.mechanism() != Mechanism.WORLD_EDIT && def.mechanism() != Mechanism.PRIVILEGED)) {
            return;
        }
        JsonObject d = new JsonObject();
        d.addProperty("tool", def.name());
        d.addProperty("mechanism", def.mechanism().id());
        d.addProperty("ok", ok);
        if (session != null) {
            d.addProperty("session", session);
        }
        if (error != null) {
            d.addProperty("error", error);
        }
        d.add("args", compactArgs(args));
        EventLog.emit("audit", d);
    }

    /**
     * {@code POST /hello} — external-session registration and self-declaration.
     *
     * <p>A shim launched without an inherited {@code MCPTK_SESSION} (someone opened an agent client in
     * the workspace themselves) calls this once, lazily, on its first tool call, and stamps the
     * returned id on every later call. This is the INBOUND half of the agent-client story and it needs
     * no toolkit configuration at all - the only direction there is.
     *
     * <p>Body: {@code {label?, client?, client_version?}}. What inbound lacked was never plumbing but
     * IDENTITY — the handshake carried only a label, so nothing on the mod side knew which client had
     * connected. The declaration is advisory, like the profile header: the bridge is localhost-trusted.
     *
     * <p>The reply carries an ORIENTATION pointer, and that is the whole fix for a real gap. The
     * session-open memory render is universal in mechanism — {@code mem_recent} returns it as an
     * ordinary tool result, and the hook that shows it on one client is just a shell calling that
     * tool. What a fresh session on any other host lacks is a REASON to call it. So it is told, once,
     * at the only moment the toolkit gets to speak first.
     */
    private static void handleHello(final HttpExchange ex) throws IOException {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            respond(ex, 405, "{\"error\":\"use POST\"}");
            return;
        }
        String label = "external";
        String client = null;
        String clientVersion = null;
        try {
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            JsonObject req = GSON.fromJson(body.isBlank() ? "{}" : body, JsonObject.class);
            if (req != null) {
                String l = str(req, "label");
                if (l != null) {
                    label = l.length() > 40 ? l.substring(0, 40) : l;
                }
                client = str(req, "client");
                clientVersion = str(req, "client_version");
            }
        } catch (RuntimeException ignored) {
            // malformed body: register with the default label rather than failing the handshake
        }
        Sessions.Entry e = Sessions.mint(Sessions.Kind.EXTERNAL, label, null);
        e.declare(client, clientVersion);
        McpToolkit.LOGGER.info("[MCP Toolkit] session {} said hello as \"{}\"{}",
            e.id, label, client == null ? " (client not declared)" : " via " + client);
        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        out.addProperty("session", e.id);
        out.addProperty("orientation", ORIENTATION);
        respond(ex, 200, GSON.toJson(out));
    }

    /**
     * What a session that has just introduced itself should do to orient. Deliberately a list of TOOL
     * CALLS: every one of them works on any host that can call a tool, which is the whole point — the
     * alternative was a render delivered by one client's session-open hook, invisible everywhere else.
     */
    private static final String ORIENTATION =
        "Call mem_recent for what previous sessions in this world learned (this is the memory render; "
        + "on hosts with session-open hooks it arrives automatically, and calling it again is cheap), "
        + "ping to identify the instance and its extensions, and get_world_info for the world you are "
        + "attached to. If you have a body, bot_status.";

    /** One optional string field, stripped, or null when absent/blank/not a string. */
    private static @Nullable String str(final JsonObject o, final String key) {
        if (!o.has(key) || !o.get(key).isJsonPrimitive()) {
            return null;
        }
        String v = o.get(key).getAsString().strip();
        return v.isEmpty() ? null : v;
    }

    /**
     * {@code POST /heartbeat} — liveness keep-alive. The shim pings this every ~30s with its
     * {@code X-MCPTK-Session} header so idle-but-open sessions stay live in the registry, which is
     * what lets session death be detected fast (session-bound drones are reaped on it).
     */
    private static void handleHeartbeat(final HttpExchange ex) throws IOException {
        String session = ex.getRequestHeaders().getFirst("X-MCPTK-Session");
        Sessions.touch(session != null && !session.isBlank() ? session : null);
        respond(ex, 200, "{\"ok\":true}");
    }

    /** A per-request view of the tool environment: the shared server refs plus the caller's identity. */
    private static ToolContext requestContext(final @Nullable String session,
                                              final @Nullable String profile) {
        if (session == null && profile == null) {
            return CONTEXT;
        }
        return new ToolContext() {
            @Override public @Nullable MinecraftServer server() { return CONTEXT.server(); }
            @Override public MinecraftServer serverOrThrow() { return CONTEXT.serverOrThrow(); }
            @Override public @Nullable String sessionId() { return session; }
            @Override public @Nullable String profile() { return profile; }
        };
    }

    /**
     * Token-budget tripwire: every tool result should stay under {@link #RESULT_SIZE_WARN_BYTES}
     * serialized. Images are exempt ({@code _image} travels as an MCP image part, not JSON text).
     * The response still goes out — the warning names the tool so it gets fixed at source.
     */
    private static void warnOversized(final ToolDef def, final @Nullable JsonElement result) {
        if (result == null || (result.isJsonObject() && result.getAsJsonObject().has("_image"))) {
            return;
        }
        int size = GSON.toJson(result).length();
        if (size > RESULT_SIZE_WARN_BYTES) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] {} returned {} bytes (budget {}) — oversized results "
                + "bloat the agent's context and can invalidate its prompt cache; add/tighten summarization",
                def.name(), size, RESULT_SIZE_WARN_BYTES);
        }
    }

    /** Args verbatim when small; a bounded preview otherwise (push_asset carries whole base64 files). */
    private static JsonElement compactArgs(final JsonObject args) {
        String s = GSON.toJson(args);
        if (s.length() <= 300) {
            return args.deepCopy();
        }
        JsonObject o = new JsonObject();
        o.addProperty("truncated", true);
        o.addProperty("length", s.length());
        o.addProperty("preview", s.substring(0, 300));
        return o;
    }

    private static void respond(final HttpExchange ex, final int status, final String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    // ---- dispatch ------------------------------------------------------------

    private static CompletableFuture<JsonElement> dispatch(final ToolDef def, final JsonObject args,
                                                           final ToolContext ctx,
                                                           final java.util.concurrent.atomic.AtomicBoolean started) {
        switch (def.context()) {
            case ANY -> {
                try {
                    started.set(true); // runs inline on the HTTP thread; a timeout can only be late
                    return def.handler().apply(ctx, args);
                } catch (Throwable t) {
                    return CompletableFuture.failedFuture(t);
                }
            }
            case SERVER -> {
                MinecraftServer s = server;
                if (s == null) {
                    return failed("no server running — load a world first");
                }
                return supplyOn(s::execute, def, args, ctx, started);
            }
            case CLIENT -> {
                Consumer<Runnable> ce = clientExecutor;
                if (ce == null) {
                    return failed("no client in this environment (dedicated server)");
                }
                return supplyOn(ce, def, args, ctx, started);
            }
            default -> {
                return failed("unhandled execution context: " + def.context());
            }
        }
    }

    /** Marshal the handler onto the given loop and flatten the handler's own future into the result. */
    private static CompletableFuture<JsonElement> supplyOn(final Consumer<Runnable> executor,
                                                           final ToolDef def, final JsonObject args,
                                                           final ToolContext ctx,
                                                           final java.util.concurrent.atomic.AtomicBoolean started) {
        CompletableFuture<JsonElement> out = new CompletableFuture<>();
        executor.accept(() -> {
            // Dispatch already timed out (handleCmd cancelled the future and reported failure):
            // don't run the handler at all — a reported-failed world edit must not land late.
            // `started` is raised BEFORE the isDone check (and lowered again on the skip path):
            // if the handler runs at all, the timeout side is guaranteed to see started=true and
            // disclose the possible late effect — the flag can only ever err toward disclosure.
            started.set(true);
            if (out.isDone()) {
                started.set(false);
                return;
            }
            try {
                def.handler().apply(ctx, args).whenComplete((res, err) -> {
                    if (err != null) out.completeExceptionally(err);
                    else out.complete(res);
                });
            } catch (Throwable t) {
                out.completeExceptionally(t);
            }
        });
        return out;
    }

    private static CompletableFuture<JsonElement> failed(final String message) {
        return CompletableFuture.failedFuture(new IllegalStateException(message));
    }
}
