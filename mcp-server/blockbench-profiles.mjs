// WHICH PROFILES SERVE THE BLOCKBENCH UPSTREAM - the one profile fact two processes need.
//
// index.mjs decides, per session, whether the second upstream is fetched, routed and polled at all
// (see BLOCKBENCH_PROFILES there, and the rule CLIENT_SURFACE and EXTENSION_SURFACE follow). The
// daemon (daemon.mjs) needs the same answer BEFORE a session exists, to know whether the session it
// is about to spawn will ever want a Blockbench instance of its own - and index.mjs is an executable
// whose import has side effects, so the set lives here and both read it. A profile named nowhere
// in this file serves no modelling app, whichever process is asking.
//
//   standard/full/entity - the workbench roles. `entity` especially: staging an entity preview and
//                          authoring its model are the same afternoon.
//   art                  - the model-authoring keep-list.
//   play/survey/survival - nothing. A body does not open a modelling app.
//   authoring/rocketeer_authoring - nothing. Those are BLOCK-authoring surfaces; a mesh editor
//                          would undo the 72% they exist to save.
//   modding              - nothing, and this is a DELIBERATE break from `standard`, the default it
//                          replaced. `art` is what a modelling session is for, and it is one
//                          `tool_surface` call away.
//   screens/inspect      - nothing. A UI session drives the game's widgets, not another app's; a
//                          read-only inspector must not hold an editor.
export const BLOCKBENCH_PROFILES = new Set(["full", "standard", "entity", "art"]);

/**
 * Does a profile serve Blockbench? `project` answers as its BASE: which upstreams exist is the
 * base's decision, which names are kept is the keep-list's (index.mjs, servesBlockbench).
 */
export function servesBlockbenchProfile(profile, projectBase = null) {
  return BLOCKBENCH_PROFILES.has(profile === "project" ? projectBase : profile);
}
