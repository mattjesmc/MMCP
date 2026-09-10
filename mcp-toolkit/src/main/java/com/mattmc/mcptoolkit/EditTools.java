package com.mattmc.mcptoolkit;

import com.google.gson.JsonObject;

/**
 * The shared surface over the {@link EditJournal}: undo any recent {@code world_edit} by its {@code undo_id}
 * and list what's undoable. Generalizes the old {@code undo_shape} (which reverted only the single last
 * shape) so {@code place_shape}, {@code set_blocks}, and future world-edit tools all roll back through one
 * mechanism (ARCHITECTURE.md, "Transactional world edits").
 */
public final class EditTools {
    private EditTools() {}

    public static void register() {
        McpTools.register(ToolDef.of(
            "undo_edit",
            "Undo a world edit (place_shape / place_shapes / set_blocks), restoring the exact blocks — "
                + "including block-entity contents like chest items — it changed. A place_shapes batch is ONE "
                + "edit, so one undo reverts every op in it. Pass `undo_id` (from the edit's response or "
                + "list_edits); omit it to undo YOUR session's most recent edit (another session's edit can "
                + "only be undone by explicit id — list_edits shows who made what). Errors if the id is "
                + "unknown or has aged out of the journal. Reports restored (and not_restored, retriable "
                + "under the same id, when cells could not be rewritten).",
            Schemas.objectOpt(Schemas.object(
                "undo_id", Schemas.str("The edit to undo (e.g. \"e-7\"). Omit to undo your most recent.")),
                "undo_id"),
            ExecutionContext.SERVER,
            Mechanism.WORLD_EDIT,
            (ctx, a) -> EditJournal.undo(
                a.has("undo_id") && !a.get("undo_id").isJsonNull() ? a.get("undo_id").getAsString() : null,
                ctx.sessionId())));

        McpTools.register(ToolDef.of(
            "list_edits",
            "List the undoable world edits, newest first: each edit's undo_id, the tool that made it, its "
                + "game_tick, how many blocks it changed, and its region. The journal keeps a bounded number "
                + "of recent edits; older ones are no longer undoable.",
            Schemas.object(),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> listEdits()));
    }

    private static JsonObject listEdits() {
        return EditJournal.list();
    }
}
