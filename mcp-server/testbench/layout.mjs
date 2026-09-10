// The bench PLATFORM anchor — where the staged world lives. Nothing else.
//
// The arena itself (towers, channel, bridge, house, sealed box, pen, pool, anomaly, Cat B patch, and
// the scripted walk) used to be declared here as fixed constants, with Category A's answer key
// written out as matching literals in questions.mjs. That made the arena unseedable: it could not be
// resampled, could not be re-drawn if a question leaked, and could not be grown — so every Category A
// cell rested on n=2 over one memorizable world, in the category both papers use as the no-tools
// model-cognition baseline.
//
// It is now GENERATED per seed by arena.mjs, which derives every truth from the geometry it built.
// The constants that lived here are gone rather than left behind, so there is no second, stale arena
// definition for someone to edit expecting it to take effect.
//
// Only the platform anchor stays, because it is shared: Category T's staging pads (tasks.mjs) are
// placed relative to the same origin and must not collide with the arena.

// y=150: ABOVE the local terrain and its tree canopy (dark-forest tops reach y~122 here). At y=100
// the arena sat under the leaves — world_surface reads showed canopy, towers vanished from the
// transcript, and the anomaly cap filled with foliage before the marker. The platform must own its
// skyline.
export const ORIGIN = { x: 3_000_000, y: 150, z: 3_000_000 };

// The platform spans rel 0..SIZE-1 in x and z, with its floor at ORIGIN.y.
export const SIZE = 140;

/** Relative -> absolute. `rel.y` is an offset ABOVE the floor (0 = the floor itself). */
export const abs = (rel) => ({ x: ORIGIN.x + rel.x, y: ORIGIN.y + (rel.y ?? 0), z: ORIGIN.z + rel.z });
