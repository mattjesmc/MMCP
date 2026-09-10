# Agent-client adapter — the toolkit stops being a Claude Code accessory

**What this file is.** The design `RELEASE_1.md` §A needs before any of it can be built, written
2026-08-28 against the source rather than against §A's own inventory. §A is the release's first item
because it renames commands, config keys, a menu, a HUD and a chat prefix, and every doc sentence
written before it is wrong. This file records the decisions the owner took, the two findings from the
code read that change §A's shape, the contract, and what is deliberately left for §B and §C.

**Decisions taken before writing (owner, 2026-08-28).** Adapter, not strip. Java interface through
the existing extension seam, with a data-driven default for plain CLI clients. No second adapter is
owed at release — `docs/guides/ADAPTER.md` is a guide an *agent* reads and acts on, so someone who
wants Cursor points their agent at it and gets whatever is compatible that day. The survival kit is
not the Claude adapter's baggage: it is a separately registrable thing, and profiles are where its
guarded outputs live. `claude.model` / `claude.effort` become the Claude adapter's own keys, so
there is no bridge-level migration. The rename (§A3's vocabulary, §B2's `/mmcp` collapse) is
explicitly deferred and lands as one pass later.

---

## 1. The finding that changes §A's shape: there are two directions, and one of them needs no config

§A5 says the primary supported path is "bridge up, no agent client configured, MCP server registered
by hand" and calls it a configuration that "has never been tested because it has never existed". The
second half is wrong, and finding out why moves most of §A's weight.

**Inbound — a session that already exists connects to the bridge.** This works today.
`BridgeServer:419` serves `POST /hello`; `index.mjs:489` calls it lazily on the first `/cmd` when no
`MCPTK_SESSION` was inherited; `Sessions.Kind.EXTERNAL` is the entry it mints. A modder who writes
the toolkit into their own host's MCP config and runs it gets a registered, attributed, chat-routable
session with **no toolkit configuration whatsoever**. There is no Claude code path on it.

**Outbound — the game starts a client.** This is the half that needs an adapter, because there is no
session yet to ask and the game must know what executable to run, in what directory, with what flags.

Everything §A describes as "the adapter" is the outbound half. `agent.client=` therefore gates the
outbound launcher **only**, and the supported path is not a configuration at all — it is the absence
of one. That is a much better story than "set this key to nothing", and it has a consequence worth
stating: the two halves are independent enough that the owner keeping `agent.client=claude-code` in
their own run dirs cannot rot the path everyone else uses, which is exactly how §F3's configuration
came to have never been exercised.

**What inbound is actually missing** is not plumbing but identity: `/hello` accepts only `{label}`,
so nothing on the mod side knows *which* client connected or what it can do. A session that
self-declares at hello is the mechanism the owner asked for, and it is a widening of an existing
handshake rather than a new one.

## 2. The second finding: the memory render is already a tool

§A4 lists memory rendering as the succeeds-falsely case — "delivered by a SessionStart hook, so on
any other client the agent starts with no memory in context", with the fix being "make the render
reachable as a **tool call**".

It already is. `mem_recent` returns the telescope render as a field on an ordinary tool result, and
`memory/recent-cli.mjs` is a 55-line shell that calls that tool and prints `r.result.render` to
stdout (`console.log(r.result.render)`, line 55). The hook runs the shell; the shell runs the tool.

So the mechanism is universal and always was. The real gap is narrower and different in kind: a
non-Claude host has no reason to *call* `mem_recent` at session open, because nothing tells it to.
That is discoverability, and the honest fix is the hello reply — a session that has just declared
itself is told, once, what it should do to orient. No new tool, no new render path, and the hook
stays as the Claude Code convenience that saves the round trip.

Recorded because §A4's version of this would have had someone build a second delivery path for a
render that already had one.

## 3. The contract

Five things §A2 says a client must supply, against what the code actually does:

| §A2 | Reality in the tree | In the contract |
|---|---|---|
| Detect | `ClaudeBootstrap:80` `execOk("cmd","/c","claude","--version")`; `CompanionSessions:259` `onPath("claude")` | `detect()` |
| Register a server | `writeReconciled(mcp.json.tpl, .mcp.json, …)` | `registerServer()` |
| Launch interactive | `cmd /c start … powershell -Command claude '<prompt>'` | — |
| Launch headless | `$null \| & claude -p $prompt --permission-mode …` | — |
| Continuity | a Stop hook + a SessionStart hook + `run-loop.ps1` | not a method — a **capability** |

