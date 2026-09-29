/* eslint-env mocha */

// Every suite of test/internalTest.js, run against a REAL vanilla server instead of the fake
// one. internalTest.js is untouched and keeps running against its fake server; this is the
// same suites, ported. test/live/realWorld.js explains what changes and why:
//
//   - the arenas are built with real /fill and /setblock commands, at the same coordinates
//   - a test that only plans paths keeps its local tricks (teleporting by assignment, items
//     in the client's inventory, made-up entities) and runs with the bot's physics off, so
//     the server never hears about them
//   - a test that really moves, mines, builds or equips uses real /tp, /give and /summon,
//     and the arena is rebuilt after a test that changes it
//
// Skipped unless PF_LIVE=1. Run it with `npm run test:live`, or `npm test --v2`, or
// `node scripts/live-server.js --accept-eula` (which also starts the server).
//
// PF_LIVE_GREP=<text> runs only the suites/tests whose name contains <text>.
//
// Every bot writes a movement log (its position each tick, the blocks it touches, what the server
// did to it) to <server dir>/movement-logs/<username>.log, with each test's name marked in it.
// PF_LIVE_MOVELOG=console prints it live; PF_LIVE_MOVELOG=off disables it. See lib/movelog.js.

const { goals, pathfinder, Movements, createHuman } = require('../..')
const { Vec3 } = require('vec3')
const assert = require('assert')
const { once } = require('events')
const Physics = require('../../lib/physics')
const { stateIdOf } = require('../support/world')
const world = require('./realWorld')

const live = process.env.PF_LIVE === '1'
const suite = live ? describe : describe.skip

const Version = world.Version
// The real server is slower than a fake one that answers instantly, and every test that
// walks sets its own timeout for the fake: give each of them this many times as long.
const SLOWDOWN = 4

beforeEach(function () {
  world.markTest(this.currentTest.fullTitle())
})

// When a test fails, show right away what every bot was doing: its state and the tail of its
// movement log (positions, blocks touched, dig/place/path events, what the server did to it).
afterEach(function () {
  if (this.currentTest && this.currentTest.state === 'failed') world.dumpAllRecent(30)
})

function add1x2Weight (entityIntersections, posX, posY, posZ, weight = 1) {
  entityIntersections[`${posX},${posY},${posZ}`] = entityIntersections[`${posX},${posY},${posZ}`] ?? 0
  entityIntersections[`${posX},${posY + 1},${posZ}`] = entityIntersections[`${posX},${posY + 1},${posZ}`] ?? 0

  entityIntersections[`${posX},${posY},${posZ}`] += weight
  entityIntersections[`${posX},${posY + 1},${posZ}`] += weight
}

suite('pathfinder Goals', function () {
  const targetBlock = new Vec3(12, 1, 8) // a gold block away from the spawn position
  const spawnPos = new Vec3(8.5, 1, 8.5) // Center of the chunk & center of the block

  /** @type { import('mineflayer').Bot & { pathfinder: import('mineflayer-pathfinder').Pathfinder }} */
  let bot

  before(async () => {
    bot = await world.join('goals', world.flatArena(), spawnPos, { physics: false })
  })
  after(async () => {
    await world.leave(bot)
    bot = null
  })

  describe('Goals', () => {
    beforeEach(() => {
      bot.entity.position = spawnPos.clone()
    })

    it('GoalBlock', () => {
      const goal = new goals.GoalBlock(targetBlock.x, targetBlock.y, targetBlock.z)
      assert.ok(!goal.isEnd(bot.entity.position))
      bot.entity.position = targetBlock.clone()
      assert.ok(goal.isEnd(bot.entity.position))
    })

    it('GoalNear', () => {
      const goal = new goals.GoalNear(targetBlock.x, targetBlock.y, targetBlock.z, 1)
      assert.ok(!goal.isEnd(bot.entity.position))
      bot.entity.position = targetBlock.offset(1, 0, 0)
      assert.ok(goal.isEnd(bot.entity.position))
    })

    it('GoalXZ', () => {
      const goal = new goals.GoalXZ(targetBlock.x, targetBlock.z)
      assert.ok(!goal.isEnd(bot.entity.position))
      bot.entity.position = targetBlock.offset(0, 1, 0)
      assert.ok(goal.isEnd(bot.entity.position))
    })

    it('GoalNearXZ', () => {
      const goal = new goals.GoalNearXZ(targetBlock.x, targetBlock.z, 1)
      assert.ok(!goal.isEnd(bot.entity.position))
      bot.entity.position = targetBlock.offset(1, 0, 0)
      assert.ok(goal.isEnd(bot.entity.position))
    })

    it('GoalY', () => {
      const goal = new goals.GoalY(targetBlock.y + 1)
      assert.ok(!goal.isEnd(bot.entity.position))
      bot.entity.position = targetBlock.offset(0, 1, 0)
      assert.ok(goal.isEnd(bot.entity.position))
    })

    it('GoalGetToBlock', () => {
      const goal = new goals.GoalGetToBlock(targetBlock.x, targetBlock.y, targetBlock.z)
      assert.ok(!goal.isEnd(bot.entity.position))
      bot.entity.position = targetBlock.offset(1, 0, 0)
      assert.ok(goal.isEnd(bot.entity.position))
    })

    it('GoalCompositeAny', () => {
      const targetBlock2 = new Vec3(10, 1, 0)
      const goal1 = new goals.GoalBlock(targetBlock.x, targetBlock.y, targetBlock.z)
      const goal2 = new goals.GoalBlock(targetBlock2.x, targetBlock2.y, targetBlock2.z)
      const goalComposite = new goals.GoalCompositeAny()
      goalComposite.goals = [goal1, goal2]
      assert.ok(!goalComposite.isEnd(bot.entity.position))
      bot.entity.position = targetBlock.clone()
      assert.ok(goalComposite.isEnd(bot.entity.position)) // target block 1
      bot.entity.position = targetBlock2.clone()
      assert.ok(goalComposite.isEnd(bot.entity.position)) // target block 2
    })

    it('GoalCompositeAll', () => {
      const targetBlock = new Vec3(2, 1, 0)
      const block2 = new Vec3(3, 1, 0)
      const goal1 = new goals.GoalBlock(targetBlock.x, targetBlock.y, targetBlock.z)
      const goal2 = new goals.GoalNear(block2.x, block2.y, block2.z, 2)
      const goalComposite = new goals.GoalCompositeAll()
      goalComposite.goals = [goal1, goal2]
      assert.ok(!goalComposite.isEnd(bot.entity.position))
      bot.entity.position = targetBlock.offset(0, 0, 0)
      assert.ok(goalComposite.isEnd(bot.entity.position))
    })

    it('GoalInvert', () => {
      const goalBlock = new goals.GoalBlock(targetBlock.x, targetBlock.y, targetBlock.z)
      const goal = new goals.GoalInvert(goalBlock)
      bot.entity.position = targetBlock.clone()
      assert.ok(!goal.isEnd(bot.entity.position))
      bot.entity.position = new Vec3(0, 1, 0)
      assert.ok(goal.isEnd(bot.entity.position))
    })

    it('GoalPlaceBlock', () => {
      const placeTarget = targetBlock.offset(0, 1, 0)
      const goal = new goals.GoalPlaceBlock(placeTarget, bot.world, {})
      bot.entity.position = targetBlock.offset(-5, 0, 0) // to far away to reach
      assert.ok(!goal.isEnd(bot.entity.position.floored()))
      bot.entity.position = targetBlock.offset(-2, 0, 0)
      assert.ok(goal.isEnd(bot.entity.position.floored()))
    })

    it('GoalLookAtBlock', () => {
      const breakTarget = targetBlock.clone() // should be a gold block or any other block thats dig able
      const goal = new goals.GoalLookAtBlock(breakTarget, bot.world, { reach: 3 })
      assert.ok(!goal.isEnd(bot.entity.position.floored()))
      bot.entity.position = targetBlock.offset(-2, 0, 0) // should now be close enough
      assert.ok(goal.isEnd(bot.entity.position.floored()))
    })
  })

  describe('Goals with entity', () => {
    beforeEach(() => {
      bot.entity.position = spawnPos.clone()
    })
    before(async () => {
      // A real chicken with no AI, so it stays where it is put.
      await world.summon(bot, 'chicken', targetBlock.offset(0.5, 1, 0.5))
    })

    it('GoalFollow', () => {
      // Match by name, not "whatever is nearest": on a real, possibly-reused server other
      // entities (a leftover chicken from an earlier run, a dropped item, ...) can be closer
      // to the bot than the one this test just summoned, which silently points the goal at
      // the wrong coordinates.
      const entity = bot.nearestEntity(e => e.name === 'chicken') || { position: targetBlock.offset(0, 1, 0) }
      const goal = new goals.GoalFollow(entity, 1)
      assert.ok(!goal.isEnd(bot.entity.position))
      bot.entity.position = targetBlock.clone()
      assert.ok(goal.isEnd(bot.entity.position))
    })
  })
})

