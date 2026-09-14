// The change feed (HOST_DESIGN.md section 4.5): every edit, by whom, and what became of it.
//
// One shape, three readers. The cockpit reads it as SSE on `GET /changes`; a CLI or a probe reads
// the ring as JSON on the same route; the agent reads the same rows as `edit` events in
// `get_events`, which the watcher writes through `record_edit` after it emits here. This is the
// daemon's own copy, so an edit made while the game was down is still on the record - the game's
// event log is the game's, and it was not there to be told.

const CAP = 500;

export class ChangeFeed {
  constructor({ cap = CAP } = {}) {
    this.cap = cap;
    this.events = [];
    this.nextId = 1;
    this.subscribers = new Set(); // {res, project}
  }

  /** Append; the event gets its id and time here. Returns the stored row. */
  emit(event) {
    const row = { id: this.nextId++, at: new Date().toISOString(), type: "edit", ...event };
    this.events.push(row);
    while (this.events.length > this.cap) this.events.shift();
    for (const s of this.subscribers) {
      if (s.project && s.project !== row.project) continue;
      try { s.res.write(`id: ${row.id}\nevent: edit\ndata: ${JSON.stringify(row)}\n\n`); } catch { /* the close handler drops it */ }
    }
    return row;
  }

  /** Rows with id > since (all when since is null), newest last; capped. */
  since(since, { project = null, limit = 100 } = {}) {
    let rows = this.events;
    if (since != null) rows = rows.filter((r) => r.id > since);
    if (project) rows = rows.filter((r) => r.project === project);
    return rows.slice(-limit);
  }

  get cursor() {
    return this.nextId - 1;
  }

  /** Hold an SSE response: replay from `since` first, then everything that follows. */
  subscribe(res, { project = null, since = null } = {}) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`: mmcpd change feed${project ? ` for ${project}` : ""}\n\n`);
    for (const row of this.since(since, { project, limit: this.cap })) {
      res.write(`id: ${row.id}\nevent: edit\ndata: ${JSON.stringify(row)}\n\n`);
    }
    const sub = { res, project };
    this.subscribers.add(sub);
    // A comment line every 25 s keeps a proxy or an idle socket from closing the stream.
    const keep = setInterval(() => { try { res.write(": keep-alive\n\n"); } catch { /* closing */ } }, 25_000);
    keep.unref();
    res.on("close", () => { this.subscribers.delete(sub); clearInterval(keep); });
  }
}
