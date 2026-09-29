/* eslint-env mocha */

// The hostile-mob support in lib/movements.js, run on the real Movements methods against a fake bot:
// which entities count, what the planner is told about them, and what a step near one costs.

const assert = require('assert')
const { Vec3 } = require('vec3')
const Movements = require('../lib/movements')
const Move = require('../lib/move')
const { buildDangerField } = require('../lib/hostiles')

/** A Movements with only what these methods read, so no registry or world data is needed. */
function movementsWith (entities, tweak = {}) {
  const me = { id: 0, name: 'player', position: new Vec3(0, 64, 0) }
  const m = Object.create(Movements.prototype)
  Object.assign(m, {
    bot: { entity: me, entities: { 0: me, ...entities }, registry: { entitiesByName: {} } },
    allowEntityDetection: true,
    avoidHostiles: true,
    hostileScanRange: 24,
    maxTrackedHostiles: 32,
    hostileCostScale: 1,
    hostileNames: new Set(),
    hostileExclusions: new Set(),
    hostileProfiles: {},
    hostilesSeen: [],
    dangerField: {},
    hostileNameCache: new Map(),
    entitiesToAvoid: new Set(),
    passableEntities: new Set(),
    entityIntersections: {}
  }, tweak)
  return m
}

const mobAt = (id, name, x, z, extra = {}) => ({ id, name, position: new Vec3(x, 64, z), width: 0.6, height: 1.95, ...extra })

describe('Movements: which entities count as hostile', () => {
  it('finds hostile mobs by what the registry said, by the registry by name, and by the name list', () => {
    const m = movementsWith({
      1: mobAt(1, 'weird_thing', 3, 0, { type: 'hostile' }),
      2: mobAt(2, 'registry_thing', 4, 0),
      3: mobAt(3, 'zombie', 5, 0)
    })
    m.bot.registry.entitiesByName.registry_thing = { type: 'hostile' }
    assert.deepStrictEqual(m.scanHostiles().map(h => h.name), ['weird_thing', 'registry_thing', 'zombie'])
  })

  it('ignores passive mobs, the bot itself and mobs that are already gone', () => {
    const m = movementsWith({
      1: mobAt(1, 'chicken', 3, 0, { type: 'passive' }),
      2: mobAt(2, 'zombie', 4, 0, { isValid: false }),
      3: mobAt(3, 'testEntity', 5, 0)
    })
    assert.deepStrictEqual(m.scanHostiles(), [])
  })

  it('lists them nearest first, with how far to keep from each', () => {
    const m = movementsWith({ 1: mobAt(1, 'zombie', 10, 0), 2: mobAt(2, 'creeper', 4, 0), 3: mobAt(3, 'skeleton', 7, 0) })
    const found = m.scanHostiles()
    assert.deepStrictEqual(found.map(h => h.name), ['creeper', 'skeleton', 'zombie'])
    assert.deepStrictEqual([found[0].radius, found[0].cost], [4, 30], 'a creeper gets a wider berth than the default')
    assert.deepStrictEqual([found[2].radius, found[2].cost], [3, 20])
  })

  it('leaves out mobs beyond the scan range, and keeps only the nearest few', () => {
    const many = {}
    for (let i = 1; i <= 40; i++) many[i] = mobAt(i, 'zombie', i, 0)
    const m = movementsWith(many, { hostileScanRange: 30, maxTrackedHostiles: 5 })
    assert.deepStrictEqual(m.scanHostiles().map(h => h.id), [1, 2, 3, 4, 5])
    const far = movementsWith({ 1: mobAt(1, 'zombie', 100, 0) })
    assert.deepStrictEqual(far.scanHostiles(), [])
  })

  it('honours the exclusions, the extra names and the per-mob profile overrides', () => {
    const m = movementsWith({ 1: mobAt(1, 'enderman', 3, 0, { type: 'hostile' }), 2: mobAt(2, 'my_mob', 4, 0), 3: mobAt(3, 'zombie', 5, 0) }, {
      hostileExclusions: new Set(['enderman']),
      hostileNames: new Set(['my_mob']),
      hostileProfiles: { zombie: { radius: 7 } }
    })
    const found = m.scanHostiles()
    assert.deepStrictEqual(found.map(h => h.name), ['my_mob', 'zombie'])
    assert.strictEqual(found[1].radius, 7)
  })

  it('finds nothing when avoiding hostiles is off, or entity detection is', () => {
    const entities = { 1: mobAt(1, 'zombie', 3, 0) }
    assert.deepStrictEqual(movementsWith(entities, { avoidHostiles: false }).scanHostiles(), [])
    assert.deepStrictEqual(movementsWith(entities, { allowEntityDetection: false }).scanHostiles(), [])
  })
})

