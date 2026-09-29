/* eslint-env mocha */

// Live ice-boat test against a REAL vanilla server (26.1 by default): the bot is given a boat
// and has to cross an ice sheet with water ponds in it.
//
// Skipped unless PF_LIVE=1, because it downloads and starts the official server and
// takes a minute or two. Everything else in this repo runs against fakes; this is the
// test that can tell whether the bot really stayed dry, because ice slipperiness is a
// real-physics thing the fake server in internalTest.js never simulates (it accepts
// whatever position the client reports). Nothing in lib/movements.js or lib/physics.js
// treats ice specially - it is costed like any other walkable block - so the only way
// to find out whether a planned route actually survives sliding on it is to walk it on
// a real server.
//
//   node scripts/live-server.js --accept-eula   starts a server AND can run this alongside it
//   PF_LIVE=1 PF_LIVE_ACCEPT_EULA=1 npx mocha test/live/iceWaterTest.js --timeout 300000 --exit
//
// Environment:
//   PF_LIVE_ACCEPT_EULA=1  required to launch a server: you accept the Minecraft EULA
//   PF_LIVE_VERSION        default 26.1
//   PF_LIVE_PORT           default 25565 (Minecraft's own default)
//   PF_LIVE_DEBUG=1        echo server console output while the test runs
//
// The bot starts with one oak boat and movements.allowBoating on, so this is the test of boating
// on ice: boats slide much further on ice than a walking player does, and the ponds are the hazard.
// Riding a boat over a pond is fine (the boat floats); standing in water outside a boat is a fail.
//
// The arena is a single ice sheet, 20 blocks wide (z) by 200 blocks long (x), on a
// bedrock base. Every 10 blocks along its length a square water pond (side 5-10,
// cycling through that range so every size gets covered) is cut into the ice, centered
// across the width with at least 2 ice columns of margin on each edge so there is
// always a dry way around it. Barrier walls run the length of both long edges so a
// slide off the side is impossible - the only hazard this course tests is sliding into
// one of the ponds. The bot's username is pf_ice_water.

'use strict'

const assert = require('assert')
const { Vec3 } = require('vec3')
const realWorld = require('./realWorld')

const live = process.env.PF_LIVE === '1'
const suite = live ? describe : describe.skip

const Version = realWorld.Version

// ---------------------------------------------------------------------------
// The course
// ---------------------------------------------------------------------------

const LENGTH = 200 // blocks along x
const WIDTH = 20 // blocks along z
const POND_SPACING = 10 // a pond starts every this many blocks along x
const MARGIN = 2 // ice columns kept clear on each edge of the width, so a pond never blocks the course

// Its own chunk, well away from every other live arena (flat/trench/parkour at chunk
// (0,0) y 0..96; hostile at (200,5,200); the maze at (400,200,400)) - it needs
// forceload before /fill against it takes effect (see realWorld.join()).
const ORIGIN = new Vec3(800, 4, 800)

// Ponds further than this from the start are not checked at join time (see iceArena()).
const VISIBLE_LENGTH = 100

/**
 * Where each pond starts along x and how big it is (both its x and z extent, it is
 * square), cycling its size through 5..10 so the course covers the whole requested
 * range instead of picking one size and repeating it.
 * @returns {{ x: number, size: number }[]}
 */
function pondPlan () {
  const ponds = []
  let i = 0
  for (let x = POND_SPACING; x + 5 <= LENGTH; x += POND_SPACING) {
    const size = 5 + (i % 6) // 5, 6, 7, 8, 9, 10, then repeats
    ponds.push({ x, size: Math.min(size, LENGTH - x) })
    i++
  }
  return ponds
}

/**
 * The ice course as an Arena: bedrock floor, an ice sheet on top, a water pond cut into
 * it every POND_SPACING blocks, and barrier walls the length of both long edges.
 * @returns {import('./realWorld').Arena}
 */
