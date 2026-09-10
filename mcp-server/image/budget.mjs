// The image budget (LOOP_KIT_DESIGN.md §5.1): every picture the shim hands the model is cropped to
// its content, then resized to a longest edge, and priced on the reply.
//
// WHY THIS IS THE FIRST PIECE OF THE LOOP KIT. A picture is billed by AREA (about width*height/750
// tokens) and, unlike a tool's text, it is re-sent on every later turn for the life of the session.
// ArmorPieces measured it on nine skin sessions: 5-15 looks outweighed every text reply put
// together, and one Blockbench viewport at 1020x946 was ~1290 tokens with the figure filling 28%
// of it. Cropping to the figure BEFORE resizing took that look to 221x384, ~113 tokens, 100% figure —
// more resolution on the thing being judged, at a twelfth of the price. Our own `screenshot` returns
// the native framebuffer of a 3840x2131 dev window, which the API itself downsamples to ~1.8k tokens
// and which is still ten times a cropped figure.
//
// Nothing here costs a manifest entry (the per-turn tax, TOKEN_PER_TOOL_FINDINGS.md), which is why
// it comes first: it is free to every profile and it is the largest generic saving in the record.
//
// The knobs: MCPTK_SHOT_MAX (longest edge, default 384, 0 keeps every picture whole — the bytes
// pass through untouched and only the cost line is added) and, per call, `max` and `crop` on
// `screenshot` (index.mjs adds them to that tool's schema and strips them before the bridge sees
// them, because ArgCheck refuses arguments a ToolDef never declared).
//
// THE CONTENT CROP IS FOR FRAMES ONLY. A frame (screenshot, render, a Blockbench viewport) is a
// view of a scene: where the figure sits in it carries nothing, so cropping to the figure loses
// nothing. A texture sheet is the opposite - its pixel (x, y) is the address the next paint call
// names - and the first live run (2026-09-06) cropped a 16x16 `get_texture` to 12x12, which would
// have moved every texel an agent read off it. So `findContent` is the caller's decision per tool
// (index.mjs CONTENT_CROP); a picture that is not a frame is resized at most, never cropped, and
// a resize keeps coordinates proportional, which the cost line's "was WxH" lets a reader undo.

import { decodePng, encodePng, isPng } from "./png.mjs";

/**
 * Longest edge after the budget. 0 = off. Read once; a session's budget is a launch property.
 *
 * 384, not 512, since 0.124.0: 384 is the edge ArmorPieces measured and settled on, and every
 * figure in LOOP_KIT_DESIGN.md section 1 was taken at it. The kit shipped at 512 and the falsifier
 * (section 11, finding 9) priced the difference on a Blockbench viewport: ~324 tokens a look
 * against ~182, paid again on every later turn. A session that wants the larger picture says so.
 */
export const DEFAULT_SHOT_MAX = 384;
export const SHOT_MAX = (() => {
  const raw = (process.env.MCPTK_SHOT_MAX ?? "").trim();
  if (raw === "") return DEFAULT_SHOT_MAX;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_SHOT_MAX;
})();

const TOKENS_PER_PX = 750;
// The API's own ceiling: anything over ~1568 px on the long edge (or ~1.15 MP) is shrunk server-side
// before it is priced. So a 4K frame does NOT cost 11k tokens — it costs what its downscaled self
// does, and that is the honest "was" figure. Any picture UNDER the ceiling costs its full area.
const API_MAX_EDGE = 1568;
const API_MAX_PIXELS = 1_150_000;
// Breathing room around the content box, so nothing sits on the frame. Source pixels.
const MARGIN = 4;
// A pixel counts as content when it differs from the corner colour by more than this (sum of the
// absolute RGB differences). shrink_shot.py's threshold, kept: a Blockbench theme's ground and a
// Minecraft sky are both flat enough that 24 separates figure from ground.
const GROUND_THRESHOLD = 24;

