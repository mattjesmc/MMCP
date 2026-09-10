package com.mattmc.mcptoolkit.wm;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mattmc.mcptoolkit.McpToolkit;
import org.jspecify.annotations.Nullable;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

/**
 * The wmserve connection (the world-model project's wmserve/PROTOCOL.md): persistent localhost TCP, one JSON
 * object per line, requests answered in order. All socket work lives on ONE dedicated IO thread —
 * the server thread only ever enqueues, so a stalled or absent sidecar can never stall a game
 * tick (the §13.2 contract is that the POLICY runs at 20&nbsp;Hz, not that the game waits for it).
 *
 * <p>Failure posture: a bounded queue that DROPS when full (counted, logged once a second at
 * most), reconnection with backoff, and a version-refused handshake that disables the client for
 * the rest of the run — a sidecar speaking the wrong feature schema must not be retried into
 * compliance (PROTOCOL.md: refuse, never adapt).
 */
final class WmPolicyClient implements AutoCloseable {

    private static final Gson GSON = new Gson();
    private static final int QUEUE_CAPACITY = 256;
    private static final long RECONNECT_BACKOFF_MS = 5_000;

    private record Pending(JsonObject request, @Nullable Consumer<JsonObject> onResponse,
                           @Nullable CompletableFuture<JsonObject> waiter) { }

    private final String host;
    private final int port;
    private final JsonObject hello;
    private final BlockingQueue<Pending> queue = new ArrayBlockingQueue<>(QUEUE_CAPACITY);
    private final Thread io;
    private final AtomicLong ids = new AtomicLong();
    private final AtomicLong dropped = new AtomicLong();
    private volatile boolean closed;
    private volatile boolean refused; // version mismatch: permanently off this run
    private volatile long lastDropLog;

    WmPolicyClient(final String host, final int port, final JsonObject hello) {
        this.host = host;
        this.port = port;
        this.hello = hello;
        this.io = new Thread(this::runLoop, "mcptoolkit-wmpolicy");
        this.io.setDaemon(true);
        this.io.start();
    }

    boolean healthy() {
        return !closed && !refused;
    }

    /** Fire-and-forget (shadow traffic): enqueue, drop-with-count when the queue is full. */
    void enqueue(final JsonObject request, final @Nullable Consumer<JsonObject> onResponse) {
        if (!healthy()) {
            return;
        }
        if (!queue.offer(new Pending(request, onResponse, null))) {
            long n = dropped.incrementAndGet();
            long now = System.currentTimeMillis();
            if (now - lastDropLog > 1_000) {
                lastDropLog = now;
                McpToolkit.LOGGER.warn("[MCP Toolkit] wm policy queue full — {} requests dropped "
                    + "so far (sidecar slow or gone?)", n);
            }
        }
    }

    /** Synchronous ask (the ON-mode driving step): bounded wait, null on timeout/unhealthy. */
    @Nullable JsonObject request(final JsonObject request, final long timeoutMs) {
        if (!healthy()) {
            return null;
        }
        CompletableFuture<JsonObject> waiter = new CompletableFuture<>();
        if (!queue.offer(new Pending(request, null, waiter))) {
            dropped.incrementAndGet();
            return null;
        }
        try {
            return waiter.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    long droppedCount() {
        return dropped.get();
    }

    // ---- the IO thread ---------------------------------------------------------

    private void runLoop() {
        while (!closed && !refused) {
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress(host, port), 2_000);
                socket.setTcpNoDelay(true);
                Writer out = new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8);
                BufferedReader in = new BufferedReader(
                    new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                if (!handshake(out, in)) {
                    return; // refused: logged, permanently off
                }
                McpToolkit.LOGGER.info("[MCP Toolkit] wm policy sidecar connected at {}:{}",
                    host, port);
                pump(out, in);
            } catch (IOException e) {
                // Sidecar not up (yet): quiet backoff — shadow mode must cost nothing when the
                // process simply isn't running.
            }
            if (!closed && !refused) {
                try {
                    Thread.sleep(RECONNECT_BACKOFF_MS);
                } catch (InterruptedException e) {
                    return;
                }
            }
        }
    }

    private boolean handshake(final Writer out, final BufferedReader in) throws IOException {
        JsonObject h = hello.deepCopy();
        h.addProperty("id", ids.incrementAndGet());
        out.write(GSON.toJson(h));
        out.write('\n');
        out.flush();
        String line = in.readLine();
        if (line == null) {
            throw new IOException("closed during handshake");
        }
        JsonObject reply = JsonParser.parseString(line).getAsJsonObject();
        if (reply.has("ok") && reply.get("ok").getAsBoolean()) {
            return true;
        }
        refused = true;
        McpToolkit.LOGGER.error("[MCP Toolkit] wm policy sidecar REFUSED the handshake — policy "
            + "disabled for this run (a model trained on other features must never drive a "
            + "body): {}", reply);
        return false;
    }

    private void pump(final Writer out, final BufferedReader in) throws IOException {
        while (!closed) {
            Pending p;
            try {
                p = queue.poll(500, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                return;
            }
            if (p == null) {
                continue;
            }
            JsonObject req = p.request();
            req.addProperty("id", ids.incrementAndGet());
            out.write(GSON.toJson(req));
            out.write('\n');
            out.flush();
            String line = in.readLine();
            if (line == null) {
                requeueFailed(p);
                throw new IOException("sidecar closed mid-request");
            }
            JsonObject reply = JsonParser.parseString(line).getAsJsonObject();
            if (p.waiter() != null) {
                p.waiter().complete(reply);
            } else if (p.onResponse() != null) {
                try {
                    p.onResponse().accept(reply);
                } catch (RuntimeException e) {
                    McpToolkit.LOGGER.warn("[MCP Toolkit] wm policy response handler threw: {}",
                        e.toString());
                }
            }
        }
    }

    private void requeueFailed(final Pending p) {
        if (p.waiter() != null) {
            p.waiter().complete(null);
        }
    }

    @Override
    public void close() {
        closed = true;
        io.interrupt();
    }
}