**Interactive and headless collapse into one call.** They differ only in whether a console window is
allocated and where the prompt goes, and both of those are properties of the *thing being launched*,
not of the client. Once the kit (§4) carries mode, prompt, profile and workspace, there is one
`launch(kit)` and the adapter reads the mode off it. Keeping two methods would have baked the
workbench/companion split into the contract, and it is not a client-level distinction.

**Continuity is not a call.** §A2 already calls it "optional", but optional-method-that-may-throw is
the shape that produces half-working. It is a **capability the client declares**, a kit **requires or
prefers**, and materialization arbitrates. A kit that requires `STOP_HOOK` against a client that has
none is refused **by name** — the same rule `roll_loot` landed for a loot table asked in the wrong
context, and the reason that rule keeps recurring is that the alternative is a launch that succeeds
and then silently does not loop.

So the interface is four methods and a capability set:

```java
public interface AgentClient {
    String id();                       // "claude-code"
    String displayName();
    Detection detect();                // installed? version? why not?
    Set<Capability> capabilities();
    String registerServer(ServerSpec spec);   // null on success, else the reason
    String launch(MaterializedKit kit);       // null on success, else the reason
}
```

**Capabilities are named after what a kit needs, not after what Claude Code happens to have** — the
list is derived by asking what each generated file in the two existing kits is *for*:

