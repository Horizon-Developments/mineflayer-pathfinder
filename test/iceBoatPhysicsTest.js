/* eslint-env mocha */

const assert = require('assert')
const iceBoatPhysics = require('../lib/iceBoatPhysics')
const { FRICTION } = require('../lib/boat')

describe('lib/iceBoatPhysics', () => {
  describe('isIceName', () => {
    it('matches every vanilla ice block', () => {
      for (const name of ['ice', 'packed_ice', 'blue_ice', 'frosted_ice']) {
        assert.strictEqual(iceBoatPhysics.isIceName(name), true, name)
      }
    })

    it('does not match unrelated blocks, including ones that merely contain "ice"', () => {
      for (const name of ['stone', 'water', 'slime_block', 'dice_block', 'ice_cream_block']) {
        assert.strictEqual(iceBoatPhysics.isIceName(name), false, name)
      }
    })
  })

  describe('terminalSpeed', () => {
    it('is higher for a higher-friction (slipperier) surface', () => {
      const water = iceBoatPhysics.terminalSpeed(iceBoatPhysics.WATER_FRICTION)
      const ice = iceBoatPhysics.terminalSpeed(FRICTION.ice)
      const blueIce = iceBoatPhysics.terminalSpeed(FRICTION.blue_ice)
      assert.ok(ice > water, `ice (${ice}) should be faster than water (${water})`)
      assert.ok(blueIce > ice, `blue_ice (${blueIce}) should be faster than ice (${ice})`)
    })

    it('matches the closed-form terminal-velocity solution of the tick recurrence', () => {
      // v(n+1) = friction*v(n) + accel converges to v* = accel/(1-friction);
      // simulate the recurrence directly and check it actually gets there.
      const friction = FRICTION.blue_ice
      const accel = 0.04
      let v = 0
      for (let i = 0; i < 100000; i++) v = friction * v + accel
      assert.ok(Math.abs(v - iceBoatPhysics.terminalSpeed(friction)) < 1e-6)
    })
  })

  describe('cruiseCost', () => {
    const boatCost = 0.35

    it('reproduces the existing water boatCost exactly at water friction', () => {
      const cost = iceBoatPhysics.cruiseCost(iceBoatPhysics.WATER_FRICTION, boatCost)
      assert.ok(Math.abs(cost - boatCost) < 1e-9)
    })

    it('prices every ice type cheaper than open water (all ice is faster than water)', () => {
      const waterCost = iceBoatPhysics.cruiseCost(iceBoatPhysics.WATER_FRICTION, boatCost)
      for (const name of ['ice', 'packed_ice', 'blue_ice', 'frosted_ice']) {
        const cost = iceBoatPhysics.iceCostForBlockName(name, boatCost)
        assert.ok(cost < waterCost, `${name} (${cost}) should be cheaper than water (${waterCost})`)
        assert.ok(cost > 0, `${name} cost must stay positive`)
      }
    })

    it('prices blue_ice cheaper than plain/packed/frosted ice, matching its lower real friction gap', () => {
      const blueCost = iceBoatPhysics.iceCostForBlockName('blue_ice', boatCost)
      const iceCost = iceBoatPhysics.iceCostForBlockName('ice', boatCost)
      assert.ok(blueCost < iceCost, `blue_ice (${blueCost}) should be cheaper than ice (${iceCost})`)
    })

    it('falls back to plain ice friction for an unknown ice-named block', () => {
      const known = iceBoatPhysics.iceCostForBlockName('ice', boatCost)
      const unknown = iceBoatPhysics.iceCostForBlockName('warped_ice', boatCost) // hypothetical future variant
      assert.ok(Math.abs(known - unknown) < 1e-9)
    })

    it('never returns zero or negative cost', () => {
      assert.ok(iceBoatPhysics.cruiseCost(0.999999, boatCost) > 0)
    })
  })

  describe('buildTable', () => {
    it('includes every friction surface boat.js knows about', () => {
      const table = iceBoatPhysics.buildTable(0.35)
      for (const name of Object.keys(FRICTION)) {
        assert.ok(table.has(name), name)
        const row = table.get(name)
        assert.strictEqual(row.friction, FRICTION[name])
        assert.ok(row.blocksPerSecond > 0)
        assert.ok(row.cost > 0)
      }
    })
  })
})
