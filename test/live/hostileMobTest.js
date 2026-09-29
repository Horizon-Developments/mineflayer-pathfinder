/* eslint-env mocha */

// Live hostile-mob-avoidance test against a REAL vanilla server.
//
// A long, walled-off plain far from every other arena (see hostileArena() /
// HOSTILE_ORIGIN in realWorld.js). The bot is sent from one end to the other; partway
// across, a real mob - with its own AI, not the NoAI dummy every other live test uses -
// is dropped right on top of its route. Two things are checked: that the pathfinder
// survives it (no hang, no throw, no kick) and still reaches the goal, and that it
// noticed: a hostile mob has to make it replan (the 'hostile_replan' event), because a
// path planned before the mob existed knows nothing about it. Nothing is listed by hand:
// the mobs are recognised as hostile from the registry, which is the point.
//
// Peaceful difficulty (the default for every other live suite) deletes hostile mobs
// outright, so this suite switches the server to Easy for its own duration and restores
// Peaceful afterwards so it doesn't affect any other suite.
//
// Skipped unless PF_LIVE=1, same as every other file in test/live/.

const assert = require('assert')
const { once } = require('events')
const { goals, pathfinder, Movements } = require('../..')
const { Vec3 } = require('vec3')
const world = require('./realWorld')

const live = process.env.PF_LIVE === '1'
const suite = live ? describe : describe.skip

const Version = world.Version
const TEST_TIMEOUT = 60000 // "make timeout 1 min for this"

// Every hostile that can spawn on ordinary land (i.e. not drowned/guardian, which need water).
const LAND_HOSTILES = ['zombie', 'creeper', 'spider', 'husk']

const LENGTH = 60
// 60 open blocks across, plus a one-block barrier wall on each side. (The walls are cells of the arena
// itself, so the arena is 62 wide, not 61: 61 would leave 59 open.)
const OPEN_WIDTH = 60
const WIDTH = OPEN_WIDTH + 2
const { x: originX, y: originY, z: originZ } = world.HOSTILE_ORIGIN
const midZ = originZ + Math.floor(WIDTH / 2) + 0.5
const start = new Vec3(originX + 1.5, originY, midZ)
const goal = new Vec3(originX + LENGTH - 2, originY, midZ)

suite(`hostile mob avoidance on a real ${Version} server`, function () {
  this.timeout(TEST_TIMEOUT * (LAND_HOSTILES.length + 1) + 30000)

  let bot

  before(async () => {
    bot = await world.join('hostiles', world.hostileArena(LENGTH, WIDTH), start, { remote: true })
    bot.loadPlugin(pathfinder)
    // Peaceful (every other suite's difficulty) deletes hostile mobs on the spot.
    bot.pfWorld.server.send('difficulty easy')
  })

  after(async () => {
    if (bot) bot.pfWorld.server.send('difficulty peaceful')
    await world.leave(bot)
  })

  for (const mob of LAND_HOSTILES) {
    it(`does not fail when a ${mob} spawns mid-path`, async function () {
      this.timeout(TEST_TIMEOUT)

      await world.rebuild(bot) // clear the previous test's mob and any mess it made
      await world.tp(bot, start)

      // No entitiesToAvoid: the pathfinder recognises hostile mobs from the registry itself.
      bot.pathfinder.setMovements(new Movements(bot))

      const replans = []
      const onReplan = (verdict) => { if (spawned) replans.push(verdict) }
      bot.on('hostile_replan', onReplan)

      let spawned = false
      const trySpawnMidway = () => {
        if (spawned) return
        if (bot.entity.position.x - originX > LENGTH / 2) {
          spawned = true
          bot.off('move', trySpawnMidway)
          // A few blocks ahead of the bot, in its way, not literally on top of it.
          const dropPoint = new Vec3(Math.min(goal.x - 1, bot.entity.position.x + 4), originY, midZ)
          world.summon(bot, mob, dropPoint, { ai: true }).catch(() => { /* asserted below via goal_reached */ })
        }
      }
      bot.on('move', trySpawnMidway)

      bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(goal.x), goal.y, Math.floor(goal.z), 1))

      const timedOut = Symbol('timeout')
      const result = await Promise.race([
        once(bot, 'goal_reached').then(() => 'reached'),
        new Promise(resolve => setTimeout(() => resolve(timedOut), TEST_TIMEOUT - 5000))
      ])

      bot.off('move', trySpawnMidway)
      bot.off('hostile_replan', onReplan)
      bot.pathfinder.setGoal(null)

      assert.ok(spawned, `never got far enough across to spawn the ${mob} - widen the arena or move the trigger point`)
      assert.notStrictEqual(result, timedOut,
        `pathfinding never finished after a ${mob} spawned mid-route: bot at ${bot.entity.position}, ` +
        `problems=${JSON.stringify(bot.pfWorld.problems)}`)
      assert.deepStrictEqual(bot.pfWorld.problems, [], `bot reported problems: ${JSON.stringify(bot.pfWorld.problems)}`)
      assert.ok(
        replans.some(v => v.name === mob),
        `a ${mob} was dropped into the bot's way and the pathfinder never replanned around it (health ${bot.health}, replans: ${JSON.stringify(replans)})`
      )

      const p = await world.getServerPos(bot)
      assert.ok(Math.hypot(p.x - goal.x, p.z - goal.z) < 2, `stopped ${p}, too far from goal ${goal}`)
    })
  }
})
