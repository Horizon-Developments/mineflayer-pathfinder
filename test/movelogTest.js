/* eslint-env mocha */

// Tests for lib/movelog.js: which blocks count as "touching" the bot, and what gets written.
// No server: the world, the bot and the boat driver are fakes.

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { MovementLog, touchingBlocks, describePath } = require('../lib/movelog')

const CUBE = [[0, 0, 0, 1, 1, 1]]

/** A world from a map of "x,y,z" -> block, where anything not listed is air. */
const worldOf = (blocks) => (x, y, z) => blocks[`${x},${y},${z}`] || { name: 'air', shapes: [] }
const stone = { name: 'stone', shapes: CUBE }

const faces = (result) => result.contacts.map(c => `${c.face}:${c.name}@${c.x},${c.y},${c.z}`)

describe('touchingBlocks', () => {
  const floor = {}
  for (let x = -2; x <= 3; x++) for (let z = -2; z <= 3; z++) floor[`${x},0,${z}`] = stone

  it('standing on a floor touches exactly the block underfoot', () => {
    assert.deepStrictEqual(faces(touchingBlocks(worldOf(floor), { x: 0.5, y: 1, z: 0.5 })), ['down:stone@0,0,0'])
  })

  it('standing on a block edge touches both blocks under the hitbox', () => {
    assert.deepStrictEqual(faces(touchingBlocks(worldOf(floor), { x: 1.0, y: 1, z: 0.5 })), ['down:stone@0,0,0', 'down:stone@1,0,0'])
  })

  it('one block off the ground touches nothing', () => {
    const t = touchingBlocks(worldOf(floor), { x: 0.5, y: 2, z: 0.5 })
    assert.deepStrictEqual(t.contacts, [])
    assert.deepStrictEqual(t.inside, [])
  })

  it('a wall on each side is reported by the side it is on (+x is east, +z is south)', () => {
    const blocks = { ...floor, '1,1,0': stone, '-1,1,0': stone, '0,1,1': stone, '0,1,-1': stone }
    // Hitbox half-width is 0.3, so at the middle of the block nothing touches; against each wall it does.
    assert.deepStrictEqual(faces(touchingBlocks(worldOf(blocks), { x: 0.5, y: 1, z: 0.5 })), ['down:stone@0,0,0'])
    assert.deepStrictEqual(faces(touchingBlocks(worldOf(blocks), { x: 0.7, y: 1, z: 0.5 })), ['down:stone@0,0,0', 'east:stone@1,1,0'])
    assert.deepStrictEqual(faces(touchingBlocks(worldOf(blocks), { x: 0.3, y: 1, z: 0.5 })), ['down:stone@0,0,0', 'west:stone@-1,1,0'])
    assert.deepStrictEqual(faces(touchingBlocks(worldOf(blocks), { x: 0.5, y: 1, z: 0.7 })), ['down:stone@0,0,0', 'south:stone@0,1,1'])
    assert.deepStrictEqual(faces(touchingBlocks(worldOf(blocks), { x: 0.5, y: 1, z: 0.3 })), ['down:stone@0,0,0', 'north:stone@0,1,-1'])
  })

  it('a wall a fraction away is not touching, one exactly at the hitbox is', () => {
    const blocks = { ...floor, '1,1,0': stone }
    assert.deepStrictEqual(faces(touchingBlocks(worldOf(blocks), { x: 0.65, y: 1, z: 0.5 })), ['down:stone@0,0,0'])
    assert.ok(faces(touchingBlocks(worldOf(blocks), { x: 0.7, y: 1, z: 0.5 })).includes('east:stone@1,1,0'))
  })

  it('a ceiling touches the head only when the hitbox reaches it', () => {
    const blocks = { ...floor, '0,3,0': stone }
    // Feet at 1.2, height 1.8: the head is exactly at y=3, the underside of the block.
    assert.ok(faces(touchingBlocks(worldOf(blocks), { x: 0.5, y: 1.2, z: 0.5 })).includes('up:stone@0,3,0'))
    assert.deepStrictEqual(faces(touchingBlocks(worldOf(blocks), { x: 0.5, y: 1, z: 0.5 })), ['down:stone@0,0,0'])
  })

  it('a block that overlaps the hitbox is inside, not merely touching', () => {
    const t = touchingBlocks(worldOf({ '0,1,0': stone }), { x: 0.5, y: 1, z: 0.5 })
    assert.deepStrictEqual(faces(t), ['inside:stone@0,1,0'])
  })

  it('a partial block is only touched at its real height', () => {
    const slab = { name: 'stone_slab', shapes: [[0, 0, 0, 1, 0.5, 1]] }
    assert.deepStrictEqual(faces(touchingBlocks(worldOf({ '0,0,0': slab }), { x: 0.5, y: 0.5, z: 0.5 })), ['down:stone_slab@0,0,0'])
    assert.deepStrictEqual(faces(touchingBlocks(worldOf({ '0,0,0': slab }), { x: 0.5, y: 1, z: 0.5 })), [])
  })

  it('a block made of several boxes is reported once per face', () => {
    const stairs = { name: 'oak_stairs', shapes: [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0, 0.5, 1, 1]] }
    const t = touchingBlocks(worldOf({ '0,0,0': stairs }), { x: 0.5, y: 0.5, z: 0.5 })
    assert.strictEqual(faces(t).filter(f => f.startsWith('down')).length, 1)
  })

  it('a non-solid block the hitbox is in is listed as inside, not as a contact', () => {
    const water = { name: 'water', shapes: [] }
    const t = touchingBlocks(worldOf({ ...floor, '0,1,0': water }), { x: 0.5, y: 1, z: 0.5 })
    assert.deepStrictEqual(t.inside, [{ x: 0, y: 1, z: 0, name: 'water' }])
    assert.deepStrictEqual(faces(t), ['down:stone@0,0,0'])
  })

  it('ignores air and unloaded chunks', () => {
    const world = (x, y, z) => (x >= 1 ? null : { name: 'cave_air', shapes: [] })
    assert.deepStrictEqual(touchingBlocks(world, { x: 0.9, y: 1, z: 0.5 }), { contacts: [], inside: [] })
  })

  it('measures a boat by its own, larger hitbox', () => {
    const blocks = { ...floor, '1,1,0': stone }
    const boat = { width: 1.375, height: 0.5625 }
    // A 1.375-wide boat at x=0.3125 reaches x=1.0: touching the wall a player at 0.3125 would not.
    assert.ok(faces(touchingBlocks(worldOf(blocks), { x: 0.3125, y: 1, z: 0.5 }, boat)).includes('east:stone@1,1,0'))
    assert.ok(!faces(touchingBlocks(worldOf(blocks), { x: 0.3125, y: 1, z: 0.5 })).includes('east:stone@1,1,0'))
  })
})

