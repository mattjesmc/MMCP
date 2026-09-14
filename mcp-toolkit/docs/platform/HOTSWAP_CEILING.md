# The live-code tier, read for its ceiling — what we stopped at, and which stops are real

**Status: READ 2026-09-13 at 0.148.0 / shim 0.75.0. Seven findings. §1 BUILT AND CONFIRMED LIVE
2026-09-13 at 0.150.0** (the confirmation run found five defects in the first cut; all five closed —
"As built → §1, confirmed live" below). **§3, §4 and §5 BUILT AND CONFIRMED LIVE 2026-09-13 at
0.152.0**, in one run, because they are one story: a swap that lands and changes nothing. **§6 and
§7 BUILT AND CONFIRMED LIVE 2026-09-13 at 0.153.0**, which closes every finding in this record. A reading pass over the whole
change-to-game loop — `HotswapTools`, `HotswapAgentMain`, `ClassTools`, the loom run configurations
in `build.gradle` and `gradle-conventions/`, `tools/rebuild.ps1`, and `../../LIVE_MODDING.md` — asking
one question: *have we taken this as far as it goes, or did we stop at the first hard edge and write
the edge into the documentation as physics?*

The answer is the second one, in three of seven places. The mechanism we built is unusually careful
for what it attempts. The loop around it stops early, and the documentation states two barriers as
properties of the JVM that are in fact properties of our launch configuration.

> **The shape of this audit.** A barrier is worth re-reading when the cost of being wrong about it is
> paid every day. Two of these are paid at four minutes a restart, in every session, by a human and
> by every loop in `docs/loops/`. That is the reason to look again at a "can't" — not a new idea
> about what we want.

| | finding | severity | state |
|---|---|---|---|
| §1 | Mixin classes are declared unswappable; the mixin jar on our own classpath ships the agent that swaps them | high | **BUILT 0.149.0, CONFIRMED LIVE 0.150.0** |
| §2 | Structural edits: the JVM limit is real, and JBR 25 lifts it — never investigated | medium-high | **FEASIBLE, PROVEN LOCALLY** |
| §3 | A swap that lands and changes nothing observable; no re-entry tier | high | **BUILT + CONFIRMED LIVE 0.152.0** |
| §4 | A no-op swap (stale or identical bytes) reports success indistinguishably from a real one | high | **BUILT + CONFIRMED LIVE 0.152.0** |
| §5 | No ledger of what diverges from the built jar; the doc says so and calls it a restart | medium | **BUILT + CONFIRMED LIVE 0.152.0** |
| §6 | No compile step inside the loop; `tools/` knows only `rebuild.ps1` | medium | **BUILT + CONFIRMED LIVE 0.153.0** |
| §7 | The human-facing manual documents the restart loop and not the seconds loop | low | **BUILT 0.153.0** |

Every finding states how it was established. Where that is "by reading", it is said so.

---

## What exists today, stated plainly

`HotswapTools` (226 lines) is the method-body tier on stock HotSpot, and the parts that are hard to
get right are right:

- It assembles a one-class agent jar at runtime and **self-attaches to its own pid**
  (`VirtualMachine.attach(ProcessHandle.current().pid())`), so nothing has to be on the command line
  but `-Djdk.attach.allowAttachSelf=true`.
- `HotswapAgentMain` parks the `Instrumentation` in `System.getProperties()`, which is the one
  hashtable both the system classloader (where the attach API loads the agent) and Knot (where the
  toolkit lives) can see. `Instrumentation` is bootstrap-loaded, so it is the same type on both sides.
- Multi-class edits go through **one atomic `redefineClasses`**, so no tick observes half an edit.
- The byte source is `file` → `dir` → the class's own classpath entry, and the classpath default
  **refuses loudly on a `jar:` URL** rather than re-reading the already-loaded bytes and reporting a
  success that changed nothing.
- `query_class` (0.96.0) prechecks all of it one call earlier: `classpath_default`, `safe`, the
  post-transform method table, the file on disk the class came from, and the mixins merged into it.

Above that tier there is nothing but `tools/rebuild.ps1`: a full restart, minutes, one cycle per port.
The gap between "seconds" and "minutes" is where every finding below lives.

---

## 1. The mixin tier is declared impossible, and Mixin shipped the answer years ago

`LIVE_MODDING.md` says, and `HotswapTools`' own tool description repeats:

> **MOD CLASSES ONLY**: redefining a mixin-transformed or remapped Minecraft class from compiled
> sources would silently drop its load-time transforms.

