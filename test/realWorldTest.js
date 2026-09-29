/* eslint-env mocha */

// Offline tests for the parts of test/live/realWorld.js that need no server: the arenas'
// commands, the run-length /fill generation, and how the helpers wait on (and report about) a
// server. The server, the bot and the world here are fakes.

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const world = require('./live/realWorld')

function fakeServer () {
  const server = {
    logs: [],
    sent: [],
    port: 25565,
    send (command) {
      server.sent.push(command)
      // The real server logs "[Server] <text>" for `say <text>`, in order with everything before it.
      if (command.startsWith('say ')) server.logs.push(`[Server] ${command.slice(4)}`)
    },
    waitForLog (re) {
      const line = server.logs.find(l => re.test(l))
      return line ? Promise.resolve(line) : Promise.reject(new Error(`no log line matched ${re}`))
    }
  }
  return server
}

/** A bot whose world is a map from "x,y,z" to a block name, and whose tp lands where asked. */
function fakeBot (server, blocks = {}) {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.username = 'pf_test'
  bot.physicsEnabled = true
  bot.entity = { position: new Vec3(0, 0, 0), onGround: true }
  bot.entities = {}
  bot.blockAt = (pos) => {
    const name = blocks[`${pos.x},${pos.y},${pos.z}`]
    return name ? { name } : { name: 'air' }
  }
  bot.waitForTicks = () => Promise.resolve()
  bot.pfWorld = { server, arena: null, spawn: null, problems: [], expectedTeleports: 0 }
  bot.blocks = blocks
  return bot
}

describe('live test support: arenas', () => {
  const CLEAR_VOLUME = 16 * 16 * 97

  it('one clear command stays within the 32768 blocks a /fill may touch', () => {
    assert.ok(CLEAR_VOLUME <= 32768)
    for (const arena of [world.flatArena(), world.trenchArena()]) {
      assert.ok(arena.commands.includes('fill 0 0 0 15 96 15 air'), `${arena.name} does not clear its region`)
    }
  })

  it('flat arena: bedrock floor at y=0 and one gold block at (12,1,8), like flatMap()', () => {
    const { commands, checks } = world.flatArena()
    assert.ok(commands.includes('fill 0 0 0 15 0 15 minecraft:bedrock'))
    assert.ok(commands.includes('setblock 12 1 8 minecraft:gold_block'))
    assert.deepStrictEqual(checks.find(c => c[3] === 'gold_block'), [12, 1, 8, 'gold_block'])
  })

  it('flat arena: clears before it builds, so a rebuild also removes what a test left behind', () => {
    const { commands } = world.flatArena()
    assert.ok(commands.indexOf('fill 0 0 0 15 96 15 air') < commands.indexOf('setblock 12 1 8 minecraft:gold_block'))
  })

  it('flat arena: removes leftover chickens inside the arena, and only there', () => {
    // KILL_ITEMS and the clear only remove items and blocks, so a live mob one suite summoned used to
    // stand on the gold block for every later suite - and the planner will not break a block with an
    // entity above it, so the isMining test could never plan its dig.
    const { commands } = world.flatArena()
    const kill = commands.find(c => c.startsWith('kill @e[type=chicken'))
    assert.ok(kill, 'the flat arena does not remove leftover chickens')
    assert.ok(kill.includes('x=0,y=0,z=0,dx=15,dy=96,dz=15'), `not scoped to the arena: ${kill}`)
    assert.ok(commands.indexOf(kill) < commands.indexOf('setblock 12 1 8 minecraft:gold_block'))
  })

  it('trench arena: the surface height of every row matches trenchMap()', () => {
    const { commands } = world.trenchArena()
    const surface = (z) => {
      const line = commands.find(c => new RegExp(`^fill 0 \\d+ ${z} 15 \\d+ ${z} minecraft:cyan_terracotta$`).test(c))
      assert.ok(line, `no surface command for z=${z}`)
      return Number(line.split(' ')[2])
    }
    const expected = [56, 56, 56, 56, 56, 56, 53, 53, 54, 55, 56, 56, 56, 56, 56, 56]
    assert.deepStrictEqual([...Array(16).keys()].map(surface), expected)
  })

  it('trench arena: solid stone underneath each surface, from y=40', () => {
    const { commands } = world.trenchArena()
    assert.ok(commands.includes('fill 0 40 6 15 52 6 minecraft:stone'), 'the trench floor is not stone down to y=40')
    assert.ok(commands.includes('fill 0 40 0 15 55 0 minecraft:stone'))
  })
})