function fakeBot (blocks = {}) {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 1, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 1.5, pitch: 0 }
  bot.controlState = {}
  bot.vehicle = null
  bot.blockAt = (pos) => blocks[`${pos.x},${pos.y},${pos.z}`] || { name: 'air', shapes: [] }
  return bot
}

function loggedBy (bot, options = {}) {
  const lines = []
  let clock = 1000
  const log = new MovementLog(bot, { write: (l) => lines.push(l), now: () => (clock += 50), ...options }).start()
  return { log, lines }
}

describe('MovementLog: samples', () => {
  const floor = { '0,0,0': stone }

  it('writes position, velocity, keys, ground state and the blocks touched', () => {
    const bot = fakeBot(floor)
    bot.controlState = { forward: true, sprint: true }
    bot.entity.velocity = new Vec3(0, -0.0784, 0.281)
    const { lines } = loggedBy(bot)
    bot.emit('physicsTick')
    assert.strictEqual(lines.length, 1)
    assert.match(lines[0], /walk pos=\(0\.500, 1\.000, 0\.500\)/)
    assert.match(lines[0], /v=\(0\.000, -0\.078, 0\.281\)/)
    assert.match(lines[0], /ground yaw=1\.50 pitch=0\.00 keys=\[F,S\] touch\[down:stone@0,0,0\]/)
  })

  it('logs how far the bot moved since the last sample', () => {
    const bot = fakeBot(floor)
    const { lines } = loggedBy(bot)
    bot.emit('physicsTick')
    bot.entity.position = new Vec3(0.5, 1, 0.781)
    bot.emit('physicsTick')
    assert.match(lines[1], /d=\(\+0\.000, \+0\.000, \+0\.281\)/)
  })

  it('skips identical samples but still writes a heartbeat, and everything in "all" mode', () => {
    const bot = fakeBot(floor)
    const { lines } = loggedBy(bot)
    for (let i = 0; i < 10; i++) bot.emit('physicsTick')
    assert.strictEqual(lines.length, 1, 'ten identical ticks should be one line')
    for (let i = 0; i < 20; i++) bot.emit('physicsTick')
    assert.strictEqual(lines.length, 2, 'a long stand-still still leaves a heartbeat')

    const every = loggedBy(fakeBot(floor), { mode: 'all' })
    const b2 = every.log.bot
    for (let i = 0; i < 5; i++) b2.emit('physicsTick')
    assert.strictEqual(every.lines.length, 5)
  })

  it('writes a new line as soon as anything changes: position, keys or what is touched', () => {
    const bot = fakeBot(floor)
    const { lines } = loggedBy(bot)
    bot.emit('physicsTick')
    bot.controlState = { jump: true }
    bot.emit('physicsTick')
    bot.entity.position = new Vec3(0.5, 1.5, 0.5)
    bot.entity.onGround = false
    bot.emit('physicsTick')
    assert.strictEqual(lines.length, 3)
    assert.match(lines[2], / air /)
    assert.match(lines[2], /touch\[\]/)
  })

  it('reports blocks the hitbox is in (water) separately from what it touches', () => {
    const bot = fakeBot({ ...floor, '0,1,0': { name: 'water', shapes: [] } })
    const { lines } = loggedBy(bot)
    bot.emit('physicsTick')
    assert.match(lines[0], /touch\[down:stone@0,0,0\] in\[water@0,1,0\]/)
  })

  it('does not sample the walking bot while it is riding (the boat driver reports then)', () => {
    const bot = fakeBot(floor)
    bot.vehicle = { name: 'oak_boat', position: new Vec3(0, 1, 0) }
    const { lines } = loggedBy(bot)
    bot.emit('physicsTick')
    assert.strictEqual(lines.length, 0)
  })
})

