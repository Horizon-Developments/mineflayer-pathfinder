'use strict'

/**
 * Helpers for running the pathfinder suites against a REAL vanilla server.
 *
 * test/internalTest.js talks to a fake server that accepts anything: it hands the
 * client one hand-built chunk and never checks a move. Its tests lean on that. They
 * "teleport" by assigning bot.entity.position, put items in the client's inventory
 * and entities in bot.entities without the server knowing, and mine blocks that the
 * fake server never removes. A real server rubber-bands the first, has no idea about
 * the second and really destroys the third. So the same suites, ported to it, need:
 *
 *   - the arenas built with real /fill and /setblock commands at the same
 *     coordinates the fake maps used (chunk 0,0),
 *   - real /tp, /give and /summon where a test actually moves, equips or spawns,
 *   - the arena rebuilt after a test that mines or builds.
 *
 * Commands are typed on the server console, so nothing here needs operator status.
 *
 * A bot joined with { physics: false } is for a suite that only plans paths and teleports by assigning
 * bot.entity.position. Turning bot.physicsEnabled off is not enough for that: mineflayer's tick skips
 * only the physics simulation, and still sends a position packet whenever bot.entity.position differs
 * from what it last sent, so the server was told about every fake teleport and answered "moved too
 * quickly". Such a bot has its outgoing movement packets dropped instead (muteMovement).
 *
 * Every bot also gets a movement log (lib/movelog.js): its position each tick, the blocks it is
 * touching, and what the server did to it, written to <server dir>/movement-logs/<username>.log.
 * PF_LIVE_MOVELOG=console prints it as well; PF_LIVE_MOVELOG=off turns it off.
 */

const { once } = require('events')
const path = require('path')
const { promises: fs } = require('fs')
const { Vec3 } = require('vec3')
const liveServer = require('../../scripts/live-server')
const { attachMovementLog } = require('../../lib/movelog')

const Version = process.env.PF_LIVE_VERSION || '26.1'
const Port = Number(process.env.PF_LIVE_PORT || liveServer.DEFAULT_PORT)

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil (predicate, timeoutMs, intervalMs = 50) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (predicate()) return true
    await sleep(intervalMs)
  }
  return predicate()
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

let serverPromise = null

// Every time the server moves the bot when a test did not ask it to. A real server checks each
// move the bot reports and answers an illegal one with a teleport back ("rubber-banding"); the
// fake server in internalTest.js accepted anything, so nothing there could ever notice.
const rubberBands = []
let currentTest = ''
const loggers = new Set()

/** Called before each test so a rubber-band can be blamed on the test that was running. */
function markTest (title) {
  currentTest = title
  for (const log of loggers) log.event('TEST', title)
}

/**
 * Start the movement log for a bot (unless PF_LIVE_MOVELOG=off). Returns null when off.
 * @param {any} bot
 * @param {string} label
 * @param {any} [server] the live server, for where its logs go
 */
function attachLog (bot, label, server) {
  const mode = process.env.PF_LIVE_MOVELOG || 'file'
  if (mode === 'off') return null
  const dir = server && server.dir ? server.dir : path.join(process.cwd(), '.mc-server')
  const log = attachMovementLog(bot, {
    label,
    file: path.join(dir, 'movement-logs', `${bot.username}.log`),
    echo: mode === 'console'
  })
  loggers.add(log)
  bot.pfMoveLog = log
  return log
}

/**
 * One line about what a bot is doing: where, holding what, carrying what, and what the pathfinder
 * thinks it is up to. For the moment a test fails and the question is "what state was it in?".
 * @param {any} bot
 */
function describeBot (bot) {
  try {
    const pf = bot.pathfinder
    const held = bot.heldItem ? `${bot.heldItem.name}x${bot.heldItem.count}` : 'nothing'
    const items = bot.inventory ? bot.inventory.items().map(i => `${i.name}x${i.count}`).join(',') : '?'
    const goal = pf && pf.goal ? pf.goal.constructor.name : 'none'
    const state = pf ? `moving=${pf.isMoving()} mining=${pf.isMining()} building=${pf.isBuilding()}` : 'no pathfinder'
    const ride = bot.vehicle ? ` riding=${bot.vehicle.name}` : ''
    return `${bot.username} at ${bot.entity.position} onGround=${bot.entity.onGround} holding=${held} items=[${items}] goal=${goal} ${state}${ride}`
  } catch (e) {
    return `${bot && bot.username}: could not describe (${e.message})`
  }
}

