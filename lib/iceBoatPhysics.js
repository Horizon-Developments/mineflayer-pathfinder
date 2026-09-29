'use strict'

/**
 * Pre-calculated boat-on-ice physics for the path planner.
 *
 * WHY THIS EXISTS
 * ----------------
 * lib/boat.js runs the *real* per-tick simulation (floatBoat/controlBoat): every
 * tick it does `vx *= invFriction` then adds the paddle's forward accel. Run
 * forever on a flat surface that converges on a terminal ("cruise") speed:
 *
 *   v(n+1) = friction * v(n) + accel   =>   v* = accel / (1 - friction)
 *
 * The A* planner in lib/movements.js needs a *cost per cell* for cruising in a
 * boat, not a tick-by-tick simulation - re-running boat.js's tick loop inside
 * the search would be far too slow, and the search doesn't have a real world
 * tick clock to step anyway. So this module solves the same recurrence once
 * up front, for every friction value lib/boat.js knows about (plain land and
 * every ice variant: ice, packed_ice, blue_ice, frosted_ice), and turns each
 * terminal speed into a cost that is directly comparable to the existing
 * `boatCost` (open water) and walking cost of 1.
 *
 * Calibration: water isn't in boat.js's FRICTION table (it uses a separate
 * buoyancy model), but its invFriction is a known constant, 0.9. Cost is made
 * inversely proportional to terminal speed - cost(friction) * speed(friction)
 * is the same constant for every surface - and requiring that constant to
 * reproduce movements.js's existing `boatCost` (0.35) at water's speed pins
 * down the one free constant, so every other surface's cost falls out of the
 * same formula rather than being a separately tuned magic number:
 *
 *   cost(friction) = boatCost * speed(waterFriction) / speed(friction)
 *                  = boatCost * (1 - friction) / (1 - waterFriction)
 *
 * Faster surfaces (friction closer to 1) get a cheaper cost per cell, exactly
 * like boatCost being cheaper than the walking cost of 1 - so A* actually
 * prefers routing a boat over blue ice > ice/packed ice/frosted ice > water
 * when a choice is available, which matches how much faster each really is
 * in-game.
 */

const { FRICTION, FORWARD_ACCEL } = require('./boat')

const WATER_FRICTION = 0.9 // BoatDriver#floatBoat, Status.IN_WATER
const TICKS_PER_SECOND = 20
// Friction to assume for a block whose name matches ICE_NAME but isn't in
// boat.js's FRICTION table yet (a brand new ice variant on a newer protocol
// version than boat.js has been updated for) - plain "ice"'s value, the most
// representative of the family.
const DEFAULT_ICE_FRICTION = FRICTION.ice

// Any block whose name is exactly "ice" or ends in "_ice" - ice, packed_ice,
// blue_ice, frosted_ice today, and any ice variant future Minecraft versions add,
// the same "match the pattern, not a fixed list" approach lib/movements.js already
// uses for boat items/entities (BOAT_NAME).
const ICE_NAME = /(^|_)ice$/

/**
 * Terminal (steady-state) speed a boat reaches paddling forward on a surface
 * with this friction, in blocks/tick.
 *
 * FORWARD_ACCEL (0.04) is controlBoat()'s accel *while holding forward*, not
 * the only accel value it uses - turning in place with no forward/back held is
 * 0.005, and reversing is -0.005. Using 0.04 here models continuous
 * forward-paddling in a straight line, which is what a cruise move (one cell,
 * same heading) actually represents; it does not account for the accel lost to
 * turning during a diagonal move's heading change, a limitation this module
 * inherits from the existing water-cruise cost (boatCost) rather than
 * introduces.
 * @param {number} friction 0..1, boat.js's invFriction for this surface
 * @returns {number}
 */
function terminalSpeed (friction) {
  return FORWARD_ACCEL / (1 - friction)
}

/**
 * @param {number} friction
 * @param {number} baseCost cost/cell to calibrate against (movements.boatCost)
 * @param {number} baseFriction the friction baseCost was measured at (water)
 * @returns {number} cost per cell, comparable to baseCost and to walking's cost of 1
 */
function cruiseCost (friction, baseCost, baseFriction = WATER_FRICTION) {
  // Inversely proportional to terminal speed: cost * speed is constant, pinned
  // by baseCost/baseFriction. A surface with higher friction (closer to 1) has
  // a higher terminal speed and so a lower cost per cell than baseCost.
  const cost = baseCost * (1 - friction) / (1 - baseFriction)
  // A zero or negative cost would break A*'s cost accounting (and friction===1
  // is not physically reachable anyway - it would mean infinite terminal speed).
  return Math.max(cost, 1e-4)
}

/**
 * Every friction value lib/boat.js knows about, by block name, plus the speeds
 * and (water-calibrated) per-cell costs derived from it. Computed once here
 * rather than per lookup - this *is* the "pre-calculation".
 * @param {number} [boatCost] movements.boatCost, to calibrate against
 * @returns {Map<string, {friction:number, blocksPerTick:number, blocksPerSecond:number, cost:number}>}
 */
function buildTable (boatCost = 0.35) {
  const table = new Map()
  for (const name of Object.keys(FRICTION)) {
    const friction = FRICTION[name]
    const blocksPerTick = terminalSpeed(friction)
    table.set(name, {
      friction,
      blocksPerTick,
      blocksPerSecond: blocksPerTick * TICKS_PER_SECOND,
      cost: cruiseCost(friction, boatCost)
    })
  }
  return table
}

/**
 * Per-cell cost of cruising a boat over a named block, for ice-family blocks.
 * Falls back to DEFAULT_ICE_FRICTION for an ice-named block boat.js's FRICTION
 * table doesn't (yet) list.
 * @param {string} name block name, e.g. 'blue_ice'
 * @param {number} boatCost movements.boatCost, to calibrate against
 * @returns {number}
 */
function iceCostForBlockName (name, boatCost) {
  const friction = Object.prototype.hasOwnProperty.call(FRICTION, name) ? FRICTION[name] : DEFAULT_ICE_FRICTION
  return cruiseCost(friction, boatCost)
}

module.exports = {
  ICE_NAME,
  WATER_FRICTION,
  DEFAULT_ICE_FRICTION,
  FRICTION,
  terminalSpeed,
  cruiseCost,
  buildTable,
  iceCostForBlockName,
  isIceName: (name) => ICE_NAME.test(String(name ?? ''))
}