suite('pathfinder events', function () {
  const mcData = require('minecraft-data')(Version)

  const targetBlock = new Vec3(12, 1, 8) // a gold block away from the spawn position
  const spawnPos = new Vec3(8.5, 1, 8.5) // Center of the chunk & center of the block

  /** @type { import('mineflayer').Bot & { pathfinder: import('mineflayer-pathfinder').Pathfinder }} */
  let bot

  before(async () => {
    bot = await world.join('events', world.flatArena(), spawnPos)
    bot.loadPlugin(pathfinder)
    bot.pathfinder.setMovements(new Movements(bot, mcData))
  })
  after(async () => {
    await world.leave(bot)
    bot = null
  })

  describe('events', async function () {
    beforeEach(async () => {
      await world.tp(bot, spawnPos)
    })
    afterEach((done) => {
      bot.pathfinder.setGoal(null)
      setTimeout(done)
      const listeners = ['goal_reached', 'goal_updated', 'path_update', 'path_stop']
      listeners.forEach(l => bot.removeAllListeners(l))
    })

    it('goal_reached', function (done) {
      this.timeout(3000 * SLOWDOWN)
      this.slow(1000)
      bot.once('goal_reached', () => done())
      bot.pathfinder.setGoal(new goals.GoalNear(targetBlock.x, targetBlock.y, targetBlock.z, 1))
    })

    it('goal_updated', function (done) {
      this.timeout(100 * SLOWDOWN)
      bot.once('goal_updated', () => done())
      bot.pathfinder.setGoal(new goals.GoalNear(targetBlock.x, targetBlock.y, targetBlock.z, 1))
    })

    it('path_update', function (done) {
      this.timeout(3000 * SLOWDOWN)
      this.slow(1000)
      bot.pathfinder.setGoal(new goals.GoalNear(targetBlock.x, targetBlock.y, targetBlock.z, 1))
      bot.once('path_update', () => done())
    })

    it('path_stop', function (done) {
      this.timeout(3000 * SLOWDOWN)
      this.slow(1000)
      bot.pathfinder.setGoal(new goals.GoalNear(targetBlock.x, targetBlock.y, targetBlock.z, 1))
      bot.once('path_stop', () => done())
      bot.pathfinder.stop()
    })
  })
})

suite('pathfinder util functions', function () {
  const mcData = require('minecraft-data')(Version)

  const targetBlock = new Vec3(12, 1, 8) // a gold block away from the spawn position
  const spawnPos = new Vec3(8.5, 1, 8.5) // Center of the chunk & center of the block

  const itemsToGive = [['diamond_pickaxe', 1], ['dirt', 64]]

  /** @type { import('mineflayer').Bot & { pathfinder: import('mineflayer-pathfinder').Pathfinder }} */
  let bot

  before(async () => {
    bot = await world.join('util', world.flatArena(), spawnPos)
    await world.resetInventory(bot, itemsToGive)
    bot.loadPlugin(pathfinder)
    bot.pathfinder.setMovements(new Movements(bot, mcData))
  })
  after(async () => {
    await world.leave(bot)
    bot = null
  })

  describe('paththing', function () {
    // These tests mine and build for real: put the gold block back, take the bot home and hand out
    // fresh items before the next one.
    this.afterEach(async () => {
      bot.pathfinder.setGoal(null)
      bot.stopDigging()
      bot.clearControlStates()
      await world.rebuild(bot)
      await world.tp(bot, spawnPos)
      await world.resetInventory(bot, itemsToGive)
    })

    it('Goto', async function () {
      this.timeout(3000 * SLOWDOWN)
      this.slow(1500)
      await bot.pathfinder.goto(new goals.GoalGetToBlock(targetBlock.x, targetBlock.y, targetBlock.z))
    })

    it('Goto rejects when there is no path to the goal', async function () {
      this.timeout(10000 * SLOWDOWN)
      const strict = new Movements(bot, mcData)
      strict.canDig = false
      strict.allow1by1towers = false
      strict.scafoldingBlocks = []
      bot.pathfinder.setMovements(strict)
      try {
        // Five blocks straight up with nothing to build or climb on: every neighbour is further from
        // the goal than the start, so A* gives back 'noPath' with an empty path.
        await assert.rejects(
          bot.pathfinder.goto(new goals.GoalBlock(Math.floor(spawnPos.x), spawnPos.y + 5, Math.floor(spawnPos.z))),
          { name: 'NoPath' }
        )
      } finally {
        bot.pathfinder.setMovements(new Movements(bot, mcData))
      }
    })

    it('stop() while the bot is not pathing does not abort the next goal', async function () {
      this.timeout(3000 * SLOWDOWN)
      this.slow(1500)
      bot.pathfinder.stop()
      await bot.pathfinder.goto(new goals.GoalGetToBlock(targetBlock.x, targetBlock.y, targetBlock.z))
    })

    it('isMoving', function (done) {
      bot.pathfinder.setGoal(new goals.GoalGetToBlock(targetBlock.x, targetBlock.y, targetBlock.z))
      const foo = () => {
        if (bot.pathfinder.isMoving()) {
          bot.removeListener('physicTick', foo)
          done()
        }
      }
      bot.on('physicTick', foo)
    })

    // Note: Ordering seams to matter when running the isBuilding test. If run after isMining isBuilding does not seam to work.
    it('isBuilding', function (done) {
      this.timeout(5000 * SLOWDOWN)
      this.slow(1500)

      bot.pathfinder.setGoal(new goals.GoalBlock(targetBlock.x, targetBlock.y + 2, targetBlock.z))
      const foo = () => {
        if (bot.pathfinder.isBuilding()) {
          bot.removeListener('physicTick', foo)
          bot.stopDigging()
          done()
        }
      }
      bot.on('physicTick', foo)
    })

    it('isMining', function (done) {
      this.timeout(5000 * SLOWDOWN)
      this.slow(1500)

      const gold = bot.blockAt(targetBlock)
      const held = bot.pathfinder.bestHarvestTool(gold)
      const digTime = gold ? gold.digTime(held ? held.type : null, false, false, false, [], bot.entity.effects) : NaN
      // The planner learns where entities are from a collision index it rebuilds before every search, and
      // outside a search that index is empty - so pricing the block without rebuilding it could not see the
      // one thing that makes the planner refuse to break it: an entity standing on top (it would fall).
      const movements = bot.pathfinder.movements
      movements.clearCollisionIndex()
      movements.updateCollisionIndex()
      const price = movements.safeOrBreak(gold, [])
      const entitiesAbove = movements.getNumEntitiesAt(gold.position, 0, 1, 0)
      movements.clearCollisionIndex()
      const nearby = Object.values(bot.entities)
        .filter(e => e !== bot.entity && e.position && e.position.distanceTo(gold.position.offset(0.5, 0.5, 0.5)) < 3)
        .map(e => `${e.name}@${e.position.x.toFixed(1)},${e.position.y.toFixed(1)},${e.position.z.toFixed(1)}`)
      const summary = `block=${gold && gold.name} tool=${held ? held.name : 'none'} digTime=${digTime}ms canDig=${movements.canDig} safeOrBreak=${price} entitiesAbove=${entitiesAbove} entitiesWithin3=[${nearby.join(' ')}]`
      if (bot.pfMoveLog) bot.pfMoveLog.event('MINING-CHECK', summary)
      if (!Number.isFinite(digTime) || !Number.isFinite(price) || price >= 100) {
        return done(new Error(`the planner cannot price breaking the block, so it will never plan to dig it${entitiesAbove > 0 ? ' (something is standing on it - a leftover mob from an earlier suite?)' : ''}: ${summary}`))
      }

      bot.pathfinder.setGoal(new goals.GoalBlock(targetBlock.x, targetBlock.y, targetBlock.z))
      const foo = () => {
        if (bot.pathfinder.isMining()) {
          bot.removeListener('physicTick', foo)
          bot.stopDigging()
          done()
        }
      }
      bot.on('physicTick', foo)
    })
  })

  it('bestHarvestTool', function () {
    const block = bot.blockAt(targetBlock)
    const tool = bot.pathfinder.bestHarvestTool(block)
    assert.ok(tool, 'no harvest tool found')
    assert.strictEqual(tool.type, mcData.itemsByName.diamond_pickaxe.id)
  })

  it('getPathTo', function () {
    const path = bot.pathfinder.getPathTo(bot.pathfinder.movements, new goals.GoalGetToBlock(targetBlock.x, targetBlock.y, targetBlock.z))
    // All depends on the actually path that gets generated. If target block is moved some were else these values have to change.
    assert.strictEqual(path.status, 'success')
    assert.ok(path.visitedNodes < 5, `Generated path visited nodes to high (${path.visitedNodes} < 5)`)
    assert.ok(path.generatedNodes < 30, `Generated path nodes to high (${path.generatedNodes} < 30)`)
    assert.ok(path.path.length === 3, `Generated path length wrong (${path.path.length} === 3)`)
    assert.ok(path.time < 50, `Generated path took too long (${path.time} < 50)`)
  })
})

