package com.mattmc.mcptoolkit.review;

import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import net.minecraft.server.MinecraftServer;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * <b>The review layer's front door: owed human tests, queued, staged, walked and answered.</b>
 *
 * <p>Every design document in a mod repository ends its record with a paragraph saying nobody has
 * looked at the thing yet. Those paragraphs are where owed human tests go to be forgotten: they are
 * prose, in a file that only grows, addressed to nobody, and there is no moment at which a person is
 * handed one. This is that queue instead — <b>an agent posts an ask; a human walks it; the answer
 * comes back where the next agent will find it.</b>
 *
 * <h2>Two ways in, one queue</h2>
 *
 * <ul>
 *   <li><b>Declared subjects</b> — {@link #declare}, called from a mod's {@code mcptoolkit}
 *       entrypoint. The right answer for "every value of every axis": enumerate the subjects from
 *       the code's own enums and the list cannot drift from the code. Re-declared on every boot;
 *       {@link ReviewQueue#merge} keeps the answers.</li>
 *   <li><b>Posted asks</b> — the {@code review_post} tool, or {@code /mmcp review ask} in-game. The right
 *       answer for "does the ash world's forty-block fog read as weather or as a bug", which exists
 *       only in the head of whoever just built it and can never be enumerated from anything.</li>
 * </ul>
 *
 * Neither alone is the mechanism. The two mods this layer was distilled from each built one of them
 * and neither could ask the other's kind of question.
 *
 * <h2>For mods</h2>
 *
 * <pre>{@code
 * public final class MyModTools implements McpToolkitEntrypoint {
 *     @Override public void registerTools(ToolRegistrar registrar) {
 *         Review.declare("mymod", () -> Stream.of(Reactor.values())
 *             .map(r -> Review.ask("reactor/" + r.id(),
 *                     "Does the " + r.id() + " reactor read as running?",
 *                     "the core glow and the exhaust plume, from 10 blocks back",
 *                     "no plume, or a glow that does not pulse")
 *                 .withSetup("mymod stage reactor " + r.id()))
 *             .toList());
 *     }
 * }
 * }</pre>
 *
 * The mod supplies the two things only it knows — <b>what the subjects are, and one command that
 * stages one</b>. Everything else (the file, the walk, the card, the verdicts, the tools) is the
 * toolkit's. That split is why the walk can live here at all: staging as a command crosses the mod
 * boundary, and staging as a Java callback never could.
 */
public final class Review {

    private Review() {}

    /** Declared subject suppliers, by mod id. Evaluated at server start, never at registration. */
    private static final Map<String, Supplier<List<ReviewAsk>>> DECLARED = new LinkedHashMap<>();

    /**
     * A fresh open ask. The source is stamped by {@link #declare} (or by the posting tool), so it is
     * not a parameter here — see {@link ReviewAsk#withSource}.
     *
     * @param failure what it looks like when it is wrong. <b>Required</b>: an ask that cannot fail
     *                spends a human's attention and returns nothing
     */
    public static ReviewAsk ask(final String id, final String title, final String look,
                                final String failure) {
        return ReviewAsk.open(id, "", title, look, failure, List.of(), null, null);
    }

    /**
     * Register a mod's subject list. Call from your {@code mcptoolkit} entrypoint.
     *
     * <p>The supplier runs on <b>every server start</b>, on the server thread, with the world loaded
     * — so it may consult registries, and it must be cheap. Its asks are stamped with {@code modId}
     * and merged into the shared queue under the rules in {@link ReviewQueue#merge}: existing
     * answers survive, descriptions refresh, and a subject you stop declaring stops being asked.
     *
     * <p>A supplier that throws costs its own mod's subjects and nothing else.
     */
    public static void declare(final String modId, final Supplier<List<ReviewAsk>> subjects) {
        DECLARED.put(modId, subjects);
    }

    // ---------------------------------------------------------------------------------------------

    public static void register() {
        ReviewCommands.register();
        ReviewTools.register();
        ServerHooks.SERVER_STARTED.register(Review::applyDeclarations);
        // Staging and checks run here, one tick after the command that asked for them — the only
        // place a nested command actually executes. See ReviewWalk.PENDING.
        ServerHooks.END_SERVER_TICK.register(ReviewWalk::drain);
        // The card is per player and the cursor is per player; a disconnect must not leave either
        // pointing at somebody who is gone.
        ServerHooks.SERVER_STOPPING.register(server -> ReviewWalk.rebuildSnapshot(null));
    }

    /**
     * Fold every mod's declared subjects into the queue, once, at server start.
     *
     * <p>At start rather than at registration because the file lives under the <em>server</em>
     * directory: there is no queue to merge into until a world is loaded, and on the integrated
     * server the process outlives worlds.
     */
    private static void applyDeclarations(final MinecraftServer server) {
        List<ReviewAsk> asks = ReviewQueue.load(server);
        final List<String> summary = new ArrayList<>();
        for (final Map.Entry<String, Supplier<List<ReviewAsk>>> entry : DECLARED.entrySet()) {
            final String modId = entry.getKey();
            try {
                final List<ReviewAsk> declared = new ArrayList<>();
                for (final ReviewAsk ask : entry.getValue().get()) {
                    declared.add(ask.withSource(modId));
                }
                asks = ReviewQueue.merge(asks, modId, declared);
                summary.add(modId + ": " + declared.size());
            } catch (final RuntimeException e) {
                // One mod's broken enumeration must not cost another mod its subjects, and must not
                // take down server start. Same rule as a failed tool registration.
                McpToolkit.LOGGER.error("[review] {} could not declare its subjects: {}",
                    modId, e.toString());
                summary.add(modId + ": FAILED");
            }
        }
        ReviewQueue.save(server, asks);
        // Sweep the checks BEFORE anyone reads the queue, so the list a session opens has already
        // had every machine-answerable ask closed. This is the layer's sharpest rule made
        // structural: a question the world can answer must not reach a human, and the moment to
        // find that out is before the walk, not during it.
        final List<String> closed = ReviewWalk.sweepChecks(server, server.createCommandSourceStack());
        if (!closed.isEmpty()) {
            McpToolkit.LOGGER.info("[review] {} ask(s) settled by their own check at start: {}",
                closed.size(), String.join(", ", closed));
            asks = ReviewQueue.load(server);
        }
        ReviewWalk.rebuildSnapshot(server);
        long open = asks.stream().filter(ReviewAsk::open).count();
        McpToolkit.LOGGER.info("[review] {} ask(s), {} open{} — {}", asks.size(), open,
            summary.isEmpty() ? "" : " (declared " + String.join(", ", summary) + ")",
            ReviewQueue.file(server));
    }
}
