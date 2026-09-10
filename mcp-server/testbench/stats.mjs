// Small, exact statistics for the bench report (FREEZE_PLAN Workstream A3). Kept dependency-free and
// unit-tested (stats.test.mjs) because the papers' falsification thresholds ride on these numbers:
//   - Wilson score interval for a binomial proportion (boolean cells: correct-or-not).
//   - Normal-approximation CI for a graded mean (fractional success: coverage, fidelity, deepest/total).
//   - Exact two-sided sign test (McNemar) for a PAIRED arm delta over shared instances — with/without
//     is naturally paired per (id, seed, rep); only discordant pairs carry signal.

const Z95 = 1.959963984540054; // two-sided 95%

/** Wilson score interval for k successes in n Bernoulli trials → {lo, hi, p} in [0,1]. */
export function wilson(k, n, z = Z95) {
  if (n === 0) return { lo: 0, hi: 1, p: 0 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half), p };
}

/** Normal-approximation CI for the mean of graded values in [0,1] → {lo, hi, p=mean}. Falls back to
 *  a point interval when n<2 (no variance estimate). Used for cells whose success is fractional. */
export function normalCI(values, z = Z95) {
  const n = values.length;
  if (n === 0) return { lo: 0, hi: 1, p: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { lo: Math.max(0, mean), hi: Math.min(1, mean), p: mean };
  const varc = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(varc / n);
  return { lo: Math.max(0, mean - z * se), hi: Math.min(1, mean + z * se), p: mean };
}

// ---- exact binomial pmf/cdf (log-space, stable for the small n the bench produces) --------------
function logGamma(x) { // Lanczos
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
const logChoose = (n, k) => logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
const binomPmf = (k, n, p) => Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));

/** Exact two-sided p-value for k successes in n trials under H0: p=p0 (default 0.5). Small-p method:
 *  sum of all outcomes no more probable than the observed one. */
export function binomTwoSided(k, n, p0 = 0.5) {
  if (n === 0) return 1;
  const obs = binomPmf(k, n, p0);
  const eps = obs * (1 + 1e-9);
  let sum = 0;
  for (let i = 0; i <= n; i++) if (binomPmf(i, n, p0) <= eps) sum += binomPmf(i, n, p0);
  return Math.min(1, sum);
}

/** Paired sign test (McNemar) for two arms over matched instances. `pairs` = [{a, b}] of 0/1 (or
 *  fractional, thresholded at >0.5) outcomes. Returns discordant counts, the success delta, and the
 *  exact two-sided p over discordant pairs. */
export function pairedSignTest(pairs) {
  let aWin = 0, bWin = 0, nA = 0, nB = 0, sumA = 0, sumB = 0;
  for (const { a, b } of pairs) {
    sumA += a; sumB += b; nA++; nB++;
    const wa = a > 0.5, wb = b > 0.5;
    if (wa && !wb) aWin++;
    else if (wb && !wa) bWin++;
  }
  const disc = aWin + bWin;
  const p = binomTwoSided(aWin, disc, 0.5);
  return {
    n: pairs.length, discordant: disc, aWin, bWin,
    meanA: nA ? sumA / nA : 0, meanB: nB ? sumB / nB : 0,
    delta: (nA ? sumA / nA : 0) - (nB ? sumB / nB : 0), p,
  };
}

/** Format a proportion CI as "72% [58–83]". */
export const fmtCI = (ci) => `${Math.round(ci.p * 100)}% [${Math.round(ci.lo * 100)}–${Math.round(ci.hi * 100)}]`;