suite('pathfinder Movement', function () {
  const mcData = require('minecraft-data')(Version)
  const Item = require('prismarine-item')(Version)
  const Block = require('prismarine-block')(Version)

  const targetBlock = new Vec3(12, 1, 8) // a gold block away from the spawn position
  const spawnPos = new Vec3(8.5, 1, 8.5) // Center of the chunk & center of the block

  /** @type { import('mineflayer').Bot & { pathfinder: import('mineflayer-pathfinder').Pathfinder }} */
  let bot
  /** @type { import('mineflayer-pathfinder').Movements } */
  let defaultMovement

  const itemsToGive = [new Item(mcData.itemsByName.diamond_pickaxe.id, 1), new Item(mcData.itemsByName.dirt.id, 64)]

  before(async () => {
    bot = await world.join('movement', world.flatArena(), spawnPos, { physics: false })
    itemsToGive.forEach(item => {
      const slot = bot.inventory.firstEmptyHotbarSlot()
      bot.inventory.slots[slot] = item
    })
    defaultMovement = new Movements(bot, mcData)
    bot.loadPlugin(pathfinder)
    bot.pathfinder.setMovements(defaultMovement)
  })
  after(async () => {
    await world.leave(bot)
    bot = null
  })

  it('countScaffoldingItems', function () {
    assert.strictEqual(defaultMovement.countScaffoldingItems(), 64)
  })

  it('getScaffoldingItem', function () {
    assert.strictEqual(defaultMovement.getScaffoldingItem(), itemsToGive[1])
  })

  it('getBlock', function () {
    assert.ok(defaultMovement.getBlock(targetBlock, 0, 0, 0).type === mcData.blocksByName.gold_block.id)
  })

  describe('safeToBreak world editing', function () {
    this.afterAll(async () => {
      defaultMovement.canDig = true
      await bot.world.setBlock(targetBlock.offset(1, 0, 0), Block.fromStateId(stateIdOf(mcData, 'air'), 0))
    })

    it('safeToBreak', async function () {
      const block = bot.blockAt(targetBlock)
      assert.ok(defaultMovement.safeToBreak(block))
      defaultMovement.canDig = false
      assert.ok(!defaultMovement.safeToBreak(block))
      defaultMovement.canDig = true
      await bot.world.setBlock(targetBlock.offset(1, 0, 0), Block.fromStateId(stateIdOf(mcData, 'water'), 0))
      assert.ok(!defaultMovement.safeToBreak(block))
    })
  })

  it('safeOrBreak', function () {
    const block = defaultMovement.getBlock(targetBlock, 0, 0, 0)
    const toBreak = []
    const extraValue = defaultMovement.safeOrBreak(block, toBreak)
    assert.ok(extraValue < 100, `safeOrBreak to high for block (${extraValue} < 100)`)
    assert.ok(toBreak.length === 1, `safeOrBreak toBreak array wrong length ${toBreak.length} (${toBreak.length} === 1)`)
  })

  it('getMoveJumpUp', function () {
    const block = defaultMovement.getBlock(targetBlock, -1, 0, 0)
    const dir = new Vec3(1, 0, 0)
    const neighbors = []
    defaultMovement.getMoveJumpUp(block.position, dir, neighbors)
    assert.ok(neighbors.length === 1, `getMoveJumpUp neighbors not right length (${neighbors.length} === 1)`)
  })

  it('getMoveForward', function () {
    const dir = new Vec3(1, 0, 0)
    const neighbors = []
    defaultMovement.getMoveForward(targetBlock, dir, neighbors)
    assert.ok(neighbors.length === 1, `getMoveForward neighbors not right length (${neighbors.length} === 1)`)
  })

  it('getMoveDiagonal', function () {
    // getMoveDiagonal expects an actual diagonal (both x and z non-zero) - see
    // Movements.generateNeighbors, which only ever calls it with entries from
    // diagonalDirections. (1, 0, 0) is a cardinal, not a diagonal; on an open
    // flat map it happened not to trip the corner-cutting check, but it was
    // never exercising the code path this test is meant to cover.
    const dir = new Vec3(1, 0, 1)
    const neighbors = []
    defaultMovement.getMoveDiagonal(targetBlock, dir, neighbors)
    assert.ok(neighbors.length === 1, `getMoveDiagonal neighbors not right length (${neighbors.length} === 1)`)
  })

  it('getLandingBlock', function () {
    const node = targetBlock.offset(-1, 3, 0)
    const dir = new Vec3(1, 0, 0)
    const block = defaultMovement.getLandingBlock(node, dir)
    assert.ok(block != null, 'Landing block is null')
    if (!block) return
    assert.ok(block.type === mcData.blocksByName.air.id, `getLandingBlock not the right block (${block.name} === air)`)
    assert.ok(block.position.offset(0, -1, 0).distanceSquared(targetBlock) === 0, `getLandingBlock not landing (${block.position.offset(0, -1, 0).distanceSquared(targetBlock)}) on target block: ${defaultMovement.getBlock(block.position, 0, -1, 0).name}`)
  })

  it('getMoveDropDown', function () {
    const dir = new Vec3(1, 0, 0)
    const neighbors = []
    defaultMovement.getMoveDropDown(targetBlock.offset(-1, 4, 0), dir, neighbors)
    assert.ok(neighbors.length === 1, `getMoveDropDown neighbors not right length (${neighbors.length} === 1)`)
  })

  it('getMoveDown', function () {
    const neighbors = []
    defaultMovement.getMoveDown(targetBlock.offset(0, 4, 0), neighbors)
    assert.ok(neighbors.length === 1, `getMoveDown neighbors not right length (${neighbors.length} === 1)`)
  })

  it('getMoveUp', function () {
    const neighbors = []
    defaultMovement.getMoveUp(targetBlock.offset(0, 1, 0), neighbors)
    assert.ok(neighbors.length === 1, `getMoveUp neighbors not right length (${neighbors.length} === 1)`)
  })

  it('getNeighbors', function () {
    const neighbors = defaultMovement.getNeighbors(targetBlock.offset(0, 1, 0))
    assert.ok(neighbors.length > 0, 'getNeighbors length 0')
  })
})

