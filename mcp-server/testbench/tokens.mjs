// Shared token accounting for the bench summaries. Every summary reports tokens BOTH ways:
//   noCache  = fresh input + output          (what the model "thought about" — the old summaries)
//   withCache = + cache read + cache write    (real throughput; cache read is the context re-read
//                                              every turn and dominates multi-turn totals ~50x)
// Records normalize to tokens_in/out/cache_read/cache_write; raw SDK usage objects use the long
// names — this reads either.
export function tokFields(r = {}) {
  return {
    i: r.tokens_in ?? r.input_tokens ?? 0,
    o: r.tokens_out ?? r.output_tokens ?? 0,
    cr: r.cache_read ?? r.cache_read_input_tokens ?? 0,
    cw: r.cache_write ?? r.cache_creation_input_tokens ?? 0,
  };
}
export function accTok(acc, r) {
  const t = tokFields(r);
  acc.i += t.i; acc.o += t.o; acc.cr += t.cr; acc.cw += t.cw;
  return acc;
}
export const zeroTok = () => ({ i: 0, o: 0, cr: 0, cw: 0 });
export const noCache = (a) => a.i + a.o;
export const withCache = (a) => a.i + a.o + a.cr + a.cw;
export const ktok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : Math.round(n / 1000) + "k");
/** "12k/1.20M" — the standard both-ways cell. */
export const bothTok = (a) => `${ktok(noCache(a))}/${ktok(withCache(a))}`;
