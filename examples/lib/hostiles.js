'use strict'

/**
 * Hostile mob handling for the planner.
 *
 * What the pathfinder had before was `entitiesToAvoid`: a set of mob names you had to fill in by
 * hand, which made only the cells inside each mob's own hitbox expensive, once, when a path was
 * planned. So a route could still brush right past a zombie, a creeper was treated exactly like a
 * chicken unless you had listed it, and a mob that walked into the path (or appeared after the path
 * was planned) changed nothing: the bot carried on toward it.
 *
 * This module is the part that needs no bot, world or registry data, so it can be tested on its own:
 *
 *   isHostile()               is this entity a hostile mob, from the registry, not from a list you keep
 *   profileFor()              how far to keep away from it and how much it costs to go near
 *   buildDangerField()        a cost field around the mobs: highest at the mob, fading with distance
 *   getDangerAt()             the field's cost for a step onto a cell
 *   snapshotHostiles()        where each mob was when a path was planned
 *   shouldReplanForHostiles() has one moved into the way, or appeared there, since
 *
 * Movements (lib/movements.js) and the executor (index.js) use them.
 */

/**
 * Hostile mobs by name, for versions whose registry does not say (and as a check on it). Neutral mobs
 * (wolves, iron golems, piglins, zombified piglins) are left out on purpose: they do nothing until
 * provoked, and steering around them all the time would make routes worse, not safer.
 */
const HOSTILE_NAMES = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'wither_skeleton',
  'creeper', 'spider', 'cave_spider', 'enderman', 'endermite', 'silverfish', 'witch', 'pillager',
  'vindicator', 'evoker', 'illusioner', 'ravager', 'vex', 'phantom', 'slime', 'magma_cube', 'blaze',
  'ghast', 'hoglin', 'zoglin', 'piglin_brute', 'guardian', 'elder_guardian', 'shulker', 'warden',
  'breeze', 'creaking', 'giant', 'wither', 'ender_dragon'
])

/** Keep this far from a mob (blocks), and pay this much at the mob itself (fading with distance). */
const DEFAULT_PROFILE = { radius: 3, cost: 20 }

const PROFILES = {
  // Explodes: the blast reaches about 3 blocks, and the fuse is short.
  creeper: { radius: 4, cost: 30 },
  ravager: { radius: 4, cost: 30 },
  warden: { radius: 8, cost: 60 },
  // Ranged: they do not need to come close, so a wider berth, at a lower price.
  skeleton: { radius: 5, cost: 12 },
  stray: { radius: 5, cost: 12 },
  bogged: { radius: 5, cost: 12 },
  pillager: { radius: 5, cost: 12 },
  witch: { radius: 5, cost: 12 },
  blaze: { radius: 5, cost: 12 },
  breeze: { radius: 5, cost: 12 },
  ghast: { radius: 6, cost: 10 },
  // Small and weak.
  silverfish: { radius: 2, cost: 8 },
  endermite: { radius: 2, cost: 8 }
}

// No single cell is worth more than this, however many mobs overlap on it: past it the planner should
// treat the cell as "no", and an unbounded sum would make every route through a crowd equally awful.
const CELL_CAP = 200

/**
 * @typedef {object} Hostile
 * @property {number} id
 * @property {string} name
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} radius
 * @property {number} cost
 */

/**
 * Is this entity a hostile mob? Asks the entity itself, then the registry, then the name list.
 * @param {{ name?: string, type?: string, kind?: string }} entity
 * @param {object} [context]
 * @param {{ entitiesByName?: Record<string, { type?: string, category?: string }> }} [context.registry]
 * @param {Set<string>} [context.extraNames] more names to treat as hostile
 * @param {Set<string>} [context.excludedNames] names never to treat as hostile
 * @param {Map<string, boolean>} [context.cache] name -> verdict from the registry and the list
 * @returns {boolean}
 */
function isHostile (entity, { registry, extraNames, excludedNames, cache } = {}) {
  const name = entity && entity.name
  if (!name) return false
  if (excludedNames && excludedNames.has(name)) return false
  if (extraNames && extraNames.has(name)) return true
  // Per entity: what mineflayer read from the registry when it spawned.
  if (entity.type === 'hostile' || entity.kind === 'Hostile mobs') return true

  if (cache && cache.has(name)) return cache.get(name)
  const byName = registry && registry.entitiesByName
  const def = byName ? byName[name] : null
  const verdict = !!(def && (def.type === 'hostile' || def.category === 'Hostile mobs')) || HOSTILE_NAMES.has(name)
  if (cache) cache.set(name, verdict)
  return verdict
}

/**
 * @param {string} name
 * @param {Record<string, { radius?: number, cost?: number }>} [overrides]
 * @returns {{ radius: number, cost: number }}
 */
