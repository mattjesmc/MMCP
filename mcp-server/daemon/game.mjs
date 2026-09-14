// The daemon's own line to a game (HOST_DESIGN.md section 4, section 12).
//
// The watcher lands edits in the running game WITH NO AGENT IN THE LOOP, so the daemon needs what
// every shim has: an identity at the game (`/hello`, then `X-MCPTK-Session` on every call, a
// heartbeat while it is in use) and a `/cmd` caller. One link per registered project, dialing the
// project's bridge port. It is best-effort in exactly the shim's way - a game that is down answers
// `{state: "down"}` to `ping()` and `call()` throws with the reason - and it re-introduces itself
// when the game it reaches is not the game it said hello to (the instance id changed: a restart),
// because the old id would be adopted as a nameless stranger by `Sessions.touch`.

/** How long a quick state read may take: `GET /projects` asks every registered game. */
export const PING_MS = 1_500;
const QUICK_MS = 5_000;
/** A liveness act may be a compile: the shim's own budget, which out-waits the bridge's per-tool caps. */
const CMD_MS = 390_000;
const HEARTBEAT_MS = 30_000;

/** A quick, attributed-to-nobody `ping` of a game: {state, info}. */
export async function gameState(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/cmd`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "ping", args: {} }), signal: AbortSignal.timeout(PING_MS),
    });
    const data = await res.json();
    const info = data?.result ?? null;
    if (!data?.ok || !info) return { state: "up", info };
    // `serverRunning` is ping's word for "a world is loaded" (the integrated server exists only then).
    return { state: info.serverRunning ? "world" : "up", info };
  } catch {
    return { state: "down", info: null };
  }
}

export class GameLink {
  /**
   * @param opts.port   the project's bridge port
   * @param opts.label  what the game's session table shows for the daemon (`mmcpd:<project>`)
   * @param opts.log    (line) => void
   */
  constructor({ port, label, log = () => {} }) {
    this.port = port;
    this.label = label;
    this.log = log;
    this.base = `http://127.0.0.1:${port}`;
    this.session = null; // the id the game minted for us
    this.instance = null; // the game instance that minted it
    this.helloInFlight = null;
    this.beat = null;
  }

  /** The game as it is right now. Also notices a restart and forgets the old identity. */
  async ping() {
    const r = await gameState(this.port);
    const id = r.info?.instanceId ?? null;
    if (r.state !== "down" && id && this.instance && id !== this.instance) {
      this.log(`game on :${this.port} restarted (instance ${this.instance} -> ${id}); saying hello again`);
      this.session = null;
      this.instance = null;
    }
    return r;
  }

  headers() {
    return this.session ? { "X-MCPTK-Session": this.session } : {};
  }

  /** Introduce the daemon to the game, once per game instance. Never throws. */
  async hello() {
    if (this.session) return;
    this.helloInFlight ??= (async () => {
      const res = await fetch(`${this.base}/hello`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: this.label, kind: "external", client: "mmcpd" }),
        signal: AbortSignal.timeout(QUICK_MS),
      });
      const data = await res.json();
      if (data?.ok && data.session) {
        this.session = data.session;
        const state = await gameState(this.port);
        this.instance = state.info?.instanceId ?? null;
        this.log(`hello to :${this.port} as ${this.session} (instance ${this.instance ?? "?"})`);
        this.startBeat();
      }
    })().catch((e) => this.log(`hello to :${this.port} failed: ${e.message}`)).finally(() => { this.helloInFlight = null; });
    await this.helloInFlight;
  }

  startBeat() {
    if (this.beat) return;
    this.beat = setInterval(() => {
      if (!this.session) return;
      fetch(`${this.base}/heartbeat`, { method: "POST", headers: this.headers(), signal: AbortSignal.timeout(QUICK_MS) })
        .catch(() => {});
    }, HEARTBEAT_MS);
    this.beat.unref();
  }

  /**
   * One tool call, as the shim makes it: the bridge's own {ok, result | error} envelope, or a
   * throw naming why the game could not be reached at all.
   */
  async call(tool, args = {}, { timeoutMs = CMD_MS } = {}) {
    await this.hello();
    let res;
    try {
      res = await fetch(`${this.base}/cmd`, {
        method: "POST", headers: { "Content-Type": "application/json", ...this.headers() },
        body: JSON.stringify({ tool, args }), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e.name === "TimeoutError" || e.name === "AbortError") throw new Error(`${tool}: no answer from the game on :${this.port} within ${timeoutMs / 1000}s`);
      throw new Error(`${tool}: game on :${this.port} unreachable (${e.cause?.code ?? e.message})`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${tool}: HTTP ${res.status}${body ? ` ${body.slice(0, 200)}` : ""}`);
    }
    return res.json();
  }

  close() {
    clearInterval(this.beat);
    this.beat = null;
  }
}
