// DORMANT — the raw Messages-API runner, kept for when an API key exists. The live substrate is
// runner-sdk.mjs (Claude Agent SDK on the Max subscription); run.mjs no longer imports this file.
//
// Headless agent loop for the ablation (ABLATION_DESIGN.md §Runner) — deliberately the seed of
// companion mode (build-order step 8 starts here). Manual tool loop over the Anthropic SDK:
// per-turn transcript is verbatim (args, result envelope, wall time) because it is the metrics
// source of truth — the mod's audit log covers world-edit/privileged calls only.

const RESULT_CHAR_CAP = 24000;

function textOf(content) {
  return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

/**
 * Run one episode: a fresh conversation, tool loop until the model stops calling tools or the turn
 * cap hits. A capped episode is an outcome (failure at max cost), not missing data.
 *
 * @param {object} o
 * @param {import("@anthropic-ai/sdk").default} o.client
 * @param {string} o.model      e.g. "claude-sonnet-5" (decided in ABLATION_DESIGN §Runner)
 * @param {string} o.effort     output_config.effort — frozen per run, logged
 * @param {string} o.system
 * @param {Array}  o.tools      Anthropic tool defs (condition-filtered)
 * @param {(name: string, input: object) => Promise<{ok: boolean}>} o.dispatch
 * @param {string} o.userMessage
 * @param {number} o.maxTurns   API round-trips, not tool calls
 * @param {(line: string) => void} [o.log]
 */
export async function runEpisode({ client, model, effort, system, tools, dispatch, userMessage, maxTurns, log = () => {} }) {
  const messages = [{ role: "user", content: userMessage }];
  const transcript = [{ t: new Date().toISOString(), type: "user", text: userMessage }];
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let turns = 0;
  let capped = false;
  let finalText = "";

  while (true) {
    if (turns >= maxTurns) {
      capped = true;
      log(`turn cap ${maxTurns} hit — episode capped`);
      break;
    }
    const response = await client.messages.create({
      model,
      max_tokens: 8000,
      system,
      tools,
      messages,
      output_config: { effort },
    });
    turns++;
    for (const k of Object.keys(usage)) usage[k] += response.usage?.[k] ?? 0;
    transcript.push({
      t: new Date().toISOString(),
      type: "assistant",
      stop_reason: response.stop_reason,
      content: response.content,
      usage: response.usage,
    });
    // Thinking blocks (adaptive, on by default on this model) must be echoed back unchanged.
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      finalText = textOf(response.content);
      if (response.stop_reason === "max_tokens") {
        capped = true;
        log("stop_reason max_tokens — treating as capped");
      }
      break;
    }

    const results = [];
    for (const tu of toolUses) {
      const t0 = Date.now();
      let env;
      try {
        env = await dispatch(tu.name, tu.input ?? {});
      } catch (e) {
        env = { ok: false, error: e.message };
      }
      const ms = Date.now() - t0;
      transcript.push({ t: new Date().toISOString(), type: "tool", name: tu.name, input: tu.input, result: env, ms });
      log(`  ${tu.name} ${env.ok ? "ok" : `ERR: ${env.error}`} (${ms}ms)`);
      let body = JSON.stringify(env.ok ? env.result : { error: env.error });
      if (body.length > RESULT_CHAR_CAP) body = body.slice(0, RESULT_CHAR_CAP) + `…[truncated ${body.length - RESULT_CHAR_CAP} chars]`;
      results.push({ type: "tool_result", tool_use_id: tu.id, content: body, is_error: !env.ok });
    }
    // All results for the parallel calls go back in ONE user message.
    messages.push({ role: "user", content: results });
  }

  return { finalText, turns, capped, usage, transcript };
}
