/* eslint-env mocha */

// Tests for lib/hostiles.js: how a hostile mob is recognised, the cost field around it, and when a
// planned path has gone stale because of one. No world and no registry data: everything is a fake.

const assert = require('assert')
const {
  HOSTILE_NAMES,
  DEFAULT_PROFILE,
  CELL_CAP,
  isHostile,
  profileFor,
  buildDangerField,
  getDangerAt,
  snapshotHostiles,
  shouldReplanForHostiles
} = require('../lib/hostiles')

const mob = (extra = {}) => ({ id: 1, name: 'zombie', x: 5.5, y: 64, z: 5.5, radius: 3, cost: 20, ...extra })

describe('hostiles: recognising a hostile mob', () => {
  it('trusts what mineflayer read from the registry when the entity spawned', () => {
    assert.strictEqual(isHostile({ name: 'some_new_mob', type: 'hostile' }), true)
    assert.strictEqual(isHostile({ name: 'some_new_mob', kind: 'Hostile mobs' }), true)
  })

  it('asks the registry by name when the entity does not say', () => {
    const registry = { entitiesByName: { zoglin_like: { type: 'hostile' }, other: { category: 'Hostile mobs' }, cow: { type: 'passive' } } }
    assert.strictEqual(isHostile({ name: 'zoglin_like' }, { registry }), true)
    assert.strictEqual(isHostile({ name: 'other' }, { registry }), true)
    assert.strictEqual(isHostile({ name: 'cow' }, { registry }), false)
  })

  it('falls back to the name list when the registry has nothing to say', () => {
    for (const name of ['zombie', 'creeper', 'skeleton', 'spider', 'witch', 'warden', 'phantom']) {
      assert.strictEqual(isHostile({ name }), true, name)
    }
    assert.ok(HOSTILE_NAMES.has('husk'))
  })

  it('does not treat passive, unknown or neutral mobs as hostile', () => {
    for (const name of ['chicken', 'cow', 'villager', 'testEntity', 'wolf', 'iron_golem', 'piglin', 'zombified_piglin', 'bee']) {
      assert.strictEqual(isHostile({ name, type: 'passive' }), false, name)
    }
    for (const name of ['wolf', 'iron_golem', 'zombified_piglin', 'piglin']) assert.strictEqual(isHostile({ name }), false, name)
  })

  it('an entity with no name is never hostile', () => {
    assert.strictEqual(isHostile({}), false)
    assert.strictEqual(isHostile(null), false)
  })

  it('an exclusion beats everything, an extra name beats the lists', () => {
    assert.strictEqual(isHostile({ name: 'enderman', type: 'hostile' }, { excludedNames: new Set(['enderman']) }), false)
    assert.strictEqual(isHostile({ name: 'zombie' }, { excludedNames: new Set(['zombie']) }), false)
    assert.strictEqual(isHostile({ name: 'my_custom_mob' }, { extraNames: new Set(['my_custom_mob']) }), true)
  })

  it('looks each name up in the registry once, however many entities have it', () => {
    let lookups = 0
    const registry = { get entitiesByName () { lookups++; return { zombie: { type: 'hostile' } } } }
    const cache = new Map()
    for (let i = 0; i < 1000; i++) isHostile({ name: 'zombie' }, { registry, cache })
    for (let i = 0; i < 1000; i++) isHostile({ name: 'testEntity' }, { registry, cache })
    assert.strictEqual(lookups, 2)
  })
})

describe('hostiles: how far to keep away', () => {
  it('has a default, and knows the mobs that deserve more room', () => {
    assert.deepStrictEqual(profileFor('zombie'), DEFAULT_PROFILE)
    assert.ok(profileFor('creeper').radius > profileFor('zombie').radius, 'a creeper explodes')
    assert.ok(profileFor('skeleton').radius > profileFor('zombie').radius, 'a skeleton shoots')
    assert.ok(profileFor('warden').radius > profileFor('creeper').radius)
    assert.ok(profileFor('silverfish').radius < profileFor('zombie').radius)
  })

  it('takes overrides by name, and only for that name', () => {
    assert.deepStrictEqual(profileFor('zombie', { zombie: { radius: 6 } }), { radius: 6, cost: DEFAULT_PROFILE.cost })
    assert.deepStrictEqual(profileFor('husk', { zombie: { radius: 6 } }), DEFAULT_PROFILE)
  })
})