suite('Parkour path test', function () {
  const mcData = require('minecraft-data')(Version)

  const spawnPos = new Vec3(8.5, 1, 8.5) // Center of the chunk & center of the block

  /** @type { import('mineflayer').Bot & { pathfinder: import('mineflayer-pathfinder').Pathfinder }} */
  let bot
  /** @type { import('mineflayer-pathfinder').Movements } */
  let defaultMovement

  const parkourSpawn1 = new Vec3(0.5, 3, 12.5)
  const parkourSpawn2 = new Vec3(5.5, 3, 12.5)

  before(async () => {
    this.timeout(180000)
    bot = await world.join('parkour', await world.parkourArena(Version), spawnPos, { physics: false })
    defaultMovement = new Movements(bot, mcData)
    bot.loadPlugin(pathfinder)
    bot.pathfinder.setMovements(defaultMovement)
  })
  after(async () => {
    await world.leave(bot)
    bot = null
  })

  it('getMoveParkourForward-1', function () {
    const dirs = [new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
    for (let i = 0; i < dirs.length; i++) {
      const dir = dirs[i] // only 2 dirs as the schematic parkour1.schem only has 2 other blocks to path to.
      const neighbors = []
      defaultMovement.getMoveParkourForward(parkourSpawn1, dir, neighbors)
      assert.ok(neighbors.length === 1, `getMoveParkourForward jump off gold block neighbors not right length (${neighbors.length} === 1)`)
    }
  })

  it('getMoveParkourForward-2', function () {
    const dirs = [new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)]
    for (let i = 0; i < dirs.length; i++) {
      const dir = dirs[i]
      const neighbors = []
      defaultMovement.getMoveParkourForward(parkourSpawn2, dir, neighbors)
      assert.ok(neighbors.length === 1, `getMoveParkourForward jump off gold block neighbors not right length (${neighbors.length} === 1)`)
    }
  })
})

suite('Physics test', function () {
  const mcData = require('minecraft-data')(Version)

  const spawnPos = new Vec3(8.5, 1, 8.5) // Center of the chunk & center of the block

  /** @type { import('mineflayer').Bot & { pathfinder: import('mineflayer-pathfinder').Pathfinder }} */
  let bot
  /** @type { import('mineflayer-pathfinder').Movements } */
  let defaultMovement

  const parkourSpawn1 = new Vec3(0.5, 3, 12.5)
  // const parkourSpawn2 = new Vec3(5.5, 3, 12.5)

  before(async () => {
    this.timeout(180000)
    bot = await world.join('physics', await world.parkourArena(Version), spawnPos)
    defaultMovement = new Movements(bot, mcData)
    bot.loadPlugin(pathfinder)
    bot.pathfinder.setMovements(defaultMovement)
  })
  after(async () => {
    await world.leave(bot)
    bot = null
  })

  it('simulateUntil', async function () {
    this.slow(1000)
    this.timeout(2000 * SLOWDOWN)
    const ticksToSimulate = 10
    const ticksPressForward = 5

    await world.tp(bot, parkourSpawn1)
    bot.entity.velocity = new Vec3(0, 0, 0)

    // Wait for the bot to be on the ground so bot.entity.onGround == true
    bot.clearControlStates()
    await once(bot, 'physicTick')
    await once(bot, 'physicTick')

    const physics = new Physics(bot)
    const pressed = (counter) => counter <= ticksPressForward

    // Everything happens inside physicsTick, which mineflayer emits right AFTER a physics step. So at
    // the first call the bot is exactly at a tick boundary: simulate from here, and set the inputs the
    // simulator uses for its step `counter` now, before the real step that follows. When the handler
    // has run `ticksToSimulate` times, that many real steps have been taken, and the bot and the
    // simulation are at the same tick.
    const { simulated, real } = await new Promise((resolve) => {
      let counter = 0
      let simulatedState = null
      const onTick = () => {
        if (counter === 0) {
          simulatedState = physics.simulateUntil(() => false, (state, step) => {
            state.control.forward = pressed(step)
            state.control.jump = pressed(step)
          }, ticksToSimulate)
        }
        if (counter === ticksToSimulate) {
          bot.removeListener('physicsTick', onTick)
          bot.clearControlStates()
          resolve({ simulated: simulatedState, real: bot.entity.position.clone() })
          return
        }
        bot.setControlState('forward', pressed(counter))
        bot.setControlState('jump', pressed(counter))
        counter++
      }
      bot.on('physicsTick', onTick)
    })

    assert.ok(real.distanceSquared(simulated.pos) < 0.01,
      `Simulated states don't match Bot: ${real.toString()} !== Simulation: ${simulated.pos.toString()}`
    )
  })

  // TODO: write test for simulateUntilNextTick
})

