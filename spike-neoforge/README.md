# spike-neoforge — KEPT. The workspace's only NeoForge

Started as the throwaway probe of `mcp-toolkit/docs/platform/CROSS_LOADER_DESIGN.md` §7 Stages 0 and 3, and its
questions are answered (§11, §13). **Do not delete it.** Nothing depends on it at build time — it is
still in no `settings.gradle` but its own — and that is exactly the trap: deleting it costs nothing
today and removes the only place four things can be checked at all. Decision recorded in
`CROSS_LOADER_DESIGN.md` §15.6.

## What it is the only arbiter for

mcp-toolkit ships one jar for two loaders. Every NeoForge fact the toolkit has is measured here,
because this is the only NeoForge in the workspace — server and client both:

| | why only here |
|---|---|
| the extension seam on NeoForge | NeoForge has no entrypoint mechanism; the seam needs a SECOND mod to hand the toolkit a class (§13) |
| the payload seam on NeoForge | human input capture rides a custom payload; §14's collision was found by this mod, not by any Fabric cell |
| the `Bootstrap` translation check | `SharedConstants.IS_RUNNING_IN_IDE` is FALSE under Loom and TRUE under ModDevGradle, so a Fabric cell CANNOT arbitrate it — it skips the path silently (§15.2) |
| any NeoForge client at all | nameplates, entity renderers, asset packs, `quit_game` (§15.4) |

The last two are the load-bearing ones: a Fabric run does not merely fail to check them, it comes
back green without having checked them.

**Keep it building.** Its `compileOnly` toolkit version tracks the workspace default (currently
`0.85.0`, overridable with `-Pmcptoolkit_version=`), and the runtime copies in `run/server/mods/`
and `run/client/mods/` are dropped in by hand — refresh those when the toolkit moves, or a boot here
is measuring an old jar.

## A trap that is now defused, and why the fix is in a spike

Both spike types are summonable, and `SpikeEntity` used to say "never spawned" while the spike
registered no renderer for it. **A registered entity type with no renderer is a client crash, not a
missing model** — `EntityRenderDispatcher.shouldRender` NPEs on the render frame one comes into
view, the entity is SAVED, and the world then crashes on every subsequent join until the save is
deleted. That cost two client boots. `SpikeClient` now gives both types vanilla's `NoopRenderer`.

## What it asks

Whether the door mcp-toolkit's `BuiltInRegistriesMixin` registers its entity types through — the
`freeze()` call inside `BuiltInRegistries.bootStrap()` — is open on NeoForge, and whether a type that
gets in that way survives **registry sync** to a joining client. The second half is invisible in
singleplayer and fatal on a dedicated server, so it needs two real processes.

Two types go in by two different doors, so one failing cannot hide the other:

| id | door |
|---|---|
| `spike:mixin_door` | the `bootStrap()` injection — mcp-toolkit's mechanism, verbatim |
| `spike:event_door` | NeoForge's own `RegisterEvent` |

## Running it

```sh
./gradlew runServer
# then, in another shell, once the server says Done:
./gradlew runClient "-PjoinServer=127.0.0.1:25565"
```

### The Stage 3 cell too

The spike is also an **extension mod** (`SpikeToolkitExtension` +
`META-INF/services/com.mattmc.mcptoolkit.McpToolkitEntrypoint`), because NeoForge has no entrypoint
mechanism and the only way to see whether one mod can hand the toolkit a class here is to have a
second mod do it. Drop `mcp-toolkit-<version>.jar` in `run/server/mods/`, `./gradlew runServer`, and
green is:

```
[MCP Toolkit] 1 extension mod(s) registered tools: [spike]
```

with `spike_toolkit_probe` in `GET /tools` carrying `"source": "spike"`. The service file also keeps
a commented-out unloadable class: uncomment it to re-run the **containment** cell, where that bad
line must cost only itself while the good line below it still registers.

The quotes on `-PjoinServer` matter — unquoted, the shell hands Gradle `127.0.0.1:25565` split at the
colon and it looks for a project called `.0.0.1`.

Then read the `[spike]` lines in both logs. The verdict is whether `rawId=` matches across the two
processes; presence alone is not enough, because entity spawn packets carry the numeric id and two
sides that disagree on it corrupt each other silently rather than failing to connect.

## The answer

All three questions came back yes. Written up in `CROSS_LOADER_DESIGN.md` §11 — read that, not this.
