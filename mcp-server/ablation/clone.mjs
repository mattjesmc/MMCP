// Track 2 retrieval isolation (ABLATION_DESIGN.md): freeze a run's memory dir and clone it so two
// fresh E2 conversations fork from an IDENTICAL corpus — the only difference is the toolset.
// Restricted to scenarios whose E2 does not mutate the world (forked E2s share one world).

import { cp, mkdir, rm, access } from "node:fs/promises";
import { join } from "node:path";

/** Copy a run's memory root into a new run dir. Destination must not already have one. */
export async function cloneMemoryDir(sourceRunDir, destRunDir) {
  const src = join(sourceRunDir, "memory");
  await access(src); // throw early if the source run has no memory dir
  const dest = join(destRunDir, "memory");
  await rm(dest, { recursive: true, force: true });
  await mkdir(destRunDir, { recursive: true });
  await cp(src, dest, { recursive: true });
  return dest;
}