and `query_class` reports `hotswap.safe: false` for any class with a merged mixin method. **That is
true of a naive redefine and false as a statement about what is possible**, because the mixin jar
already on this project's runtime classpath ships the machinery:

```
sponge-mixin-0.17.4+mixin.0.8.7.jar          (net.fabricmc, in the Gradle cache, on the run classpath)
  META-INF/MANIFEST.MF
    Premain-Class:        org.spongepowered.tools.agent.MixinAgent
    Agent-Class:          org.spongepowered.tools.agent.MixinAgent
    Can-Redefine-Classes:    true
    Can-Retransform-Classes: true
  org/spongepowered/tools/agent/MixinAgent.class          implements IHotSwap
  org/spongepowered/tools/agent/MixinAgentClassLoader.class
  org/spongepowered/asm/mixin/transformer/IMixinTransformer.class
    List<String> reload(String mixinClass, ClassNode node)     // returns the affected TARGETS
```

Established by `unzip -l` and `javap -c` over that jar on this machine, not from memory. The wiring,
read out of the bytecode:

- `MixinTransformer`'s constructor contains the literal strings `"Attempting to load Hot-Swap agent"`
  and `"org.spongepowered.tools.agent.MixinAgent"`: it **reflectively instantiates the agent at
  startup** when `MixinEnvironment.Option.HOT_SWAP` is set. That option's string is `hotSwap`, so the
  switch is `-Dmixin.hotSwap=true`.
- `MixinAgent`'s constructor adds itself to a static `agents` list and calls `initTransformer()` *if*
  a static `Instrumentation` is already present. `initTransformer()` is
  `instrumentation.addTransformer(new Transformer(this), true)` — retransform-capable.
- `MixinAgent.init(Instrumentation)` is **public static**: it stores the instrumentation and calls
  `initTransformer()` on every agent constructed before it arrived. **This is the late-attach door,
  and it fits the agent we already self-attach.** No `-javaagent:` on the command line is required.
- `MixinAgent$Transformer.transform` branches on what is being redefined. A **mixin** class →
  `reloadMixin` → `IMixinTransformer.reload(...)` → the target list → `reApplyMixins(targets)` (which
  retransforms them, re-running mixin against the *original* bytes — the exact thing the naive
  redefine destroys). A registered **target** class → `transformClassBytes` re-applied. On failure it
  returns `ERROR_BYTECODE` and logs *"Mixin {} cannot be reloaded, needs a restart to be applied"*.

**`grep -rn "mixin.hotSwap"` across `build.gradle` and `gradle-conventions/` returned nothing.** We
never turned it on. Editing the body of an existing `@Inject` — the most common mixin edit there is —
has cost a four-minute restart for the life of this project, for a launch flag.

**One implementation trap, which is why this was not a one-line change.** `MixinAgentClassLoader`
loads a *fake* copy of each mixin class specifically so the JVM has something redefinable to hand the
agent; `Transformer.transform` recognises a mixin by
`classLoader.getFakeMixinBytecode(classBeingRedefined)`. Our `hotswap` resolved exactly one `Class`
via `Class.forName(name, false, HotswapTools.class.getClassLoader())` — the Knot copy — and would
have redefined the copy the agent is not watching. **The lookup has to become "every loaded class
with this binary name"**, which `Instrumentation.getAllLoadedClasses()` gives us and which is also how
an IDE debugger does it (`VirtualMachine.classesByName`).

> **Corrected by the live run**: there is no Knot copy. A mixin is applied, never loaded, so the shell
> is normally the ONLY loaded class with that name, and `Class.forName` does not merely pick the wrong
> one — it asks Knot to load a mixin, which the transformer refuses outright. The loaded-class list is
> therefore not an improvement on `forName` here; it is the only thing that works at all.

**Honest limits that survive the fix**, and which the tool keeps saying: a *new* `@Inject` adds a
method to the target, which is still a structural change and still refused (until §2); the target's
frames must still compute; and `reload()` throws `MixinReloadException` for mixin changes it cannot
re-apply, which must surface as a refusal and not as a success.

## 2. Structural edits: the JVM limit is real, the ceiling is not, and nobody had looked

`redefineClasses` cannot add or remove a field, a method, or a class. That is HotSpot, and no amount
of care in `HotswapTools` changes it. The escape has existed for a decade — DCEVM, now carried by
JetBrains Runtime behind `-XX:+AllowEnhancedClassRedefinition` — and this repository had **zero
occurrences** of `dcevm`, `JBR`, `JetBrains Runtime`, `HotswapAgent` or `enhanced class redefinition`
in any file. Not rejected on the don't-build list, not deferred in `TODO.md`: never considered.

