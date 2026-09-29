/* eslint-env mocha */
const assert = require('assert')
const { performance } = require('perf_hooks')
const { Vec3 } = require('vec3')
const { makeWorld, makeBot, nodeAt, describe: describeMoves } = require('./planner-harness')
const Movements = require('../lib/movements')

function mv (bot, tweak = {}) {
  const m = new Movements(bot)
  Object.assign(m, tweak)
  return m
}

describe('parkour floorCleared safety (issue #207)', () => {
  /**
   * Down-parkour: launch from y=64, fly over x=1 and x=2, land one block lower at
   * x=3. The cell under the flight path at (2, 62) is the variable under test -
   * it is what decides whether floorCleared stays true long enough for the d=3
   * landing to be emitted.
   *
   * This geometry matters. An earlier version of this test used a plain gap, which
   * produced a *forward* parkour and never executed the floorCleared code at all,
   * so it passed against both the fixed and the original predicate.
   */
  function flightPathWorld (underFlight) {
    const w = makeWorld()
    w.fill(-2, 63, -2, 0, 63, 2, 'stone') // launch platform, top y=63 -> node y=64
    w.fill(2, 62, -2, 2, 62, 2, underFlight) // the cell that decides floorCleared
    w.fill(3, 62, -2, 6, 62, 2, 'stone') // landing floor, top y=63 -> feet y=63
    return w
  }

  function downParkour (underFlight) {
    const bot = makeBot(flightPathWorld(underFlight))
    const m = mv(bot, { canDig: false, allow1by1towers: false })
    const n = m.getNeighbors(nodeAt(0, 64, 0))
    return n.filter(x => x.parkour && x.x > 0 && x.y < 64)
  }

  it('emits a down-parkour landing when the flight path is clear air', () => {
    const moves = downParkour('air')
    assert.strictEqual(moves.length, 1, 'expected exactly one down-parkour landing')
    assert.strictEqual(`${moves[0].x},${moves[0].y}`, '3,63')
  })

  it('does not emit a down-parkour landing over lava', () => {
    const moves = downParkour('lava')
    assert.strictEqual(moves.length, 0, 'planner routed a parkour drop over lava: ' + JSON.stringify(describeMoves(moves)))
  })
})

describe('Move state hashing', () => {
  it('separates walking and boating at the same coordinates', () => {
    const walk = nodeAt(5, 64, 5)
    const boat = nodeAt(5, 64, 5, { boat: true })
    assert.notStrictEqual(walk.hash, boat.hash)
  })
})