function profileFor (name, overrides = {}) {
  return { ...DEFAULT_PROFILE, ...PROFILES[name], ...overrides[name] }
}

/**
 * A cost field around hostile mobs: the most at the mob, fading linearly to a little at `radius`, and
 * nothing beyond. Keyed by "x,y,z" of the cell a walker's feet would be in; a mob's danger is applied
 * to the cells from one below it to two above it, which are the feet levels it can reach.
 * @param {Hostile[]} mobs
 * @param {{ scale?: number }} [options] scale multiplies every cost
 * @returns {Record<string, number>}
 */
function buildDangerField (mobs, { scale = 1 } = {}) {
  const field = {}
  for (const mob of mobs) {
    const baseX = Math.floor(mob.x)
    const baseY = Math.floor(mob.y)
    const baseZ = Math.floor(mob.z)
    const reach = Math.ceil(mob.radius)
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dz = -reach; dz <= reach; dz++) {
        const distance = Math.hypot(baseX + dx + 0.5 - mob.x, baseZ + dz + 0.5 - mob.z)
        if (distance > mob.radius) continue
        const cost = mob.cost * scale * (1 - distance / (mob.radius + 1))
        for (let dy = -1; dy <= 2; dy++) {
          const key = `${baseX + dx},${baseY + dy},${baseZ + dz}`
          field[key] = Math.min(CELL_CAP, (field[key] ?? 0) + cost)
        }
      }
    }
  }
  return field
}

/**
 * What stepping onto the cell whose feet are at (x, y, z) costs, from hostile mobs: the worse of the
 * feet cell and the head cell.
 */
function getDangerAt (field, x, y, z) {
  return Math.max(field[`${x},${y},${z}`] ?? 0, field[`${x},${y + 1},${z}`] ?? 0)
}

/**
 * Remember where each mob was when a path was planned.
 * @param {Hostile[]} mobs
 * @returns {Map<number, { x: number, y: number, z: number }>}
 */
function snapshotHostiles (mobs) {
  return new Map(mobs.map(m => [m.id, { x: m.x, y: m.y, z: m.z }]))
}

/**
 * Has a hostile mob made the current path stale? A path was priced with every mob where it stood when
 * the path was planned. A mob that has since walked 1.5 blocks or more, or that was not there at all, is
 * not where the path assumed, and matters only if it is now close to the bot or to the steps still to
 * come: one across the room is not worth a new search.
 *
 * @param {object} args
 * @param {Map<number, { x: number, y: number, z: number }>} args.planned
 * @param {Hostile[]} args.current
 * @param {{ x: number, y: number, z: number }[]} args.path the remaining steps, in order
 * @param {{ x: number, y: number, z: number }} args.botPosition
 * @param {number} [args.moveThreshold] blocks a mob must have moved to count
 * @param {number} [args.lookahead] how many of the next steps to look at
 * @param {number} args.msSinceReplan
 * @param {number} [args.cooldown] ms between replans, so a chasing mob does not cause one per tick
 * @returns {{ replan: boolean, reason?: string, id?: number, name?: string, distance?: number, moved?: number }}
 */
function shouldReplanForHostiles ({ planned, current, path, botPosition, moveThreshold = 1.5, lookahead = 12, msSinceReplan, cooldown = 1000 }) {
  if (msSinceReplan < cooldown) return { replan: false }
  const steps = path.slice(0, lookahead)

  for (const mob of current) {
    const threat = mob.radius + 1.5
    // Only things on about the same floor as the mob count: one a storey below is not in its way.
    let distance = Infinity
    if (Math.abs(botPosition.y - mob.y) <= 3) distance = Math.hypot(mob.x - botPosition.x, mob.z - botPosition.z)
    for (const step of steps) {
      if (Math.abs(step.y - mob.y) > 3) continue
      distance = Math.min(distance, Math.hypot(mob.x - (step.x + 0.5), mob.z - (step.z + 0.5)))
    }
    if (distance > threat) continue

    const before = planned.get(mob.id)
    if (!before) return { replan: true, reason: 'appeared', id: mob.id, name: mob.name, distance }
    const moved = Math.hypot(mob.x - before.x, mob.z - before.z)
    if (moved >= moveThreshold) return { replan: true, reason: 'moved', id: mob.id, name: mob.name, distance, moved }
  }
  return { replan: false }
}

module.exports = {
  HOSTILE_NAMES,
  DEFAULT_PROFILE,
  PROFILES,
  CELL_CAP,
  isHostile,
  profileFor,
  buildDangerField,
  getDangerAt,
  snapshotHostiles,
  shouldReplanForHostiles
}
