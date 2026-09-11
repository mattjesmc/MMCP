# Mod testing

Everything your mod does was verified once, by you, driving a client — and never asked again. This
page is about closing that gap: building a **gate** for your mod that runs every check it has in one
command, including the ones that need a running game, a real player, or a picture.

It covers the four kinds of check and what each one needs to run, how to drive a dedicated server
and a client from a test file, how to test things whose subject is an image, and the check that runs
*while you are authoring* rather than before a release. It does not cover unit-testing plain Java —
that is JUnit and it works here exactly as it does anywhere.

## On this page

- [Why mod testing is different](#why-mod-testing-is-different)
- [How it works](#how-it-works)
  - [The four tiers](#the-four-tiers)
  - [What answers without a client](#what-answers-without-a-client)
- [Walkthrough: a gate for your mod](#walkthrough-a-gate-for-your-mod)
  - [Tier 0 — the tree](#tier-0--the-tree)
  - [Tier 1 — the JVM](#tier-1--the-jvm)
  - [Tier 2 — the server](#tier-2--the-server)
  - [Tier 3 — the client, and pictures](#tier-3--the-client-and-pictures)
- [The check that runs while you author](#the-check-that-runs-while-you-author)
- [What cannot be automated: the review queue](#what-cannot-be-automated-the-review-queue)
- [An agent session](#an-agent-session)
- [Things to keep in mind](#things-to-keep-in-mind)
- [Where to go next](#where-to-go-next)

---

## Why mod testing is different

A mod is not a library. Most of what it claims is a claim about a **running game**: that a recipe
appears in the book, that a loot table drops the thing about one time in forty, that a block model
does not z-fight, that a screen's slots line up with the container behind it. None of that is
reachable from a JUnit test, because none of it exists until Minecraft has loaded, built registries,
generated a world and drawn a frame.

So the honest state of most mod repositories is: a build that compiles, a handful of tests over
whatever logic happened to be extractable, and a large body of behaviour that a person confirmed by
hand at some point. The authoring scripts rot silently. The feature that broke three releases ago
broke in a way nobody has looked at since.

The toolkit's contribution is that **the game is drivable from a test file**. A dedicated server with
the bridge on it will answer questions about registries, loot, data, commands and a real player's
inventory. A client with the bridge on it will render a subject and hand you the pixels. Once the
game answers, a test can ask.

## How it works

Your mod's checks are ordinary programs — Python, Node, JUnit, whatever you like — that talk to the
bridge over HTTP on localhost, or run entirely offline over your source tree. The toolkit does not
supply a test framework and deliberately does not want to: it supplies the *game*, and your suite
stays yours.

What the bridge gives a test is:

- **`ping`** — is a game there, is a world loaded, is a client present, which build is answering, and
  did the last one crash. Every serious suite starts here.
- **the read tools** — `query_registry`, `query_class`, `roll_loot`, `describe_box`, `get_blocks_at`,
  `get_screen`, `get_tooltip`, `preview_worldgen`. Each carries `mechanism: observe`, which is the
  contract that its answer is a read of the game and not an inference.
- **the act tools** — `push_data`, `set_blocks`, `run_command`, `bot_*`, `create_world`. These
  change the world, so a test that uses one reads the world back afterwards.
- **`render` and `studio`** — a picture of a subject, deterministically, which is what makes visual
  regression possible at all.

### The four tiers

The single most useful idea here is to group your checks by **what they need to run**, not by what
they are about. That is what decides whether a check can run on a given machine, in CI, or in the
thirty seconds before you commit.

| Tier | Needs | Costs | Typical subject |
|---|---|---|---|
| **0 — the tree** | Nothing but your interpreter | Seconds to a couple of minutes | Files, schemas, references, your authoring scripts, plain unit tests |
| **1 — the JVM** | Gradle | A compile | It builds; JUnit passes; datagen output matches |
| **2 — the server** | A dedicated server with the bridge | ~1 minute boot, then seconds | Registries, recipes, loot rates, commands, a real player's inventory |
| **3 — the client** | A client with the bridge, and a world | ~1 minute boot, then seconds per scene | Rendering, models, screens, anything whose subject is a picture |

Run them in that order and stop at the first failure that matters. Tier 0 catches most things and
costs nothing, which is what makes it worth having a lot of.

Run them **sequentially**, not in parallel. This is not conservatism: checks that rewrite files
(regenerating a texture, say) will be read mid-write by a check running beside them, and two games
cannot share a bridge port. Concurrency here buys seconds and costs you a flaky suite.

### What answers without a client

A dedicated server has no render thread, so a large part of the tool surface simply is not there.
This is not something to discover by trying — every tool declares an execution context, and the
generated table in `docs/platform/HEADLESS.md` is the list:

- **`server`** — needs a loaded world, works on either process. The bulk of the surface.
- **`any`** — needs only the bridge, so it answers before a world exists and on a dedicated server.
  `ping`, the log, the launcher.
- **`client`** — needs the render thread. A dedicated server never registers these, so they are
  *absent* from its manifest rather than present and failing.

Write your tier 2 suite against that table; write tier 3 against a client. `ping` reports
`clientPresent` and `serverRunning` for the live answer.

## Walkthrough: a gate for your mod

We will build the thing one tier at a time. The worked example throughout is **ArmorPieces**, a mod
with about ninety authored armor pieces, whose `tools/gate.py` runs fourteen checks across all four
tiers in one command. Its layout is worth stealing wholesale.

The goal is one command, one line of output per check, non-zero exit if any of them failed:

```
python tools/gate.py                    # every tier this machine can run
python tools/gate.py --tier 0           # the tree only
python tools/gate.py --only loot        # one check, by name
python tools/gate.py --list             # what would run, without running it
python tools/gate.py --json report.json # the same result as a file
```

`--list` and `--json` are not decoration. `--list` is how somebody else discovers what your suite
covers; `--json` is how the result gets read by anything that is not a person looking at a terminal,
including an agent.

### Tier 0 — the tree

Start here, because it is free and it catches the most.

**The one you get for nothing:** the convention plugin gives your repository `checkAssets`, wired
under `check`. It walks your resources tree and reports dangling references — a blockstate naming a
model that is not there, a model naming a texture that is not there — as failures, and unused assets
as warnings. It needs no game at all, so it runs before anything loads.

```
gradlew checkAssets
```

**Then your own.** Anything in your repository with a schema is checkable offline: datapack entries
against their shape, language files against the ids that need names, generated assets against the
script that generates them. The pattern that pays for itself is a **per-artifact checker** — one
program that takes one piece of content and reports what is wrong with it — because you then get
three things from one piece of work: a tier 0 check that runs it over everything, a command you run
by hand while building one, and the [authoring gate](#the-check-that-runs-while-you-author) below.

Have every checker print a machine-readable last line as well as a human one. ArmorPieces' checkers
take `--json --brief` and emit `{text, problems, notes, full}`; that exact shape is what the loop
gate consumes later, so it is worth adopting.

**Test your authoring scripts.** This is the one people skip. If your repository has a `tools/`
directory that generates content, nothing in the build runs it, so it rots in silence and you find
out when you next need it. Plain unit tests over those scripts are tier 0 and cost nothing.

### Tier 1 — the JVM

```
gradlew build
```

Compilation and JUnit. Keep the logic that *can* live outside Minecraft outside Minecraft — pure
functions over your own types — and test it here. Do not contort game code to make it unit-testable;
that is what tiers 2 and 3 are for.

### Tier 2 — the server

Now the interesting part. A tier 2 check is a **scenario**: a few bridge calls, and what their
answers have to say.

The runner starts a dedicated server with the bridge, waits for it, runs every scenario, and stops it
again. Give it an `--attach` flag for when you are *writing* scenarios and a game is already up — but
have the gate itself always start its own, because the point of a gate is that it needs nothing to be
true of the machine beforehand.

A scenario in practice:

```python
def loot_contains_templates(bridge):
    """A smithing template turns up in a jungle temple chest at a reasonable rate."""
    reply = bridge.call("roll_loot", {
        "table": "minecraft:chests/jungle_temple",
        "count": 5000,
        "seed": 1234,
    })
    assert reply["exists"], "the game has no such table — check the id, not the rate"

    by_id = {item["id"]: item for item in reply["items"]}
    entry = by_id.get("armorpieces:skin_template")
    share = entry["share"] if entry else 0.0
    assert 0.01 < share < 0.08, (
        f"a template came out of the jungle temple in {share:.1%} of 5000 rolls; "
        f"the table produced {[i['id'] for i in reply['items'][:5]]}"
    )
```

`roll_loot`'s aggregate is the point of it: every item carries `share` (the fraction of rolls that
produced it), `avg`, `min`, `max`, alongside `empty_rolls` and `distinct`. `seed` makes the run
reproducible. Note the `exists` check on the line above — the game's own `getLootTable` returns an
**empty table** for an id that does not exist, so without it a typo in your table id reports as
"drops nothing" and you spend an hour in the wrong file.

Four rules make the difference between a suite you trust and one you delete in six months. Every one
of them is a scar.

**Say what is wrong, not that something is.** A tier 2 failure is read by somebody who cannot see the
game. Put the line the game actually printed into the assertion message. A bare `assert x == y` here
costs a full boot cycle to diagnose.

**Leave the world as you found it.** A scenario that pushes a datapack file clears it again in a
`finally`. Otherwise the next scenario runs against your mess — and so does the next person to open
that world.

**Ask for a share, not for presence.** "A template came out of this chest" passes with your entire
loot system switched off, because one item in ninety turns up eventually. Assert over thousands of
rolls at a fixed seed and check the *rate*. This is the single most common way a green mod test suite
is testing nothing.

**Guard against a stale instance.** This one will get you. A second game cannot bind the bridge port,
and the bridge answers from the **older JVM** without saying so — which means a green run against code
that is not loaded. Read `ping`'s `build` at the start of every run and refuse an instance that does
not carry the code you just compiled, or that the toolkit itself reports as stale.

You will also want a real player for anything that is about a wearer, a hand or an inventory: many
commands refuse a console source. The toolkit can spawn a headless player body — see
[Servers and production](servers-and-production.md).

For the mechanics of talking to the bridge from a test file — hitting `/cmd` directly with an
`X-MCPTK-Session` header, and skipping cleanly when the bridge is down — the pattern is
`mcp-server/probes/extension.test.mjs`, and `EXTENDING.md` § *Testing your extension* explains it.

### Tier 3 — the client, and pictures

The only tier whose subject is an image. A picture cannot be asserted the way a number can — but it
*can* be asserted not to have changed.

The mechanism that makes this work is `studio`. It puts the subject in a dimension with no sky and
flat full-bright lighting, `freeze: true` stops the tick, and `render` shoots out of band at a fixed
resolution. Under those conditions the same scene renders **bit-identically**: two shots of one
subject measured a maximum channel difference of zero. So the comparison tolerance you set is not
absorbing renderer noise — there is none — it is absorbing a driver or a game update moving a texel,
and it should be small enough that a decoration which stopped drawing cannot hide underneath it.

That last point deserves a number. If your subject is a small part of the frame — a helmet
decoration on a 320×320 figure is a few hundred texels — then a *percentage-of-image* threshold loose
enough to absorb antialiasing will happily absorb the entire decoration disappearing. Use a **count**
of differing pixels, and a low one.

**The golden rule, and it is the whole difference between this tier and the others:** a golden is a
frame a *person has looked at* and said is right. Your runner must never write one on its own, for
any reason. A scene with no golden beside it is not a pass and not a failure — it is a frame nobody
has looked at yet, and it should report `new`, fail the run, and print the path of the image to open.
Blessing frames automatically turns visual regression into a machine that asserts your mod still
draws whatever it drew the day it broke.

So: an explicit `--bless` flag, run by a human, and nothing else writes a golden.

When a comparison fails, write three panels side by side — the golden, what came back, and a mask of
where they differ. The number that failed tells you nothing about whether the render layer died or a
texture moved by one pixel; the mask tells you instantly.

**Build the world, never reuse it.** A datapack registry is read once when a world loads, the studio
moves the client, and the last run's frozen tick is the last run's problem. Create a fresh flat world
per run with `create_world {replace: true}`. Keep `--attach` for when you are writing scenes.

## The check that runs while you author

A gate runs before a release. There is a second, cheaper place to put a check: **after every editing
call in an authoring session**, so a mistake is caught on the turn it is made rather than forty turns
later.

This is what `.mcptoolkit/loop.json` in your repository does. A `checks` entry names a command and
the *mechanism* that should trigger it:

```json
{
  "checks": [
    {
      "name": "part",
      "after": { "mechanism": ["blockbench_edit"] },
      "run": ["python", "tools/check_active.py", "--json", "--brief"],
      "stateful": true,
      "timeout_ms": 8000
    }
  ]
}
```

The reply to every editing call now ends with your check's verdict. Two things about that:

- **Trigger on mechanism, not on a list of tool names.** A name list goes stale the moment the tool
  surface changes — and it will. "An editing tool ran, so the subject may have changed, so check it"
  runs the check one time too many rather than one time too few, which is the right side to err on.
- **The check has to be cheap and its output short.** It is paid on every editing turn. The
  `{text, problems, notes, full}` shape from tier 0 exists for this: the session reads `text` and
  `problems`, and only opens `full` when something is wrong.

The full design, including the cost arithmetic, is `LOOP_KIT_DESIGN.md` section 5.2, with the how-to
in `LOOPS.md`.

## What cannot be automated: the review queue

Some claims only a person can settle. "Does the walk cycle look right." "Is this readable at
distance." "Does the particle effect read as fire or as smoke."

The toolkit has a queue for exactly these, so they stop living in your head. `review_post` files an
ask; `review_status` reads the answers from any later session; `/mmcp review` in game walks a person
through the queue, staging each subject and recording a verdict. Your mod can also *declare* its
subjects from its own enums, so the list cannot drift from the code.

Four things about it that are load-bearing:

- **An ask with no failure mode is refused.** A step that cannot fail collects a nod instead of a
  judgement. The reviewer's card keeps `FAILS IF` on screen for the same reason: somebody who has
  forgotten what wrong looks like agrees with whatever is in front of them.
- **Staging is a list of server commands, nothing else.** That is what lets the toolkit own the walk
  while your mod owns the content.
- **A machine-answerable ask never reaches a human.** An ask can carry a `check` command whose
  success closes it as `checked` — never as `ok`, because "the world satisfies this" and "a person
  looked and was happy" are different facts.
- **A verdict gates nothing**, deliberately. A subjective judgement that can fail a build turns a
  person's opinion into a merge conflict.

`ARCHITECTURE.md` § *The review layer* has the reasoning; `EXTENDING.md` § *Asking a human to look at
something* has the API.

## An agent session

Where an agent earns its keep here is not writing the assertions — it is the loop of *run, read the
failure, form a hypothesis, ask the game, fix*. That loop is exactly what the bridge makes possible,
because the agent can interrogate a running game instead of guessing from a stack trace.

An abridged session, adding tier 2 coverage for a loot change:

> **You:** I changed the jungle temple loot injection. Add a tier 2 scenario for it and run the gate.

> **Agent** calls `ping`.
> → `{ serverRunning: false, clientPresent: false, build: "armorpieces 0.3.0", last_crash: null }`
>
> The bridge is up but no world is loaded, so it starts the tier 2 runner, which boots a dedicated
> server and waits.

> **Agent** calls `roll_loot {table: "minecraft:chests/jungle_temple", count: 5000, seed: 1234}`
> → the distribution comes back with `armorpieces:skin_template` at 0.4%.
>
> It writes the scenario asserting a 1–8% share, and the assertion fails.

> **You:** is that the code or the test?

> **Agent** calls `query_registry {registry: "loot_table", entry: "minecraft:chests/jungle_temple"}` — the table is
> registered. Then `push_data {dry_run: true}` over the injection file — `valid: true`, so the file
> decodes. Then `get_log {logger: "armorpieces", level: "all"}`:
> → `Skipping loot modifier armorpieces:jungle_temple: unknown condition type armorpieces:has_theme`
>
> The game *logged and skipped* it. The reload succeeded and loaded nothing, which is the failure
> mode you would never have found from the loot numbers alone.

> **Agent:** the condition type is not registered — the registration is behind a mod-loaded check
> that never fires. Fixing that is a structural Java change, so it needs a rebuild rather than a
> hotswap.

Three things in that exchange are worth naming, because they are the pattern rather than the
anecdote. The agent **read the game rather than reasoning about the source** — `query_registry` and
`get_log` settled in two calls what reading Java could have argued about for twenty. The **log
channel is where silent failures live**: Minecraft steps over a malformed recipe, model or modifier
and carries on, so a reload reporting success while loading nothing is normal and only the log knows.
And it **named the route for the fix** rather than attempting a hotswap that would fail — see
[The change loop](the-change-loop.md).

You do not need an agent for any of this. You need to know that `get_log` exists.

## Things to keep in mind

**Your suite is green and the code is not loaded.** A second game cannot bind the bridge port, and
the bridge answers from the older JVM without saying so. Read `ping`'s `build` at the start of every
run and refuse a stale instance. This is the single highest-value line in a mod test suite.

**Your check passes because the feature is off.** "The item appeared" passes with the whole system
disabled if the item appears anywhere for any reason. Assert rates over thousands of seeded rolls,
not presence. Ask of every check you write: what would it take for this to fail?

**A check whose failure mode is "loosen the check" needs a falsifier.** When a check's assertion is a
restriction, the cheapest way to make it green is to delete the restriction — and that is what
happens under deadline. Pair it with a case that must fail, so removing the restriction breaks
something visibly.

**`ok: true` means the command parsed.** `run_command` reports Minecraft's parse result, not its
effect. If a scenario depends on a command having done something, read the world back.

**A reload can succeed and load nothing.** Vanilla logs and steps over malformed data. `push_data`'s
`dry_run` tells you the bytes decode; `get_log` tells you whether the game accepted them. Neither
alone is "it is in the game".

**A probe that reads a cache passes for the wrong reason.** If your check can be satisfied by
something the game computed earlier, it is not testing what you think. Make the subject fresh — a new
world, a new seed, a cleared pack.

**Run sequentially.** Two games cannot share a port, and a check that rewrites files will be read
mid-write by a check running beside it. If you want a concurrent run, keep it as a load test and make
the sequential one the arbiter of truth.

**Never bless a frame automatically.** A golden nobody looked at asserts that your mod still draws
whatever it drew the day it broke.

**Leave the world as you found it.** Every scenario that writes, cleans up in a `finally`. The next
person to open that world is probably you.

**Test your authoring scripts.** Nothing in the build runs `tools/`, so it rots silently. This is
tier 0 and it is free.

**A stateful check that reports a diff is reporting about the run, not the artifact.** Useful, and
worth knowing which lines of a report are which — a "three new problems since last check" line means
nothing to somebody reading the report cold.

## Where to go next

**In this wiki**

- [Debugging](debugging.md) — the log channel, crashes, `query_class`, and what to do when a test
  fails for a reason that is not your mod.
- [Servers and production](servers-and-production.md) — running a dedicated server, headless
  players, and which tools answer without a client.
- [Authoring at scale](authoring-at-scale.md) — the loop kit, where the authoring-time check lives.
- [Rendering and screenshots](rendering-and-screenshots.md) — `studio` and `render`, which tier 3
  is built on.
- [Tool profiles and cost](tool-profiles-and-cost.md) — keeping a long test-writing session cheap.

**Reference**

- `EXTENDING.md` § *Testing your extension* — the probe pattern, `ping`'s `extensions` array, and
  reading your own mod's log lines out of a running game.
- `HEADLESS.md` — the generated table of which tools answer without a client.
- `LOOP_KIT_DESIGN.md` § 5.2 — the authoring-time check contract.
- `ARCHITECTURE.md` § *The review layer* — why a human verdict gates nothing.
- `LIVE_MODDING.md` § *Did it actually load?* — the log channel in full.
- `tools/README.md` — `battery.ps1`, the toolkit's own sequential live suite, as a working example
  of the runner shape described here.
