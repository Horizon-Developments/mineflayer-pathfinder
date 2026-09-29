/* eslint-env mocha */

// Live boat test against a REAL vanilla server (26.1 by default).
//
// Skipped unless PF_LIVE=1, because it downloads and starts the official server and
// takes a minute or two. Everything else in this repo runs against fakes; this is
// the test that can tell whether a boat is really driven, because the server's own
// vehicle checks decide the outcome.
//
//   node scripts/live-server.js --accept-eula   starts a server AND runs this in the same window
//   npm run test:live      only this (starts and stops its own server)
//   npm test --v2          the whole suite, then this (same as `npm run test:v2`)
//
// Directly, without the runner (it also asks you to accept the Minecraft EULA):
//   Windows cmd:   set PF_LIVE=1&& set PF_LIVE_ACCEPT_EULA=1&& npx mocha test/live/boatLiveTest.js --timeout 300000 --exit
//   PowerShell:    $env:PF_LIVE=1; $env:PF_LIVE_ACCEPT_EULA=1; npx mocha test/live/boatLiveTest.js --timeout 300000 --exit
//   bash:          PF_LIVE=1 PF_LIVE_ACCEPT_EULA=1 npx mocha test/live/boatLiveTest.js --timeout 300000 --exit
//
// Environment:
//   PF_LIVE_ACCEPT_EULA=1  required to launch a server: you accept the Minecraft EULA
//   PF_LIVE_VERSION        default 26.1
//   PF_LIVE_PORT           default 25565 (Minecraft's own default)
//   PF_LIVE_HOST           use an already-running server instead of launching one. The
//                          bot ("pf_boat_bot") must be an operator there: the arena is
//                          built with /fill, /tp and /give typed as the bot.
//   JAVA                   path to the java executable, if the one on PATH is too old
//   PF_LIVE_DEBUG=1        print the boat driver's state every second
//
// The arena is a floating platform at y=98..99: a lake (water x 20..40) between two
// stone banks (x 0..19 and 41..60), walled at z=-1 and z=31 so the water cannot spill.
// The bot starts on the west bank with one oak boat and is sent to the east bank. There is no
// way round the lake that does not involve a long drop, so the only route is by boat.
//
// What is asserted is what a real server can judge: the boat really travelled, the bot
// really got out, and the server never logged the vehicle as having moved wrongly.

const assert = require('assert')
const { once } = require('events')
const liveServer = require('../../scripts/live-server')
const realWorld = require('./realWorld')

const live = process.env.PF_LIVE === '1'
const suite = live ? describe : describe.skip

const Version = process.env.PF_LIVE_VERSION || '26.1'
const Host = process.env.PF_LIVE_HOST
const Username = 'pf_boat_bot'
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil (predicate, timeoutMs, intervalMs = 100) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (predicate()) return true
    await sleep(intervalMs)
  }
  return predicate()
}