describe('live test support: run-length /fill generation', () => {
  it('collapses a run of identical blocks along x into one command', () => {
    const { commands } = world.runLengthFills((x, y, z) => (y === 2 && z === 3 && x >= 4 && x <= 9 ? 'stone' : null), 5)
    assert.deepStrictEqual(commands, ['fill 4 2 3 9 2 3 minecraft:stone'])
  })

  it('splits where the block changes and where there is a gap', () => {
    const at = { 0: 'stone', 1: 'stone', 2: 'dirt', 3: null, 4: 'dirt' }
    const { commands } = world.runLengthFills((x, y, z) => (y === 0 && z === 0 ? at[x] ?? null : null), 1)
    assert.deepStrictEqual(commands, [
      'fill 0 0 0 1 0 0 minecraft:stone',
      'fill 2 0 0 2 0 0 minecraft:dirt',
      'fill 4 0 0 4 0 0 minecraft:dirt'
    ])
  })

  it('a full row is one command, and runs stop at the chunk edge', () => {
    const { commands } = world.runLengthFills((x, y, z) => (y === 0 && z === 15 ? 'stone' : null), 1)
    assert.deepStrictEqual(commands, ['fill 0 0 15 15 0 15 minecraft:stone'])
  })

  it('reproduces exactly the same blocks as the per-block map it came from', () => {
    const pick = (x, y, z) => ((x * 7 + y * 3 + z) % 5 === 0 ? 'stone' : (x + y) % 4 === 0 ? 'dirt' : null)
    const { commands } = world.runLengthFills(pick, 4)
    const painted = new Map()
    for (const c of commands) {
      const [, x0, y, z, x1, , , name] = c.match(/^fill (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) minecraft:(\w+)$/)
      for (let x = Number(x0); x <= Number(x1); x++) painted.set(`${x},${y},${z}`, name)
    }
    for (let y = 0; y < 4; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          assert.strictEqual(painted.get(`${x},${y},${z}`) ?? null, pick(x, y, z), `(${x},${y},${z})`)
        }
      }
    }
  })
})