/** Print the state of every live bot and the tail of its movement log. Used when a test fails. */
function dumpAllRecent (n = 30) {
  for (const log of loggers) {
    console.log(`[live] ${describeBot(log.bot)}`)
    log.dumpRecent(n)
  }
}

/** Stop a bot's movement log. Safe if there is none. */
function detachLog (bot) {
  if (!bot || !bot.pfMoveLog) return
  loggers.delete(bot.pfMoveLog)
  bot.pfMoveLog.stop()
  bot.pfMoveLog = null
}

/** @returns {{ suite: string, test: string, at: string, log: string | null }[]} */
function rubberBandReport () {
  return rubberBands.slice()
}

/** Lines the server logged about a move it rejected. */
function serverMovementComplaints () {
  const server = liveServer.current
  return server ? server.logs.filter(l => /moved (wrongly|too quickly)|Vehicle moved|Flying|floating/i.test(l)) : []
}

/**
 * The one server every live suite shares: the one `node scripts/live-server.js` started if
 * there is one, else one started here (once) and killed when the process exits.
 * @returns {Promise<any>}
 */
function getServer () {
  if (liveServer.current) return Promise.resolve(liveServer.current)
  if (!serverPromise) {
    serverPromise = (async () => {
      if (process.env.PF_LIVE_ACCEPT_EULA !== '1') {
        throw new Error('Set PF_LIVE_ACCEPT_EULA=1 to launch a server (that means you accept the Minecraft EULA), or use `npm run test:live` / `node scripts/live-server.js --accept-eula`, which ask.')
      }
      const server = await liveServer.startServer({ version: Version, port: Port, acceptEula: true, echo: process.env.PF_LIVE_DEBUG === '1' })
      liveServer.current = server
      return server
    })()
  }
  return serverPromise
}

let flushes = 0

/** Resolve once the server has run every command sent before this call. */
async function flush (server, timeoutMs = 60000) {
  const tag = `pf-flush-${++flushes}`
  server.send(`say ${tag}`)
  await server.waitForLog(new RegExp(tag), timeoutMs)
}

// ---------------------------------------------------------------------------
// Arenas
// ---------------------------------------------------------------------------

// Everything the arenas use lives in chunk (0,0), y 0..96: one /fill is at most 32768 blocks.
const CLEAR = 'fill 0 0 0 15 96 15 air'
const KILL_ITEMS = 'kill @e[type=item]'
// KILL_ITEMS and CLEAR only remove dropped items and blocks, never a live mob. The NoAI chicken that
// 'Goals with entity' puts on the gold block therefore outlived its suite and stood there for every
// later one on this arena. The planner will not break a block with an entity above it (Movements
// dontMineUnderFallingBlock), so 'isMining' could never plan its dig and just timed out. Scoped to the
// arena so it cannot touch another arena's mobs.
const KILL_ARENA_MOBS = 'kill @e[type=chicken,x=0,y=0,z=0,dx=15,dy=96,dz=15]'
// The most blocks one /fill may change (the server's commandModificationBlockLimit, 32768 by default).
const MAX_FILL_BLOCKS = 32768

/** `fill` commands for a box, cut into slices along z so that none of them is over MAX_FILL_BLOCKS. */
function limitedFills (x0, y0, z0, x1, y1, z1, block) {
  const rowBlocks = (x1 - x0 + 1) * (y1 - y0 + 1) // one z row of the box
  const rowsPerFill = Math.max(1, Math.floor(MAX_FILL_BLOCKS / rowBlocks))
  const commands = []
  for (let z = z0; z <= z1; z += rowsPerFill) {
    commands.push(`fill ${x0} ${y0} ${z} ${x1} ${y1} ${Math.min(z1, z + rowsPerFill - 1)} ${block}`)
  }
  return commands
}

// hostileArena() lives well away from every other arena's coordinates, in its own chunk, so
// nothing it does (barrier walls, a hostile mob with real AI) can bleed into another suite.
const HOSTILE_ORIGIN = new Vec3(200, 5, 200)

/**
 * @typedef {object} Arena
 * @property {string} name
 * @property {string[]} commands console commands that build it, after clearing the region
 * @property {[number, number, number, string][]} checks blocks the client must see before it is ready
 */

