package com.mattmc.mcptoolkit;

import com.sun.net.httpserver.HttpExchange;
import org.jspecify.annotations.Nullable;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * <b>The one rule on this bridge that is not advisory: a browser may not drive the game.</b>
 *
 * <p>Everything else a caller declares here — its session id, its profile — is taken on trust,
 * because the bridge is localhost-trusted and those are attribution, not authentication. An
 * {@code Origin} header is the exception, and the reason is mechanical rather than a matter of
 * policy: a browser attaches it to a cross-site request and <b>a page cannot forge or remove it</b>.
 * So it is the one thing a caller says that is worth checking, and it is worth checking precisely
 * because nothing else is.
 *
 * <p>The threat is not hypothetical and does not need a preflight to land. A cross-origin
 * {@code fetch} declaring {@code Content-Type: text/plain} is a CORS <i>simple request</i>: the
 * browser sends it without asking permission first, and although the page never gets to read the
 * reply, the side effect has already happened in somebody's world. Every tool on the manifest sits
 * behind that — {@code run_command} and {@code hotswap_class} among them — and the port is not a
 * secret (25599 in dev, 25600 in production; a page may simply try both).
 *
 * <p><b>Both doors, one check.</b> This lived inside {@code mcp/McpEndpoint} first, where the MCP
 * spec asks for it, and for one release the private {@code /cmd} door — the one that carries the
 * whole manifest with no surface slicing — did not make it. Two doors into one process disagreeing
 * about who may knock is not a policy, it is a hole; the check belongs to the bridge, so it lives
 * here and both doors call it.
 *
 * <p><b>An absent {@code Origin} is allowed, deliberately.</b> {@code curl}, the Node shim and every
 * non-browser MCP client send none. Refusing them is how a localhost dev tool becomes unusable in
 * order to be safe from a threat it had already handled.
 */
public final class BridgeOrigin {
    private BridgeOrigin() {}

    /** The refusal body, identical on both doors so a caller sees one sentence however it arrived. */
    public static final String REFUSAL =
        "{\"error\":\"this endpoint serves loopback origins only — a web page may not drive this game\"}";

    /**
     * Answer 403 and say why when this request carries a non-loopback {@code Origin}.
     *
     * @return true when the request was refused and the handler must return immediately
     */
    public static boolean refused(final HttpExchange ex) throws IOException {
        if (allowed(ex)) {
            return false;
        }
        // Named, at INFO: a page on the internet reaching somebody's game port is not noise, and
        // the only way anyone finds out it happened is this line.
        McpToolkit.LOGGER.info("[MCP Toolkit] refused {} {} from origin {} — not loopback",
            ex.getRequestMethod(), ex.getRequestURI().getPath(),
            ex.getRequestHeaders().getFirst("Origin"));
        byte[] bytes = REFUSAL.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(403, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
        return true;
    }

    /** Whether this request's {@code Origin} (if it has one at all) is loopback. */
    public static boolean allowed(final HttpExchange ex) {
        return isLoopback(ex.getRequestHeaders().getFirst("Origin"));
    }

    /**
     * Loopback, or nothing at all. {@code "null"} is the opaque origin a sandboxed frame or a
     * {@code file://} page sends, and it is not a host we can place — but it is also not a page that
     * can read a reply, and treating it as absent is what the MCP spec's own examples do.
     */
    public static boolean isLoopback(final @Nullable String origin) {
        if (origin == null || origin.isBlank() || "null".equals(origin.strip())) {
            return true;
        }
        String o = origin.strip().toLowerCase(Locale.ROOT);
        // The scheme is checked, not skipped over: "file://127.0.0.1" has a loopback-looking host and
        // is not a loopback origin, and an origin whose scheme we do not recognize is not one either.
        int scheme = o.indexOf("://");
        if (scheme < 0 || !(o.startsWith("http://") || o.startsWith("https://"))) {
            return false;
        }
        String host = o.substring(scheme + 3);
        int slash = host.indexOf('/');
        if (slash >= 0) {
            host = host.substring(0, slash);
        }
        int colon = host.lastIndexOf(':');
        if (colon > 0 && host.indexOf(']') < colon) {
            host = host.substring(0, colon);
        }
        return host.equals("127.0.0.1") || host.equals("localhost") || host.equals("[::1]")
            || host.equals("::1");
    }
}