The obvious blocker was the toolchain. Minecraft 26.2 requires **Java 25** — Mojang's floor, not our
preference (`gradle-conventions`: `def javaRelease = 25`; `fabric.mod.json`: `"java": ">=25"`) — and
JBR's enhanced-redefinition builds have historically tracked whatever LTS IntelliJ ships, which was 17
and then 21. If JBR had no 25 line, the route was closed and the finding would end here.

**It has one, and the flag works. Established locally, with a falsifier:**

```
$ jbr-25.0.4.1-windows-x64-b583.48/bin/java.exe -XX:+AllowEnhancedClassRedefinition -version
openjdk version "25.0.4.1" 2026-08-18
OpenJDK Runtime Environment JBR-25.0.4.1+1-583.48-nomod (build 25.0.4.1+1-b583.48)

$ "C:/Program Files/Eclipse Adoptium/jdk-25.0.3.9-hotspot/bin/java.exe" \
      -XX:+AllowEnhancedClassRedefinition -version
Unrecognized VM option 'AllowEnhancedClassRedefinition'
Error: Could not create the Java Virtual Machine.
```

The falsifier is the half that matters: a flag that is silently ignored would also print a version
banner. Stock Temurin 25 — the JDK this project builds and runs on today — **refuses** it, so the
acceptance on JBR is the feature being present and not the flag being tolerated.

**What is proven and what is not.** Proven: a Java 25 JVM with enhanced class redefinition exists for
Windows x64 and is downloadable (`jbr-25.0.4.1-windows-x64-b583.48.zip`, ~101 MB, from
`cache-redirector.jetbrains.com/intellij-jbr/`). Not proven, and owed before any claim is made in
`LIVE_MODDING.md`: that Minecraft 26.2 **boots** on JBR 25 (JBR is a patched OpenJDK and the client
touches graphics and `sun.misc.Unsafe` corners); that Fabric loader and Knot tolerate it; that an
added method to a loaded mod class actually takes; and how it interacts with §1, since DCEVM
redefinition and mixin's retransform both want to rewrite the same target.

**Recommendation.** Opt-in, never the default: a `-PjbrHome=<path>` (or a conventional path the build
probes) that points the loom run's `javaLauncher` at JBR and adds the flag, so the project keeps
building and shipping on stock Temurin and only the *dev run* moves. The ceiling moving is worth a
day; the ceiling moving for everyone who ever builds this mod is not what anyone asked for.

## 3. A swap lands and nothing changes — there is no re-entry tier

`redefineClasses` replaces bytecode. It does not rebuild the object graph the old bytecode already
produced. A `Screen` has already run `init()` and is holding the widgets that method built. An entity
has already assembled its goal list. A registry holds a lambda captured at registration. A config was
parsed once into a field. In every one of those cases the swap genuinely succeeded and the running
game genuinely does not change, and the agent that called the tool has no way to tell that apart from
a change that did land.

`LIVE_MODDING.md` gestures at this exactly once, in the UI section — *"Container screens can't be
constructed by tool (they need a server-side menu): re-interact with the block after the hotswap
instead"* — which is a workaround for one case of a general problem, filed under a different heading,
where nobody looking for it would find it.

**This is the single highest-value unbuilt thing in the loop, and it is not research.** The re-entry
acts are all short and all already reachable: re-open the screen the client is on, re-run an entity's
`registerGoals`, invalidate the caches we know by name, re-fetch the block entity ticker.

**Recommendation.** A `reinit` argument on `hotswap_class` (or a documented follow-on call per
subsystem, which is cheaper and more honest), plus one paragraph in `LIVE_MODDING.md` stating the
general rule: *the bytes are new, the objects are old; a swap is visible only where the code runs
again.* Without it, `redefined: 1` is a true statement that reliably produces a false belief.

## 4. A no-op swap is indistinguishable from a real one

The reply is `redefined`, `count`, `bytes`, `source`. Every one of those is exactly as true when the
bytes pushed are **byte-identical to the ones already loaded** — which is what happens when the
`compileJava` was forgotten, went to a different output directory, or the daemon decided there was
nothing to do. That is the most common failure of this loop in practice, and the tool reports it as
success.

The refusal on a `jar:` URL exists precisely because the author saw this class of lie and closed one
instance of it. The general instance is still open.