/** Flat bedrock floor at y=0 with a single gold block at (12,1,8). Same as flatMap(). */
function flatArena () {
  return {
    name: 'flat',
    commands: [KILL_ITEMS, KILL_ARENA_MOBS, CLEAR, 'fill 0 0 0 15 0 15 minecraft:bedrock', 'setblock 12 1 8 minecraft:gold_block'],
    checks: [[12, 1, 8, 'gold_block'], [5, 0, 5, 'bedrock'], [5, 1, 5, 'air'], [12, 2, 8, 'air']]
  }
}

/** The floating island with a three-deep trench across it. Same as trenchMap(). */
function trenchArena () {
  const top = (z) => z <= 5 ? 56 : z <= 7 ? 53 : z === 8 ? 54 : z === 9 ? 55 : 56
  const commands = [KILL_ITEMS, CLEAR]
  for (let z = 0; z < 16; z++) {
    commands.push(`fill 0 40 ${z} 15 ${top(z) - 1} ${z} minecraft:stone`)
    commands.push(`fill 0 ${top(z)} ${z} 15 ${top(z)} ${z} minecraft:cyan_terracotta`)
  }
  return {
    name: 'trench',
    commands,
    checks: [[5, 56, 0, 'cyan_terracotta'], [5, 53, 6, 'cyan_terracotta'], [5, 54, 8, 'cyan_terracotta'], [5, 57, 0, 'air'], [5, 50, 7, 'stone']]
  }
}

/**
 * Turn a 16x?x16 block function into /fill commands, one per run of identical blocks along x.
 * @param {(x: number, y: number, z: number) => (string | null)} nameAt block name, or null for air
 * @param {number} maxY
 * @returns {{ commands: string[], solid: [number, number, number, string][] }} solid holds the start
 *   of each run
 */
function runLengthFills (nameAt, maxY) {
  const commands = []
  const solid = []
  for (let y = 0; y < maxY; y++) {
    for (let z = 0; z < 16; z++) {
      let x = 0
      while (x < 16) {
        const name = nameAt(x, y, z)
        if (!name) {
          x++
          continue
        }
        let end = x
        while (end + 1 < 16 && nameAt(end + 1, y, z) === name) end++
        commands.push(`fill ${x} ${y} ${z} ${end} ${y} ${z} minecraft:${name}`)
        solid.push([x, y, z, name])
        x = end + 1
      }
    }
  }
  return { commands, solid }
}

/**
 * The parkour1.schem course, laid down in runs of identical blocks along x so it takes a few
 * hundred /fill commands instead of a few thousand /setblock. Same as parkourMap(): block names
 * are matched by name, default block states, and a name this version lacks is left as air.
 * @param {string} version
 * @returns {Promise<Arena>}
 */
async function parkourArena (version) {
  const { Schematic } = require('prismarine-schematic')
  const mcData = require('minecraft-data')(version)
  const schem = await Schematic.read(await fs.readFile(path.join(__dirname, '../schematics/parkour1.schem')), '1.18.2')
  const maxY = Math.min(96, schem.size ? schem.size.y : 96)
  const cache = new Map()
  const nameAt = (x, y, z) => {
    const key = `${x},${y},${z}`
    if (!cache.has(key)) {
      const block = schem.getBlock(new Vec3(x, y, z))
      cache.set(key, block && block.name !== 'air' && mcData.blocksByName[block.name] ? block.name : null)
    }
    return cache.get(key)
  }

  const { commands: fills, solid } = runLengthFills(nameAt, maxY)
  const commands = [KILL_ITEMS, CLEAR, ...fills]
  // Enough spot checks to know the whole course arrived, without polling thousands of blocks.
  const step = Math.max(1, Math.floor(solid.length / 24))
  const checks = solid.filter((_, i) => i % step === 0)
  return { name: 'parkour', commands, checks }
}

/**
 * A long, walled-off plain far from every other arena (those all live in chunk (0,0)) - big
 * enough that the bot is genuinely mid-route, not a step from the goal, when something is
 * dropped on top of its path. Barrier walls on all four edges keep a hostile mob (or the bot)
 * from wandering out of the test area; peaceful difficulty deletes hostile mobs on sight, so
 * the suite that uses this must switch difficulty itself (see hostileMobTest.js).
 * @param {number} [length] blocks along x
 * @param {number} [width] blocks along z
 * @returns {Arena}
 */