`LAUNCH_ATTENDED` · `LAUNCH_HEADLESS` · `SERVER_REGISTRATION` · `PROJECT_CONTEXT_FILE` (an
auto-loaded per-directory instruction file — `CLAUDE.md`'s role) · `SYSTEM_PROMPT_FILE` (replaces the
stock system prompt; the charter needs this and the reason is recorded in `ClaudeBootstrap`'s own
comment — a stock coding-assistant prompt outranked the charter and produced "may I use may_modify
to dig?") · `SESSION_START_HOOK` · `STOP_HOOK` · `TOOL_DENYLIST` · `MODEL_SELECTION`.

A client that has none of the last six is still a first-class client: it launches, it registers, and
every kit that needs more than that refuses with a sentence naming the capability.

## 4. The kit — what the owner's answer to survival actually requires

Today the bootstrap's signature is `bootstrap(Minecraft client, boolean survival)`. A boolean where a
registrable thing belongs, and the whole of `ClaudeBootstrap:130-165` is the second branch of it.

A **kit** is the bundle that makes a session what it is:

- **id and label** — `workbench`, `survival`
- **profile** — the `MCPTK_PROFILE` baked into that kit's server registration. This is the seam to
  §C: the kit names a profile, §C decides what the profile contains. The survival kit's "same tools
  with heavily guarded outputs" is a profile statement, and it stays one.
- **workspace directory** — relative to the game dir; `.` for the workbench, `mcptoolkit/survival`
  for survival. That separation is load-bearing and its reason is already recorded: launched from the
  game dir, the survival session auto-loaded the *copilot* `CLAUDE.md` and got a second contradictory
  role sheet full of tools its profile hides.
- **files** — each with a role (`PROJECT_CONTEXT`, `SYSTEM_PROMPT`, `SERVER_CONFIG`, `HOOK`,
  `SCRIPT`, `PROSE`) and a **write policy**.
- **prompt** and **mode** (attended / headless)
- **requires** / **prefers** — capability sets

**The write policy is a per-file property and it is expressible as data, which is what makes the
data-driven default adapter viable.** The tree already has three policies and they are already
per-file: machine-owned (rewritten every launch — the charter, the hook, `run-loop.ps1`),
write-if-absent (prose the user may edit), and **reconciled against a marker** — `.mcp.json` against
the bridge URL, `CLAUDE.md` against `ROLE GUARD`, `settings.json` against `"permissions"`,
survival's `.mcp.json` against `MCPTK_PROFILE`. Each marker exists because a specific failure was
observed: a click on a run bound to a different port stranding the config on a dead bridge;
pre-permissions workspaces leaving wake sessions unable to call any tool. Carrying the marker as a
field means the adapter needs no per-file logic — it materializes what the kit declares.

**Registrable by extension mods**, which is the owner's "separately registrable somehow".
`McpToolkitEntrypoint` is a `@FunctionalInterface` with one method and existing extensions implement
it as a lambda; **`default` methods keep every one of those compiling and linking**, so the seam
widens without a version break:

```java
default void registerKits(KitRegistrar registrar) {}
default void registerAgentClients(AgentClientRegistrar registrar) {}
```

Containment follows `Extensions.discover()` unchanged — a throw costs that mod its kit and nothing
else.

## 5. Java interface, data-driven default

The owner's answer, and the code read supports it: the five contract calls are *almost* all "run this
exe with these flags", which is data — but the bootstrap's node/npm preflight, the extract-and-
reconcile, and the survival workspace are not, and `LaunchPrefs` validates model names against
**Claude Code's own vocabulary** (`haiku|sonnet|opus|fable`, `low…max`), which must not sit in the
bridge's config where it would imply every client has those.

So: `AgentClient` is Java. A bundled `SpecAgentClient` implements it from a declarative block (exe,
detect args, launch argv template, env, workdir, capability list), which covers CLI clients — all of
them today. Claude Code is a hand-written `AgentClient` that uses the spec form for the parts it fits
and overrides the rest. Its presence is the evidence the contract is real, the same argument the
extension seam won on.

## 6. What moves, and what does not

**Into the Claude Code adapter** (its own package; classes keep their names, so the diff stays
readable): `ClaudeBootstrap`, `CompanionSessions`' spawn mechanics, `ClaudeSessionRegistry`,
`TranscriptTailer`, `ClaudeSubtitles` + `HudMixin`'s call, `ClaudeButton`, `LaunchPrefs` and the
`claude.*` config keys, and every template under `mcptoolkit/bootstrap/`.

**Stays where it is, and this is the tier-3 list §A1 says not to touch:** the bridge, `ToolDef` /
`Mechanism` / `ExecutionContext`, the extension seam, `index.mjs`, the chat event and `send_chat`
mechanism, the review layer, `mem_*`, `X-MCPTK-Session` and `POST /hello`.

**`ObsSupervisor` is neither.** It starts and stops `tools/obs/record-supervisor.mjs`, the sidecar
that pauses an OBS recording so idle time is cut live. It is already dev-workspace-gated —
`available()` is false in production because `tools/obs/` is not bundled — its only caller is
`ClaudeMenuScreen`, and its one Claude reference is a comment. It is owner-workstation tooling that
lives on the Claude menu only because that was the only menu. It keeps its gate and its button
re-homes onto §B1's screen.

**Companion sessions are a kit, not an adapter feature.** `companion_spawn` is `launch(kit)` with
mode `HEADLESS`; the `--permission-mode` plumbing and its bypass surfacing are Claude Code's
expression of `TOOL_DENYLIST` + permissions, and belong to that adapter.

## 7. Config surface after this

```properties
# Which agent client the IN-GAME launcher starts. Empty = no launcher; the bridge still serves,
# and a session that registers this server in its own host works with no configuration at all.
agent.client=
```

`enabled` and `port` are unchanged. Every `claude.*` key is read by the Claude adapter, from the same
file, and is documented by that adapter rather than by `BridgeConfig`'s prose — which is also the
answer to the migration question: nothing migrates, because the keys keep their names and merely
change owner.

## 8. `docs/guides/ADAPTER.md`

The guide's reader is an agent, which is a sharper specification than "documentation":

- **Self-contained.** No "see `ARCHITECTURE.md` §12". Exact source paths only where the agent must
  genuinely read code.
- **The bundled Claude Code adapter is the worked example**, named as such.
- **Capability-first.** The reader's client may have no hooks, no system-prompt file, no denylist.
  The honest-degradation rule is the centre of the document, not a footnote.
- **It ends in a verification the agent can run** — does `hello` show your client, does a kit
  materialize, does a kit requiring a capability you lack refuse *by name*. Without this the agent
  writes an adapter that launches something, reports success, and has no continuity: the
  succeeds-falsely class, from the one direction where nobody would be watching.

**Written from the built thing, not before it.** Every §D item in `RELEASE_1.md` found a bug on its
first live run, and two of them found the bug *in their own tool description's example*
(`tags/blocks/` in §E1, the enchantment form in §E6). A guide written ahead of the build would
document a contract the build then corrects.

**Repo-only, no jar path.** A production user never writes an adapter: they enable the bridge from
the §B1 menu on a chosen port and profile and point their own host at it. Someone writing an adapter
has the checkout. So the "no client configured" state points at the config file today and the menu
once §B lands — never at a document a production install does not carry.

## 9. Arbiters

- **`probes/agent-client.test.mjs`** — the §F3 configuration that has never been tested: bridge up,
  `agent.client=` empty, server registered by hand, dev profile. Every dev tool reachable; the
  session self-declares at hello and is `EXTERNAL`; the hello reply carries the orientation pointer;
  no Claude class is loaded. Plus the capability arbitration: a kit requiring a capability the client
  lacks is refused by name, and the refusal names the capability rather than failing generically.
- **The review layer** for the outbound half — a human clicks the button, in both kits. That is what
  §F6's queue is for, and it is the second time §B1's menu will want it.
- No site; battery chunk **b**.

## 10. Out of scope for this piece, deliberately

The **rename** — `/claude`, `[Claude]`, the `"claude stop"` phrase, the muted-file message,
`EventTools:39`'s `MCP_TOOL_TIMEOUT` gloss — and §B2's `/mmcp` collapse. Deferred at the owner's
direction; mechanical, touches a different file set, and doing it once instead of twice is why §B2
calls the moment free. The **§B1 menu**. The **profile content** (§C) — this file names the seam a
kit uses to select a profile and stops there.

## 11. Build order

1. `AgentClient`, `Capability`, `Detection`, `ServerSpec` — the contract, with nothing implementing it.
2. `Kit`, `KitRegistrar`, `MaterializedKit`, the write policies; port `workbench` and `survival`
   across unchanged, still launched by the existing code.
3. Hello self-declaration: widen `POST /hello`'s body, record client identity on `Sessions.Entry`,
   add the orientation pointer to the reply. Shim side in `index.mjs`.
4. `agent.client=` gating the outbound launcher; the no-client state everywhere it shows.
5. `SpecAgentClient`, then the Claude Code adapter as a real implementation of the interface, moving
   the tier-1 classes behind it.
6. The two `default` entrypoint methods.
7. `probes/agent-client.test.mjs`, live.
8. `docs/guides/ADAPTER.md`, written from what exists.

Steps 1–4 are safe to land before the rename; step 5 is the one that moves files, and it wants a
clean tree under it.

---

## 12. Build record — what the build corrected, 2026-08-28, toolkit 0.104.0

Built in one pass, steps 1–8 in order. Live-green on an isolated dev server
(`-Pport=25631 -PrunDir=../run-server-agent`): `probes/agent-client.test.mjs`, 13/13.
`mcp-server` 0.47.0. Menagerie recompiles against 0.104.0 with its `implements McpToolkitEntrypoint`
class untouched, which is the `default`-method claim of §4 verified rather than asserted.

Battery chunk **b** ran whole on the same server as the regression check: 28 of 31 files green, and
the three that were not are all pre-existing and recorded in `RELEASE_1.md` §F2 — `preview-worldgen`
case 5 (n=1 on a fresh world, under a jungle canopy), `site-map` (two site collisions from 0.101.0
and 0.103.0), and `ui-input` skipping itself headless as declared. Nothing this change touched went
red.

**Every §D item found a bug on its first live run and two found it in their own example.** This one
did too, and its bug was in this document.

### The correction the probe found: `mem_*` are not bridge tools

§2 says the memory render is already a tool, and that is right. It does not say **which layer's
tool**, and the answer changes what the orientation pointer means.

`mem_recent` is served by the **Node shim** (`mcp-server/memory/tools.mjs`), not by the mod. It is
absent from the bridge's own `/tools` manifest and a `POST /cmd` for it answers `unknown tool`. The
first version of the probe asserted the pointer's vocabulary against the bridge manifest and went red
on the toolkit's own headline feature — three cases at once, all of them the same mistake.

Nothing is broken by this: every MCP host reads ONE merged manifest, the shim's, and `mem_recent` is
in it. But the consequence is worth stating, because it is the kind of thing a later reader assumes
the other way round. **The orientation pointer is advice to the MCP CLIENT, not to the bridge, so its
vocabulary is the union of both layers.** A pointer naming only bridge tools would be needlessly
narrow; a probe resolving it against only the bridge is wrong. The probe now resolves against the
union and says why.

### Four places the build overruled §3–§6

1. **`.mcp.json` and `settings.json` stopped being templates.** §6 moves "every template under
   `mcptoolkit/bootstrap/`" into the adapter. Two of them should not have survived the move at all:
   once hooks are the *kit's* declaration (§4), `settings.json.tpl` and `settings.survival.json.tpl`
   differ by exactly one hook entry, and `mcp.json.tpl` / `mcp.survival.json.tpl` differ by one env
   var. All four are now generated by the adapter from the `ServerSpec` and the kit's `HookSpec`s.
   The reconcile markers survive unchanged — bridge URL, `"permissions"`, `MCPTK_PROFILE` — because
   each of them is a failure somebody paid for, and a generated file can go stale exactly as a
   templated one can.

2. **The launch script is the adapter's, not the kit's.** The design implies the kit carries whatever
   it needs. `run-loop.ps1` runs `claude`, so a kit cannot own it without owning a client. The split
   that works: the kit declares `Continuity.RELAUNCH` ("wake a fresh session in the same world
   whenever this one stops without being told to") and the adapter decides what that costs on its
   client — here, a wrapper process plus a Stop hook. The relauncher's charter path and denied-tool
   list are now `%%SYSTEM_PROMPT%%` / `%%DENIED_TOOLS%%` filled from the kit, so the kit's data
   reaches it without the kit knowing the file exists.

   The same split explains a field the design did not anticipate: the survival kit's `prompt` is
   **null**. A relauncher that re-enters the same character owns the wake, and therefore owns the
   wake prompt — the first prompt and the wake prompt are two different sentences, and the toolkit
   has no basis for choosing between them.

3. **`ClaudeButton` and `ClaudeMenuScreen` did NOT move into the adapter package**, though §6 lists
   the first. They became **client-agnostic launcher UI**: the menu renders one button per registered
   kit, greys out the ones the selected client cannot host, and shows the missing capability in the
   tooltip — the refusal computed before the click rather than toasted three seconds after it. That
   is what §B1's menu needs, and moving them into `agent/claude/` would have meant moving them out
   again. Model/effort and the subtitle toggle *are* gated on the Claude adapter being selected,
   because a picker offering `haiku|sonnet|opus|fable` to another client's user is a picker whose
   values mean nothing.

4. **A ninth thing moved that §6 does not mention: `CompanionSessions`' spawn mechanics.** §6 says
   they should, in one clause, and it is right, but the shape only became obvious in the doing:
   `companion` is a **kit**, with mode `HEADLESS` and a prompt supplied per launch (it names the
   session's own id, minted moments earlier — which is why `AgentLauncher.Request` takes a
   `Function<String, String>` rather than a string). What stays in `CompanionSessions` is what is
   genuinely its own: the enable switch, the workspace choice, the kill switches, and orphan reaping.
   The one thing the contract could not express is the `Process` handle — `launch()` returns a
   sentence — so the adapter attaches it to the already-minted `Sessions.Entry`, which is where
   `companion_stop` and the reaper were reading it from anyway.

### Two smaller things worth carrying

- **`agent.activity` is the arbiter, not the classloader.** §9 asks the probe to assert "no Claude
  class is loaded". It cannot, honestly: an adapter is a registered object, so its class loads
  whether or not it is ever asked to do anything, and an instrumentation-based check would pass for
  an adapter that merely registers lazily. What is asserted instead is that **no adapter code path is
  taken** — every contract call is recorded on `AgentClients`, and with no client configured the list
  is empty. That is the claim with teeth, and it is the one §A5 actually cares about.

- **The falsifier needed a second client, and the second client is a feature.** A refusal matrix with
  one all-capable adapter in it proves nothing. Rather than a test fixture, the tree ships the
  data-driven `cli` adapter with the modest default capability set — which is the honest default for
  a CLI agent whose owner has not said it has hooks. So `ping`'s matrix carries a real refusal on any
  install: the survival kit against `cli`, naming `stop_hook`.

### Owed after this

- **The outbound half has not been clicked.** Both attended kits and the headless one are queued in
  the review layer (`agent/launch/<kit>`, enumerated from the kit registry so a later kit arrives on
  its own), plus the no-client state and any refused kit. That is §F6's queue doing what it is for.
- **Rocketeer was not rebuilt against 0.104.0** — its dev game was running and its tree is dirty from
  another session. Menagerie was, and passes. The `default`-method claim is a language guarantee, but
  the second consumer has not been exercised.
- The **rename** is still deferred and untouched: `/claude`, `[Claude]`, the `"claude stop"` phrase,
  the muted-file message, `EventTools:39`'s gloss. §B2 decides it.