describe('boat movement generation', () => {
  // Beach at x<=0 (top y=63, stand at 64), open water from x=1 to x=8 (water at y=63).
  function shoreWorld () {
    const w = makeWorld()
    w.fill(-4, 60, -4, 0, 63, 4, 'stone')
    w.fill(1, 60, -4, 8, 62, 4, 'stone') // sea floor
    w.fill(1, 63, -4, 8, 63, 4, 'water') // surface water
    return w
  }

  it('generates no boat moves when allowBoating is off', () => {
    const bot = makeBot(shoreWorld(), { items: ['oak_boat'] })
    const m = mv(bot, { allowBoating: false })
    const n = m.getNeighbors(nodeAt(0, 64, 0))
    assert.strictEqual(n.filter(x => x.boat).length, 0)
  })

  it('embarks from the shore onto adjacent surface water', () => {
    const bot = makeBot(shoreWorld(), { items: ['oak_boat'] })
    const m = mv(bot, { allowBoating: true })
    const n = m.getNeighbors(nodeAt(0, 64, 0))
    const embarks = n.filter(x => x.boat)
    assert.ok(embarks.length > 0, 'expected an embark move onto the water')
    // Shore is one above the water surface, so the boat node sits at y=63.
    assert.ok(embarks.every(e => e.y === 63), 'embark nodes should be on the water surface: ' + JSON.stringify(describeMoves(embarks)))
  })

  it('does not embark without a boat item or a nearby boat', () => {
    const bot = makeBot(shoreWorld(), { items: [] })
    const m = mv(bot, { allowBoating: true })
    const n = m.getNeighbors(nodeAt(0, 64, 0))
    assert.strictEqual(n.filter(x => x.boat).length, 0)
  })

  it('cruises across open water and does not emit walking moves', () => {
    const bot = makeBot(shoreWorld(), { items: ['oak_boat'] })
    const m = mv(bot, { allowBoating: true })
    const n = m.getNeighbors(nodeAt(4, 63, 0, { boat: true }))
    assert.ok(n.length > 0, 'expected cruise moves')
    assert.ok(n.every(x => x.boat), 'a boat node must not expand into walking moves: ' + JSON.stringify(describeMoves(n)))
    assert.ok(n.every(x => x.toBreak.length === 0 && x.toPlace.length === 0), 'boats do not dig or place')
    // Cruising is cheaper per cell than walking, so A* prefers water routes.
    assert.ok(n.every(x => x.cost < 1), 'cruise cost should undercut the walking cost of 1')
  })

  it('disembarks from water onto the shore', () => {
    const bot = makeBot(shoreWorld(), { items: ['oak_boat'] })
    const m = mv(bot, { allowBoating: true })
    const n = m.getNeighbors(nodeAt(1, 63, 0, { boat: true }))
    const land = n.filter(x => !x.boat)
    assert.ok(land.length > 0, 'expected a disembark move onto the beach')
    assert.ok(land.every(x => x.x === 0 && x.y === 64), 'disembark should land on the shore at y=64: ' + JSON.stringify(describeMoves(land)))
  })

  it('will not boat on submerged water', () => {
    const w = makeWorld()
    w.fill(0, 60, -2, 6, 63, 2, 'water') // water with water above it - no surface
    const bot = makeBot(w, { items: ['oak_boat'] })
    const m = mv(bot, { allowBoating: true })
    // y=61 is submerged: the cell above is also water
    assert.strictEqual(m.isBoatable(nodeAt(3, 61, 0), 0, 0, 0), false)
    // y=63 is the surface
    assert.strictEqual(m.isBoatable(nodeAt(3, 63, 0), 0, 0, 0), true)
  })

  it('will not boat on lava', () => {
    const w = makeWorld()
    w.fill(0, 60, -2, 6, 62, 2, 'stone')
    w.fill(0, 63, -2, 6, 63, 2, 'lava')
    const bot = makeBot(w, { items: ['oak_boat'] })
    const m = mv(bot, { allowBoating: true })
    assert.strictEqual(m.isBoatable(nodeAt(3, 63, 0), 0, 0, 0), false)
  })

  it('recognises every boat and raft variant as a boat item', () => {
    const w = makeWorld()
    const bot = makeBot(w, { items: ['bamboo_raft'] })
    const m = mv(bot, { allowBoating: true })
    assert.ok(m.getBoatItem(), 'bamboo_raft should count as a boat item')
    const chestBot = makeBot(w, { items: ['acacia_chest_boat'] })
    assert.ok(mv(chestBot, { allowBoating: true }).getBoatItem(), 'chest boats should count too')
  })
})