describe('MovementLog: events and the recent-history dump', () => {
  it('writes the events that explain a movement: dig, place, path reset, goal, teleport from the server', () => {
    const bot = fakeBot()
    const { lines } = loggedBy(bot)
    const block = { name: 'gold_block', position: new Vec3(12, 1, 8) }
    bot.emit('diggingCompleted', block)
    bot.emit('diggingAborted', block)
    bot.emit('blockPlaced', { name: 'air' }, { name: 'dirt', position: new Vec3(3, 2, 3) })
    bot.emit('path_reset', 'stuck')
    bot.emit('goal_reached')
    bot._client.emit('position', { x: 8.5, y: 1, z: 8.5, flags: { x: false } })
    bot.emit('forcedMove')
    const all = lines.join('\n')
    assert.match(all, /\*\* DIG-DONE gold_block@12,1,8/)
    assert.match(all, /\*\* DIG-ABORTED gold_block@12,1,8/)
    assert.match(all, /\*\* PLACED dirt@3,2,3/)
    assert.match(all, /\*\* PATH-RESET stuck/)
    assert.match(all, /\*\* GOAL-REACHED/)
    assert.match(all, /\*\* SERVER-POSITION to \(8\.500, 1\.000, 8\.500\) flags=\{"x":false\}/)
    assert.match(all, /\*\* FORCED-MOVE/)
  })

  it('dumpRecent shows the last samples, including the ones the file skipped', () => {
    const bot = fakeBot({ '0,0,0': stone })
    const { log, lines } = loggedBy(bot, { ring: 10 })
    for (let i = 0; i < 6; i++) bot.emit('physicsTick')
    assert.strictEqual(lines.length, 1, 'the file only got the first, identical ones skipped')
    const out = []
    log.dumpRecent(4, (l) => out.push(l))
    assert.match(out[0], /the last 4 samples/)
    assert.strictEqual(out.length, 5)
  })

  it('the history is bounded', () => {
    const bot = fakeBot()
    const { log } = loggedBy(bot, { ring: 5 })
    for (let i = 0; i < 50; i++) bot.emit('physicsTick')
    assert.strictEqual(log.recent().length, 5)
  })

  it('stop() detaches every listener', () => {
    const bot = fakeBot()
    const { log, lines } = loggedBy(bot)
    log.stop()
    bot.emit('physicsTick')
    bot.emit('path_reset', 'x')
    bot._client.emit('position', { x: 1, y: 1, z: 1 })
    assert.strictEqual(lines.length, 0)
    assert.strictEqual(bot.listenerCount('physicsTick'), 0)
    assert.strictEqual(bot._client.listenerCount('position'), 0)
  })
})