function iceArena () {
  const { x: x0, y: y0, z: z0 } = ORIGIN
  const x1 = x0 + LENGTH - 1
  const z1 = z0 + WIDTH - 1
  const ponds = pondPlan()

  const commands = [
    `kill @e[type=item,x=${x0},y=${y0},z=${z0},dx=${LENGTH},dy=10,dz=${WIDTH}]`,
    // One /fill over the whole box is 200 x 10 x 20 = 40000 blocks, over the server's 32768 limit,
    // and the server refuses it. Slice it.
    ...realWorld.limitedFills(x0, y0, z0, x1, y0 + 9, z1, 'air'),
    `fill ${x0} ${y0 - 1} ${z0} ${x1} ${y0 - 1} ${z1} minecraft:bedrock`,
    `fill ${x0} ${y0} ${z0} ${x1} ${y0} ${z1} minecraft:ice`,
    // Barrier walls the whole length of both edges so the only way to fail is a pond,
    // not a slide off the side.
    `fill ${x0} ${y0} ${z0 - 1} ${x1} ${y0 + 3} ${z0 - 1} minecraft:barrier`,
    `fill ${x0} ${y0} ${z1 + 1} ${x1} ${y0 + 3} ${z1 + 1} minecraft:barrier`
  ]

  const checks = [
    [x0, y0 - 1, z0, 'bedrock'],
    [x0, y0, z0, 'ice'],
    [x0, y0, z0 - 1, 'barrier'],
    [x0, y0, z1 + 1, 'barrier']
  ]

  for (const pond of ponds) {
    const safeSize = Math.min(pond.size, WIDTH - 2 * MARGIN)
    const zStart = z0 + MARGIN + Math.floor((WIDTH - 2 * MARGIN - safeSize) / 2)
    const px0 = x0 + pond.x
    const px1 = px0 + pond.size - 1
    const pz1 = zStart + safeSize - 1
    commands.push(`fill ${px0} ${y0} ${zStart} ${px1} ${y0} ${pz1} minecraft:water`)
    // Only require ponds the client can actually see from the start: the live server runs with
    // view-distance=8 (128 blocks) and the bot spawns at the west end, so the far ponds are never
    // sent and waitForBlocks() would time out. The bot loads them as it walks toward them.
    if (px0 <= x0 + VISIBLE_LENGTH) checks.push([px0, y0, zStart, 'water'])
  }

  return {
    name: 'ice_water',
    commands,
    checks,
    bounds: { x0: x0 - 1, z0: z0 - 1, x1: x1 + 1, z1: z1 + 1 }
  }
}