/** What the API charges for a picture of this size, after its own downscale. */
export function apiTokens(width, height) {
  let w = width, h = height;
  const edge = Math.max(w, h);
  if (edge > API_MAX_EDGE) { const s = API_MAX_EDGE / edge; w *= s; h *= s; }
  if (w * h > API_MAX_PIXELS) { const s = Math.sqrt(API_MAX_PIXELS / (w * h)); w *= s; h *= s; }
  return Math.round((w * h) / TOKENS_PER_PX);
}

/**
 * The content's own rectangle, [x0, y0, x1, y1) exclusive: the alpha bounding box when the image has
 * transparency and the box is under 90% of the frame, else the box of pixels that differ from the
 * corner colour. Null when nothing differs (a flat frame — nothing to crop to).
 */
export function contentBox({ width, height, data }) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  let anyTransparent = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3];
      if (a === 0) { anyTransparent = true; continue; }
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (anyTransparent && x1 >= 0 && (x1 - x0 + 1) * (y1 - y0 + 1) < width * height * 0.9) {
    return [x0, y0, x1 + 1, y1 + 1];
  }
  const gr = data[0], gg = data[1], gb = data[2];
  x0 = width; y0 = height; x1 = -1; y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const d = Math.abs(data[o] - gr) + Math.abs(data[o + 1] - gg) + Math.abs(data[o + 2] - gb);
      if (d <= GROUND_THRESHOLD) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 >= 0 ? [x0, y0, x1 + 1, y1 + 1] : null;
}

/** Crop RGBA8 to [x0, y0, x1, y1), clamped to the frame. */
export function crop(img, [x0, y0, x1, y1]) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(img.width, Math.ceil(x1)); y1 = Math.min(img.height, Math.ceil(y1));
  const width = Math.max(1, x1 - x0), height = Math.max(1, y1 - y0);
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    img.data.copy(data, y * width * 4, ((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + width) * 4);
  }
  return { width, height, data };
}

/**
 * Downscale RGBA8 by area averaging: every output pixel is the mean of the source rectangle it
 * covers, fractional edges weighted. Box filtering is the right filter for a REDUCTION (Lanczos
 * only earns its ringing when enlarging or when the ratio is near 1), and it never invents a colour
 * that was not there, which matters for a picture someone reads a value band off.
 */
export function resize(img, width, height) {
  if (width === img.width && height === img.height) return img;
  const out = Buffer.alloc(width * height * 4);
  const sx = img.width / width, sy = img.height / height;
  for (let oy = 0; oy < height; oy++) {
    const y0 = oy * sy, y1 = (oy + 1) * sy;
    for (let ox = 0; ox < width; ox++) {
      const x0 = ox * sx, x1 = (ox + 1) * sx;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let y = Math.floor(y0); y < Math.min(img.height, Math.ceil(y1)); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (wy <= 0) continue;
        for (let x = Math.floor(x0); x < Math.min(img.width, Math.ceil(x1)); x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const o = (y * img.width + x) * 4;
          r += img.data[o] * w; g += img.data[o + 1] * w; b += img.data[o + 2] * w; a += img.data[o + 3] * w;
          wsum += w;
        }
      }
      const o = (oy * width + ox) * 4;
      out[o] = Math.round(r / wsum); out[o + 1] = Math.round(g / wsum);
      out[o + 2] = Math.round(b / wsum); out[o + 3] = Math.round(a / wsum);
    }
  }
  return { width, height, data: out };
}

/**
 * The whole budget over one PNG buffer. Returns `{ png, before, cropped, after, filled, was, now,
 * changed }` — the picture, its sizes at each stage, the fraction of the frame the content filled,
 * and the token price before and after. `max` 0 keeps the bytes untouched (`changed:false`) and still
 * prices them. `rect` is an explicit crop in source pixels ([x0,y0,x1,y1)); when given, the content
 * search is skipped — explicit is explicit.
 *
 * Never throws: an image the codec cannot read (interlaced, exotic) comes back untouched with
 * `error` naming why, so the reply can say "not shrunk: …" instead of losing the picture.
 */
