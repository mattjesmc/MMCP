// query_class — what a class ACTUALLY is in this JVM (RELEASE_1.md §D5), live.
//
// The tool exists because a decompiled tree answers from SOURCE and a running game answers from the
// class table, so every case here asks something source cannot answer: did this mixin merge, which
// file did this class come from, would hotswap_class' default work on it. The subjects are the
// toolkit's own classes and the vanilla classes the toolkit mixes into, so the file needs no
// fixtures and stages nothing.
//
// No world geometry, no site, no global resource: every call is a read of the JVM's own tables.

import { test, before } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
async function call(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
const ok = (r, what) => {
  assert.equal(r.ok, true, `${what}: ${r.error ?? JSON.stringify(r)}`);
  return r.result;
};

const SERVER = "net.minecraft.server.MinecraftServer";
const OWN = "com.mattmc.mcptoolkit.McpToolkit";

before(async () => {
  const res = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!res?.ok) throw new Error("no bridge — start the dev server (gradlew runServer) first");
});

test("a mixin that merged into a vanilla class is visible ON the vanilla class", async () => {
  // MinecraftServerMixin is what fires END_SERVER_TICK, and it is applied in every run this probe
  // can be in — the bridge answering at all is the proof it ran. Source cannot tell you this: it
  // says a @Mixin was WRITTEN, not that it took.
  const r = ok(await call("query_class", { class: SERVER }), "query MinecraftServer");
  assert.equal(r.loaded, true, "the server class is loaded on a running server");
  assert.ok(r.mixins.count > 0, `no merged mixins found on ${SERVER}: ${JSON.stringify(r.mixins)}`);
  const ours = r.mixins.applied.find((m) => /mcptoolkit/i.test(m.mixin));
  assert.ok(ours, `the toolkit's own mixin is not among ${JSON.stringify(r.mixins.applied)}`);
  assert.ok(ours.methods.length > 0, "a merged mixin brought no methods, which is not how it merged");
  assert.equal(typeof r.mixins.detection, "string", "the detection mechanism must be named");
});

test("the method table is the POST-transform one, and the merged methods are marked in it", async () => {
  const r = ok(await call("query_class", { class: SERVER, contains: "mcptoolkit", limit: 50 }),
    "filtered table");
  assert.ok(r.methods.count > 0, "a mixin's handler methods carry its prefix and must be findable");
  assert.ok(r.methods.shown.every((m) => /mcptoolkit/i.test(m.name)), "the filter must filter");
  assert.ok(r.methods.shown.some((m) => m.mixin), "a merged method must name the mixin it came from");
});

test("a class the toolkit owns reports where on disk it came from, and hotswap's verdict on it", async () => {
  const r = ok(await call("query_class", { class: OWN }), "query own class");
  assert.equal(r.kind, "class");
  assert.ok(r.source, "a mod class has a code source");
  assert.equal(typeof r.hotswap.classpath_default, "boolean",
    "the hotswap precheck is the pairing; it must always be answered");
  // Its own class is not a mixin target and not a vanilla class, so it is the safe case.
  assert.equal(r.hotswap.safe, true, `${OWN} should be hotswap-safe: ${JSON.stringify(r.hotswap)}`);
});

test("hotswap is refused-by-report on a mixed class, BEFORE the call rather than after it", async () => {
  const r = ok(await call("query_class", { class: SERVER }), "query MinecraftServer");
  assert.equal(r.hotswap.safe, false,
    "a class carrying merged mixin methods must not be reported as safe to redefine");
  assert.match(r.hotswap.safety_note, /transform/, `the note must say why: ${r.hotswap.safety_note}`);
});

test("counts are exact even when the listing is truncated", async () => {
  const small = ok(await call("query_class", { class: SERVER, limit: 3 }), "limit 3");
  assert.equal(small.methods.shown.length, 3, "the limit limits");
  assert.ok(small.methods.count > 3, "MinecraftServer has more than three methods");
  assert.equal(small.methods.truncated, small.methods.count - 3,
    "truncated + shown must account for every member, or the count is decoration");
});

test("field types are the JVM's, and a generic one carries both", async () => {
  const r = ok(await call("query_class", { class: SERVER, contains: "level", limit: 50 }), "fields");
  assert.ok(r.fields.count > 0, `no matching fields: ${JSON.stringify(r.fields)}`);
  for (const f of r.fields.shown) {
    assert.ok(f.type, `a field with no type: ${JSON.stringify(f)}`);
    assert.ok(!f.generic || f.generic !== f.type, "generic is only reported when it ADDS something");
  }
});

test("inherited:true reaches up the chain and says who declared what", async () => {
  const own = ok(await call("query_class", { class: OWN, inherited: false }), "declared");
  const all = ok(await call("query_class", { class: OWN, inherited: true, limit: 200 }), "inherited");
  assert.ok(all.methods.count > own.methods.count,
    "every class inherits from Object, so the inherited table must be larger");
  assert.ok(all.methods.shown.some((m) => m.declared_by),
    "an inherited member must name the class that declared it");
});

test("a class that does not exist anywhere is refused, not answered emptily", async () => {
  const r = await call("query_class", { class: "com.example.no.Such$Class" });
  assert.equal(r.ok, false, "an unknown class must be refused");
  assert.match(r.error, /no such class|not loaded/, `unhelpful refusal: ${r.error}`);
});

test("the reply says HOW it looked the class up, because the two ways differ", async () => {
  const r = ok(await call("query_class", { class: OWN }), "lookup");
  assert.ok(["loaded_class_list", "class_forname"].includes(r.lookup),
    `unknown lookup mechanism: ${r.lookup}`);
  if (r.lookup === "class_forname") {
    assert.ok(r.lookup_note,
      "the Class.forName path can LOAD the class it was asked about, and must say so");
  }
});

test("an argument query_class does not have is refused, not dropped", async () => {
  const r = await call("query_class", { class: OWN, methods: true });
  assert.equal(r.ok, false, "unknown argument must be refused (ArgCheck)");
  assert.match(r.error, /methods/, `the refusal should name the argument: ${r.error}`);
});