suite('pathfinder entity avoidance test', function () {
  const mcData = require('minecraft-data')(Version)

  // The tests assert one generator step finishes the search, inside a time limit. Both were tuned for a
  // fake server on an otherwise idle machine. Here a Java server, mocha and the bot share the CPU (the
  // server logs "Can't keep up" in the middle of this suite), and one search slice ran into A*'s 40 ms
  // tickTimeout and came back 'partial'. A slice of a second still finishes a 3x3 course at once, and
  // a real slowdown (a path that takes over 200 ms) still fails.
  const patherOptions = { resetEntityIntersects: false, tickTimeout: 1000 }
  const maxPathTime = 50 * SLOWDOWN

  const spawnPos = new Vec3(8.5, 1.0, 8.5) // Center of the chunk & center of the block

  /** @type { import('mineflayer').Bot & { pathfinder: import('mineflayer-pathfinder').Pathfinder }} */
  let bot

  before(async () => {
    bot = await world.join('avoid', await world.parkourArena(Version), spawnPos, { physics: false })

    bot.loadPlugin(pathfinder)
    bot.pathfinder.setMovements(new Movements(bot, mcData))
  })

  after(async () => {
    await world.leave(bot)
    bot = null
  })

  /**
  * Ensure algorithm does not impede performance when handling a large number of entities
  */
  it('entityIndexPerformance', () => {
    const { performance } = require('perf_hooks')

    const targetBlock = new Vec3(11.5, 2.0, 10.5) // a gold block away from the spawn position
    const startPos = new Vec3(11.5, 2.0, 14.5) // Start point for test

    const goal = new goals.GoalGetToBlock(targetBlock.x, targetBlock.y, targetBlock.z)

    for (let i = 1; i <= 10000; i++) {
      const pos = (i % 2) === 0 ? new Vec3(10.5, 2.0, 12.5) : new Vec3(12.5, 2.0, 12.5)
      bot.entities[i] = { name: 'testEntity', position: pos, height: 2.0, width: 1.0 }
    }

    const beforeTime = performance.now()

    const generator = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, startPos, goal)
    const { value: { result } } = generator.next()

    const timeElapsed = performance.now() - beforeTime

    bot.pathfinder.movements.clearCollisionIndex()
    for (let i = 1; i <= 10000; i++) {
      delete bot.entities[i]
    }

    assert.ok(timeElapsed < maxPathTime, `Generated path took too long (${result.time} < ${maxPathTime})`)
  })

  /**
   * Tests if bot will prefer a basic path with less entities
   * The test course is a 3x3x2 with a divider in the center
   * [O] = Open, [W] = Wall, [S] = Start, [E] = End
   *    W E W
   *  W O O O W
   *  W O W O W
   *  W O O O W
   *    W S W
   */
  describe('Weighted Path Avoidance', () => {
    const targetBlock = new Vec3(11.5, 2.0, 10.5) // a gold block away from the spawn position
    const startPos = new Vec3(11.5, 2.0, 14.5) // Start point for test
    const firstLeftNode = new Vec3(10.5, 2.0, 12.5)
    const firstRightNode = new Vec3(12.5, 2.0, 12.5)

    /**
     * Which side of the divider a path goes round. The side cell is looked for anywhere
     * on the path: with allowCornerCutting off there is no diagonal off the start, so the
     * route is (11,13) -> (10,13) -> (10,12) ... and the cell in the middle of a side is
     * the third node, not the first or second as it was when diagonals were allowed.
     */
    const branchesTaken = (path) => ({
      leftBranch: path.some(node => node.equals(firstLeftNode)),
      rightBranch: path.some(node => node.equals(firstRightNode))
    })

    const goal = new goals.GoalGetToBlock(targetBlock.x, targetBlock.y, targetBlock.z)

    beforeEach((done) => {
      bot.pathfinder.movements.clearCollisionIndex()
      setTimeout(done, 100)
    })

    /**
     * With no entities the two routes tie; see the assertion below.
     * [X] = Ent, [O] = Open, [W] = Wall
     *   O O O
     *   O W O
     *   O O O
     */
    it('defaultPath', () => {
      const generator = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, startPos, goal, patherOptions)
      const { value: { result } } = generator.next()
      const path = result.path

      const { leftBranch, rightBranch } = branchesTaken(path)

      // All depends on the actually path that gets generated. If target block is moved some were else these values have to change.
      assert.strictEqual(result.status, 'success')
      assert.ok(result.time < maxPathTime, `Generated path took too long (${result.time} < ${maxPathTime})`)
      // With allowCornerCutting: false (the current Movements default), the
      // diagonal through the 1-wide gap between the walls grazes both flanks
      // and is refused, so the planner goes around via two cardinal steps
      // instead of cutting straight through - length 5, not 3.
      assert.ok(path.length === 5, `Generated path length wrong (${path.length} === 5)`)
      // With no entities both ways round cost exactly the same (five unit steps), so
      // which one A* returns is a tie-break, not something to pin: it used to be a
      // diagonal path where the heap happened to prefer the left, and this test
      // mistook that for a rule. What matters is that the path commits to one side.
      assert.ok(leftBranch !== rightBranch, `Generated path must go round exactly one side [Left Branch: ${leftBranch}, Right Branch: ${rightBranch}]`)
    })

    /**
     * Ensure path with weight is avoided
     * [X] = Ent, [O] = Open, [W] = Wall
     *   O O O
     *   O W X
     *   O O O
     */
    it('rightBranchObstructed', () => {
      add1x2Weight(bot.pathfinder.movements.entityIntersections, 12, 2, 12)

      const generator = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, startPos, goal, patherOptions)
      const { value: { result } } = generator.next()
      const path = result.path

      const { leftBranch, rightBranch } = branchesTaken(path)

      // All depends on the actually path that gets generated. If target block is moved some were else these values have to change.
      assert.strictEqual(result.status, 'success')
      assert.ok(result.time < maxPathTime, `Generated path took too long (${result.time} < ${maxPathTime})`)
      // See defaultPath: allowCornerCutting: false means no diagonal shortcut
      // through the gap, so this is 5 cardinal-step nodes, not 3.
      assert.ok(path.length === 5, `Generated path length wrong (${path.length} === 5)`)
      assert.ok(leftBranch === true, `Generated path did not follow Left Branch [Left Branch: ${leftBranch}, Right Branch: ${rightBranch}]`)
    })

    /**
     * Ensure path with more weight is avoided
     * [X] = Ent, [O] = Open, [W] = Wall
     *   O O O
     *   X W X
     *   X O O
     */
    it('leftBranchMoreObstructed', () => {
      add1x2Weight(bot.pathfinder.movements.entityIntersections, 12, 2, 12)
      add1x2Weight(bot.pathfinder.movements.entityIntersections, 10, 2, 12)
      add1x2Weight(bot.pathfinder.movements.entityIntersections, 10, 2, 13)

      const generator = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, startPos, goal, patherOptions)
      const { value: { result } } = generator.next()
      const path = result.path

      const { leftBranch, rightBranch } = branchesTaken(path)

      // All depends on the actually path that gets generated. If target block is moved some were else these values have to change.
      assert.strictEqual(result.status, 'success')
      assert.ok(result.time < maxPathTime, `Generated path took too long (${result.time} < ${maxPathTime})`)
      // See defaultPath: allowCornerCutting: false means no diagonal shortcut
      // through the gap, so this is 5 cardinal-step nodes, not 3.
      assert.ok(path.length === 5, `Generated path length wrong (${path.length} === 5)`)
      assert.ok(rightBranch === true, `Generated path did not follow Right Branch [Left Branch: ${leftBranch}, Right Branch: ${rightBranch}]`)
    })

    /**
     * Ensure blocks adjacent to diagonal nodes are detected
     * [X] = Ent, [O] = Open, [W] = Wall
     *   O O X
     *   X W O
     *   O O X
     */
    it('rightBranchDiagsClear', () => {
      add1x2Weight(bot.pathfinder.movements.entityIntersections, 12, 2, 13)
      add1x2Weight(bot.pathfinder.movements.entityIntersections, 12, 2, 11)
      add1x2Weight(bot.pathfinder.movements.entityIntersections, 10, 2, 12)

      const generator = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, startPos, goal, patherOptions)
      const { value: { result } } = generator.next()
      const path = result.path

      const { leftBranch, rightBranch } = branchesTaken(path)

      // All depends on the actually path that gets generated. If target block is moved some were else these values have to change.
      assert.strictEqual(result.status, 'success')
      assert.ok(result.time < maxPathTime, `Generated path took too long (${result.time} < ${maxPathTime})`)
      // See defaultPath: allowCornerCutting: false means no diagonal shortcut
      // through the gap, so this is 5 cardinal-step nodes, not 3.
      assert.ok(path.length === 5, `Generated path length wrong (${path.length} === 5)`)
      assert.ok(leftBranch === true, `Generated path did not follow Left Branch [Left Branch: ${leftBranch}, Right Branch: ${rightBranch}]`)
    })

    /**
     * Ensure blocks adjacent to diagonal nodes are detected
     * [X] = Ent, [O] = Open, [W] = Wall
     *   X O O
     *   O W X
     *   X O O
     */
    it('leftBranchDiagsClear', () => {
      add1x2Weight(bot.pathfinder.movements.entityIntersections, 12, 2, 12)
      add1x2Weight(bot.pathfinder.movements.entityIntersections, 10, 2, 13)
      add1x2Weight(bot.pathfinder.movements.entityIntersections, 10, 2, 11)

      const generator = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, startPos, goal, patherOptions)
      const { value: { result } } = generator.next()
      const path = result.path

      const { leftBranch, rightBranch } = branchesTaken(path)

      // All depends on the actually path that gets generated. If target block is moved some were else these values have to change.
      assert.strictEqual(result.status, 'success')
      assert.ok(result.time < maxPathTime, `Generated path took too long (${result.time} < ${maxPathTime})`)
      // See defaultPath: allowCornerCutting: false means no diagonal shortcut
      // through the gap, so this is 5 cardinal-step nodes, not 3.
      assert.ok(path.length === 5, `Generated path length wrong (${path.length} === 5)`)
      assert.ok(rightBranch === true, `Generated path did not follow Right Branch [Left Branch: ${leftBranch}, Right Branch: ${rightBranch}]`)
    })
  })

  /**
   * Tests if bot will try to path where they cannot build due to an entity and whether it will
   * try to break a block that would potentially cause an entity to fall.
   * The test course is a 2x2x4 pit where the start is at the bottom and the end is at the top
   * [O] = Open, [W] = Wall, [S] = Start, [E] = End
   *   W W W E
   *   W O O W
   *   W S O W
   *   W W W W
   */
  describe('Construction Path Avoidance', () => {
    const Item = require('prismarine-item')(Version)

    const scaffoldItemId = mcData.itemsByName.dirt.id
    const groundYPos = 2
    const lidYPos = 5
    const forwardPos = { x: 11, z: 6 }
    const leftPos = { x: 10, z: 6 }
    const rightPos = { x: 11, z: 7 }
    const backPos = { x: 10, z: 7 }
    const targetBlock = new Vec3(forwardPos.x + 1.5, lidYPos + 1.0, forwardPos.z - 0.5) // a gold block away from the spawn position. One block diagonal from forward
    const startPos = new Vec3(backPos.x + 0.5, groundYPos, backPos.z + 0.5) // Start point for test
    const firstLeftNode = new Vec3(leftPos.x + 0.5, groundYPos, leftPos.z + 0.5)
    const firstRightNode = new Vec3(rightPos.x + 0.5, groundYPos, rightPos.z + 0.5)
    const firstForwardNode = new Vec3(forwardPos.x + 0.5, groundYPos, forwardPos.z + 0.5)
    const firstBackNode = startPos.clone().plus(new Vec3(-0.5, 1, -0.5)) // Jump up isn't going to half block and targets one block higher

    const blockersToPlace = [forwardPos, leftPos, rightPos, backPos]
    const goal = new goals.GoalGetToBlock(targetBlock.x, targetBlock.y, targetBlock.z)

    /** @type { number } */
    let hotbarSlot

    before(() => {
      hotbarSlot = bot.inventory.firstEmptyHotbarSlot()
    })

    beforeEach((done) => {
      bot.pathfinder.movements.clearCollisionIndex()
      bot.inventory.slots[hotbarSlot] = new Item(scaffoldItemId, 64)
      setTimeout(done, 100)
    })

    /** Put `name` in every blocker position, on the server, and wait for the client to see it. */
    const fillBlockers = async (name) => {
      for (const hPos of blockersToPlace) await world.setBlock(bot, new Vec3(hPos.x, lidYPos, hPos.z), name)
    }

    afterEach(async () => {
      await fillBlockers('air')
    })

    /**
     * By default, algorithm will favor the Backward Path
     * [X] = Ent Below, [+] = Ent Above a Block, [O] = Open, [W] = Wall
     *   W W W W
     *   W O O W
     *   W O O W
     *   W W W W
     */
    it('defaultPath', () => {
      const generator = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, startPos, goal, patherOptions)
      const { value: { result } } = generator.next()
      const path = result.path

      // Look at first and second nodes incase diagonal movements are used
      const leftBranch = (path[0].equals(firstLeftNode) || path[1].equals(firstLeftNode))
      const rightBranch = (path[0].equals(firstRightNode) || path[1].equals(firstRightNode))
      const forwardBranch = (path[0].equals(firstForwardNode) || path[1].equals(firstForwardNode))
      const backwardBranch = (path[0].equals(firstBackNode) || path[1].equals(firstBackNode))

      // All depends on the actually path that gets generated. If target block is moved some were else these values have to change.
      assert.strictEqual(result.status, 'success')
      assert.ok(result.time < maxPathTime, `Generated path took too long (${result.time} < ${maxPathTime})`)
      assert.ok(path.length === 6, `Generated path length wrong (${path.length} === 6)`)
      assert.ok(backwardBranch === true, `Generated path did not follow Backward Branch [Left Branch: ${leftBranch}, Right Branch: ${rightBranch}, Forward Branch: ${forwardBranch}, Backward Branch: ${backwardBranch}]`)
    })

    /**
     * Ensure bot finds a path when it cannot break left blocker with ent on top
     * [X] = Ent Below, [+] = Ent Above a Block, [O] = Open, [W] = Wall
     *   W W W W
     *   W O O W
     *   W + O W
     *   W W W W
     */
    it('backPathObstructed', async () => {
      const blockPos = { x: backPos.x, y: lidYPos, z: backPos.z }
      await world.setBlock(bot, new Vec3(blockPos.x, blockPos.y, blockPos.z), 'dirt')
      add1x2Weight(bot.pathfinder.movements.entityIntersections, blockPos.x, blockPos.y + 1, blockPos.z)

      const generator = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, startPos, goal, patherOptions)
      const { value: { result } } = generator.next()
      const path = result.path

      // Look at first and second nodes incase diagonal movements are used
      const leftBranch = (path[0].equals(firstLeftNode) || path[1].equals(firstLeftNode))
      const rightBranch = (path[0].equals(firstRightNode) || path[1].equals(firstRightNode))
      const forwardBranch = (path[0].equals(firstForwardNode) || path[1].equals(firstForwardNode))
      const backwardBranch = (path[0].equals(firstBackNode) || path[1].equals(firstBackNode))

      // All depends on the actually path that gets generated. If target block is moved some were else these values have to change.
      assert.strictEqual(result.status, 'success')
      assert.ok(result.time < maxPathTime, `Generated path took too long (${result.time} < ${maxPathTime})`)
      assert.ok(path.length === 6, `Generated path length wrong (${path.length} === 6)`)
      assert.ok(rightBranch === true, `Generated path did not follow Right Branch [Left Branch: ${leftBranch}, Right Branch: ${rightBranch}, Forward Branch: ${forwardBranch}, Backward Branch: ${backwardBranch}]`)
    })

    /**
     * If there are blocks capping the pit with an entity above each block, ensure bot cannot path since
     * there are no blocks that can be broken without potentially dropping an entity. Bot is expected
     * to follow forward branch for as far as possible
     * [X] = Ent Below, [+] = Ent Above a Block, [O] = Open, [W] = Wall
     *   W W W W
     *   W + + W
     *   W + + W
     *   W W W W
     */
    it('noPathsBreakingObstructed', async () => {
      await fillBlockers('dirt')
      blockersToPlace.forEach(hPos => {
        add1x2Weight(bot.pathfinder.movements.entityIntersections, hPos.x, lidYPos + 1, hPos.z)
      })

      const generator = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, startPos, goal, patherOptions)
      const { value: { result } } = generator.next()
      const path = result.path

      // Look at first and second nodes incase diagonal movements are used
      const leftBranch = (path[0].equals(firstLeftNode) || path[1].equals(firstLeftNode))
      const rightBranch = (path[0].equals(firstRightNode) || path[1].equals(firstRightNode))
      const forwardBranch = (path[0].equals(firstForwardNode) || path[1].equals(firstForwardNode))
      const backwardBranch = (path[0].equals(firstBackNode) || path[1].equals(firstBackNode))

      // All depends on the actually path that gets generated. If target block is moved some were else these values have to change.
      assert.strictEqual(result.status, 'noPath')
      assert.ok(result.time < maxPathTime, `Generated path took too long (${result.time} < ${maxPathTime})`)
      assert.ok(path.length === 2, `Generated path length wrong (${path.length} === 2)`)
      assert.ok(forwardBranch === true, `Generated path did not attempt to follow Forward Branch [Left Branch: ${leftBranch}, Right Branch: ${rightBranch}, Forward Branch: ${forwardBranch}, Backward Branch: ${backwardBranch}]`)
    })

    /**
     * If there are blocks capping the pit with an entity above each block, ensure bot can path
     * if allowed in the movements configuration
     * [X] = Ent Below, [+] = Ent Above a Block, [O] = Open, [W] = Wall
     *   W W W W
     *   W + + W
     *   W + + W
     *   W W W W
     */
    it('canPathWithBreakingObstructed', async () => {
      await fillBlockers('dirt')
      blockersToPlace.forEach(hPos => {
        add1x2Weight(bot.pathfinder.movements.entityIntersections, hPos.x, lidYPos + 1, hPos.z)
      })

      bot.pathfinder.movements.dontMineUnderFallingBlock = false
      const generator = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, startPos, goal, patherOptions)
      const { value: { result } } = generator.next()
      const path = result.path
      bot.pathfinder.movements.dontMineUnderFallingBlock = true

      // Look at first and second nodes incase diagonal movements are used
      const leftBranch = (path[0].equals(firstLeftNode) || path[1].equals(firstLeftNode))
      const rightBranch = (path[0].equals(firstRightNode) || path[1].equals(firstRightNode))
      const forwardBranch = (path[0].equals(firstForwardNode) || path[1].equals(firstForwardNode))
      const backwardBranch = (path[0].equals(firstBackNode) || path[1].equals(firstBackNode))

      // All depends on the actually path that gets generated. If target block is moved some were else these values have to change.
      assert.strictEqual(result.status, 'success')
      assert.ok(result.time < maxPathTime, `Generated path took too long (${result.time} < ${maxPathTime})`)
      assert.ok(path.length === 6, `Generated path length wrong (${path.length} === 6)`)
      assert.ok(forwardBranch === true, `Generated path did not follow Forward Branch [Left Branch: ${leftBranch}, Right Branch: ${rightBranch}, Forward Branch: ${forwardBranch}, Backward Branch: ${backwardBranch}]`)
    })

    /**
     * If there are entities filling the entire build area, ensure bot cannot path since
     * entities will prevent any block placement. Bot is expected to follow forward branch
     * for as far as possible
     * [X] = Ent Below, [+] = Ent Above a Block, [O] = Open, [W] = Wall
     *   W W W W
     *   W X X W
     *   W X X W
     *   W W W W
     */
    it('noPathsBuildingObstructed', () => {
      blockersToPlace.forEach(hPos => {
        add1x2Weight(bot.pathfinder.movements.entityIntersections, hPos.x, groundYPos, hPos.z)
      })

      const generator = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, startPos, goal, patherOptions)
      const { value: { result } } = generator.next()
      const path = result.path

      const leftBranch = path[0].equals(firstLeftNode)
      const rightBranch = path[0].equals(firstRightNode)
      const forwardBranch = path[0].equals(firstForwardNode)
      const backwardBranch = path[0].equals(firstBackNode)

      // All depends on the actually path that gets generated. If target block is moved some were else these values have to change.
      assert.strictEqual(result.status, 'noPath')
      assert.ok(result.time < maxPathTime, `Generated path took too long (${result.time} < ${maxPathTime})`)
      assert.ok(path.length === 1, `Generated path length wrong (${path.length} === 1)`)
      assert.ok(forwardBranch === true, `Generated path did not attempt to follow Forward Branch [Left Branch: ${leftBranch}, Right Branch: ${rightBranch}, Forward Branch: ${forwardBranch}, Backward Branch: ${backwardBranch}]`)
    })

    /**
     * If there are entities filling the entire build area except for one space, ensure bot finds a path
     * [X] = Ent Below, [+] = Ent Above a Block, [O] = Open, [W] = Wall
     *   W W W W
     *   W O X W
     *   W X X W
     *   W W W W
     */
    it('singlePathUnobstructed', () => {
      blockersToPlace.forEach(hPos => {
        if ((hPos.x !== leftPos.x) || (hPos.z !== leftPos.z)) {
          add1x2Weight(bot.pathfinder.movements.entityIntersections, hPos.x, groundYPos, hPos.z)
        }
      })

      const generator = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, startPos, goal, patherOptions)
      const { value: { result } } = generator.next()
      const path = result.path

      // Look at first and second nodes incase diagonal movements are used
      const leftBranch = (path[0].equals(firstLeftNode) || path[1].equals(firstLeftNode))
      const rightBranch = (path[0].equals(firstRightNode) || path[1].equals(firstRightNode))
      const forwardBranch = (path[0].equals(firstForwardNode) || path[1].equals(firstForwardNode))
      const backwardBranch = (path[0].equals(firstBackNode) || path[1].equals(firstBackNode))

      // All depends on the actually path that gets generated. If target block is moved some were else these values have to change.
      assert.strictEqual(result.status, 'success')
      assert.ok(result.time < maxPathTime, `Generated path took too long (${result.time} < ${maxPathTime})`)
      assert.ok(path.length === 6, `Generated path length wrong (${path.length} === 6)`)
      assert.ok(leftBranch === true, `Generated path did not follow Left Branch [Left Branch: ${leftBranch}, Right Branch: ${rightBranch}, Forward Branch: ${forwardBranch}, Backward Branch: ${backwardBranch}]`)
    })
  })
})

