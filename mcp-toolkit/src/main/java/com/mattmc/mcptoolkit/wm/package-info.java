/**
 * The world-model recorder, referee and policy seam — an <b>experimental research subsystem</b>, off
 * by default, and the toolkit-side half of a project that lives in its own repository.
 *
 * <h2>Where the other half is</h2>
 *
 * <p>The design documents this package's javadoc cites — {@code DESIGN.md}, {@code V3_PLAN.md},
 * {@code HUMAN_RIG_PLAN.md}, {@code wmserve/PROTOCOL.md} — belong to the <b>world-model project</b>,
 * which is a separate repository and is deliberately not part of this one. So are the Python
 * packages that consume what this writes ({@code wmloader}, {@code wmnav}, {@code wmserve}), the
 * recorded corpus, and the trained checkpoints. Nothing in that project ships in the toolkit's
 * artifacts, and none of it needs to exist for this package to compile, run or stay silent.
 *
 * <p>Citations here name the file, not a path into this repository, because there is no such path.
 *
 * <h2>What ships, and what it does when nobody asks for it</h2>
 *
 * <p>These classes are compiled into the toolkit jar, because the taps they hang off — the fan walk
 * in {@code Sightlines}, the input-frame sinks in the drone/nav layer, the intent chokepoint in
 * {@code BridgeServer}, the policy seam in {@code NavDriver} — are in the toolkit's own hot paths.
 * Every one of them costs a null check and nothing more while recording is off, which is the
 * default: {@link WmConfig} reads {@code wm.record} from {@code config/mcptoolkit.properties} and
 * defaults it to {@code false}. With it off there is no session directory, no thread, no socket, no
 * row and no file.
 *
 * <p>The tools this package serves ({@code wm_session_tag}, {@code wm_perturb}, {@code wm_verdict},
 * {@code wm_obsgap}, {@code human_task}, {@code human_task_cancel}) are research-harness surface and
 * are withheld from every dev and experimental tool profile the MCP server offers. They remain
 * visible in {@code full} and {@code standard}, which are bench arms pinned by measurement rather
 * than roles a modder is given.
 *
 * <h2>Human input capture</h2>
 *
 * <p>{@link WmHuman} and its client counterpart record a real player's input frame. Read that as the
 * capability it is: it is gated behind {@code wm.record} (which is off), it is refused outright on a
 * remote server — the client sends the frame only while on a local server — and it exists to teach a
 * navigation policy from demonstrations, in a world whose owner is the person being recorded.
 */
package com.mattmc.mcptoolkit.wm;
