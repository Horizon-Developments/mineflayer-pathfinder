/* eslint-env mocha */

// The damage model for breaking a boat (lib/boatBreak.js). A boat breaks once its damage is ABOVE 40 and
// every hit adds 10 x its damage, so 4 damage lands on 40 and does not break it.

const assert = require('assert')
const { attackStats, cooldownTicks, hitsToBreak, planWith, choose, damageOf, BREAK_ABOVE } = require('../lib/boatBreak')

const hits = (name, crit) => planWith(name, { crit }).hits

// Independent check that hitsToBreak's count actually breaks a boat, simulated via damageOf
// rather than trusting hitsToBreak's own formula - catches an off-by-one that both share.
const simulatedHitsToBreak = (name, crit) => {
  let total = 0
  let n = 0
  while (total <= BREAK_ABOVE) {
    total += damageOf(name, crit)
    n++
  }
  return n
}

describe('boat breaking', () => {
  it('a fist needs five hits, or three with crits', () => {
    assert.strictEqual(hits(null, false), 5)
    assert.strictEqual(hits(null, true), 3)
  })

  it('a hit of exactly 4 damage does not break a boat', () => {
    assert.strictEqual(hits('wooden_sword', false), 2)
    assert.strictEqual(hits('wooden_sword', true), 1)
    assert.strictEqual(hitsToBreak(4), 2)
    assert.strictEqual(hitsToBreak(5), 1)
  })

  it('counts hits for the other tools', () => {
    assert.deepStrictEqual(['wooden_hoe', 'wooden_pickaxe', 'stone_pickaxe', 'wooden_shovel', 'stone_shovel', 'iron_shovel', 'wooden_axe'].map(n => [hits(n, false), hits(n, true)]),
      [[5, 3], [3, 2], [2, 1], [2, 2], [2, 1], [1, 1], [1, 1]])
  })

  it('reads the attack speed as a cooldown in ticks', () => {
    assert.strictEqual(cooldownTicks(attackStats('wooden_sword').speed), 12)
    assert.strictEqual(cooldownTicks(attackStats('wooden_axe').speed), 25)
    assert.strictEqual(cooldownTicks(attackStats(null).speed), 5)
  })

  it('treats anything that is not a tool as a fist', () => {
    assert.deepStrictEqual(attackStats('oak_boat'), attackStats(null))
    assert.strictEqual(attackStats('oak_boat').tool, false)
  })

  it('prices the switch to a tool: it resets the cooldown', () => {
    assert.strictEqual(planWith('stone_sword', { equip: true }).ticks, 12)
    assert.strictEqual(planWith('stone_sword', { equip: false }).ticks, 0)
  })

  it('a crit costs a whole jump between hits', () => {
    const crit = planWith(null, { crit: true })
    assert.strictEqual(crit.hits, 3)
    assert.strictEqual(crit.interval, 12)
    assert.ok(crit.ticks > planWith(null).ticks, 'three crit hits are slower than five punches')
  })

  it('takes a sword over bare hands, and crits only when they save time', () => {
    const boat = { name: 'oak_boat' }
    assert.strictEqual(choose([boat, { name: 'stone_sword' }], { held: boat }).name, 'stone_sword')
    assert.strictEqual(choose([boat], { held: boat }).name, null)
    assert.strictEqual(choose([boat], { held: boat }).crit, false)
    const wooden = choose([boat, { name: 'wooden_sword' }], { held: boat })
    assert.deepStrictEqual([wooden.name, wooden.crit, wooden.hits], ['wooden_sword', true, 1])
    // without crits, switching to a wooden sword (12 ticks of cooldown, then two hits) loses to punching
    assert.strictEqual(choose([boat, { name: 'wooden_sword' }], { held: boat, crits: false }).name, null)
  })

  it('a hoe in hand means unequipping to punch', () => {
    const hoe = { name: 'wooden_hoe' }
    assert.strictEqual(choose([hoe], { held: hoe }).name, null)
    assert.strictEqual(choose([hoe], { held: hoe }).ticks, planWith(null, { equip: true }).ticks)
  })

  it('a different damage threshold changes the counts', () => {
    assert.strictEqual(planWith(null, { threshold: 20 }).hits, 3)
  })

  it('actually breaks the boat: simulated cumulative damage crosses BREAK_ABOVE at hits(name), not before', () => {
    for (const name of [null, 'wooden_sword', 'wooden_hoe', 'stone_pickaxe', 'iron_shovel', 'wooden_axe']) {
      for (const crit of [false, true]) {
        const n = hits(name, crit)
        assert.strictEqual(simulatedHitsToBreak(name, crit), n, `${name || 'fist'}${crit ? ' (crit)' : ''}`)
        let totalBeforeLast = 0
        for (let i = 0; i < n - 1; i++) totalBeforeLast += damageOf(name, crit)
        assert.ok(totalBeforeLast <= BREAK_ABOVE, `${name || 'fist'}${crit ? ' (crit)' : ''} broke early, at hit ${n - 1}`)
        assert.ok(totalBeforeLast + damageOf(name, crit) > BREAK_ABOVE, `${name || 'fist'}${crit ? ' (crit)' : ''} did not actually break at hit ${n}`)
      }
    }
  })
})