suite('human walker', function () {
  const spawnPos = new Vec3(8.5, 1, 8.5) // Center of the chunk & center of the block
  const goal = new Vec3(3.5, 1, 12.5)
  // Standing at goal (feet y=1) the bot's eye is at y = 1 + eyeHeight (~1.62), i.e. ~2.62 -
  // y=2.6 is actually AT/BELOW eye level, not above it, so pitchTo() correctly computes a
  // ~level-to-down look there and `pitch > 0` fails deterministically. Give it real margin.
  const faceAt = new Vec3(3.5, 4, 2.5)

  /** @type { import('mineflayer').Bot & { pathfinder: import('mineflayer-pathfinder').Pathfinder }} */
  let bot
  /** @type { import('mineflayer-pathfinder').Human } */
  let human

  before(async () => {
    bot = await world.join('human', world.flatArena(), spawnPos)
    bot.loadPlugin(pathfinder)
    human = createHuman(bot, { seed: 7 })
  })
  after(async () => {
    human.active = false
    await world.leave(bot)
    bot = null
  })

  it('seed reproduces a personality', function () {
    const a = createHuman(bot, { seed: 123 })
    const b = createHuman(bot, { seed: 123 })
    a.active = false
    b.active = false
    assert.deepStrictEqual(a.personality, b.personality)
    const c = createHuman(bot, { seed: 1, personality: { sprints: false } })
    c.active = false
    assert.strictEqual(c.personality.sprints, false)
  })

  it('walkTo stops at the goal facing faceAt, on the sensitivity grid', async function () {
    this.timeout(15000 * SLOWDOWN)
    this.slow(6000)
    const sens = 0.15 * Math.PI / 180
    const rotations = []
    const onMove = () => rotations.push([bot.entity.yaw, bot.entity.pitch])
    bot.on('move', onMove)
    await human.walkTo(goal, { faceAt })
    bot.off('move', onMove)

    // Check against the server's own idea of where the bot is, not the client's locally-tracked
    // position - the client's copy can be a tick or two of prediction ahead of what actually
    // landed server-side, and "did we really stop on the goal" is exactly the kind of assertion
    // that precision matters for.
    const p = await world.getServerPos(bot)
    assert.ok(Math.hypot(p.x - goal.x, p.z - goal.z) < 1, `stopped ${p} away from ${goal}`)
    assert.ok(Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < 0.02, 'still moving')
    assert.ok(human.route.length >= 2 && human.route[human.route.length - 1].equals(goal))

    const wantYaw = Math.atan2(-(faceAt.x - p.x), -(faceAt.z - p.z))
    const yawErr = Math.abs(Math.atan2(Math.sin(wantYaw - bot.entity.yaw), Math.cos(wantYaw - bot.entity.yaw)))
    assert.ok(yawErr < 2 * Math.PI / 180, `facing ${yawErr * 180 / Math.PI}° off faceAt`)
    assert.ok(bot.entity.pitch > 0, 'faceAt is above eye level, pitch should look up')

    for (const [y, pch] of rotations) {
      for (const a of [y, pch]) assert.ok(Math.abs(a / sens - Math.round(a / sens)) < 1e-6, `rotation ${a} off the sensitivity grid`)
    }
  })

  it('a rotation forced after the walk stands', async function () {
    this.timeout(15000 * SLOWDOWN)
    await world.tp(bot, spawnPos)
    await human.walkTo(goal)
    bot.entity.yaw = 1.25
    bot.entity.pitch = -0.5
    bot.emit('forcedMove')
    await bot.waitForTicks(10)
    assert.strictEqual(bot.entity.yaw, 1.25, 'yaw was pulled back after the walk')
    assert.strictEqual(bot.entity.pitch, -0.5, 'pitch was pulled back after the walk')

    await human.lookAt(faceAt)
    bot.entity.yaw = -0.75
    bot.entity.pitch = 0.25
    bot.emit('forcedMove')
    await bot.waitForTicks(10)
    assert.strictEqual(bot.entity.yaw, -0.75, 'yaw was pulled back after lookAt')
    assert.strictEqual(bot.entity.pitch, 0.25, 'pitch was pulled back after lookAt')
  })

  it('walkTo rejects when superseded', async function () {
    this.timeout(15000 * SLOWDOWN)
    await world.tp(bot, spawnPos)
    const first = human.walkTo(goal)
    const second = human.walkTo(spawnPos.offset(2, 0, 0))
    await assert.rejects(first, /superseded/)
    await second
  })

  it('walkTo reissued for the goal in flight joins that walk instead of superseding it', async function () {
    this.timeout(15000 * SLOWDOWN)
    this.slow(6000)
    await world.tp(bot, spawnPos)
    await once(bot, 'physicsTick')
    const first = human.walkTo(goal)
    // Reissued while the search is still slicing, then on a timer for the rest of the walk.
    assert.strictEqual(human.walkTo(goal.offset(0.3, 0, -0.3)), first)
    let calls = 0
    const timer = setInterval(() => {
      calls++
      const again = human.walkTo(goal)
      again.catch(() => {})
      assert.strictEqual(again, first)
    }, 100)
    try {
      await first
    } finally {
      clearInterval(timer)
    }
    assert.ok(calls >= 5, `walk ended after ${calls} reissues, too few to exercise the join`)
    const p = bot.entity.position
    assert.ok(Math.hypot(p.x - goal.x, p.z - goal.z) < 1, `stopped ${p} away from ${goal}`)
    const next = human.walkTo(goal)
    assert.notStrictEqual(next, first, 'a walk that finished was handed out again')
    await next
  })

  it('walkTo reissued for the goal in flight with different options supersedes it', async function () {
    this.timeout(15000 * SLOWDOWN)
    this.slow(6000)
    await world.tp(bot, spawnPos)
    await once(bot, 'physicsTick')
    const first = human.walkTo(goal, { radius: 5 })
    const second = human.walkTo(goal, { radius: 0.1, faceAt })
    assert.notStrictEqual(second, first, 'a tighter radius joined the loose walk')
    await assert.rejects(first, { message: 'superseded' })
    assert.strictEqual(human.walkTo(goal, { radius: 0.1, faceAt: faceAt.clone() }), second)
    const dropped = human.walkTo(goal, { radius: 0.1 })
    assert.notStrictEqual(dropped, second, 'dropping faceAt joined the walk')
    await assert.rejects(second, { message: 'superseded' })
    const third = human.walkTo(goal, { radius: 0.1, faceAt })
    await assert.rejects(dropped, { message: 'superseded' })
    await third
    const p = bot.entity.position
    assert.ok(Math.hypot(p.x - goal.x, p.z - goal.z) < 1, `stopped ${p} away from ${goal}`)
  })

  it('walkTo issued in the same turn as stop starts a fresh walk', async function () {
    this.timeout(15000 * SLOWDOWN)
    this.slow(6000)
    await world.tp(bot, spawnPos)
    await once(bot, 'physicsTick')
    const before = human.route
    const first = human.walkTo(goal)
    // Stop once this walk is under way rather than still planning.
    while (human.route === before) await once(bot, 'physicsTick')
    human.stop()
    const next = human.walkTo(goal)
    assert.notStrictEqual(next, first, 'the stopped walk was handed out again')
    await assert.rejects(first, { message: 'stopped' })
    await next
    const p = bot.entity.position
    assert.ok(Math.hypot(p.x - goal.x, p.z - goal.z) < 1, `stopped ${p} away from ${goal}`)
  })

  it('walkTo resolves when the bot already stands in the goal block', async function () {
    this.timeout(15000 * SLOWDOWN)
    await world.tp(bot, spawnPos)
    await once(bot, 'physicsTick')
    await human.walkTo(spawnPos.offset(0.2, 0, -0.2), { faceAt })
    const p = bot.entity.position
    assert.ok(Math.hypot(p.x - spawnPos.x, p.z - spawnPos.z) < 1, `walked off to ${p}`)
    const wantYaw = Math.atan2(-(faceAt.x - p.x), -(faceAt.z - p.z))
    const yawErr = Math.abs(Math.atan2(Math.sin(wantYaw - bot.entity.yaw), Math.cos(wantYaw - bot.entity.yaw)))
    assert.ok(yawErr < 2 * Math.PI / 180, `facing ${yawErr * 180 / Math.PI} deg off faceAt`)
  })

  it('a superseded walkTo stops searching instead of running out its think timeout', async function () {
    this.timeout(15000 * SLOWDOWN)
    await world.tp(bot, spawnPos)
    await once(bot, 'physicsTick')
    const realGetPath = bot.pathfinder.getPathFromTo.bind(bot.pathfinder)
    let slices = 0
    let stubbed = false
    // A search that only converges after many slices, standing in for one that runs out its think timeout.
    const SLICES = 400
    bot.pathfinder.getPathFromTo = (...args) => {
      if (stubbed) return realGetPath(...args)
      stubbed = true
      return {
        next: () => {
          slices++
          const result = { status: slices < SLICES ? 'partial' : 'timeout', path: [] }
          return { done: slices >= SLICES, value: { result } }
        }
      }
    }
    const first = human.walkTo(spawnPos.offset(0, 0, 6))
    await new Promise(resolve => setImmediate(resolve))
    const second = human.walkTo(spawnPos.offset(1, 0, 0))
    const atSupersede = slices
    await assert.rejects(first, /superseded/)
    await second
    bot.pathfinder.getPathFromTo = realGetPath
    assert.ok(slices - atSupersede <= 1, `superseded search ran ${slices - atSupersede} more slices`)
  })

  it('walkTo rejects with no path when the route ends under an unreachable goal', async function () {
    this.timeout(20000 * SLOWDOWN)
    this.slow(8000)
    await world.tp(bot, spawnPos)
    await once(bot, 'physicsTick')
    // The goal's column is a short walk away, but its level is 20 blocks up in the air.
    const above = goal.offset(0, 20, 0)
    await assert.rejects(human.walkTo(above), /no path/)
    const p = bot.entity.position
    assert.ok(Math.hypot(p.x - above.x, p.z - above.z) < 1.5, `stopped at ${p}, did not walk under the goal`)
    assert.ok(Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < 0.02, 'still moving')
  })

  it('walkTo walks to the closest reachable point before rejecting with no path', async function () {
    this.timeout(20000 * SLOWDOWN)
    this.slow(8000)
    await world.tp(bot, spawnPos)
    await once(bot, 'physicsTick')
    // Beyond the arena there is no floor at this height (the real ground is 60 blocks down), so the search ends without reaching it.
    await assert.rejects(human.walkTo(spawnPos.offset(0, 0, 60)), /no path/)
    const p = bot.entity.position
    assert.ok(p.z > spawnPos.z + 3, `stopped at ${p}, did not head for the goal`)
    assert.ok(human.route.length >= 2 && !human.route[human.route.length - 1].equals(spawnPos.offset(0, 0, 60)), 'route must end at the closest node, not the goal')
  })

  it('walkTo and lookAt reject at once while physics is disabled', async function () {
    this.timeout(20000 * SLOWDOWN)
    this.slow(8000)
    await world.tp(bot, spawnPos)
    await once(bot, 'physicsTick')
    const from = bot.entity.position.clone()
    const yaw = bot.entity.yaw
    bot.physicsEnabled = false
    const t0 = Date.now()
    try {
      await assert.rejects(human.walkTo(goal, { timeout: 60000 }), /physicsEnabled is false/)
      await assert.rejects(human.lookAt(faceAt), /physicsEnabled is false/)
    } finally {
      bot.physicsEnabled = true
    }
    // The point of the guard: the caller hears back now, not when the walk timeout expires.
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms to report physics was off`)
    assert.ok(bot.entity.position.distanceTo(from) < 0.01, `moved to ${bot.entity.position} with physics disabled`)
    assert.strictEqual(bot.entity.yaw, yaw, 'turned the head with physics disabled')

    // ...and the controller is still usable once physics comes back.
    await once(bot, 'physicsTick')
    await human.walkTo(goal)
    const p = bot.entity.position
    assert.ok(Math.hypot(p.x - goal.x, p.z - goal.z) < 1, `stopped ${p} away from ${goal}`)
  })
})

suite('human walker on an island', function () {
  const spawnPos = new Vec3(8.5, 57, 2.5)
  const goal = new Vec3(8.5, 57, 12.5)

  let bot
  let human

  before(async () => {
    bot = await world.join('island', world.trenchArena(), spawnPos)
    bot.loadPlugin(pathfinder)
    human = createHuman(bot, { seed: 7 })
  })
  after(async () => {
    human.active = false
    await world.leave(bot)
    bot = null
  })

  it('walkTo drops three blocks into a trench and climbs the steps out', async function () {
    this.timeout(20000 * SLOWDOWN)
    this.slow(8000)
    await once(bot, 'physicsTick')
    await human.walkTo(goal, { timeout: 15000 })
    const p = bot.entity.position
    assert.ok(Math.hypot(p.x - goal.x, p.z - goal.z) < 1, `stopped ${p} away from ${goal}`)
    assert.strictEqual(p.y, goal.y)
    assert.ok(human.route.some(w => w.y === 54), `route ${human.route} did not go through the trench floor`)
    assert.ok(human.route[human.route.length - 1].equals(goal), 'route must end at the goal')
  })
})

// A real server verifies every move the bot reports. If it disagrees it teleports the bot back
// ("rubber-banding"), which a fake server never does. Each test above that moves the bot is
// therefore also a test of the executor's movement; this one names the culprits.
suite('server movement validation', function () {
  it('never rubber-banded the bot outside a teleport the tests asked for', function () {
    const bands = world.rubberBandReport()
    const complaints = world.serverMovementComplaints()
    const lines = bands.slice(0, 12).map(b => `  [${b.suite}] during "${b.test}": the server moved the bot to ${b.at}${b.log ? ` (movement log: ${b.log})` : ''}`)
    assert.strictEqual(
      bands.length,
      0,
      `the server rubber-banded the bot ${bands.length} time(s):\n${lines.join('\n')}\nserver log:\n${complaints.slice(0, 8).join('\n')}`
    )
  })
})