**Recommendation.** The agent already declares `Can-Retransform-Classes: true`, so the currently
loaded bytes are obtainable: register a capturing `ClassFileTransformer`, call `retransformClasses`,
keep what it hands back. Compare against the replacement and report `changed: false` per class (or,
much cheaper and nearly as good: report each `.class` file's mtime against the swap time, so "this
file was compiled before your edit" is visible). Either way the silent no-op becomes a named one,
which is the shape of refusal this codebase already prefers.

## 5. No ledger of what diverges from the built jar

`LIVE_MODDING.md` states the gap and prescribes amnesia:

> A restart resets all swaps; there is no tool that lists live divergence from the built jar — if
> you've lost track, restart.

Every swap is `Mechanism.PRIVILEGED`, so every call already lands in the audit and event log. The
information exists; nothing surfaces it. This is bookkeeping, not research, and it matters most for
the autonomous loops in `docs/loops/`, which can swap many times before a human ever looks at the
session.

**Recommendation.** A `status` op on `hotswap_class` (or a block in `query_class`) listing class →
swap time → source → digest. Cheap, and it converts "restart because I've lost track" into a read.

## 6. There is no compile step inside the loop, and `tools/` does not know the tier exists

Every swap today is two turns and a guess: run `gradlew compileJava` through Bash, then hand
`hotswap_class` a class name and a `dir`, having worked out the binary-name-to-path mapping by hand.

The coverage sweep makes the consequence concrete. Across the whole workbench, the string `hotswap`
appears in 52 files, **all of them under `mcp-toolkit/` or `mcp-server/`** — and in **zero** files
under `tools/`, `wiki/`, `template-mod/`, `spike-neoforge/`, `world-model/` or `entity-loop/`.
`tools/rebuild.ps1` is the only code-change route any script in this repository knows about. The
loops therefore reach for the four-minute restart *by construction*, not by judgement — including
`entity-loop/`, the newest one.

**Recommendation.** A `compile: true` option (the toolkit can shell the Gradle task itself; `jar` is
the task that deadlocks against a running game, `compileJava` is not), or a watch-on-`build/classes`
mode. The repository already measures token-per-turn cost carefully
(`docs/platform/TOOL_BILL_PLAN.md`), and this is two turns collapsing into one on the most frequent
action in a modding session.

## 7. The manual documents the restart loop and not the seconds loop

Following from §6: `wiki/` — the manual written for the person rather than the agent — never mentions
hotswap. A human reading this project's documentation learns the four-minute loop as *the* loop.

**Recommendation.** One wiki section, after §1 and §3 land, since those change what the honest advice
is.

---

## Correctly refused — not gaps

- **Cross-JVM push** (a server broadcasting a hotswap or asset to players' clients). On the
  don't-build list in `ARCHITECTURE.md` since 2026-07-19, for the right reason: it is remote code
  execution on someone else's machine, and it breaks the boundary Minecraft deliberately keeps. The
  live-code tier stays local-JVM. Nothing in this record touches that.
- **Whole-mod classloader reload.** Minecraft's registries freeze, entrypoints run once, and half the
  game holds references into the old loader. It would be slower and less predictable than the restart
  it replaces.
- **Tool unregistration / hot re-registration.** Already on the don't-build list, and its stated
  reason is *"dev iteration already has `hotswap_class`"* — worth re-reading after §1 and §2, since
  that reason gets stronger, not weaker.

---

## As built

### §2 — feasibility, 2026-09-13

Not built; **proven feasible**, which is what the finding asked for. JBR 25.0.4.1 (b583.48, built
2026-08-18) runs on this machine and accepts `-XX:+AllowEnhancedClassRedefinition`; stock Temurin
25.0.3 rejects it. Owed before this becomes a route in `LIVE_MODDING.md`: Minecraft 26.2 booting on
JBR, Knot tolerating it, an added method actually taking, and its interaction with §1.

### §1 — built 2026-09-13 at 0.149.0

202 unit tests green (`gradlew test` in `mcp-toolkit/`), of which 4 are new. **Offline-green and
LIVE-UNRUN**: no game was running when this landed, so what a test JVM can reach is the account given
when the agent is NOT armed, and the re-apply itself is owed a live confirmation (below).

| | what landed | where |
|---|---|---|
| the flag | `-Dmixin.hotSwap=true` on both loom runs, and on every consumer's runs | `build.gradle` (client, server), `gradle-conventions/src/main/groovy/com.mattmc.mcmod.gradle` |
| arming | `MixinAgent.init(inst)` reflectively, once per JVM, from the instrumentation the toolkit already self-attaches — no `-javaagent:` on the command line | `MixinHotswap` (new) |
| the lookup | every loaded COPY of a binary name via `Instrumentation.getAllLoadedClasses()`, replacing a single `Class.forName` | `HotswapTools.loadedCopies` |
| the refusal | a mixin TARGET is refused and names the mixin to swap instead | `HotswapTools.hotswap`, `ClassTools.anyMergedMixin` (new, shared) |
| the account | `mixin.reapplied` when a shell was in the batch; `mixin_note` naming the flag and the rebuild when it was not | `HotswapTools.hotswap`, `MixinHotswap.why` |
| the precheck | `query_class`'s `hotswap` block gained `route` (target → swap this mixin) and `mixin_class` (proved by the agent holding a shell, not by an annotation) | `ClassTools.hotswap` |

Two decisions worth keeping:

- **A class that is not loaded is now a refusal, not a redefine.** The old lookup was
  `Class.forName(name, false, loader)`, which *loads* a class in order to redefine bytes nobody is
  running. The new message says the true thing instead: there is nothing to redefine, and a class
  that loads later reads the new bytes off the classpath by itself.
- **`mixin_class` is proved by the shell, not by `@Mixin`.** Reading the annotation would answer
  "this is a mixin"; finding Mixin's agent holding a shell for it answers "this is a mixin AND the
  agent is armed to re-apply it", which is the question a caller about to swap actually has.

### §1 — confirmed live 2026-09-13 at 0.150.0

Two games: one launched from this build, and one **deliberately launched with the flag commented out**
of `build.gradle`, because a mechanism that is only ever observed switched on has not been observed to
do anything. Everything below is a reply or a log line from those two runs.

| | asked | answered |
|---|---|---|
| the flag arrives | does `-Dmixin.hotSwap=true` reach the game | `latest.log:10` — `(FabricLoader/Mixin) Attempting to load Hot-Swap agent`. **ABSENT** in the flag-off run, which is the falsifier |
| **a mixin body edit lands** | edit an existing `@Inject`, `compileJava`, swap the MIXIN | `{"redefined":["…ChatListenerMixin"],"bytes":5158,"source":"classpath","mixin":{"reapplied":true}}`, then the edited line ran **on the Render thread, in the world, with no restart** |
| Mixin says so | the success log | `[FabricLoader/Mixin/agent] Redefining mixin com/mattmc/mcptoolkit/mixin/client/ChatListenerMixin`, on the `mcptoolkit-http` thread — our own call |
| it reverts | swap the pristine mixin back | lands, and the edited behaviour **stops** — the tier is not one-way |
| a target is refused | `hotswap_class` on `net.minecraft.…ChatListener` | refused, naming `ChatListenerMixin` as the route |
| the precheck agrees | `query_class` on that target | `safe:false` + the `route` line |
| the precheck on the mixin | `query_class` on the mixin | `mixin_class:true`, `route`, `classpath_default:true` — **after the fixes below; the first cut answered none of it** |
| no flag, no tier | swap any mod class on the flag-off game | `mixin_note`: *this game was started without `-Dmixin.hotSwap=true` … rebuild* |

**The classpath default works for a mixin**, which was not obvious and is now the normal route: the
shell has no code source at all, but `MixinAgentClassLoader` delegates the *resource* to its parent,
so `.../build/classes/java/main/…/FooMixin.class` resolves. No `dir` argument is needed.

#### Five defects the confirmation found, all closed at 0.150.0

Offline-green was not close to enough. Four of these five are in the paths a *first* mixin swap takes.

1. **A mixin is loaded ONCE, not twice.** The record above says "a mixin is loaded twice, the Knot copy
   and the shell". Live, Knot never defines one at all: a mixin is applied, not run. So the shell is
   not a second copy to be found beside the real one — it is the only copy there is. That falsifies the
   premise of two checks:
   - `ClassTools.isMixinClass` looked for *another* loaded copy that was a shell, and the class it was
     asked about **was** the shell, so `mixin_class` and its `route` were unreachable in the case they
     were written for.
   - `HotswapTools`' own `primary` rule survives it (the shell is returned when it is all there is),
     but its justifying comment was wrong, which is how the other check came to be written.
2. **`query_class` on a mixin threw Mixin's own error.** `Class.forName` on a mixin does not find the
   wrong copy — it makes Knot *try to load* one, which the transformer refuses:
   `RuntimeException: Mixin transformation of … failed`, surfaced raw. So the natural first move
   — precheck the class you are about to swap — failed on exactly the classes 0.149.0 made swappable,
   with an error that names no cause. Now a refusal that says a mixin is applied rather than loaded,
   that the only runtime copy is the agent's shell, and that a swap attaches the agent that reveals it.
3. **The precheck contradicted the tool.** `query_class` read the class's CODE SOURCE; a swap reads
   the loader's RESOURCE. On a shell those disagree — no code source, resolvable resource — so the
   precheck said *"no code source … pass 'file' or 'dir'"* about a swap whose classpath default then
   worked. Both now ask `HotswapTools.classpathResource`, so the precheck reads what the swap reads.
4. **"Class not loaded" pointed the wrong way for a mixin.** On the flag-off game, swapping the mixin
   gave *"there is nothing to redefine, and a class that loads later reads the new bytes off the
   classpath by itself"* — true of an ordinary class, **false of a mixin**, which never loads and whose
   targets keep the old injector until a restart. The most likely mixin swap on the most likely broken
   setup got a reassuring refusal that named neither the flag nor the rebuild. Both `hotswap_class` and
   `query_class` now name them whenever the state is known-unarmed.
5. **A DECLINED re-apply reported as five words.** Asked for by the handoff, and the answer is better
   than feared *and* worse: Mixin's agent returns `ERROR_BYTECODE` when `reload()` throws, the JVM
   rejects it, and **nothing is redefined** — so a declined re-apply does NOT masquerade as success.
   But `ClassFormatError` is an `Error`, so it escaped `catch (Exception)` and reached the caller as
   the bare string `java.lang.ClassFormatError`: no mixin named, no cause, no fix. Measured with a new
   `@Inject`, which is the structural case:

   ```
   [FabricLoader/Mixin/agent] ERROR Error while finding targets for mixin …/ChatListenerMixin
     MixinPreProcessorException: Conform error … [Conform injector mcptoolkit$falsifierNewInjector…]
   ```

   The reply now says Mixin declined, that nothing was redefined and the targets still run the old
   injectors, that a new injector is the usual cause, and where Mixin's own reason is. Note the log
   line is **not** the `cannot be reloaded, needs a restart to be applied` this record predicted — that
   string belongs to a different branch of the agent; what a structural mixin edit actually produces is
   `Error while finding targets for mixin`.

**Fix 5 was itself installed by `hotswap_class` into the running game** and confirmed there, without a
restart — a method-body edit to `HotswapTools.hotswap`, which is the tier repairing itself.

**Still owed on §1** at the time of writing: a mixin whose targets are MOD classes rather than
vanilla ones (every mixin swapped here targeted Minecraft), and the dedicated-server run, where only
`build.gradle`'s `server` block carries the flag. Both were answered later the same day — see "the
leftovers, answered" at the end of this record.


### §3, §4, §5 — built and confirmed live 2026-09-13 at 0.152.0

216 unit tests green (12 new), and every line below is a reply or a log line from a running client in
a world. The three were built together because they are one defect seen from three sides: **a swap
that lands and changes nothing.** §4 is the case where the bytes were never new, §3 the case where
the bytes are new and the objects are old, §5 the memory that makes both answerable a second time.

| | what landed | where |
|---|---|---|
| the account | a `reentry` block on EVERY swap: per class, its KIND in this running game, what old state survives, and what would make the code run again | `Reentry` (new), `HotswapTools.hotswap` |
| the act | `reinit: true` — rebuild the current screen's widgets (`Screen.resize` → `rebuildWidgets` → `init()`), re-run `registerGoals()` on every loaded instance of a swapped `Mob` | `Reentry`, `client/ScreenReentry` (new), `mixin/MobAccessor` (new) |
| the no-op | bytes byte-identical to what is already installed are REFUSED, naming the file and `compileJava` | `HotswapTools.installedBytes` (a capturing retransform), `SwapLedger` |
| the staleness signal | `compiled_at` — the mtime of the bytes just installed, on every reply | `HotswapTools.compiledAt` |
| the ledger | `{"status": true}`: class → when, source, bytes, digest, swap count | `SwapLedger` (new) |

**Kinds are decided by real class references, never by name.** `Mob.class.isAssignableFrom(cls)` is
remapped with the rest of the jar and means the same thing in a production install; a string compare
against `"net.minecraft.world.entity.Mob"` would answer PLAIN for every Minecraft supertype there.
`Screen` is the one kind this rule cannot reach from common code — it is a client class and
`Reentry` loads on a dedicated server — so it is delegated to a `ClientReentry` seam, which is also
what makes the whole screen path testable without a game.

#### What the running game said

| | asked | answered |
|---|---|---|
| the screen is HELD | swap `InterpretedScreen` while the client is on one, with a logging line added to `init()` | `reentry.live`: *"the client is on this screen right now"*, and the log is **empty** — the swap landed and `init()` did not run |
| **`reinit` re-enters it** | the same call with `reinit:true` | `"re-ran init() on the live InterpretedScreen"` and the probe line appears **on the Render thread**, no restart |
| the mob is HELD | a drone body in the world, a logging line in `BotBodyEntity.registerGoals()`, swap | `reentry.live`: *"1 loaded instance(s) in this world"*, log **empty** |
| **`reinit` re-enters it** | the same call with `reinit:true` | `"re-ran registerGoals() on 1 loaded instance(s), both selectors cleared first"`, and the probe line appears **on the Server thread** |
| a mixin is a kind of its own | swap `ChatListenerMixin` | `kind: "mixin"`, `mixin.reapplied: true` — and the §1 tier still works at 0.152.0 |
| the no-op is refused | swap a class twice without recompiling | *"nothing to redefine: … is byte-identical to what this JVM is running right now"*, naming the file and `compileJava` |
| the ledger's half of it | the same, on a MIXIN (whose shell must never be retransformed) | *"byte-identical to the bytes pushed at 17:51:11Z"* — the fallback source, in the case it was written for |
| the ledger | `{"status":true}` after the run | both classes, newest first, with digests and the note that only a restart resets them |

#### Three things only the running game could say

1. **The bytes a dev run holds for a mod class are NOT the bytes on its `.class` file.** The first
   cut compared the file against the loaded bytes and expected equality on an untouched class
   straight after a clean build; live, it reported a successful redefine. Measured: *same length,
   different content* — Knot rewrites every mod class as it loads it. So a **first** swap of a class
   cannot be decided by bytes at all, and from the **second** on it can, exactly, because our own
   redefine installed the file's bytes verbatim. The check now asks the ledger first and only reads
   the JVM back for a class it has already swapped (which also means a first swap never retransforms
   anything). `compiled_at` exists because of this: on the one swap neither source can decide, the
   mtime is what separates "I recompiled" from "I forgot to".
2. **`reinit` had to be legal on unchanged bytes.** The loop a caller actually walks is *swap, look,
   nothing moved, re-enter* — and the second call carries the same bytes, which §4 had just made a
   refusal. A no-op refusal answering a request that was not for a redefine is the same class of
   wrong answer this record is about. Unchanged bytes plus `reinit:true` now redefine nothing, run
   the re-entry, and say both.
3. **A capturing retransform is safe on a plain class and must never touch a mixin shell.** Mixin's
   agent is a retransform-capable transformer, so retransforming a shell would re-apply the mixin to
   its targets — a real act performed in the course of answering a question. The shell is skipped by
   name and answered from the ledger instead, which the run above exercised.

**Still owed** at the time of writing: `reinit` on a mob whose subclass overrides `registerGoals()`
(the one measured here inherits it), and the §1 leftovers — a mixin whose targets are MOD classes,
and the dedicated-server run. All three were answered later the same day — see "the leftovers,
answered" at the end of this record.

### §6, §7 — built and confirmed live 2026-09-13 at 0.153.0

228 unit tests green (12 new). §6 is `hotswap_class {compile: true}`; §7 is the wiki, which could
only be written once §1 and §3 had changed what the honest advice was.

**The two turns were the cost; the guess was the defect.** A separate `gradlew compileJava` and a
`hotswap_class` are two statements about which project is being worked on, and nothing checked that
they agreed — a compile in one and a swap in another each report success and together change nothing,
which is the §4 no-op arriving by a second road. So the compile is derived, not typed: the loaded
class states its classes root (the classpath URL the swap already reads, minus the package path), and
a Gradle classes root states the project and the task — `<project>/build/classes/<lang>/<sourceSet>`
is built by `compile[SourceSet][Lang]`, which is Gradle's own naming rule rather than a table, so
`build/classes/java/client` resolves to `compileClientJava` and `build/classes/kotlin/main` to
`compileKotlin` without either having been anticipated. One Gradle run per distinct project-and-task
in a batch.

| | what landed | where |
|---|---|---|
| the step | `compile: true` — run the compile, in the project the bytes come from, before reading them | `GradleCompile` (new), `HotswapTools.compileFor` |
| the derivation | classes root → project + task; refused, never guessed, when the directory is not a Gradle one | `GradleCompile.of`, `HotswapTools.classesRoot` |
| the failure | javac's own file/line/column IS the reply; nothing is redefined | `GradleCompile.explain` |
| the no-`jar` rule | structural: a task name derived from a classes directory can never be a packaging task, and a sibling's locked jar is translated into "your game is running" | `GradleCompile.explain` |
| the refusal, rewritten | with `compile: true`, byte-identical bytes no longer mean "you forgot to compile" — the compile just ran | `HotswapTools.hotswap` |
| the manual | `wiki/the-change-loop.md`, where `hotswap` appeared in **zero** files before this | `wiki/` (4 pages) |

**Ordering is part of the contract.** Every refusal that costs nothing — not loaded, mixin target,
not a Gradle classes root — is reached before the compiler runs, so a caller who is about to be
refused never waits twenty seconds for it.

#### What the running game said

| | asked | answered |
|---|---|---|
| the whole loop, one call | add a line to `BuiltinTools`' `ping` handler, `hotswap_class {compile: true}` | `compiled: [{task: "compileJava", status: "executed", ms: 5016}]`, `redefined: 1` — and the next `ping` carries the new field |
| the same call again, unedited | `hotswap_class {compile: true}` | *"The compile ran here first (compileJava UP-TO-DATE) and produced these same bytes, so a missing compile is NOT the cause"* — §4's refusal, re-aimed |
| a directory that is not a classes root | `compile: true` with `dir` pointing at the game directory | refused before Gradle started, naming the shape it wanted |
| a source that does not compile | break the line, swap | javac's `error: cannot find symbol` with file, line and column, *"nothing was redefined, and the game is still running the code it was running before"* |
| the tool on itself | `hotswap_class {class: "…GradleCompile", compile: true}` | the compile step compiled and swapped itself, `compileJava UP-TO-DATE` (the tests had just built it), and the next failure came back in the new shape |

#### What the live run corrected

**A compiler that fails says it three times.** The first cut handed back everything Gradle printed:
javac's report, then Gradle's `FAILURE:` banner repeating it indented, then advice to re-run with
`--scan` — 1400 characters to say `cannot find symbol` once, on a tool billed per token on the most
frequent action in a session. The banner is now dropped **when there is an `error:` above it**, which
is the whole of the rule: a jar lock says its piece in the banner and nowhere else, so cutting on the
marker alone would have deleted the reason. Measured after the fix, live: 430 characters, same
information.

**A drained pipe and a wait are not the same wait.** Reading the subprocess's output on the calling
thread makes `readAllBytes` the timeout — it returns at EOF, which a hung Gradle never reaches — so
the drain is a thread of its own and `waitFor` is the clock. Leaving the pipe undrained instead is
the other half: a full buffer stops the subprocess dead, which is a hang we would have caused.

**Still owed**: nothing in this record but §2 — JBR 25's enhanced redefinition, feasible and
unbuilt, which would take the structural rebuild out of the loop as well. The §1 and §3 leftovers
were answered the same day, below.

### The leftovers, answered 2026-09-13

Three checks deferred for want of a running game, all done in one sitting on the 0.153.0 swap tier —
first on a client in a world, then on a **dedicated server**. (The jar reported 0.154.0: an unrelated
fix was in flight in the same working tree. Nothing in the tier moved.)

They needed two throwaway probes, because nothing this jar ships is the shape being tested: an
override of `registerGoals()` in `WalkerEntity` that logs, and a mixin injecting into
`SwapLedger.status()` — a MOD class — that stamps a string into the reply. Both reverted afterwards.

| | asked | answered |
|---|---|---|
| **§3 — a subclass that OVERRIDES `registerGoals()`** | spawn a `WalkerEntity`, swap the ABSTRACT superclass `BotBodyEntity` with `reinit: true` | `re-ran registerGoals() on 1 loaded instance(s)`, and the **subclass's** override logged, on the Server thread. The `@Invoker` dispatches VIRTUALLY — until now a javadoc claim; and selection is `isInstance`, so a swap of an abstract superclass reaches every subclass instance |
| **§1 — a mixin whose target is a MOD class** | inject at `RETURN` of `SwapLedger.status()`, edit the injector body, swap the mixin | `mixin.reapplied: true`, and `{status: true}` came back carrying the new string. Mixin re-applies to a Knot-loaded MOD target exactly as it does to a vanilla one |
| **§1 — the dedicated-server run** | the same mixin swap, plus `CommandsMixin` (a VANILLA target), plus `compile: true`, on `runServer` | all three land: the self-attach works with no client, the `server` block's `-Dmixin.hotSwap=true` really arms the agent, and `run_command` still answers after `Commands` was retransformed under it |
| **§3 — the mob re-entry on a dedicated server** | spawn a walker by explicit `pos` (no player to anchor on), swap, `reinit: true` | the same answer as the client's integrated server, on the same thread |

**One finding, and it is a build-time one.** A mixin whose target is a mod class needs
`remap = false` on the `@Mixin` **and** on the injector: without it the annotation processor looks
for the target method in the Minecraft mappings, does not find it, and fails the build. Nothing in
this jar had ever needed it, because every mixin it ships targets vanilla.