describe('live test support: talking to the server', () => {
  it('waitForBlocks resolves once the client sees the blocks, and names what is wrong if it never does', async () => {
    const bot = fakeBot(fakeServer(), { '1,1,1': 'stone' })
    await world.waitForBlocks(bot, [[1, 1, 1, 'stone'], [2, 2, 2, 'air']], 500)
    await assert.rejects(world.waitForBlocks(bot, [[1, 1, 1, 'gold_block']], 200), /\(1,1,1\) wanted gold_block, client sees stone/)
  })

  it('setBlock sends the command and waits for the block to show', async () => {
    const server = fakeServer()
    const bot = fakeBot(server)
    setTimeout(() => { bot.blocks['3,4,5'] = 'dirt' }, 60)
    await world.setBlock(bot, new Vec3(3, 4, 5), 'dirt')
    assert.deepStrictEqual(server.sent, ['setblock 3 4 5 minecraft:dirt'])
  })

  it('tp sends the command, waits for arrival, and expects exactly one position packet', async () => {
    const server = fakeServer()
    const bot = fakeBot(server)
    setTimeout(() => bot.entity.position.set(8.5, 1, 8.5), 60)
    await world.tp(bot, new Vec3(8.5, 1, 8.5))
    assert.deepStrictEqual(server.sent, ['tp pf_test 8.5 1 8.5'])
    assert.strictEqual(bot.pfWorld.expectedTeleports, 1)
  })

  it('tp fails with the bot\'s real position when it never arrives', async () => {
    const server = fakeServer()
    server.logs.push('[Server thread/WARN]: pf_test moved too quickly!')
    const bot = fakeBot(server)
    const original = setTimeout
    // Shorten the 15 s wait for this one test.
    global.setTimeout = (fn, ms, ...args) => original(fn, ms > 1000 ? 100 : ms, ...args)
    try {
      await assert.rejects(world.tp(bot, new Vec3(50, 1, 50)), /never arrived: the bot is at \(0, 0, 0\)[\s\S]*moved too quickly/)
    } finally {
      global.setTimeout = original
    }
  })

  it('resetInventory clears, gives, and waits for the client to agree', async () => {
    const server = fakeServer()
    const bot = fakeBot(server)
    // The real registry is not loaded in unit tests: hand the helper a two-item one.
    const Module = require('module')
    const realLoad = Module._load
    Module._load = function (request, ...rest) {
      if (request === 'minecraft-data') return () => ({ itemsByName: { dirt: { id: 3 }, diamond_pickaxe: { id: 9 } } })
      return realLoad.call(this, request, ...rest)
    }
    try {
      const have = { 3: 0, 9: 0 }
      bot.inventory = { count: (id) => have[id] }
      setTimeout(() => { have[3] = 64; have[9] = 1 }, 60)
      await world.resetInventory(bot, [['diamond_pickaxe', 1], ['dirt', 64]])
    } finally {
      Module._load = realLoad
    }
    assert.deepStrictEqual(server.sent, ['clear pf_test', 'give pf_test minecraft:diamond_pickaxe 1', 'give pf_test minecraft:dirt 64'])
  })

  it('summon waits until the client has seen the mob', async () => {
    const server = fakeServer()
    const bot = fakeBot(server)
    setTimeout(() => { bot.entities[1] = { name: 'chicken' } }, 60)
    await world.summon(bot, 'chicken', new Vec3(1, 2, 3))
    assert.deepStrictEqual(server.sent, ['summon minecraft:chicken 1 2 3 {NoAI:1b}'])
  })

  it('getServerPos reads the position, not the log timestamp before it', async () => {
    // The server puts a bracketed timestamp at the start of every line. A bare /\[(...)\]/ took that for
    // the position: parseFloat('14:03:11') is 14, with no y or z.
    const server = fakeServer()
    const bot = fakeBot(server)
    server.logs.push('[14:03:11] [Server thread/INFO]: pf_test has the following entity data: [3.5d, 1.0d, 12.5d]')
    const p = await world.getServerPos(bot)
    assert.deepStrictEqual([p.x, p.y, p.z], [3.5, 1, 12.5])
    assert.deepStrictEqual(server.sent, ['data get entity pf_test Pos'])
  })

  it('getServerPos answers about the entity it was asked about', async () => {
    const server = fakeServer()
    const bot = fakeBot(server)
    server.logs.push('[14:03:11] [Server thread/INFO]: someone_else has the following entity data: [99.0d, 5.0d, 99.0d]')
    server.logs.push('[14:03:12] [Server thread/INFO]: pf_test has the following entity data: [-4.25d, 64.0d, 0.5d]')
    const p = await world.getServerPos(bot)
    assert.deepStrictEqual([p.x, p.y, p.z], [-4.25, 64, 0.5])
  })

  it('getServerPos refuses an unreadable answer instead of returning NaN', async () => {
    const server = fakeServer()
    const bot = fakeBot(server)
    server.logs.push('[14:03:11] [Server thread/INFO]: pf_test has the following entity data: [oops]')
    await assert.rejects(world.getServerPos(bot), /could not read a position/)
  })

  it('leave tolerates nothing, a dead bot, and being called twice', async () => {
    await world.leave(null)
    const bot = { end () { throw new Error('already gone') } }
    await world.leave(bot)
    await world.leave(bot)
  })
})