describe('MovementLog: the boat', () => {
  const lake = { '0,0,0': stone, '1,1,0': stone }

  it('hooks the pathfinder\'s boat driver once it exists, and logs the boat\'s own hitbox', () => {
    const bot = fakeBot(lake)
    const { lines } = loggedBy(bot)
    bot.pathfinder = { boatDriver: { onTick: null } }
    bot.emit('physicsTick') // the plugin loaded after the log started: it is found on the next tick
    const driver = bot.pathfinder.boatDriver
    assert.strictEqual(typeof driver.onTick, 'function')

    driver.onTick({ x: 0.3125, y: 1, z: 0.5, vx: 0.4, vy: 0, vz: 0, yRot: 90, status: 'in_water', onGround: false, input: { forward: true, back: false, left: false, right: true } })
    const boat = lines.find(l => / boat /.test(l))
    assert.match(boat, /boat pos=\(0\.313, 1\.000, 0\.500\)/)
    assert.match(boat, /yRot=90\.0 status=in_water keys=\[F,R\]/)
    assert.match(boat, /east:stone@1,1,0/, 'the boat is wide enough to touch the wall a player here would not')
  })

  it('stop() lets go of the boat driver', () => {
    const bot = fakeBot()
    const { log } = loggedBy(bot)
    bot.pathfinder = { boatDriver: { onTick: null } }
    bot.emit('physicsTick')
    log.stop()
    assert.strictEqual(bot.pathfinder.boatDriver.onTick, null)
  })
})

describe('MovementLog: boat events', () => {
  it('records the executor\'s boat steps, boats appearing and vanishing, and the driver being released', () => {
    const bot = fakeBot()
    const { lines } = loggedBy(bot)
    bot.emit('boat_step', 'place attempt 1: aiming at (21.50, 99.80, 15.50)')
    bot.emit('entitySpawn', { name: 'oak_boat', id: 77, position: new Vec3(22.6, 99.5, 15.5) })
    bot.emit('entitySpawn', { name: 'chicken', id: 78, position: new Vec3(1, 1, 1) })
    bot.emit('boat_driver_released', 'the server removed the bot from the boat')
    bot.emit('boat_driver_disabled', 'the server keeps rejecting the reported boat position')
    bot.emit('entityGone', { name: 'bamboo_raft', id: 77 })
    const all = lines.join('\n')
    assert.match(all, /\*\* BOAT-STEP place attempt 1: aiming at \(21\.50, 99\.80, 15\.50\)/)
    assert.match(all, /\*\* BOAT-SPAWNED oak_boat id=77 at \(22\.6, 99\.5, 15\.5\)/)
    assert.ok(!/chicken/.test(all), 'a mob that is not a boat must not be logged')
    assert.match(all, /\*\* BOAT-DRIVER-RELEASED the server removed the bot/)
    assert.match(all, /\*\* BOAT-DRIVER-DISABLED the server keeps rejecting/)
    assert.match(all, /\*\* BOAT-GONE bamboo_raft id=77/)
  })
})

describe('MovementLog: what the planner decided', () => {
  const node = (x, y, z, extra = {}) => ({ x, y, z, toBreak: [], toPlace: [], boat: false, ...extra })

  it('describes a route with what each step breaks and places', () => {
    const text = describePath({
      status: 'success',
      cost: 6.5,
      time: 3.4,
      path: [node(9, 1, 8), node(11, 1, 8), node(12, 1, 8, { toBreak: [{}, {}] }), node(12, 2, 8, { toPlace: [{}] })]
    })
    assert.strictEqual(text, 'success nodes=4 cost=6.5 3ms route=[(9,1,8) (11,1,8) (12,1,8) b2 (12,2,8) p1]')
  })

  it('marks boat legs and truncates a long route', () => {
    const path = Array.from({ length: 12 }, (_, i) => node(i, 99, 15, { boat: i > 3 }))
    const text = describePath({ status: 'partial', path })
    assert.match(text, /^partial nodes=12 route=\[/)
    assert.match(text, /\(4,99,15\) boat/)
    assert.match(text, /\.\.\.\+4\]$/)
  })

  it('says so when there is no route, and survives a missing result', () => {
    assert.strictEqual(describePath({ status: 'noPath', path: [] }), 'noPath nodes=0 route=[]')
    assert.strictEqual(describePath(null), 'no result')
  })

  it('logs planner results and goal changes as events', () => {
    const bot = fakeBot()
    const { lines } = loggedBy(bot)
    bot.emit('goal_updated', new (class GoalBlock {})(), false)
    bot.emit('path_update', { status: 'success', cost: 4, time: 2, path: [node(1, 1, 1, { toBreak: [{}] })] })
    const all = lines.join('\n')
    assert.match(all, /\*\* GOAL-UPDATED GoalBlock/)
    assert.match(all, /\*\* PATH-UPDATE success nodes=1 cost=4\.0 2ms route=\[\(1,1,1\) b1\]/)
  })
})