describe('ascending-move arrival tolerance (jump-over-block rubberband)', () => {
  // getReached is exercised directly with fake states rather than a full
  // chunk/physics simulation: it is a pure function of (target, state.pos), and
  // the bug is entirely in that comparison, not in collision or movement.
  const Physics = require('../lib/physics')
  const { Vec3 } = require('vec3')

  function fakePhysics (arrivalTolerance = 0.35) {
    const bot = { pathfinder: { arrivalTolerance, parkourArrivalTolerance: 0.5, boatArrivalTolerance: 1.2 } }
    return new Physics(bot)
  }

  function state (x, y, z) {
    return { pos: new Vec3(x, y, z) }
  }

  it('does not report an ascending target reached while still well below it', () => {
    const ph = fakePhysics()
    // getMoveJumpUp target: one block forward and up from a departure at y=64.
    const target = nodeAt(1, 65, 0)
    const reached = ph.getReached([target])
    // Horizontally already adjacent (inside the obstacle's column), but only
    // 0.4 of the 1.0 block risen - still colliding with the block's face.
    assert.strictEqual(reached(state(1, 64.4, 0)), false, 'must not be reached while still below the ledge')
  })

  it('reports an ascending target reached once actually risen to it', () => {
    const ph = fakePhysics()
    const target = nodeAt(1, 65, 0)
    const reached = ph.getReached([target])
    assert.strictEqual(reached(state(1, 64.98, 0)), true, 'must be reached once landed on top')
  })

  it('keeps the loose band for a descending or flat target', () => {
    const ph = fakePhysics()
    // A drop-down or flat move: target at or below the current node.
    const flatTarget = nodeAt(1, 64, 0)
    const reachedFlat = ph.getReached([flatTarget])
    assert.strictEqual(reachedFlat(state(1, 64.5, 0)), true, 'falling through open air above a flat/lower target is harmless and should still register')

    const dropTarget = nodeAt(1, 63, 0)
    const reachedDrop = ph.getReached([dropTarget])
    assert.strictEqual(reachedDrop(state(1, 63.9, 0)), true, 'mid-fall above a lower target should still register - nothing to collide with')
  })

  it('still enforces the horizontal tolerance for ascending targets', () => {
    const ph = fakePhysics()
    const target = nodeAt(5, 65, 5)
    const reached = ph.getReached([target])
    assert.strictEqual(reached(state(5, 64.99, 2)), false, 'far outside horizontal tolerance must not be reached regardless of height')
  })
})

describe('rise classification (walk / jump / unreachable)', () => {
  /**
   * Bot stands on a carpet (surface 0.0625 above the block below) next to a full
   * block (surface 1.0). The rise is 0.9375 - far beyond the 0.6 auto-step, but
   * well within jump range.
   *
   * Original behaviour: emitted as a plain walk, which the physics engine cannot
   * execute, so the executor failed every predicate and froze on the spot.
   */
  function carpetLedge () {
    const w = makeWorld()
    w.fill(-3, 62, -3, 3, 62, 3, 'stone')
    w.set(0, 63, 0, 'white_carpet') // bot stands here -> node y=64
    w.fill(1, 63, -3, 3, 63, 3, 'stone') // neighbouring floor a full block high
    return w
  }

  it('measures the rise from the real standing surface, not the block grid', () => {
    const m = mv(makeBot(carpetLedge()), { canDig: false })
    const node = nodeAt(0, 64, 0)
    assert.strictEqual(m.getBlock(node, 0, -1, 0).height, 63.0625) // carpet top
    assert.strictEqual(m.getBlock(node, 1, -1, 0).height, 64) // full block top
  })

  it('emits an over-step rise as a jump, not a walk', () => {
    const m = mv(makeBot(carpetLedge()), { canDig: false, allow1by1towers: false, allowParkour: false })
    const east = m.getNeighbors(nodeAt(0, 64, 0)).filter(n => n.x === 1 && n.z === 0)
    assert.strictEqual(east.length, 1, 'the cell must stay reachable: ' + JSON.stringify(describeMoves(east)))
    assert.strictEqual(east[0].parkour, true, 'a 0.94 rise must be flagged as a jump so the executor jumps')
    assert.ok(east[0].cost > 1, 'a jump should cost more than a stride')
  })

  it('leaves a flat walk unflagged and at base cost', () => {
    const w = makeWorld()
    w.fill(-3, 63, -3, 3, 63, 3, 'stone')
    const m = mv(makeBot(w), { canDig: false, allowParkour: false })
    const east = m.getNeighbors(nodeAt(0, 64, 0)).filter(n => n.x === 1 && n.z === 0)
    assert.strictEqual(east.length, 1)
    assert.strictEqual(east[0].parkour, false)
    assert.strictEqual(east[0].cost, 1)
  })

  it('still allows a half-block step up as a plain walk', () => {
    const w = makeWorld()
    w.fill(-3, 62, -3, 3, 62, 3, 'stone')
    w.set(0, 63, 0, 'smooth_stone_slab') // bot stands on the slab -> node y=64
    w.fill(1, 63, -3, 3, 63, 3, 'stone') // full blocks beside it, top at y=64
    const m = mv(makeBot(w), { canDig: false, allow1by1towers: false, allowParkour: false })
    const east = m.getNeighbors(nodeAt(0, 64, 0)).filter(n => n.x === 1 && n.z === 0)
    assert.strictEqual(east.length, 1, 'a 0.5 step up must remain reachable')
    assert.strictEqual(east[0].parkour, false, 'a 0.5 rise is within auto-step and must not become a jump')
  })
})