suite(`movement: ice bridge with water hazards on a real ${Version} server`, function () {
  this.timeout(180000)

  let bot = null
  let goalReached = false
  let pathUpdates = 0
  let fellInWater = false
  let waterAt = null
  let mounted = 0
  let dismounted = 0
  let driverDisabled = null
  const resets = []
  const samples = [] // boat position while riding

  const arena = iceArena()
  const start = new Vec3(ORIGIN.x + 0.5, ORIGIN.y + 1, ORIGIN.z + WIDTH / 2 + 0.5)
  const goal = { x: ORIGIN.x + LENGTH - 1, y: ORIGIN.y, z: ORIGIN.z + Math.floor(WIDTH / 2) }

  const diagnostics = () => [
    `goalReached=${goalReached} pathUpdates=${pathUpdates} fellInWater=${fellInWater} waterAt=${waterAt}`,
    `mounted=${mounted} dismounted=${dismounted} driverDisabled=${driverDisabled} path_resets=[${resets.join(', ')}]`,
    `boat travelled from x=${samples.length ? samples[0].x.toFixed(1) : '-'} to x=${samples.length ? samples[samples.length - 1].x.toFixed(1) : '-'} (${samples.length} samples)`,
    `problems=${JSON.stringify(bot && bot.pfWorld && bot.pfWorld.problems)}`,
    `bot at ${bot && bot.entity && bot.entity.position}`
  ].join('\n')

  const checkForWater = () => {
    // In a boat over a pond is the boat working, not the bot falling in.
    if (fellInWater || !bot.entity || bot.vehicle) return
    const feet = bot.blockAt(bot.entity.position.floored())
    if (feet && feet.name === 'water') {
      fellInWater = true
      waterAt = bot.entity.position.toString()
    }
  }

  before(async function () {
    realWorld.markTest(this.test.parent.title)

    // remote: true because ORIGIN is a chunk nobody has ever visited - it needs
    // forceload before the /fill commands actually land (see realWorld.join()).
    bot = await realWorld.join('ice_water', arena, start, { remote: true })

    // This bot is not pf_boat_bot, so nothing else hands it a boat: give it one (and only one).
    await realWorld.resetInventory(bot, [['oak_boat', 1]])

    const { pathfinder, Movements, goals } = require('../..')
    bot.loadPlugin(pathfinder)
    const movements = new Movements(bot)
    if (process.env.PF_LIVE_DEBUG === '1') bot.pathfinder.debugBoat = true
    movements.allowBoating = true
    movements.boatRecycle = true
    bot.pathfinder.setMovements(movements)

    bot.on('path_update', () => { pathUpdates++ })
    bot.on('physicTick', checkForWater)
    bot.on('mount', () => { mounted++ })
    bot.on('dismount', () => { dismounted++ })
    bot.on('path_reset', (reason) => resets.push(reason))
    bot.on('boat_driver_disabled', (reason) => { driverDisabled = reason })
    bot.once('goal_reached', () => { goalReached = true })
    this.sampler = setInterval(() => { if (bot && bot.vehicle) samples.push(bot.vehicle.position.clone()) }, 100)
    bot.once('end', () => clearInterval(this.sampler))

    // GoalNear, not GoalBlock: the goal is a walkable ice tile, not something to dig into.
    bot.pathfinder.setGoal(new goals.GoalNear(goal.x, goal.y, goal.z, 1))
    await realWorld.waitUntil(() => goalReached || fellInWater || driverDisabled || bot.pfWorld.problems.length > 0, 150000)
  })

  after(async function () {
    if (this.sampler) clearInterval(this.sampler)
    if (bot) bot.removeListener('physicTick', checkForWater)
    await realWorld.leave(bot)
  })

  it('never got kicked or errored while pathing', function () {
    assert.deepStrictEqual(bot.pfWorld.problems, [], `the bot had a connection problem. ${diagnostics()}`)
  })

  it('actually planned at least one path across the ice (did not just sit still)', function () {
    assert.ok(pathUpdates > 0, `pathfinder never reported a path. ${diagnostics()}`)
  })

  it('mounts the boat', function () {
    assert.ok(mounted >= 1, `the bot never got into its boat. ${diagnostics()}`)
  })

  it('the boat really travels along the ice (vehicle position moved)', function () {
    assert.ok(samples.length > 0, `bot.vehicle was never set while pathing. ${diagnostics()}`)
    const travelled = Math.max(...samples.map(s => s.x)) - Math.min(...samples.map(s => s.x))
    assert.ok(travelled > 10, `the boat only travelled ${travelled.toFixed(1)} blocks. ${diagnostics()}`)
  })

  it('does not thrash: no repeated stuck / rejected boat resets', function () {
    const bad = resets.filter(r => /stuck|boat_/.test(r))
    assert.ok(bad.length === 0 && !driverDisabled, `path was abandoned for: ${bad.join(', ')} driverDisabled=${driverDisabled}. ${diagnostics()}`)
  })

  // The one this suite exists for: sliding into any of the ponds is a fail, whether or
  // not the bot eventually also reached the goal tile.
  it('never slides into a water pond', function () {
    assert.ok(!fellInWater, `the bot ended up standing in water. ${diagnostics()}`)
  })

  it('reaches the far end of the ice', function () {
    assert.ok(goalReached, `goal_reached never fired within the timeout. ${diagnostics()}`)
  })

  it('the server itself agrees the bot ended up at the goal (not just the client)', async function () {
    const pos = await realWorld.getServerPos(bot)
    const distance = Math.sqrt((pos.x - (goal.x + 0.5)) ** 2 + (pos.z - (goal.z + 0.5)) ** 2)
    assert.ok(distance < 2, `server reports the bot at ${pos}, too far from the goal (${goal.x}, ${goal.y}, ${goal.z}). ${diagnostics()}`)
  })

  it('the server never logged the bot moving wrongly or too quickly', function () {
    const complaints = realWorld.serverMovementComplaints()
    assert.deepStrictEqual(complaints, [], `the server rejected reported positions:\n${complaints.slice(0, 5).join('\n')}`)
  })
})
