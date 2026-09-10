// Shared scaffolding for the probe suite (MEMORY_DESIGN.md §Evaluation). Probes are executable specs:
// written against the frozen store API + file formats, red until build-order step 3 implements them.

// Probes are deterministic: the semantic backend is off unless a test opts in (semantic.test.mjs).
process.env.MCPTK_EMBED_BACKEND ??= "none";

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../store.mjs";

export const WORLD = { world_uuid: "test-world-0000", name: "probe-world" };
export const SESSION = "s-probe";

export async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), "mcmem-"));
  const store = new MemoryStore(root, WORLD);
  await store.open();
  return { root, store };
}

/** Parse one of the world's JSONL files into records; missing file = empty list. */
export async function records(root, file) {
  try {
    const text = await readFile(join(root, WORLD.world_uuid, file), "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

/** Note a positioned observation and return its entry record. */
export function obs(store, text, pos, tick, extra = {}) {
  return store.note({ kind: "obs", text, pos, tick, session: SESSION, ...extra });
}