describe('live test support: rubber-band detection', () => {
  it('a position packet nobody asked for is recorded against the running test', () => {
    const before = world.rubberBandReport().length
    const bot = fakeBot(fakeServer())
    world.watchRubberBanding(bot, 'suiteX')
    world.markTest('suiteX walks somewhere')
    bot._client.emit('position', {})
    const report = world.rubberBandReport()
    assert.strictEqual(report.length, before + 1)
    assert.deepStrictEqual(
      { suite: report[before].suite, test: report[before].test },
      { suite: 'suiteX', test: 'suiteX walks somewhere' }
    )
  })

  it('the packet that answers a requested teleport is not a rubber-band', () => {
    const before = world.rubberBandReport().length
    const bot = fakeBot(fakeServer())
    world.watchRubberBanding(bot, 'suiteY')
    bot.pfWorld.expectedTeleports = 1
    bot._client.emit('position', {})
    assert.strictEqual(world.rubberBandReport().length, before, 'the requested teleport was counted')
    assert.strictEqual(bot.pfWorld.expectedTeleports, 0)
    bot._client.emit('position', {}) // a second one is not requested
    assert.strictEqual(world.rubberBandReport().length, before + 1)
  })

  it('reads the server log for rejected moves, and only those', () => {
    const liveServer = require('../scripts/live-server')
    const saved = liveServer.current
    liveServer.current = { logs: ['[Server thread/INFO]: hello', '[Server thread/WARN]: pf_a moved too quickly! 1.0,2.0,3.0', '[Server thread/WARN]: pf_a (vehicle of pf_a) moved wrongly!', '[Server thread/INFO]: Done'] }
    try {
      assert.strictEqual(world.serverMovementComplaints().length, 2)
    } finally {
      liveServer.current = saved
    }
  })
})

describe('live test support: movement logs', () => {
  const withEnv = async (value, fn) => {
    const saved = process.env.PF_LIVE_MOVELOG
    if (value === undefined) delete process.env.PF_LIVE_MOVELOG
    else process.env.PF_LIVE_MOVELOG = value
    try {
      return await fn()
    } finally {
      if (saved === undefined) delete process.env.PF_LIVE_MOVELOG
      else process.env.PF_LIVE_MOVELOG = saved
    }
  }
  const botWithEntity = (server) => {
    const bot = fakeBot(server)
    bot.entity.velocity = new Vec3(0, 0, 0)
    bot.controlState = {}
    return bot
  }

  it('attaches a log that writes under the server\'s directory, named for the bot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pflive-'))
    await withEnv(undefined, async () => {
      const bot = botWithEntity(fakeServer())
      const log = world.attachLog(bot, 'suiteZ', { dir })
      assert.strictEqual(log.file, path.join(dir, 'movement-logs', 'pf_test.log'))
      assert.strictEqual(bot.pfMoveLog, log)
      world.detachLog(bot)
      assert.strictEqual(bot.pfMoveLog, null)
    })
    await new Promise(resolve => setTimeout(resolve, 100)) // let the log file finish opening
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('PF_LIVE_MOVELOG=off attaches nothing', async () => {
    await withEnv('off', async () => {
      const bot = botWithEntity(fakeServer())
      assert.strictEqual(world.attachLog(bot, 'suiteZ', { dir: os.tmpdir() }), null)
      assert.strictEqual(bot.pfMoveLog, undefined)
    })
  })

  it('markTest writes the test title into every attached log, so a log reads test by test', async () => {
    await withEnv(undefined, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pflive-'))
      const a = botWithEntity(fakeServer())
      const b = botWithEntity(fakeServer())
      b.username = 'pf_other'
      const logA = world.attachLog(a, 'a', { dir })
      const logB = world.attachLog(b, 'b', { dir })
      world.markTest('human walker walkTo stops at the goal')
      assert.match(logA.recent().join('\n'), /\*\* TEST human walker walkTo stops at the goal/)
      assert.match(logB.recent().join('\n'), /\*\* TEST human walker walkTo stops at the goal/)
      world.detachLog(a)
      world.markTest('after a left')
      assert.ok(!logA.recent().join('\n').includes('after a left'), 'a detached log was still written to')
      world.detachLog(b)
      await new Promise(resolve => setTimeout(resolve, 100)) // let the log files finish opening
      fs.rmSync(dir, { recursive: true, force: true })
    })
  })

  it('a rubber-band is written into the log and its recent history is printed', () => {
    const bot = fakeBot(fakeServer())
    const events = []
    const dumps = []
    bot.pfMoveLog = { file: '/logs/pf_test.log', event: (kind, detail) => events.push([kind, detail]), dumpRecent: (n) => dumps.push(n) }
    const before = world.rubberBandReport().length
    world.watchRubberBanding(bot, 'suiteQ')
    world.markTest('suiteQ something')
    bot._client.emit('position', {})
    assert.strictEqual(events.length, 1)
    assert.strictEqual(events[0][0], 'RUBBER-BAND')
    assert.deepStrictEqual(dumps, [25])
    assert.strictEqual(world.rubberBandReport()[before].log, '/logs/pf_test.log', 'the report should say where the log is')
  })

  it('a requested teleport is logged as a request, not as a rubber-band', async () => {
    const bot = fakeBot(fakeServer())
    const events = []
    bot.pfMoveLog = { event: (kind) => events.push(kind) }
    setTimeout(() => bot.entity.position.set(1, 1, 1), 60)
    await world.tp(bot, new Vec3(1, 1, 1))
    assert.deepStrictEqual(events, ['TP-REQUEST'])
  })
})