describe('boat entity recognition (place-but-never-mount)', () => {
  // Since per-wood boats, the entity for an oak boat is 'oak_boat', not 'boat'. An
  // exact-name match therefore never saw the boat the executor had just placed, so
  // it was never mounted and another was placed on the next tick.
  const variants = [
    'boat', 'chest_boat', // legacy names
    'oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat', 'acacia_boat', 'dark_oak_boat',
    'mangrove_boat', 'cherry_boat', 'pale_oak_boat',
    'oak_chest_boat', 'cherry_chest_boat',
    'bamboo_raft', 'bamboo_chest_raft'
  ]

  function ent (name, x, y, z, extra = {}) {
    return { name, position: new Vec3(x, y, z), ...extra }
  }

  it('recognises every boat, chest boat and raft variant', () => {
    const m = mv(makeBot(makeWorld()))
    for (const name of variants) {
      assert.strictEqual(m.isBoatEntity(ent(name, 0, 0, 0)), true, `${name} should be accepted as a boat`)
    }
  })

  it('recognises the pre-1.14 object-type boat and display-name-only entities', () => {
    const m = mv(makeBot(makeWorld()))
    assert.strictEqual(m.isBoatEntity({ objectType: 'Boat', position: new Vec3(0, 0, 0) }), true)
    assert.strictEqual(m.isBoatEntity({ displayName: 'Oak Boat', position: new Vec3(0, 0, 0) }), true)
    assert.strictEqual(m.isBoatEntity({ displayName: 'Bamboo Raft', position: new Vec3(0, 0, 0) }), true)
  })

  it('does not mistake other entities for boats', () => {
    const m = mv(makeBot(makeWorld()))
    for (const name of ['minecart', 'chest_minecart', 'item', 'player', 'boat_rack', 'chicken', undefined]) {
      assert.strictEqual(m.isBoatEntity(ent(name, 0, 0, 0)), false, `${name} is not a boat`)
    }
    assert.strictEqual(m.isBoatEntity(null), false)
  })

  it('never reads the deprecated entity.objectType of a real, named entity', () => {
    // prismarine-entity prints a stack trace every time objectType is read. The planner
    // asks isBoatEntity about every loaded entity for every node it expands, so reading
    // it there flooded the console and starved the event loop until the search timed out.
    let reads = 0
    const named = (name) => ({
      name,
      displayName: name,
      position: new Vec3(0, 0, 0),
      get objectType () { reads++; return undefined }
    })
    const m = mv(makeBot(makeWorld()))
    for (const name of ['oak_boat', 'bamboo_raft', 'chicken', 'item', 'minecart']) m.isBoatEntity(named(name))
    // ...including when only the display name is filled in.
    m.isBoatEntity({ displayName: 'Oak Boat', position: new Vec3(0, 0, 0), get objectType () { reads++ } })
    assert.strictEqual(reads, 0, 'isBoatEntity read entity.objectType')
  })

  it('a boat-source check scans the entities once per node, not once per direction', () => {
    // Each scan is O(entities). Four per node made a busy server's search crawl.
    const w = makeWorld()
    w.fill(-4, 60, -4, 0, 63, 4, 'stone')
    w.fill(1, 60, -4, 8, 62, 4, 'stone')
    w.fill(1, 63, -4, 8, 63, 4, 'water')
    let scans = 0
    const entities = new Proxy({ 1: { name: 'chicken', position: new Vec3(20, 63, 20) } }, {
      ownKeys (t) { scans++; return Reflect.ownKeys(t) }
    })
    const m = mv(makeBot(w, { items: [], entities }), { allowBoating: true })
    m.getNeighbors(nodeAt(0, 64, 0))
    assert.strictEqual(scans, 1, `entities were scanned ${scans} times for one node`)
  })

  it('getNearbyBoat finds a per-wood boat and ignores other entities', () => {
    const entities = {
      1: ent('chicken', 1, 63, 0),
      2: ent('cherry_boat', 3, 63, 0)
    }
    const m = mv(makeBot(makeWorld(), { entities }))
    const found = m.getNearbyBoat(new Vec3(2.5, 63, 0.5), 3)
    assert.ok(found, 'a cherry_boat within range must be found')
    assert.strictEqual(found.name, 'cherry_boat')
  })

  it('getNearbyBoat picks the nearest of several boat types', () => {
    const entities = {
      1: ent('oak_boat', 6, 63, 0),
      2: ent('bamboo_raft', 2, 63, 0),
      3: ent('oak_chest_boat', 4, 63, 0)
    }
    const m = mv(makeBot(makeWorld(), { entities }))
    assert.strictEqual(m.getNearbyBoat(new Vec3(1.5, 63, 0), 6).name, 'bamboo_raft')
  })

  it('a floating per-wood boat is enough to plan an embark without a boat item', () => {
    const w = makeWorld()
    w.fill(-4, 60, -4, 0, 63, 4, 'stone')
    w.fill(1, 60, -4, 8, 62, 4, 'stone')
    w.fill(1, 63, -4, 8, 63, 4, 'water')
    const bot = makeBot(w, { items: [], entities: { 1: ent('mangrove_boat', 3, 63, 0) } })
    const m = mv(bot, { allowBoating: true })
    const n = m.getNeighbors(nodeAt(0, 64, 0))
    assert.ok(n.some(x => x.boat), 'expected an embark move because a boat is floating nearby')
  })
})

