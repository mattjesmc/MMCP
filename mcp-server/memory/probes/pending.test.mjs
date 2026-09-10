// Pending-candidate surface (MEMORY_DESIGN.md §Pending-memory surface): rule-based candidates nag in
// mem_recent until described (mem_note with refs.events → ack relation) or dismissed. Rules only —
// no importance classifier. The queue is assistive derived state; acks ARE memory (relations).

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent } from "../tools.mjs";
import { makeStore, records } from "./helpers.mjs";
import { SESSION } from "./helpers.mjs";

test("classification rules: outcomes/failures/world-edits flag, routine noise does not", () => {
  const flag = (ev) => classifyEvent(ev)?.rule ?? null;
  // An arrival is routine mechanics (archive/TOKEN_EFFICIENCY_PLAN.md §5) — only NON-arrivals flag.
  assert.equal(flag({ id: 1, game_tick: 10, type: "action_completed", data: { action: "goto", arrived: true } }), null);
  assert.equal(flag({ id: 1, game_tick: 10, type: "action_completed", data: { action: "goto", arrived: false } }), "action_outcome");
  assert.equal(flag({ id: 2, game_tick: 11, type: "action_failed", data: { reason: "path_blocked" } }), "action_outcome");
  // A supersede (new goto replacing the old while tailing) is control flow, never pending.
  assert.equal(flag({ id: 2, game_tick: 11, type: "action_superseded", data: { reason: "superseded" } }), null);
  assert.equal(flag({ id: 3, game_tick: 12, type: "audit", data: { tool: "place_shape", mechanism: "world_edit", ok: true, args: {} } }), "world_edit");
  assert.equal(flag({ id: 4, game_tick: 13, type: "audit", data: { tool: "run_command", mechanism: "privileged", ok: false, error: "boom" } }), "failed_authority_call");
  assert.equal(flag({ id: 5, game_tick: 14, type: "drone_removed", data: { reason: "died_or_unloaded" } }), "drone_lost");
  // Noise: routine successful privileged calls, ambient world/observer events, drone replacement.
  assert.equal(flag({ id: 6, game_tick: 15, type: "audit", data: { tool: "run_command", mechanism: "privileged", ok: true } }), null);
  assert.equal(flag({ id: 7, game_tick: 16, type: "time_of_day", data: { label: "dusk" } }), null);
  assert.equal(flag({ id: 8, game_tick: 17, type: "entity_entered_radius", data: {} }), null);
  assert.equal(flag({ id: 9, game_tick: 18, type: "drone_removed", data: { reason: "replaced" } }), null);
});

test("body events: death and the silent killers are candidates, routine pain is not", () => {
  const flag = (ev) => classifyEvent(ev)?.rule ?? null;
  const at = (data) => ({ id: 1, game_tick: 100, type: "body_died", data });
  // How the body died is the memory a next session most needs — and it used to vanish with the ring.
  assert.equal(flag(at({ cause: "drown", pos: { x: 12.5, y: 61, z: -8.2 }, hazards: ["air_low"] })), "body_died");
  const died = classifyEvent(at({ cause: "drown", pos: { x: 12.5, y: 61, z: -8.2 }, hazards: ["air_low"] }));
  assert.match(died.summary, /DIED at \(13, 61, -8\): drown while air_low/);
  // A death with no position still classifies — a candidate that says "somewhere" beats none.
  assert.match(classifyEvent(at({ cause: "lava" })).summary, /DIED at an unknown place: lava/);

  const danger = (cause, extra = {}) =>
    flag({ id: 2, game_tick: 101, type: "body_endangered", data: { cause, pos: { x: 1, y: 2, z: 3 }, ...extra } });
  // The killers that look like nothing flag …
  assert.equal(danger("air_low", { seconds_left: 4 }), "body_hazard");
  assert.equal(danger("in_lava"), "body_hazard");
  assert.equal(danger("suffocating"), "body_hazard");
  // … the frequent, self-explaining ones do not (nagging about them trains bulk dismissal).
  assert.equal(danger("falling"), null);
  assert.equal(danger("on_fire"), null);
  assert.equal(danger("starving"), null);
  // Recovery and per-hit damage are situational awareness, not memory.
  assert.equal(flag({ id: 3, game_tick: 102, type: "body_safe", data: { cause: "air_low" } }), null);
  assert.equal(flag({ id: 4, game_tick: 103, type: "body_damaged", data: { cause: "mob", health: 12 } }), null);
});

test("pending lifecycle: nag in recent, auto-ack via mem_note refs, dismiss drops without a relation", async () => {
  const { root, store } = await makeStore();
  await store.updatePending(42, [
    { event_id: 40, game_tick: 5000, rule: "action_outcome", summary: "goto completed", t: "2026-07-19T12:00:00Z" },
    { event_id: 41, game_tick: 5100, rule: "world_edit", summary: "place_shape …", t: "2026-07-19T12:01:00Z" },
  ]);

  // Both candidates nag in the render and the structured result.
  const r1 = await store.recent({});
  assert.equal(r1.pending.length, 2);
  assert.ok(r1.render.includes("[pending] 2 event(s)"));
  assert.ok(r1.render.includes("goto completed"));

  // Describing one (refs.events) acknowledges it: ack relation written, candidate gone.
  const entry = await store.note({
    kind: "outcome", text: "Drone arrived at the ravine site (-210,58,290).",
    pos: [-210, 58, 290], tick: 5200, session: SESSION, refs: { events: [40] },
  });
  const acks = (await records(root, "relations.jsonl")).filter((r) => r.kind === "ack");
  assert.deepEqual(acks.map((a) => [a.event_id, a.entry]), [[40, entry.id]]);
  assert.deepEqual((await store.recent({})).pending.map((c) => c.event_id), [41]);

  // Dismissal drops the candidate but writes NO relation — deliberate non-memory.
  assert.equal(await store.dismissPending([41]), 1);
  const r2 = await store.recent({});
  assert.equal(r2.pending.length, 0);
  assert.ok(!r2.render.includes("[pending]"));
  assert.equal((await records(root, "relations.jsonl")).filter((r) => r.kind === "ack").length, 1);

  // Queue state survives a cold rebuild (pending.json is derived but persistent).
  const { MemoryStore } = await import("../store.mjs");
  const store2 = new MemoryStore(root, store.worldInfo);
  await store2.open();
  assert.equal(store2.eventCursor, 42);
  assert.equal(store2.pending.length, 0);

  // Re-delivery of an already-known candidate does not duplicate.
  await store.updatePending(43, [{ event_id: 99, game_tick: 6000, rule: "world_edit", summary: "x", t: "2026-07-19T12:05:00Z" }]);
  await store.updatePending(43, [{ event_id: 99, game_tick: 6000, rule: "world_edit", summary: "x", t: "2026-07-19T12:05:00Z" }]);
  assert.equal(store.pending.length, 1);

  // Bulk dismiss by rule sweeps every candidate of that rule (backlog hygiene), leaves others.
  await store.updatePending(45, [
    { event_id: 100, game_tick: 6100, rule: "action_outcome", summary: "goto a-1 FAILED: x", t: "2026-07-19T12:06:00Z" },
    { event_id: 101, game_tick: 6101, rule: "action_outcome", summary: "goto a-2 FAILED: x", t: "2026-07-19T12:06:01Z" },
  ]);
  assert.equal(store.pending.length, 3);
  assert.equal(await store.dismissPending([], "action_outcome"), 2);
  assert.deepEqual(store.pending.map((c) => c.event_id), [99]);
});