suite(`live boat crossing on a real ${Version} server`, function () {
  this.timeout(240000)

  let server = null
  let bot = null
  const resets = []
  const samples = [] // boat position while riding
  let mounted = 0
  let dismounted = 0
  let goalReached = false
  let vehicleMoves = 0
  let driverDisabled = null
  const kicks = []

  const goalX = 50.5
  const start = { x: 10.5, y: 100, z: 15.5 }

  const diagnostics = () => [
    `mounted=${mounted} dismounted=${dismounted} goalReached=${goalReached} vehicle_move sent=${vehicleMoves}`,
    `path_resets=[${resets.join(', ')}] driverDisabled=${driverDisabled} kicks=${JSON.stringify(kicks)}`,
    `bot at ${bot && bot.entity && bot.entity.position}`,
    `boat travelled from x=${samples.length ? samples[0].x.toFixed(1) : '-'} to x=${samples.length ? samples[samples.length - 1].x.toFixed(1) : '-'} (${samples.length} samples)`,
    server ? `last server log:\n${server.logs.slice(-12).join('\n')}` : ''
  ].join('\n')

  /** Run a server command: on the console if we launched the server, else as the bot. */
  const run = async (cmd) => {
    if (server) server.send(cmd)
    else bot.chat(`/${cmd}`)
    await sleep(600)
  }

  before(async function () {
    if (liveServer.current) {
      // `node scripts/live-server.js` started this server and is running the test itself.
      server = liveServer.current
    } else if (!Host) {
      // Started once and shared with the other live suites; it dies with this process.
      server = await realWorld.getServer()
    }

    const mineflayer = require('mineflayer')
    const { pathfinder, Movements, goals } = require('../..')

    bot = mineflayer.createBot({ host: Host || 'localhost', port: Host ? Number(process.env.PF_LIVE_PORT || liveServer.DEFAULT_PORT) : server.port, username: Username, version: Version })
    bot.on('kicked', (reason) => kicks.push(String(reason).slice(0, 200)))
    bot.on('error', (err) => kicks.push(`error: ${err.message}`))
    await once(bot, 'spawn')
    realWorld.attachLog(bot, 'boat', server)
    await bot.waitForChunksToLoad()

    // Count what the executor actually sends, at the socket.
    const write = bot._client.write.bind(bot._client)
    bot._client.write = (name, params, ...rest) => {
      if (name === 'vehicle_move') vehicleMoves++
      return write(name, params, ...rest)
    }

    if (server) await run(`op ${Username}`)

    // --- Arena -----------------------------------------------------------------
    await run('fill 0 98 -1 60 98 31 stone')
    await run('fill 0 99 0 19 99 30 stone')
    await run('fill 41 99 0 60 99 30 stone')
    await run('fill 0 99 -1 60 101 -1 stone')
    await run('fill 0 99 31 60 101 31 stone')
    await run('fill 0 100 0 60 108 30 air')
    await run('fill 20 99 0 40 99 30 water')
    await sleep(1500)
    await run(`tp ${Username} ${start.x} ${start.y} ${start.z}`)
    await run(`give ${Username} oak_boat 1`)
    assert.ok(
      await waitUntil(() => bot.entity.onGround && Math.abs(bot.entity.position.y - start.y) < 0.6, 15000),
      `the bot never landed on the west bank. ${diagnostics()}`
    )
    assert.ok(await waitUntil(() => bot.inventory.items().some(i => /boat$/.test(i.name)), 10000), `the bot was never given a boat. ${diagnostics()}`)

    // --- Go ----------------------------------------------------------------------
    bot.loadPlugin(pathfinder)
    if (process.env.PF_LIVE_DEBUG === '1') bot.pathfinder.debugBoat = true
    const movements = new Movements(bot)
    movements.allowBoating = true
    movements.boatRecycle = true
    bot.pathfinder.setMovements(movements)

    bot.on('mount', () => { mounted++ })
    bot.on('dismount', () => { dismounted++ })
    bot.on('path_reset', (reason) => resets.push(reason))
    bot.on('boat_driver_disabled', (reason) => { driverDisabled = reason })
    bot.once('goal_reached', () => { goalReached = true })
    const sampler = setInterval(() => { if (bot && bot.vehicle) samples.push(bot.vehicle.position.clone()) }, 100)
    bot.once('end', () => clearInterval(sampler))
    this.sampler = sampler

    bot.pathfinder.setGoal(new goals.GoalNear(goalX, start.y, start.z, 1))
    await waitUntil(() => goalReached || driverDisabled || kicks.length, 120000)
  })

  after(async function () {
    if (this.sampler) clearInterval(this.sampler)
    realWorld.detachLog(bot)
    try { if (bot) bot.end() } catch (e) { /* already gone */ }
    // A server the CLI started is left up for inspection; one this test started is stopped.
    if (server && server !== liveServer.current) await server.stop()
  })

  it('mounts a boat', function () {
    assert.ok(mounted >= 1, `never mounted. ${diagnostics()}`)
  })

  it('reports the boat with vehicle_move and the boat really travels across the lake', function () {
    assert.ok(vehicleMoves > 0, `no vehicle_move was ever sent - a real server would never move the boat. ${diagnostics()}`)
    assert.ok(samples.length > 0, `bot.vehicle was never set while pathing. ${diagnostics()}`)
    const travelled = Math.max(...samples.map(s => s.x)) - Math.min(...samples.map(s => s.x))
    assert.ok(travelled > 12, `the boat only travelled ${travelled.toFixed(1)} blocks (the lake is 21 wide). ${diagnostics()}`)
  })

  it('does not thrash: no repeated stuck / rejected resets', function () {
    // boat_recycled is the planned replan after the boat just left is broken and picked up (movements.boatRecycle
    // is on above), not an abandoned path.
    const bad = resets.filter(r => /stuck|boat_(?!recycled$)/.test(r))
    assert.ok(bad.length === 0, `path was abandoned for: ${bad.join(', ')}. ${diagnostics()}`)
  })

  it('the server never logs the vehicle as moving wrongly or too quickly', function () {
    if (!server) return this.skip() // only a server we launched has a log we can read
    const complaints = server.logs.filter(l => /moved (wrongly|too quickly)|Vehicle moved/i.test(l))
    assert.deepStrictEqual(complaints, [], `the server rejected the reported boat positions:\n${complaints.slice(0, 5).join('\n')}`)
  })

  it('gets out on the far bank and reaches the goal', function () {
    assert.ok(goalReached, `goal_reached never fired. ${diagnostics()}`)
    assert.ok(dismounted >= 1 && !bot.vehicle, `still in the boat. ${diagnostics()}`)
    assert.ok(bot.entity.position.x > 41, `ended at x=${bot.entity.position.x.toFixed(1)}, not on the east bank`)
  })

  it('never got kicked', function () {
    assert.deepStrictEqual(kicks, [], 'the server disconnected the bot')
  })
})
