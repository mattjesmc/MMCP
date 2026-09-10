// Fresh-session quiz runner + machine scorer. Each question is ONE new Agent SDK conversation
// with NO tools — the context under test (walk transcript or format rendering) is the entire
// world the model gets, so the bench measures reading + spatial reasoning, never live lookups.
// (Design rule: quiz answers must not be recoverable from the quizzed session's own history.)

const BUILTIN_TOOLS = [
  "Task", "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "ExitPlanMode", "SlashCommand", "Skill",
  "ToolSearch", "ListMcpResources", "ReadMcpResource", "AskUserQuestion", "EnterPlanMode", "Monitor",
];

const SYSTEM = [
  "You are taking a spatial-reasoning quiz about a Minecraft area.",
  "Everything you know about the area is in the user message — you have no tools and cannot look anything up.",
  "Coordinate convention: +x is east, +z is south, y is up. Compass: north = -z, south = +z, east = +x, west = -x.",
  "Reason step by step if it helps, then end your reply with ONE final line of the form:",
  "ANSWER: <value>",
  "Keep <value> minimal (a block id, a direction word, a number, yes/no, or a short list).",
  "If the observations genuinely cannot answer the question, end with: ANSWER: unknown",
].join("\n");

export async function askOne({ model, context, question }) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const t0 = performance.now();
  const q = query({
    prompt: `${context}\n\n# Question\n${question}`,
    options: {
      systemPrompt: SYSTEM,
      model,
      maxTurns: 2,
      permissionMode: "dontAsk",
      settingSources: [],
      tools: [],
      disallowedTools: BUILTIN_TOOLS,
    },
  });
  let text = "";
  let usage = null;
  for await (const msg of q) {
    if (msg.type === "assistant") {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text") text += block.text;
      }
    } else if (msg.type === "result") {
      usage = msg.usage ?? null;
    }
  }
  return { text, usage, ms: Math.round(performance.now() - t0) };
}

/** Pull the committed answer out of the reply — the LAST "ANSWER:" line wins. */
export function extractAnswer(text) {
  const matches = [...text.matchAll(/ANSWER:\s*(.+)/gi)];
  return matches.length ? matches[matches.length - 1][1].trim() : null;
}

const norm = (s) => String(s).toLowerCase().replace(/minecraft:/g, "").trim();
const numbers = (s) => [...String(s).matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => parseFloat(m[0]));

/** Machine-score one answer. Returns {correct, abstained}. */
export function score(q, rawAnswer) {
  if (rawAnswer === null) return { correct: false, abstained: true };
  const a = norm(rawAnswer);
  if (a === "unknown") return { correct: false, abstained: true };
  switch (q.answer_type) {
    case "block_id":
      return { correct: a.replace(/[^a-z_]/g, "") === norm(q.truth).replace(/[^a-z_]/g, ""), abstained: false };
    case "enum": {
      if (a === norm(q.truth)) return { correct: true, abstained: false };
      // Accept a sentence containing exactly one of the options, when it is the right one.
      const present = (q.options ?? []).filter((opt) => a.includes(norm(opt)));
      return { correct: present.length === 1 && norm(present[0]) === norm(q.truth), abstained: false };
    }
    case "bool": {
      const yes = /\b(yes|true)\b/.test(a);
      const no = /\b(no|false)\b/.test(a);
      if (yes === no) return { correct: false, abstained: false }; // both or neither: not an answer
      return { correct: yes === q.truth, abstained: false };
    }
    case "numeric": {
      const ns = numbers(a);
      return { correct: ns.length > 0 && Math.abs(ns[0] - q.truth) <= (q.tolerance ?? 0), abstained: false };
    }
    case "set": {
      // The domain is the QUESTION'S OWN options. It used to be the hardcoded list
      // ["red","blue","green","yellow"], which silently mis-scored any set question whose answer
      // tokens fell outside those four — exactly what happens once the arena seeds tower colours
      // from the 8-wool palette (arena.mjs). `options` is required here for that reason: falling
      // back to the truth tokens would score an over-broad answer ("red blue green yellow" when the
      // truth is [red, blue]) as CORRECT, because the extra tokens would not be in the domain and
      // would vanish before the length check.
      if (!q.options) throw new Error(`answer_type "set" requires options (question ${q.id})`);
      const domain = q.options.map(norm);
      const want = q.truth.map(norm);
      const got = [...new Set(a.split(/[^a-z_]+/).filter((w) => domain.includes(w)))];
      return {
        correct: got.length === want.length && want.every((t) => got.includes(t)),
        abstained: false,
      };
    }
    case "pair": {
      const ns = numbers(a);
      return { correct: ns.length >= 2 && ns[0] === q.truth[0] && ns[1] === q.truth[1], abstained: false };
    }
    default:
      throw new Error(`unknown answer_type ${q.answer_type}`);
  }
}
