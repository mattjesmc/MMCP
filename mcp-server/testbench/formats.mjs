// Category B — the serialization-format arm: identical questions over identical block data, served
// three ways. This is the head-to-head the literature lacks (research open question 1); a null
// result at frontier scale is a cheap, useful close.
//
// The patch and every answer are derived from the seeded arena (arena.mjs). They used to be
// literals — "minecraft:red_concrete", 8, 72, [4,4], and a "diagonal" that was the answer on every
// run — which meant Cat B, like Cat A, could not be resampled and its pattern question could be
// answered without reading the grid.

/** The patch data straight from the arena spec (staging wrote exactly this). */
export function patchData(arena) {
  const o = arena.origin, p = arena.patch;
  const cells = [];
  for (let row = 0; row < p.size; row++) {
    for (let col = 0; col < p.size; col++) {
      cells.push({
        x: o.x + p.xMin + col, y: o.y, z: o.z + p.zMin + row,
        col, row, block: p.blockAt(col, row),
      });
    }
  }
  return cells;
}

const header = (arena, name) => {
  const o = arena.origin, p = arena.patch;
  return `A flat ${p.size}x${p.size} square of blocks on the floor (all at the same y). ` +
    `Columns are numbered col = x - ${o.x + p.xMin}, rows are row = z - ${o.z + p.zMin} ` +
    `(both 0-indexed, so the square spans col 0..${p.size - 1}, row 0..${p.size - 1}). ` +
    `The data below is in the "${name}" format.\n`;
};

export const FORMATS = {
  // Plain coordinate objects — the verbose baseline.
  json_coords(cells, arena) {
    return header(arena, "json_coords") + JSON.stringify(
      cells.map(({ x, y, z, block }) => ({ x, y, z, block })));
  },
  // The toolkit's native get_blocks_at shape: shared palette + [x,y,z,paletteIndex] rows.
  palette_rows(cells, arena) {
    const palette = [...new Set(cells.map((c) => c.block))];
    return header(arena, "palette_rows") + JSON.stringify({
      palette,
      blocks: cells.map((c) => [c.x, c.y, c.z, palette.indexOf(c.block)]),
    });
  },
  // A drawn grid with a legend — the "picture" serialization.
  ascii_grid(cells, arena) {
    const size = arena.patch.size;
    const legend = new Map();
    const letters = ["W", "R", "C", "B", "G", "Y", "M", "K"];
    for (const c of cells) {
      if (!legend.has(c.block)) legend.set(c.block, letters[legend.size]);
    }
    const grid = [];
    for (let row = 0; row < size; row++) {
      let line = "";
      for (let col = 0; col < size; col++) {
        line += legend.get(cells.find((c) => c.col === col && c.row === row).block);
      }
      grid.push(line);
    }
    const legendLines = [...legend].map(([block, ch]) => `${ch} = ${block}`).join("\n");
    return header(arena, "ascii_grid")
      + `Legend:\n${legendLines}\n\nGrid (each line is one row, row 0 first; character position in the line is the col):\n`
      + grid.join("\n");
  },
};

export function generateCatB(arena) {
  const p = arena.patch;
  const cells = patchData(arena);
  const c = Math.floor(p.size / 2);
  const at = (col, row) => p.blockAt(col, row);
  const count = (block) => cells.filter((x) => x.block === block).length;
  const markBlock = `minecraft:${p.mark}_concrete`;
  const fieldBlock = `minecraft:${p.field}_concrete`;
  const centreBlock = `minecraft:${p.centre}_concrete`;
  // A cell that is marked but is not the centre — the b1 probe. Guaranteed to exist: every shape
  // marks at least 8 non-centre cells.
  const probe = cells.find((x) => x.block === markBlock);

  return [
    {
      id: "b1", answer_type: "block_id", truth: at(probe.col, probe.row),
      question: `What block is at col ${probe.col}, row ${probe.row}?`,
    },
    {
      id: "b2", answer_type: "block_id", truth: centreBlock,
      question: `What block is at col ${c}, row ${c}?`,
    },
    {
      id: "b3", answer_type: "numeric", tolerance: 0, truth: count(markBlock),
      question: `How many ${markBlock} blocks are in the square?`,
    },
    {
      id: "b4", answer_type: "enum",
      options: ["diagonal", "row", "column", "cross", "ring"], truth: p.shape,
      question: `What geometric pattern do the ${p.mark}_concrete blocks form across the square?`,
    },
    {
      id: "b5", answer_type: "numeric", tolerance: 0, truth: count(fieldBlock),
      question: `How many ${fieldBlock} blocks are in the square?`,
    },
    {
      id: "b6", answer_type: "pair", truth: [c, c],
      question: `At which (col, row) is the ${p.centre}_concrete block?`,
    },
  ];
}