describe('hostiles: the cost field', () => {
  it('is highest at the mob and fades with distance until it stops at the radius', () => {
    const field = buildDangerField([mob()])
    const at = (x) => field[`${x},64,5`] ?? 0
    assert.strictEqual(at(5), 20) // the mob's own cell
    assert.ok(at(6) < at(5) && at(7) < at(6) && at(8) < at(7), 'it should fade')
    assert.ok(at(8) > 0, 'exactly at the radius there is still something')
    assert.strictEqual(at(9), 0, 'beyond the radius there is nothing')
  })

  it('is round, not square', () => {
    const field = buildDangerField([mob()])
    assert.ok((field['5,64,5'] ?? 0) > 0)
    assert.strictEqual(field['8,64,8'] ?? 0, 0, 'the far corner of the bounding square is farther than the radius')
  })

  it('covers the feet levels the mob can reach: one below to two above, no more', () => {
    const field = buildDangerField([mob()])
    for (const y of [63, 64, 65, 66]) assert.ok((field[`5,${y},5`] ?? 0) > 0, `y=${y}`)
    for (const y of [62, 67]) assert.strictEqual(field[`5,${y},5`] ?? 0, 0, `y=${y}`)
  })

  it('is empty with no mobs, and scales with the cost scale', () => {
    assert.deepStrictEqual(buildDangerField([]), {})
    assert.strictEqual(buildDangerField([mob()], { scale: 0 })['5,64,5'], 0)
    assert.strictEqual(buildDangerField([mob()], { scale: 2 })['5,64,5'], 40)
  })

  it('adds up where two mobs overlap, but never past the cap', () => {
    const two = buildDangerField([mob({ id: 1 }), mob({ id: 2 })])
    assert.strictEqual(two['5,64,5'], 40)
    const crowd = buildDangerField(Array.from({ length: 30 }, (_, i) => mob({ id: i })))
    assert.strictEqual(crowd['5,64,5'], CELL_CAP)
  })

  it('a bigger mob claims a bigger area', () => {
    const creeper = buildDangerField([mob({ radius: 4, cost: 30 })])
    const zombie = buildDangerField([mob()])
    assert.ok(Object.keys(creeper).length > Object.keys(zombie).length)
    assert.ok((creeper['9,64,5'] ?? 0) > 0)
    assert.strictEqual(zombie['9,64,5'] ?? 0, 0)
  })

  it('a step is priced by the worse of the feet cell and the head cell', () => {
    assert.strictEqual(getDangerAt({ '1,64,1': 5, '1,65,1': 9 }, 1, 64, 1), 9)
    assert.strictEqual(getDangerAt({ '1,64,1': 5 }, 1, 64, 1), 5)
    assert.strictEqual(getDangerAt({}, 1, 64, 1), 0)
  })
})

describe('hostiles: has a path gone stale?', () => {
  const path = [1, 2, 3, 4, 5, 6].map(x => ({ x, y: 64, z: 0 }))
  const bot = { x: 0.5, y: 64, z: 0.5 }
  const ask = (current, extra = {}) => shouldReplanForHostiles({
    planned: snapshotHostiles([mob({ x: 3.5, z: 4.5 })]),
    current,
    path,
    botPosition: bot,
    msSinceReplan: 10000,
    ...extra
  })

  it('remembers where each mob was', () => {
    const snap = snapshotHostiles([mob({ id: 7, x: 1, y: 2, z: 3 })])
    assert.deepStrictEqual(snap.get(7), { x: 1, y: 2, z: 3 })
  })

  it('does nothing when the mobs are where the path assumed', () => {
    assert.deepStrictEqual(ask([mob({ x: 3.5, z: 4.5 })]), { replan: false })
  })

  it('a mob that walked into the way makes the path stale', () => {
    const v = ask([mob({ x: 3.5, z: 2.0 })]) // was 4.5 blocks off the path, now 2 blocks: moved 2.5
    assert.strictEqual(v.replan, true)
    assert.strictEqual(v.reason, 'moved')
    assert.strictEqual(v.name, 'zombie')
    assert.ok(v.moved >= 1.5)
  })

  it('a mob that was not there when the path was planned, and is now near it, does too', () => {
    const v = ask([mob({ id: 9, name: 'creeper', radius: 4, x: 4.5, z: 1.5 })])
    assert.strictEqual(v.replan, true)
    assert.strictEqual(v.reason, 'appeared')
    assert.strictEqual(v.name, 'creeper')
  })

  it('a mob that appears near the bot itself counts even if the path is elsewhere', () => {
    const v = ask([mob({ id: 9, x: 0.5, z: 2.5 })], { path: [{ x: 20, y: 64, z: 20 }] })
    assert.strictEqual(v.replan, true)
  })

  it('a small movement is not worth a new search', () => {
    assert.strictEqual(ask([mob({ x: 3.5, z: 3.9 })]).replan, false) // 0.6 blocks
  })

  it('a mob far from the bot and the path is ignored, however far it moved', () => {
    const planned = snapshotHostiles([mob({ x: 30.5, z: 30.5 })])
    assert.strictEqual(ask([mob({ x: 40.5, z: 30.5 })], { planned }).replan, false)
    assert.strictEqual(ask([mob({ id: 9, x: 40.5, z: 30.5 })]).replan, false, 'nor one that appeared over there')
  })

  it('only the next few steps count as "in the way"', () => {
    const longPath = Array.from({ length: 40 }, (_, i) => ({ x: i + 1, y: 64, z: 0 }))
    const far = mob({ id: 9, x: 30.5, z: 0.5 })
    assert.strictEqual(ask([far], { path: longPath, lookahead: 12 }).replan, false)
    assert.strictEqual(ask([far], { path: longPath, lookahead: 40 }).replan, true)
  })

  it('a mob on another floor is not in the way', () => {
    assert.strictEqual(ask([mob({ id: 9, y: 50, x: 2.5, z: 0.5 })]).replan, false)
  })

  it('does not replan again before the cooldown is over, so a chasing mob is not one search per tick', () => {
    const chasing = [mob({ x: 3.5, z: 2.0 })]
    assert.strictEqual(ask(chasing, { msSinceReplan: 200 }).replan, false)
    assert.strictEqual(ask(chasing, { msSinceReplan: 1000 }).replan, true)
    assert.strictEqual(ask(chasing, { msSinceReplan: 300, cooldown: 250 }).replan, true)
  })

  it('reports the first mob that matters', () => {
    const v = ask([mob({ id: 1, x: 3.5, z: 4.5 }), mob({ id: 2, name: 'husk', x: 2.5, z: 1.0 })])
    assert.strictEqual(v.id, 2)
  })
})
