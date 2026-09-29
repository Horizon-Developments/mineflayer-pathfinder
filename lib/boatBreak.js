'use strict'

// Breaking a boat as a player.
//
// Boat.hurt() adds 10 x the hit's damage to the boat's own damage and destroys it once that total is
// ABOVE 40. So a 4-damage hit (wooden sword) lands exactly on 40 and does not break it, and a fist
// (1 damage) needs five hits. Every hit is scaled by the attack cooldown, so the bot waits out the
// cooldown between hits and always lands full-strength ones.
//
// Everything here is a plan for the cost model and the hit loop. The executor keeps hitting until the
// boat entity is gone, so a wrong number here costs time, never correctness.

const DAMAGE_PER_POINT = 10
const BREAK_ABOVE = 40
const CRIT_MULTIPLIER = 1.5
// Ticks of a jump before the bot is falling (a crit needs fallDistance > 0), and a whole jump.
const CRIT_FIRST_TICKS = 7
const CRIT_CYCLE_TICKS = 12
// One planner cost unit is one block of walking: 20 / 4.317 ticks.
const TICKS_PER_COST = 4.63

const TIERS = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite']

// Total attack damage (the player's base 1 included) and attack speed, in TIERS order.
const TOOLS = {
  sword: { damage: [4, 4, 5, 6, 7, 8], speed: [1.6, 1.6, 1.6, 1.6, 1.6, 1.6] },
  axe: { damage: [7, 7, 9, 9, 9, 10], speed: [0.8, 1, 0.8, 0.9, 1, 1] },
  pickaxe: { damage: [2, 2, 3, 4, 5, 6], speed: [1.2, 1.2, 1.2, 1.2, 1.2, 1.2] },
  shovel: { damage: [2.5, 2.5, 3.5, 4.5, 5.5, 6.5], speed: [1, 1, 1, 1, 1, 1] },
  hoe: { damage: [1, 1, 1, 1, 1, 1], speed: [1, 1, 2, 3, 4, 4] }
}
const FIST = { damage: 1, speed: 4, tool: false }

const TOOL_NAME = new RegExp(`^(${TIERS.join('|')})_(${Object.keys(TOOLS).join('|')})$`)

/**
 * Attack damage and speed of an item. Anything that is not one of the tools above (a boat in hand,
 * a block, nothing) hits like a fist; an unknown tool counts as a fist too, which errs towards more hits.
 * @param {string | null | undefined} name item name
 * @returns {{ damage: number, speed: number, tool: boolean }}
 */
function attackStats (name) {
  const m = TOOL_NAME.exec(name || '')
  if (!m) return FIST
  const i = TIERS.indexOf(m[1])
  return { damage: TOOLS[m[2]].damage[i], speed: TOOLS[m[2]].speed[i], tool: true }
}

/** Ticks between two full-strength hits: the cooldown is full once (ticks + 0.5) / (20 / speed) reaches 1. */
const cooldownTicks = (speed) => Math.ceil(20 / speed - 0.5)

/**
 * Hits needed for a boat to go from undamaged to destroyed.
 * @param {number} damage damage of one full-strength hit
 * @param {{ crit?: boolean, threshold?: number }} [options]
 */
function hitsToBreak (damage, { crit = false, threshold = BREAK_ABOVE } = {}) {
  const per = damage * (crit ? CRIT_MULTIPLIER : 1) * DAMAGE_PER_POINT
  return Math.floor(threshold / per) + 1
}

/**
 * How long one way of breaking the boat takes.
 * @param {string | null} name the item used, null for a fist
 * @param {{ crit?: boolean, equip?: boolean, threshold?: number }} [options] equip: the item has to be
 *   switched to first, which resets the attack cooldown
 * @returns {{ name: string | null, crit: boolean, hits: number, cooldown: number, interval: number, first: number, ticks: number }}
 *   first: ticks until the first hit; interval: ticks between hits; ticks: until the last hit lands
 */
function planWith (name, { crit = false, equip = false, threshold = BREAK_ABOVE } = {}) {
  const { damage, speed } = attackStats(name)
  const cooldown = cooldownTicks(speed)
  const hits = hitsToBreak(damage, { crit, threshold })
  const ready = equip ? cooldown : 0
  const first = crit ? Math.max(ready, CRIT_FIRST_TICKS) : ready
  const interval = crit ? Math.max(cooldown, CRIT_CYCLE_TICKS) : cooldown
  return { name, crit, hits, cooldown, interval, first, ticks: first + (hits - 1) * interval }
}

/**
 * The fastest way to break a boat with what is in the inventory.
 * @param {{ name: string, type?: number }[]} items inventory items
 * @param {{ held?: { name: string } | null, crits?: boolean, threshold?: number }} [options]
 * @returns {ReturnType<typeof planWith> & { item: object | null }} item is null for the bare hand
 */
function choose (items, { held = null, crits = true, threshold = BREAK_ABOVE } = {}) {
  const heldTool = !!held && attackStats(held.name).tool
  const candidates = [{ item: null, equip: heldTool }]
  for (const item of items) if (attackStats(item.name).tool) candidates.push({ item, equip: !held || held.name !== item.name })
  let best = null
  for (const { item, equip } of candidates) {
    for (const crit of crits ? [false, true] : [false]) {
      const p = { ...planWith(item && item.name, { crit, equip, threshold }), item }
      if (!best || p.ticks < best.ticks || (p.ticks === best.ticks && p.hits < best.hits)) best = p
    }
  }
  return best
}

/**
 * Damage one real hit actually deals - the same math hitsToBreak assumes, exposed so the executor can
 * track the boat's running total against what really landed instead of trusting a precomputed hit count.
 * @param {string | null | undefined} name item used, null for a fist
 * @param {boolean} [crit] whether this specific hit was a genuine crit
 */
function damageOf (name, crit = false) {
  const { damage } = attackStats(name)
  return damage * (crit ? CRIT_MULTIPLIER : 1) * DAMAGE_PER_POINT
}

module.exports = {
  attackStats,
  cooldownTicks,
  hitsToBreak,
  planWith,
  choose,
  damageOf,
  TICKS_PER_COST,
  CRIT_CYCLE_TICKS,
  CRIT_MULTIPLIER,
  DAMAGE_PER_POINT,
  BREAK_ABOVE
}