describe('Movements: planning around them', () => {
  it('updateCollisionIndex remembers the hostiles and costs the cells around them', () => {
    const m = movementsWith({ 1: mobAt(1, 'zombie', 5.5, 5.5) })
    m.updateCollisionIndex()
    assert.strictEqual(m.hostilesSeen.length, 1)
    assert.strictEqual(m.dangerField['5,64,5'], 20)
    assert.ok(m.dangerField['7,64,5'] > 0)
  })

  it('clearCollisionIndex forgets them', () => {
    const m = movementsWith({ 1: mobAt(1, 'zombie', 5.5, 5.5) })
    m.updateCollisionIndex()
    m.clearCollisionIndex()
    assert.deepStrictEqual(m.hostilesSeen, [])
    assert.deepStrictEqual(m.dangerField, {})
    assert.deepStrictEqual(m.entityIntersections, {})
  })

  it('does not disturb the existing entity handling: a mob still occupies its own cells', () => {
    const m = movementsWith({ 1: mobAt(1, 'zombie', 5.5, 5.5), 2: mobAt(2, 'chicken', 8.5, 8.5) })
    m.updateCollisionIndex()
    assert.ok(m.getNumEntitiesAt({ x: 5, y: 64, z: 5 }, 0, 0, 0) > 0)
    assert.ok(m.getNumEntitiesAt({ x: 8, y: 64, z: 8 }, 0, 0, 0) > 0)
    // ...and the cells AROUND a hostile are cost, not "an entity is in the way" (that would forbid placing blocks there).
    assert.strictEqual(m.getNumEntitiesAt({ x: 7, y: 64, z: 5 }, 0, 0, 0), 0)
  })

  it('entitiesToAvoid keeps working, separately', () => {
    const m = movementsWith({ 1: mobAt(1, 'chicken', 5.5, 5.5) }, { entitiesToAvoid: new Set(['chicken']) })
    m.updateCollisionIndex()
    assert.strictEqual(m.getNumEntitiesAt({ x: 5, y: 64, z: 5 }, 0, 0, 0), 100)
    assert.deepStrictEqual(m.hostilesSeen, [], 'a chicken you asked to avoid is not thereby a hostile mob')
  })

  it('a step onto a cell near a hostile costs more; one away from it costs what it did', () => {
    const m = movementsWith({ 1: mobAt(1, 'zombie', 5.5, 5.5) })
    m.updateCollisionIndex()
    m.generateNeighbors = () => [new Move(5, 64, 5, 0, 1), new Move(7, 64, 5, 0, 1), new Move(20, 64, 20, 0, 1)]
    const [atMob, nearMob, away] = m.getNeighbors({})
    assert.strictEqual(atMob.cost, 21)
    assert.ok(nearMob.cost > 1 && nearMob.cost < atMob.cost, `near cost ${nearMob.cost}`)
    assert.strictEqual(away.cost, 1)
  })

  it('every kind of step is priced, including a boat step', () => {
    const m = movementsWith({ 1: mobAt(1, 'zombie', 5.5, 5.5) })
    m.updateCollisionIndex()
    m.generateNeighbors = () => [new Move(5, 64, 5, 0, 1, [], [], false, true)]
    assert.strictEqual(m.getNeighbors({})[0].cost, 21)
  })

  it('costs nothing extra when there is no hostile, or when the cost scale is 0', () => {
    const none = movementsWith({})
    none.updateCollisionIndex()
    none.generateNeighbors = () => [new Move(5, 64, 5, 0, 1)]
    assert.strictEqual(none.getNeighbors({})[0].cost, 1)

    const off = movementsWith({ 1: mobAt(1, 'zombie', 5.5, 5.5) }, { hostileCostScale: 0 })
    off.updateCollisionIndex()
    off.generateNeighbors = () => [new Move(5, 64, 5, 0, 1)]
    assert.strictEqual(off.getNeighbors({})[0].cost, 1)
  })

  it('prices the field it was given, so a caller can plan around mobs it made up', () => {
    const m = movementsWith({})
    m.hostilesSeen = [{}]
    m.dangerField = buildDangerField([{ id: 1, name: 'x', x: 1.5, y: 64, z: 1.5, radius: 2, cost: 10 }])
    m.generateNeighbors = () => [new Move(1, 64, 1, 0, 1)]
    assert.strictEqual(m.getNeighbors({})[0].cost, 11)
  })

  it('still drops stuck places', () => {
    const m = movementsWith({})
    m.bot.pathfinder = { stuckPlaces: new Map([['x', 1]]) }
    m.isStuckPlace = (move) => move.x === 1
    m.generateNeighbors = () => [new Move(1, 64, 1, 0, 1), new Move(2, 64, 1, 0, 1)]
    assert.deepStrictEqual(m.getNeighbors({}).map(n => n.x), [2])
  })
})
