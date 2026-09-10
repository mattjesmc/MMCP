# The travelling subject

One real `.bbmodel`, so `mcptoolkit_entity.test.mjs` keeps a real subject on a checkout of
mcp-toolkit alone.

The fifteen Blockbench sources this harness was written against lived in
`mcmodding/blockbench_sources/`, a **sibling** of this repo rather than a part of it, until
2026-09-06; they are now in the mod checkouts they belong to — seven entity models in
`rocketeer/blockbench_sources/`, eight block ones in `villagejobs/blockbench_sources/`. The harness
prefers a corpus when one is there (pass its directory as the first argument, or put one at
`mcmodding/blockbench_sources/`) — seven entity models and eight block ones is what lets section 2
assert the *partition* rather than demanding every source convert. When none is there, section 2
would simply have had nothing to run, and a harness that quietly loses its only real subject is
worse than one that never had it.

So exactly one model travels: **`space_narwhal.bbmodel`**, and it is that one on purpose. It is
small (7 cubes, 21 pairs), it is genuine Blockbench output rather than something written to pass,
and it is one of the two models `ENTITY_AUTHORING_DESIGN.md` §7.2 stood the loader up against in the
live client — so the travelling arbiter and the live evidence name the same subject.

What it cannot do is cover the vocabulary no real source in this workspace uses (cube rotation,
inflate, mirrored UV) or the block-model partition. Those are section 3's asymmetric fixture and
section 5's refusals, both written in the harness itself — which is why one file is enough here and
a second would only be more of the same evidence.
