// The bench's own version — distinct from the toolkit version (build.gradle) and the git head,
// both of which manifests already record. Runners stamp this into manifest.json as
// `bench_version`, so a result row is citable against the instrument that produced it
// (PAPER_BENCH.md §8) even after registry/question churn.
//
// Policy (agreed 2026-07-25):
//   0.9.x  — pre-freeze: registry/questions/truths may still move; results are directional.
//   1.0.0  — THE FREEZE: registry + question sets + truths frozen; every paper-cited table
//            re-runnable from the tag; repo split happens at this tag, not before.
//   then SemVer: patch = harness fixes that cannot change scores; minor = additive units/arms;
//   major = anything invalidating cross-version comparison of an existing unit.
// 0.9.1 — validity fixes + the seeded Category A/B arena. Still pre-freeze, but this bump marks a
// COMPARABILITY BOUNDARY: rows stamped 0.9.0 and 0.9.1 are not interchangeable for these units, so
// filter with `bench-report --bench-version` before pooling them.
//   a1-a14, b1-b6  — the arena is generated per seed instead of a single fixed world, and the walk
//                    is recorded at floor level (0.9.0 observed from y=251, ~100 blocks up).
//   t9_findsite    — terrain rebuilt; the 0.9.0 answer was derivable from the prompt text.
//   t12_machineroom— the canonical answer is now withheld on half the seeds; 0.9.0 was closed-book.
//   t13_hopperchain— 4 chests answered by coordinates, not a 2-way A/B (was a 50% guess floor).
// 0.9.2 — additive: E-traverse gains a `--body walker` arm axis (grounded body on a 3-high-interior
// tube; flyer runs are byte-identical to 0.9.1 — default body stays flyer, ROOF_DY 3, oracle
// body-matched). Flyer rows pool with 0.9.1; walker rows are a NEW unit, not comparable to flyer.
// 0.9.3 — pre-freeze expansion round (FREEZE_PLAN Workstream F, Matthijs 2026-07-26):
//   E-repair (run-repair.mjs) — the failure-path ladder: plug_break/bridge_gap/door_shut (work
//     REQUIRED; goal-vs-hand remedial-turn A/B), iron_control (diagnosis: name the control),
//     budget_resume (finish off the resumable ledger). New units e_repair_*.
//   claimed/claim_matches columns (E-traverse + E-repair) — the agent's ARRIVED/BLOCKED claim
//     scored beside server truth; keeps predict-vs-execute clean of agent-behavior noise.
//   mspt_before/mspt_after per row — server load attribution (a lagging server is a censoring
//     instrument; the row now says so). Score-neutral; older rows simply lack the columns.
// 0.9.4 — Category C surface repair + the `revisit` workflow arm (2026-07-27). COMPARABILITY
// BOUNDARY for Category C: do NOT pool C rows across 0.9.3/0.9.4.
//   AGENT_WORLD_TOOLS named `get_blocks`, renamed to `get_surface` in toolkit 0.6.0. The shim
//     filters this list against the LIVE manifest, so the stale name silently VANISHED and C ran
//     with no structured block reader — the agent raycast 70+ times hunting a chest 6 blocks from a
//     coordinate it had been handed, and `stale` was arguably never fairly answerable. Now
//     get_surface + describe_box + get_blocks_at, and `assertWorldToolsLive` (FREEZE_PLAN B4) makes
//     a tool a transform names but the SUT lacks a THROW instead of a silent narrowing.
//   The shim no longer re-wraps perception in asciiSurfaceView: get_surface already returns an
//     abstracted result, and the wrapper blanks to "(no columns returned)" on default detail.
//   New `--workflow recall|revisit` axis on run-memory (additive; default `recall` keeps unflagged
//     runs byte-identical). recall = answer from memory alone; revisit = memory locates, the world
//     is re-read before answering.
// 0.9.5 — the two Category C question defects 0.9.4 recorded as known-open are now FIXED. Another
// COMPARABILITY BOUNDARY for C (question text changed ⇒ questions_hash changes): do not pool C rows
// across 0.9.4/0.9.5 either. C is the only category touched; every other category's 0.9.3 rows stand.
//   `anchor` printed stage.Y (the platform) beside the words "on top of", while the truth is at
//     markerPos[1] = stage.Y+1. THREE independent sessions answered `polished_andesite` — the
//     platform body — identically; a reproducible wrong answer is a question defect, not a
//     capability result. Now prints the marker's own y and names it "the START marker itself".
//   `breadth` asked for structures "you recorded" but graded construction truth, so an agent that
//     recorded two and honestly said two was marked wrong. Now asks what is "present in region 3",
//     which is what the scorer has always measured.
// 0.9.6 — additive: the Category C `change` rung, the capture-forced arm, and one censoring repair
// (2026-07-28). The recall/revisit quiz, its truths and its questions_hash are UNCHANGED — a
// recall-only invocation is byte-identical to 0.9.5, and the §2 baseline (anchor/region/stale 100%,
// where/count 57% [25–84], breadth 71%) re-reports identically after every change below. So this is
// NOT a comparability boundary for the existing C units.
//   `--workflow change` — the change-detection rung OBSERVATION_MEMORY_DESIGN §6 prediction 2 rests
//     on: four probe platforms mutated between explore and quiz (a cluster grows, a tower vanishes, a
//     structure appears on bare stone, one is left alone as the false-positive guard), each scored on
//     the PRIOR as well as the verdict — a right verdict from a wrong prior is a coin flip, not
//     change detection. Its own workflow, not a seventh question, so the shared answer block every
//     arm sees is untouched. New units chg_grew / chg_vanished / chg_appeared / chg_same / chg_now;
//     chg_now (the live re-read) is the built-in control both arms should hold at ceiling. Because it
//     mutates the world, `change` always runs LAST within a seed and a resume across it is refused.
//   `--arch capture-forced` (condition f) — e's tools with a prompt that says to consult them. The
//     first paired smoke exposed the captured surface to a free-choosing agent and it called the
//     tools ZERO times. Free choice prices DISCOVERY, steering prices the REPRESENTATION; both arms
//     are reported, per the PATTERN_SEARCH precedent. `obs_tools` is now a column on every C row.
//   CENSORING REPAIR — two holes, both the same shape as A5's: a session whose MCP server never
//     connected opened with 0 tools, answered blind, and was reported `success` by the SDK, so the
//     harness SCORED it (1/6); and a C row's terminal state lived only on its nested `quiz` object,
//     so even a stalled or runaway quiz was scored question-by-question. Now `toolSurfaceFailure`
//     aborts such a session at its init message (retried once, since it wrote nothing), and
//     SCOPES its server-status check to the arm's OWN server — the first live run of this guard
//     aborted a healthy session because the developer's ambient `claude.ai Gmail/Drive/Calendar`
//     servers sat in `needs-auth`, and censoring a good session is the same defect as scoring a
//     blind one, pointed the other way. Corrected before 0.9.6 produced any scored row but one.
//     expandRow carries stop_reason/capped down to the per-question subrows. Score effect on the
//     corpus: the two 2026-07-23 error_max_turns C rows are now censored rather than scored — they
//     predate 0.9.4 and were never poolable with the baseline anyway.
// 0.9.7 — the change rung's TWO question defects, found by running it (2026-07-28). Both are the
// 0.9.5 lesson repeating: a reproducible wrong answer is a question defect, not a capability result.
// COMPARABILITY BOUNDARY for the chg_* units only — they have no citable rows (the 0.9.6 attempt was
// quarantined), and no other unit is touched, so recall/revisit rows still pool with 0.9.5.
//   `chg_vanished`'s prior was UNOBSERVABLE. As a wool TOWER it spanned y=201..201+h (h 3..5), while
//     explore sessions habitually scan a ~4-tall box — truncating it at every height in the range.
//     The session honestly saw 2 of 5 and wrote 2; capture recorded 2 as well, because the
//     observation WAS 2. Grading against the construction truth of 5 therefore measured how tall the
//     explore session happened to scan, not whether memory kept a prior. The structure is now a flat
//     cluster at y=201, caught by any platform-sized box. The report also gained a permanent
//     prior-observability column (obs-report.mjs) so this class is visible rather than scored.
//   The quiz pointed at the SLAB. It printed the platform's y beside "what has happened to them",
//     and one arm answered `stone`/`cobblestone` for all four probes — the platform bodies — scoring
//     0/5 with five confident wrongs while the other two arms scored 4/5 on the same corpus. Exactly
//     0.9.5's `anchor` defect (a coordinate that is not the answer's coordinate invites that answer),
//     and worse here because the quiz session is FRESH: it never saw the patrol prompt, so the
//     "raised platform, record what is built on it" convention is nowhere in its context. The prompt
//     now states the structure stands ON TOP at y=201+, gives that y per probe, and says plainly that
//     the slab is never the answer. Random across arms, so it was injecting variance unrelated to the
//     hypothesis into the one rung that carries prediction 2.
// 0.10.0 — MEMORY REDESIGN cycle 2 (MEMORY_REDESIGN.md §8). ADDITIVE arms + a rung version bump:
//   arms g/h/i/j  — the redesigned 8-tool memory surface in two annotate ON/OFF pairs
//                   (`annotate`/`annotate-off`, `worldonly-ann`/`worldonly`). Within a pair the tool
//                   manifest and the prompt bytes are IDENTICAL; the only variable is
//                   MCPTK_OBS_ANNOTATE, i.e. whether memory arrives unbidden on the reads the agent
//                   was already making.
//   arms c-f      — now NON-RUNNABLE by construction: they name five tools the consolidation
//                   deleted, and assertMemToolsLive throws rather than serving a silently narrower
//                   arm. Their existing ROWS are untouched and still report; only new runs are
//                   refused. a/b are unaffected.
//   world surface — g-j add `locate` (0.9.7's scope note: the agent under test could not call it,
//                   so the locate capture extractor contributed nothing to the corpus).
//   change rung   — CHANGE_RUNG_VERSION 2 (`chg_vanished` is a flat cluster, not a tower). Stamped
//                   into the manifest as `change_rung_version`. v1 and v2 absolute levels are a
//                   COMPARABILITY BOUNDARY and must not be pooled; paired within-run reads are fine.
//   explore pass  — cycle-2 runs build the corpus under condition g rather than d, which is the
//                   comparability boundary against the 0.9.7 corpus that §8 names in advance.
// Every pre-0.10.0 row re-reports bit-for-bit (verified: bench-report C aggregate, the 0.9.5
// per-unit baseline, and the full 0.9.7 obs-report).
// 0.11.0 — CATEGORY C STAGING FIX + COMPARABILITY BOUNDARY FOR ALL OF C.
//   explore prompt  — EXPLORE_PROMPT_VERSION 2. v1 said "Survey these 4 raised platforms (all at
//                     y=200)" and listed every waypoint as `(x, 200, z)`, i.e. it handed the agent the
//                     SLAB's coordinate and asked what was built there. Agents complied: they read
//                     y=200, found cobblestone, recorded the slab. Measured over three seeds, the
//                     captured structure-layer priors (y>=201 — the only cells ANY C question is
//                     about) were 54 / 0 / 2 cells, so the shared corpus was dark or nearly dark in
//                     two of three seeds and every arm quizzing it inherited that.
//                     The 0.9.5 `anchor` defect exactly ("a coordinate that is not the answer's
//                     coordinate invites that answer"), fixed in the CHANGE-QUIZ prompt at 0.9.7 and
//                     left standing in the explore prompt — where it costs more, because explore
//                     builds the ONE corpus every arm shares. v2 mirrors the quiz prompt's ON-TOP
//                     wording so both halves describe the same world.
//   ⚠ BOUNDARY       — this moves the CORPUS, so it is not confined to the change rung: `where`,
//                     `count`, `breadth`, `anchor`, `region`, `stale` and every `chg_*` probe may be
//                     answerable on a v2 corpus and simply absent from a v1 one. v1 and v2 absolute
//                     levels are NOT interchangeable. Split on the manifest's `explore_prompt_version`
//                     before pooling any C rows across this bump. Paired within-run comparisons are
//                     unaffected (both arms share one corpus, as always).
//   report           — obs-report gained: structure-layer coverage per seed (a total-cell-row count
//                     called an all-y=200 corpus "annotatable"); an opportunity-vs-delivery replay so
//                     "the agent never looked" is distinguishable from "the appendix is broken"; and
//                     UNDERPOWERED labelling where a sign test cannot reach p<.05 (<6 discordant
//                     pairs), which otherwise printed FAIL for prediction 2 and a vacuous PASS for 3.
// 0.12.0 — ADDITIVE: the LEGAL arm (`--arch legal`, condition k) — MEMORY_REDESIGN §12.5's
// instrument fix for Category C. Not a comparability boundary: no existing arm, prompt, question,
// truth or corpus moves, and a run without `legal` is byte-identical to 0.11.0.
//   arm k        — the production `survival` profile's shape as a bench arm: every X-ray read and the
//                  operator surface removed AT THE TOOL LEVEL (LEGAL_WORLD_TOOLS), `locate` answered
//                  from the provenance-filtered observation store (legalLocate), `bot_scan` as the
//                  deliberate look-around, `sense_entities` as the entity belief store. Memory
//                  surface is g's verbatim; only perception is the variable. Its own LEGAL_CORE
//                  prompt, because the standard CORE names X-ray tools this arm does not have.
//   why it fixes — 0.9.7's standing caveat is that C cannot isolate recall while the quiz session
//                  holds remote world reads (agents re-survey with describe_box instead of
//                  remembering). The corpus is still built by an X-ray explore pass under `g`, and
//                  the legal quiz's provenance-filtered locate structurally CANNOT re-survey it —
//                  so a correct answer must come through recall or fresh legal observation. That
//                  asymmetry is the measurement, not a leak.
//   guards       — assertWorldToolsLive/assertMemToolsLive cover k unchanged; harness.test pins the
//                  X-ray exclusions and the prompt's tool-honesty; the runner prints a per-arm
//                  X-RAY LEAKED warning if the quiz transcript contains an X-ray call at all.
//   NOTE         — a measurement run keeps its own pre-registration (§12.5): this bump ships the
//                  INSTRUMENT, not a result.
//   Also additive this release (score-neutral for every existing arm): nav verdicts carry the body's
//   traversal trail + the embodied tick/dimension envelope, captured as the reserved
//   `proprioception` provenance (SURVIVAL_MODE_PLAN §4). Capture-off runs are untouched; capture-on
//   arms gain store rows they could already have had from a raycast over the same cells.
export const BENCH_VERSION = "0.12.0";