describe('stuck places (retry must not repeat the same path)', () => {
  function openFloor () {
    const w = makeWorld()
    w.fill(-5, 63, -5, 5, 63, 5, 'stone')
    return w
  }
  const flat = { canDig: false, allow1by1towers: false, allowParkour: false }

  function eastMove (m) {
    return m.getNeighbors(nodeAt(0, 64, 0)).find(n => n.x === 1 && n.z === 0)
  }

  it('leaves a logged stuck place out of the neighbours', () => {
    const bot = makeBot(openFloor())
    const m = mv(bot, flat)
    const before = m.getNeighbors(nodeAt(0, 64, 0))
    const east = before.find(n => n.x === 1 && n.z === 0)
    assert.ok(east, 'precondition: east is normally reachable')

    bot.pathfinder.stuckPlaces = new Map([[east.hash, { hash: east.hash, expires: performance.now() + 60000 }]])
    const after = m.getNeighbors(nodeAt(0, 64, 0))
    assert.ok(!after.some(n => n.hash === east.hash), 'the stuck place must not be planned through')
    assert.strictEqual(after.length, before.length - 1, 'only the stuck place should be removed')
  })

  it('forgets a stuck place once it has expired', () => {
    const bot = makeBot(openFloor())
    const m = mv(bot, flat)
    const east = eastMove(m)
    bot.pathfinder.stuckPlaces = new Map([[east.hash, { hash: east.hash, expires: performance.now() - 1 }]])
    assert.ok(eastMove(m), 'an expired entry must no longer block the cell')
    assert.strictEqual(bot.pathfinder.stuckPlaces.size, 0, 'the expired entry should be dropped')
  })

  it('is a no-op when nothing has been logged', () => {
    const bot = makeBot(openFloor())
    const m = mv(bot, flat)
    bot.pathfinder.stuckPlaces = new Map()
    assert.ok(eastMove(m))
  })

  it('keeps a boat cell and the walkable cell at the same coordinates apart', () => {
    const w = makeWorld()
    w.fill(-4, 60, -4, 0, 63, 4, 'stone')
    w.fill(1, 60, -4, 8, 62, 4, 'stone')
    w.fill(1, 63, -4, 8, 63, 4, 'water')
    const bot = makeBot(w, { items: ['oak_boat'] })
    const m = mv(bot, { allowBoating: true })
    const embark = m.getNeighbors(nodeAt(0, 64, 0)).find(n => n.boat && n.x === 1 && n.z === 0)
    assert.ok(embark, 'precondition: an embark onto (1,63,0)')
    bot.pathfinder.stuckPlaces = new Map([[embark.hash, { hash: embark.hash, expires: performance.now() + 60000 }]])
    assert.ok(!m.getNeighbors(nodeAt(0, 64, 0)).some(n => n.hash === embark.hash), 'the stuck embark is skipped')
  })
})