describe('MovementLog: events survive a long stand-still', () => {
  it('the dump lists recent events separately, so idle samples cannot push them out', () => {
    const bot = fakeBot({ '0,0,0': stone })
    const { log } = loggedBy(bot, { ring: 10 })
    bot.emit('path_reset', 'stuck')
    for (let i = 0; i < 60; i++) bot.emit('physicsTick') // far more idle samples than the sample history holds
    const out = []
    log.dumpRecent(5, (l) => out.push(l))
    const text = out.join('\n')
    assert.ok(!/PATH-RESET/.test(out.slice(0, 6).join('\n')), 'the samples section should be all idle samples by now')
    assert.match(text, /the last 1 events:[\s\S]*\*\* PATH-RESET stuck/)
  })
})

describe('MovementLog: file output', () => {
  it('creates the directory, truncates an old log, and holds every line by the time it is stopped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movelog-'))
    const file = path.join(dir, 'nested', 'bot.log')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'stale line from an earlier run\n')

    const bot = fakeBot({ '0,0,0': stone })
    const log = new MovementLog(bot, { file }).start()
    bot.emit('physicsTick')
    bot.emit('path_reset', 'stuck')
    log.stop()
    await new Promise(resolve => setTimeout(resolve, 100))

    const text = fs.readFileSync(file, 'utf8')
    assert.ok(!text.includes('stale line'), 'the old log was appended to instead of replaced')
    assert.match(text, /walk pos=\(0\.500, 1\.000, 0\.500\)/)
    assert.match(text, /\*\* PATH-RESET stuck/)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('echo mode prints each line with the log\'s label', () => {
    const printed = []
    const original = console.log
    console.log = (line) => printed.push(line)
    try {
      const bot = fakeBot()
      const log = new MovementLog(bot, { echo: true, label: 'events' }).start()
      bot.emit('goal_reached')
      log.stop()
    } finally {
      console.log = original
    }
    assert.ok(printed.some(l => /^\[move:events\] .*\*\* GOAL-REACHED/.test(l)), printed.join('\n'))
  })
})

describe('MovementLog: a log that cannot be written', () => {
  const quiet = async (fn) => {
    const original = console.warn
    const warnings = []
    console.warn = (line) => warnings.push(line)
    try {
      await fn()
    } finally {
      console.warn = original
    }
    return warnings
  }

  it('a directory that cannot be created costs the file, not the bot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movelog-'))
    const blocker = path.join(dir, 'a-file')
    fs.writeFileSync(blocker, 'not a directory')
    const lines = []
    const warnings = await quiet(async () => {
      const bot = fakeBot({ '0,0,0': stone })
      const log = new MovementLog(bot, { file: path.join(blocker, 'sub', 'bot.log'), write: (l) => lines.push(l) }).start()
      bot.emit('physicsTick')
      log.stop()
    })
    assert.strictEqual(warnings.length, 1)
    assert.match(warnings[0], /cannot write .*Continuing without a log file/)
    assert.strictEqual(lines.length, 1, 'the other outputs should carry on')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a write error mid-run is survived, and the log keeps going to its other outputs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movelog-'))
    const lines = []
    const warnings = await quiet(async () => {
      const bot = fakeBot({ '0,0,0': stone })
      const log = new MovementLog(bot, { file: path.join(dir, 'bot.log'), write: (l) => lines.push(l) }).start()
      bot.emit('physicsTick')
      log.stream.emit('error', new Error('no space left on device'))
      bot.emit('path_reset', 'after the error')
      log.stop()
    })
    assert.match(warnings[0], /no space left on device/)
    assert.ok(lines.some(l => /PATH-RESET after the error/.test(l)))
    await new Promise(resolve => setTimeout(resolve, 50))
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