describe('live test support: what to show when a test fails', () => {
  it('describeBot says where the bot is, what it holds and carries, and what the pathfinder is doing', () => {
    const bot = fakeBot(fakeServer())
    bot.heldItem = { name: 'diamond_pickaxe', count: 1 }
    bot.inventory = { items: () => [{ name: 'diamond_pickaxe', count: 1 }, { name: 'dirt', count: 64 }] }
    bot.pathfinder = { goal: new (class GoalBlock {})(), isMoving: () => true, isMining: () => false, isBuilding: () => false }
    const text = world.describeBot(bot)
    assert.match(text, /pf_test at \(0, 0, 0\)/)
    assert.match(text, /holding=diamond_pickaxex1 items=\[diamond_pickaxex1,dirtx64\]/)
    assert.match(text, /goal=GoalBlock moving=true mining=false building=false/)
  })

  it('describeBot mentions a boat the bot is riding, and survives a bot that is half set up', () => {
    const bot = fakeBot(fakeServer())
    bot.inventory = { items: () => [] }
    bot.vehicle = { name: 'oak_boat' }
    assert.match(world.describeBot(bot), /riding=oak_boat/)
    assert.match(world.describeBot({ username: 'pf_broken' }), /pf_broken: could not describe/)
  })

  it('dumpAllRecent prints the state and the recent log of every attached bot', async () => {
    const bot = fakeBot(fakeServer())
    bot.entity.velocity = new Vec3(0, 0, 0)
    bot.controlState = {}
    bot.inventory = { items: () => [] }
    const dir = require('os').tmpdir()
    const saved = process.env.PF_LIVE_MOVELOG
    process.env.PF_LIVE_MOVELOG = 'file'
    const printed = []
    const original = console.log
    console.log = (line) => printed.push(line)
    let log
    try {
      log = world.attachLog(bot, 'dump', { dir })
      bot.emit('goal_reached')
      world.dumpAllRecent(5)
    } finally {
      console.log = original
      world.detachLog(bot)
      if (saved === undefined) delete process.env.PF_LIVE_MOVELOG
      else process.env.PF_LIVE_MOVELOG = saved
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.ok(log)
    const text = printed.join('\n')
    assert.match(text, /\[live\] pf_test at/)
    assert.match(text, /GOAL-REACHED/)
  })
})

describe('live test support: bots that only plan paths', () => {
  function botWithWire () {
    const bot = fakeBot(fakeServer())
    const sent = []
    bot._client.write = (name, params) => { sent.push(name) }
    world.installMovementMute(bot)
    return { bot, sent }
  }

  it('drops the packets that say where the bot is and which way it faces, and only those', () => {
    const { bot, sent } = botWithWire()
    world.setMuted(bot, true)
    for (const name of ['position', 'position_look', 'look', 'flying', 'chat_message', 'tick_end', 'use_item']) bot._client.write(name, {})
    assert.deepStrictEqual(sent, ['chat_message', 'tick_end', 'use_item'])
  })

  it('lets everything through until the bot is muted', () => {
    const { bot, sent } = botWithWire()
    bot._client.write('position', {})
    assert.deepStrictEqual(sent, ['position'])
  })

  it('can be switched off again', () => {
    const { bot, sent } = botWithWire()
    world.setMuted(bot, true)
    bot._client.write('position', {})
    world.setMuted(bot, false)
    bot._client.write('position', {})
    assert.deepStrictEqual(sent, ['position'])
  })

  it('passes the arguments through untouched', () => {
    const bot = fakeBot(fakeServer())
    const calls = []
    bot._client.write = (...args) => { calls.push(args) }
    world.installMovementMute(bot)
    bot._client.write('chat_message', { message: 'hi' }, 'extra')
    assert.deepStrictEqual(calls, [['chat_message', { message: 'hi' }, 'extra']])
  })
})
