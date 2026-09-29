/* eslint-env mocha */

// Hostile mobs and the planner, end to end: the real Movements and the real A* on a synthetic world
// (test/planner-harness.js), so it needs minecraft-data but no server. What is asserted is how the
// ROUTE changes, which is the point: the numbers in the thresholds come from running this same search
// on an open floor, with plenty of margin.

const assert = require('assert')
const { Vec3 } = require('vec3')
const { makeWorld, makeBot } = require('./planner-harness')
const Movements = require('../lib/movements')
const AStar = require('../lib/astar')
const Move = require('../lib/move')
const goals = require('../lib/goals')

/** A wide, flat floor whose top is y=63, so a walker's feet are at y=64. */
function openFloor () {
  const w = makeWorld()
  w.fill(-15, 63, -15, 25, 63, 15, 'stone')
  return w
}

const hostile = (name, x, z, extra = {}) => ({ id: 1, name, type: 'hostile', position: new Vec3(x, 64, z), width: 0.6, height: 1.95, ...extra })

/** Plan from (0,64,0) to (goalX,64,0) with `entities` around, after tweaking the Movements. */
function plan (world, entities, { tweak = {}, goalX = 10 } = {}) {
  const bot = makeBot(world, { entities })
  const movements = new Movements(bot)
  Object.assign(movements, tweak)
  movements.updateCollisionIndex()
  const search = new AStar(new Move(0, 64, 0, 0, 0), movements, new goals.GoalBlock(goalX, 64, 0), 5000)
  return search.compute()
}

/** How close any step of the route comes to (x, z), measured from the middle of the step's block. */
const closest = (path, x, z) => Math.min(...path.map(n => Math.hypot(n.x + 0.5 - x, n.z + 0.5 - z)))

describe('hostile mobs: the route bends around them', () => {
  it('with nothing around, the route is the straight line', () => {
    const r = plan(openFloor(), {})
    assert.strictEqual(r.status, 'success')
    assert.strictEqual(r.path.length, 10)
  })

  it('a zombie in the way is walked around, not through', () => {
    const r = plan(openFloor(), { 1: hostile('zombie', 5.5, 0.5) })
    assert.strictEqual(r.status, 'success')
    assert.ok(closest(r.path, 5.5, 0.5) >= 2.5, `the route came within ${closest(r.path, 5.5, 0.5).toFixed(2)} blocks of the zombie`)
  })

  it('without the avoidance the same route goes straight through it (so the test above measures something)', () => {
    const r = plan(openFloor(), { 1: hostile('zombie', 5.5, 0.5) }, { tweak: { avoidHostiles: false } })
    assert.ok(closest(r.path, 5.5, 0.5) < 1, `the route stayed ${closest(r.path, 5.5, 0.5).toFixed(2)} blocks from the zombie anyway`)
  })

  it('a creeper gets a wider berth than a zombie', () => {
    const zombie = plan(openFloor(), { 1: hostile('zombie', 5.5, 0.5) })
    const creeper = plan(openFloor(), { 1: hostile('creeper', 5.5, 0.5) })
    assert.ok(closest(creeper.path, 5.5, 0.5) >= 3.5, `the route came within ${closest(creeper.path, 5.5, 0.5).toFixed(2)} blocks of the creeper`)
    assert.ok(closest(creeper.path, 5.5, 0.5) > closest(zombie.path, 5.5, 0.5))
  })

  it('a mob that is not in the registry at all is recognised by name', () => {
    const r = plan(openFloor(), { 1: { id: 1, name: 'zombie', position: new Vec3(5.5, 64, 0.5), width: 0.6, height: 1.95 } })
    assert.ok(closest(r.path, 5.5, 0.5) >= 2.5)
  })

  it('a passive mob does not bend the route', () => {
    const r = plan(openFloor(), { 1: { id: 1, name: 'chicken', type: 'passive', position: new Vec3(5.5, 64, 0.5), width: 0.4, height: 0.7 } })
    assert.ok(closest(r.path, 5.5, 0.5) < 1.5)
  })

  it('a mob you have excluded does not bend it either', () => {
    const r = plan(openFloor(), { 1: hostile('enderman', 5.5, 0.5) }, { tweak: { hostileExclusions: new Set(['enderman']) } })
    assert.ok(closest(r.path, 5.5, 0.5) < 1.5)
  })

  it('a mob far from the route changes nothing about it', () => {
    const r = plan(openFloor(), { 1: hostile('zombie', 5.5, 12.5) })
    assert.strictEqual(r.path.length, 10)
  })

  it('two mobs are both avoided', () => {
    const r = plan(openFloor(), { 1: hostile('zombie', 3.5, 0.5), 2: hostile('zombie', 8.5, 0.5, { id: 2 }) })
    assert.strictEqual(r.status, 'success')
    assert.ok(closest(r.path, 3.5, 0.5) >= 2.5)
    assert.ok(closest(r.path, 8.5, 0.5) >= 2.5)
  })
})

describe('hostile mobs: they never make a reachable goal unreachable', () => {
  it('a goal right beside a hostile mob is still reached', () => {
    const r = plan(openFloor(), { 1: hostile('zombie', 10.5, 0.5) }, { goalX: 9 })
    assert.strictEqual(r.status, 'success')
  })

  it('a mob standing in a corridor with no way round is passed, at a price, not refused', () => {
    const w = makeWorld()
    w.fill(-2, 63, 0, 12, 63, 0, 'stone') // a one-block-wide floor...
    w.fill(-2, 64, -1, 12, 66, -1, 'stone') // ...with a wall on each side
    w.fill(-2, 64, 1, 12, 66, 1, 'stone')
    const r = plan(w, { 1: hostile('zombie', 5.5, 0.5) })
    assert.strictEqual(r.status, 'success')
    assert.strictEqual(r.path.length, 10)
  })

  it('the bot standing inside the danger zone can still find its way out and on', () => {
    const r = plan(openFloor(), { 1: hostile('zombie', 1.5, 0.5) })
    assert.strictEqual(r.status, 'success')
  })
})