export function shrinkPng(buf, { max = SHOT_MAX, rect = null, margin = MARGIN, findContent = true } = {}) {
  const base = { png: buf, changed: false };
  if (!isPng(buf)) return { ...base, error: "not a PNG" };
  let img;
  try {
    img = decodePng(buf);
  } catch (e) {
    const size = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    return { ...base, before: size, after: size, was: apiTokens(size.width, size.height),
      now: apiTokens(size.width, size.height), error: e.message };
  }
  const before = { width: img.width, height: img.height };
  const was = apiTokens(img.width, img.height);
  if (!max) return { ...base, before, cropped: before, after: before, filled: 1, was, now: was };

  let box = rect ?? (findContent ? contentBox(img) : null);
  if (box && !rect) {
    box = [box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin];
  }
  let out = box ? crop(img, box) : img;
  const cropped = { width: out.width, height: out.height };
  const filled = (out.width * out.height) / (img.width * img.height);
  const edge = Math.max(out.width, out.height);
  if (edge > max) {
    const s = max / edge;
    out = resize(out, Math.max(1, Math.round(out.width * s)), Math.max(1, Math.round(out.height * s)));
  }
  const after = { width: out.width, height: out.height };
  const now = apiTokens(out.width, out.height);
  // A budget that made nothing smaller changes no bytes: a re-encode is not free (it is a different
  // file) and it bought nothing.
  if (after.width === before.width && after.height === before.height) {
    return { ...base, before, cropped, after, filled, was, now };
  }
  return { png: encodePng(out), changed: true, before, cropped, after, filled, was, now };
}

/** The line that rides the reply. The model can only plan a budget it can see the price of. */
export function costLine(r) {
  if (r.error) {
    return `picture ${r.before?.width ?? "?"}x${r.before?.height ?? "?"} ~${r.was ?? "?"} tok, not shrunk (${r.error}); re-sent every turn after this one`;
  }
  const size = `${r.after.width}x${r.after.height}`;
  if (!r.changed) {
    return `picture ${size} ~${r.now} tok; re-sent every turn after this one`;
  }
  const filled = r.filled < 0.999 ? `, content was ${Math.round(r.filled * 100)}% of the frame` : "";
  return `picture ${size} ~${r.now} tok (was ${r.before.width}x${r.before.height} ~${r.was} tok${filled}); re-sent every turn after this one`;
}

/**
 * Apply the budget to an MCP content array: every image part is shrunk and one cost line per
 * picture is appended to the text part (created when there is none). The array comes back new; the
 * parts that were not images are the same objects.
 *
 * `opts.max` and `opts.rect` are per-call overrides; `opts.rectFor(index)` can name a rectangle per
 * image when a reply carries several. `opts.findContent` (default true) is the content crop; false
 * for a picture whose pixels are addresses (a texture sheet). Non-PNG images (a JPEG from some upstream) are priced from
 * nothing and passed through — the codec is PNG-only and says so on the line.
 */
export function budgetContent(content, opts = {}) {
  if (!Array.isArray(content)) return content;
  const out = [];
  const lines = [];
  let imageIndex = 0;
  for (const part of content) {
    if (part?.type !== "image" || typeof part.data !== "string") { out.push(part); continue; }
    const i = imageIndex++;
    if (part.mimeType && part.mimeType !== "image/png") {
      out.push(part);
      lines.push(`picture (${part.mimeType}) not shrunk: the budget reads PNG only; re-sent every turn after this one`);
      continue;
    }
    const buf = Buffer.from(part.data, "base64");
    const r = shrinkPng(buf, { max: opts.max, rect: opts.rectFor ? opts.rectFor(i) : opts.rect ?? null,
      findContent: opts.findContent ?? true });
    out.push(r.changed ? { ...part, data: r.png.toString("base64"), mimeType: "image/png" } : part);
    lines.push(costLine(r));
  }
  if (!lines.length) return content;
  const text = lines.join("\n");
  // Append to the LAST text part rather than a fresh one: one part fewer per reply, and the line
  // lands where the reader's eye already is. A reply that was only a picture gets its first text.
  const lastText = out.map((p, i) => [p, i]).reverse().find(([p]) => p?.type === "text");
  if (lastText) {
    const [p, i] = lastText;
    out[i] = { ...p, text: `${p.text}\n${text}` };
  } else {
    out.push({ type: "text", text });
  }
  return out;
}