describe('never cut a corner (diagonals need both flanks open)', () => {
  // Flat floor, top y=63 -> feet y=64. Bot at (0,64,0); the diagonal goes to (1,64,1).
  function floor () {
    const w = makeWorld()
    w.fill(-4, 63, -4, 4, 63, 4, 'stone')
    return w
  }
  const opts = { canDig: false, allow1by1towers: false, allowParkour: false }
  const diagonalTo = (m) => m.getNeighbors(nodeAt(0, 64, 0)).find(n => n.x === 1 && n.z === 1)

  it('still takes a diagonal across open ground', () => {
    const m = mv(makeBot(floor()), opts)
    assert.ok(diagonalTo(m), 'both flanks are open, so the diagonal is fine')
  })

  it('refuses a diagonal that would graze a block on the x flank', () => {
    const w = floor()
    w.set(1, 64, 0, 'stone')
    const m = mv(makeBot(w), opts)
    assert.strictEqual(diagonalTo(m), undefined, 'must not round the corner of the block at (1,64,0)')
  })

  it('refuses a diagonal that would graze a block on the z flank', () => {
    const w = floor()
    w.set(0, 64, 1, 'stone')
    const m = mv(makeBot(w), opts)
    assert.strictEqual(diagonalTo(m), undefined, 'must not round the corner of the block at (0,64,1)')
  })

  it('treats a block at head height as a corner too', () => {
    const w = floor()
    w.set(1, 65, 0, 'stone') // above the flank cell, still in the bot's path
    const m = mv(makeBot(w), opts)
    assert.strictEqual(diagonalTo(m), undefined)
  })

  it('goes round with straight steps instead', () => {
    const w = floor()
    w.fill(1, 64, 0, 1, 65, 0, 'stone') // two high, so it is a wall and not a step
    const m = mv(makeBot(w), opts)
    const n = m.getNeighbors(nodeAt(0, 64, 0))
    assert.ok(n.some(x => x.x === 0 && x.z === 1), 'a straight step south must remain available')
    assert.ok(!n.some(x => x.x === 1 && x.z === 0), 'the blocked cell is not walkable')
    const second = m.getNeighbors(nodeAt(0, 64, 1))
    assert.ok(second.some(x => x.x === 1 && x.z === 1), 'and from there a straight step east completes the detour')
  })

  it('does not dig a flank out to make a diagonal', () => {
    const w = floor()
    w.set(1, 64, 0, 'stone')
    const m = mv(makeBot(w), { canDig: true, allow1by1towers: false, allowParkour: false })
    assert.strictEqual(diagonalTo(m), undefined, 'a diagonal that needs a flank broken is still a corner cut')
  })

  it('allowCornerCutting restores the old behaviour', () => {
    const w = floor()
    w.set(1, 64, 0, 'stone')
    const m = mv(makeBot(w), { ...opts, allowCornerCutting: true })
    assert.ok(diagonalTo(m), 'with the flag on the diagonal is generated again')
  })
})