function hostileArena (length = 60, width = 10) {
  const { x: x0, y: y0, z: z0 } = HOSTILE_ORIGIN
  const x1 = x0 + length - 1
  const z1 = z0 + width - 1
  const wallTop = y0 + 12
  const commands = [
    `kill @e[type=!player,x=${x0},y=${y0 - 1},z=${z0},dx=${length},dy=20,dz=${width}]`,
    // Cut into slices: one /fill over the whole box is over the 32768-block limit once the arena is
    // much wider than 10 (60 x 62 x 22 is 81840), and the server refuses it, leaving the old blocks.
    ...limitedFills(x0, y0 - 1, z0, x1, y0 + 20, z1, 'air'),
    `fill ${x0} ${y0 - 1} ${z0} ${x1} ${y0 - 1} ${z1} minecraft:grass_block`,
    `fill ${x0} ${y0} ${z0} ${x1} ${wallTop} ${z0} minecraft:barrier`,
    `fill ${x0} ${y0} ${z1} ${x1} ${wallTop} ${z1} minecraft:barrier`,
    `fill ${x0} ${y0} ${z0} ${x0} ${wallTop} ${z1} minecraft:barrier`,
    `fill ${x1} ${y0} ${z0} ${x1} ${wallTop} ${z1} minecraft:barrier`
  ]
  return {
    name: 'hostile',
    commands,
    checks: [
      [x0, y0 - 1, z0, 'grass_block'],
      [x0, y0, z0, 'barrier'],
      [x1, y0, z1, 'barrier'],
      [Math.floor((x0 + x1) / 2), y0 - 1, Math.floor((z0 + z1) / 2), 'grass_block']
    ],
    // No player has ever been near chunk (200,200), so the server hasn't loaded it: /fill against
    // an unloaded chunk silently no-ops ("That position is not loaded"), which left this arena
    // unbuilt while the /tp that followed still succeeded, dropping the bot into the void. join()
    // forceloads this region before running `commands` so the fills actually take effect.
    bounds: { x0, z0, x1, z1 }
  }
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

/** Wait until the client's own copy of the world shows these blocks. */
async function waitForBlocks (bot, checks, timeoutMs = 30000) {
  const wrong = () => checks.filter(([x, y, z, name]) => {
    const block = bot.blockAt(new Vec3(x, y, z))
    return !block || block.name !== name
  })
  if (await waitUntil(() => wrong().length === 0, timeoutMs)) return
  const bad = wrong().slice(0, 6).map(([x, y, z, name]) => {
    const block = bot.blockAt(new Vec3(x, y, z))
    return `(${x},${y},${z}) wanted ${name}, client sees ${block ? block.name : 'nothing'}`
  })
  throw new Error(`the client never saw the arena: ${bad.join('; ')}`)
}

async function build (bot, arena) {
  const { server } = bot.pfWorld
  for (const command of arena.commands) server.send(command)
  await flush(server)
  await waitForBlocks(bot, arena.checks)
}

/**
 * Connect a bot, build the arena, stand it at `spawn`.
 * @param {string} label short and unique per suite (it becomes the username)
 * @param {Arena} arena
 * @param {Vec3} spawn
 * @param {{ physics?: boolean, remote?: boolean }} [options] physics:false leaves the bot's
 *   physics loop off so a suite that only plans paths can move bot.entity.position around
 *   locally without the server ever hearing of it (a real server would rubber-band it).
 *   remote:true is for an arena far from the bot's login position (e.g. hostileArena(), which
 *   deliberately lives in its own chunk): no player has ever been near that chunk, so it isn't
 *   loaded on the server yet and a /fill against it silently no-ops ("That position is not
 *   loaded") instead of throwing - the arena would look built (commands sent, flush returned)
 *   while nothing actually changed. An arena with `bounds` gets that region /forceload'd first
 *   so the fills land; only then does the bot teleport in and the usual waitForBlocks() check
 *   run against what should now really be there.
 */
async function join (label, arena, spawn, { physics = true, remote = false } = {}) {
  const server = await getServer()
  const mineflayer = require('mineflayer')
  const bot = mineflayer.createBot({ host: 'localhost', port: server.port, username: `pf_${label}`.slice(0, 16), version: Version })
  bot.pfWorld = { server, arena, spawn, problems: [], expectedTeleports: 0, muted: false }
  bot.on('kicked', (reason) => bot.pfWorld.problems.push(`kicked: ${String(reason).slice(0, 200)}`))
  bot.on('error', (err) => bot.pfWorld.problems.push(`error: ${err.message}`))
  await once(bot, 'spawn')
  installMovementMute(bot)
  attachLog(bot, label, server)
  await bot.waitForChunksToLoad()
  if (remote) {
    if (arena.bounds) {
      // Force the chunk(s) resident before building: /fill silently no-ops in a chunk the
      // server has never loaded, which a /tp afterwards would not reveal (the teleport itself
      // still succeeds and force-loads the chunk, just too late for the fills that already failed).
      const { x0, z0, x1, z1 } = arena.bounds
      server.send(`forceload add ${x0} ${z0} ${x1} ${z1}`)
      await flush(server)
    }
    for (const command of arena.commands) server.send(command)
    await flush(server)
    watchRubberBanding(bot, label)
    await tp(bot, spawn) // the server enforces collision from its own blocks regardless of what the client has rendered
    await waitForBlocks(bot, arena.checks)
  } else {
    await build(bot, arena)
    watchRubberBanding(bot, label)
    await tp(bot, spawn)
  }
  if (!physics) {
    bot.physicsEnabled = false
    setMuted(bot, true) // physicsEnabled=false alone still lets mineflayer report a locally changed position
  }
  return bot
}

// The packets that tell the server where the bot is and which way it faces.
const MOVEMENT_PACKETS = new Set(['position', 'position_look', 'look', 'flying'])

/**
 * Let the bot's outgoing movement packets be dropped while bot.pfWorld.muted is true. Installed once
 * per bot; with the flag off it does nothing.
 * @param {any} bot
 */
function installMovementMute (bot) {
  const client = bot._client
  const write = client.write.bind(client)
  client.write = (name, ...rest) => {
    if (bot.pfWorld && bot.pfWorld.muted && MOVEMENT_PACKETS.has(name)) return undefined
    return write(name, ...rest)
  }
}

/** Drop (or stop dropping) the bot's movement packets. */
function setMuted (bot, muted) {
  bot.pfWorld.muted = !!muted
}

/**
 * From now on, a position packet the server sends that we did not ask for (with tp()) is the server
 * rejecting a move the bot made, and is recorded against the running test.
 * @param {any} bot needs bot._client and bot.pfWorld.expectedTeleports
 * @param {string} label
 */
function watchRubberBanding (bot, label) {
  bot._client.on('position', () => {
    if (bot.pfWorld.expectedTeleports > 0) {
      bot.pfWorld.expectedTeleports--
    } else {
      const log = bot.pfMoveLog
      rubberBands.push({ suite: label, test: currentTest, at: bot.entity.position.toString(), log: log ? log.file : null })
      if (log) {
        log.event('RUBBER-BAND', `the server moved the bot and no teleport was requested; the bot thought it was at ${bot.entity.position}`)
        log.dumpRecent(25)
      }
    }
  })
}

/** Disconnect. Safe to call with nothing, or twice. */
async function leave (bot) {
  if (!bot) return
  const arena = bot.pfWorld && bot.pfWorld.arena
  if (arena && arena.bounds && bot.pfWorld.server) {
    const { x0, z0, x1, z1 } = arena.bounds
    bot.pfWorld.server.send(`forceload remove ${x0} ${z0} ${x1} ${z1}`)
  }
  detachLog(bot)
  try {
    bot.end()
  } catch (e) { /* already gone */ }
  await sleep(300) // let the server register the departure before the next suite reuses the port
}

/** Rebuild the arena the bot joined with, e.g. after a test that mined or built. */
async function rebuild (bot) {
  await build(bot, bot.pfWorld.arena)
}

/** A real teleport: the server moves the bot and the bot has to arrive. */
async function tp (bot, pos) {
  const { server, problems } = bot.pfWorld
  bot.pfWorld.expectedTeleports++
  if (bot.pfMoveLog) bot.pfMoveLog.event('TP-REQUEST', `to ${pos}`)
  server.send(`tp ${bot.username} ${pos.x} ${pos.y} ${pos.z}`)
  const arrived = await waitUntil(() => bot.entity.position.distanceTo(pos) < 0.5 && (bot.entity.onGround || !bot.physicsEnabled), 15000)
  if (!arrived) {
    throw new Error(`teleport to ${pos} never arrived: the bot is at ${bot.entity.position} (onGround=${bot.entity.onGround}). ${problems.join('; ')}\n${server.logs.slice(-8).join('\n')}`)
  }
  if (bot.physicsEnabled) await bot.waitForTicks(2)
}

/** Change one block on the server and wait for the client to see it. */
async function setBlock (bot, pos, name) {
  bot.pfWorld.server.send(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:${name}`)
  await waitForBlocks(bot, [[pos.x, pos.y, pos.z, name]])
}

/**
 * Spawn a mob. By default it's tagged NoAI so it stays exactly where it's put (what every
 * existing test wants); pass { ai: true } for a real mob that moves, paths and attacks on its
 * own - only meaningful on a difficulty above peaceful, since peaceful deletes hostiles outright.
 */
async function summon (bot, entity, pos, { ai = false } = {}) {
  const tag = ai ? '' : ' {NoAI:1b}'
  bot.pfWorld.server.send(`summon minecraft:${entity} ${pos.x} ${pos.y} ${pos.z}${tag}`)
  const seen = await waitUntil(() => Object.values(bot.entities).some(e => e.name === entity), 10000)
  if (!seen) throw new Error(`the client never saw the ${entity}`)
}

/**
 * Empty the inventory and hand out exactly these items, on the server, and wait for the client
 * to agree.
 * @param {[string, number][]} items
 */
async function resetInventory (bot, items) {
  const { server } = bot.pfWorld
  const mcData = require('minecraft-data')(Version)
  server.send(`clear ${bot.username}`)
  for (const [name, count] of items) server.send(`give ${bot.username} minecraft:${name} ${count}`)
  const synced = await waitUntil(() => items.every(([name, count]) => bot.inventory.count(mcData.itemsByName[name].id) === count), 10000)
  if (!synced) throw new Error(`the client's inventory never showed ${JSON.stringify(items)}`)
}

/**
 * Ask the server itself where an entity is, instead of trusting the client's locally-tracked
 * (and sometimes client-predicted-ahead) bot.entity.position. Uses the same console-command +
 * log-scrape mechanism as everything else in this file (server.send / server.waitForLog), so it
 * needs nothing new server-side.
 * @param {any} bot
 * @param {string} [selector] defaults to this bot; pass another entity's selector (e.g. a UUID
 *   or `@e[type=chicken,limit=1,sort=nearest]`) to ask about something else.
 * @returns {Promise<Vec3>} the position the server reports, right now.
 */
async function getServerPos (bot, selector = bot.username) {
  const { server } = bot.pfWorld
  server.send(`data get entity ${selector} Pos`)
  // Vanilla prints e.g. "<name> has the following entity data: [8.5d, 1.0d, 8.5d]" - tie the
  // match to the selector so a concurrent data-get for a different entity/bot can't be mistaken
  // for this one.
  // fresh: true, or the first answer ever logged for this selector would be returned for every later call.
  const answer = new RegExp(`${escapeRegExp(selector)} has the following entity data: \\[([^\\]]+)\\]`)
  const line = await server.waitForLog(answer, 5000, { fresh: true })
  // Parse with the SAME pattern that found the line. The server prefixes every log line with a
  // bracketed timestamp - "[14:03:11] [Server thread/INFO]: ..." - and a bare /\[([^\]]+)\]/ matches
  // that first: parseFloat("14:03:11") is 14, and split(',') leaves no y or z, which is how a walk
  // that ended on the goal was reported as "stopped (14, undefined, undefined) away".
  const match = answer.exec(line)
  const [x, y, z] = match ? match[1].split(',').map(s => parseFloat(s)) : []
  if (![x, y, z].every(Number.isFinite)) throw new Error(`could not read a position for ${selector} from: ${line}`)
  return new Vec3(x, y, z)
}

function escapeRegExp (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

module.exports = {
  Version,
  sleep,
  waitUntil,
  getServer,
  flatArena,
  trenchArena,
  parkourArena,
  hostileArena,
  HOSTILE_ORIGIN,
  runLengthFills,
  limitedFills,
  watchRubberBanding,
  join,
  leave,
  rebuild,
  tp,
  setBlock,
  summon,
  resetInventory,
  getServerPos,
  waitForBlocks,
  installMovementMute,
  setMuted,
  attachLog,
  detachLog,
  describeBot,
  dumpAllRecent,
  markTest,
  rubberBandReport,
  serverMovementComplaints
}
