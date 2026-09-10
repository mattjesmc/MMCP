#!/usr/bin/env node
// Print the raw mem_recent result as JSON for the harness's session-open render. Runs as a one-shot
// child process so each episode sees the CURRENT memory files — the shim (a separate process) wrote
// entries the parent's cached MemoryStore instance would never see.
// Env: MCPTK_MEMORY_DIR (required), MCPTK_RENDER_BUDGET (tokens, default 800).

import { bridge } from "./bridge.mjs";
import { callLocalTool } from "../memory/tools.mjs";

const budget = parseInt(process.env.MCPTK_RENDER_BUDGET || "800", 10);
const r = await callLocalTool("mem_recent", { budget_tokens: budget }, bridge);
process.stdout.write(JSON.stringify(r));
