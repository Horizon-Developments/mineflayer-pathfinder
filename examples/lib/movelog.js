'use strict'

/**
 * Movement log: where the bot is on every physics tick, what it is touching, and what the
 * server and the pathfinder did around it. Made for finding out why a real server moves the
 * bot back ("rubber-banding"), but it does nothing pathfinder-specific: give it any bot.
 *
 * One line per sample, e.g.
 *
 *    12.350s #247 walk pos=(8.500, 1.000, 9.120) d=(+0.000, +0.000, +0.281) v=(0.000, -0.078, 0.281)
 *      ground yaw=3.14 keys=[F,S] touch[down:bedrock@8,0,9 east:stone@9,1,9]
 *
 * "touch" lists the blocks whose collision boxes are in contact with the bot's hitbox, by face
 * (down = the floor, up = a ceiling, east/west/north/south = walls; +x is east, +z is south).
 * "inside" lists a block the hitbox overlaps, which is either a solid one it is stuck in or a
 * non-solid one such as water, a ladder or grass; "in[...]" lists those. Every position is a
 * block position, so any line can be checked against the world.
 *
 * While a boat is being driven the same is logged for the boat's hitbox, from the boat
 * driver's own ticks (mineflayer emits no physics tick while mounted).
 */

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')

const EPS = 1e-3
const AIR = new Set(['air', 'cave_air', 'void_air'])
const KEYS = [['forward', 'F'], ['back', 'B'], ['left', 'L'], ['right', 'R'], ['jump', 'J'], ['sprint', 'S'], ['sneak', 'N']]
const PLAYER = { width: 0.6, height: 1.8 }
const BOAT = { width: 1.375, height: 0.5625 }
// A sample identical to the last one is skipped, but one is still written this often (in ticks) so
// a long stand-still shows the bot was alive.
const HEARTBEAT = 20
const BOATLIKE = /(^|_)(boat|raft)$/

const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0)

/**
 * The blocks in contact with a hitbox standing at `pos` (its feet, centred).
 * @param {(x: number, y: number, z: number) => ({ name: string, shapes?: number[][] } | null | undefined)} getBlock
 *   `shapes` are collision boxes relative to the block, [minX, minY, minZ, maxX, maxY, maxZ]
 * @param {{ x: number, y: number, z: number }} pos
 * @param {{ width?: number, height?: number }} [size]
 * @returns {{ contacts: { x: number, y: number, z: number, name: string, face: string }[], inside: { x: number, y: number, z: number, name: string }[] }}
 */
function touchingBlocks (getBlock, pos, { width = PLAYER.width, height = PLAYER.height } = {}) {
  const r = width / 2
  const box = { minX: pos.x - r, maxX: pos.x + r, minY: pos.y, maxY: pos.y + height, minZ: pos.z - r, maxZ: pos.z + r }
  const contacts = []
  const inside = []
  const seen = new Set()

  for (let x = Math.floor(box.minX - EPS); x <= Math.floor(box.maxX + EPS); x++) {
    for (let y = Math.floor(box.minY - EPS); y <= Math.floor(box.maxY + EPS); y++) {
      for (let z = Math.floor(box.minZ - EPS); z <= Math.floor(box.maxZ + EPS); z++) {
        const block = getBlock(x, y, z)
        if (!block || AIR.has(block.name)) continue
        const shapes = block.shapes || []

        if (shapes.length === 0) {
          // Nothing to collide with, but worth naming when the hitbox is in it: water, ladders, grass.
          if (overlap(box.minX, box.maxX, x, x + 1) > EPS && overlap(box.minY, box.maxY, y, y + 1) > EPS && overlap(box.minZ, box.maxZ, z, z + 1) > EPS) {
            inside.push({ x, y, z, name: block.name })
          }
          continue
        }

        for (const s of shapes) {
          const ox = overlap(box.minX, box.maxX, x + s[0], x + s[3])
          const oy = overlap(box.minY, box.maxY, y + s[1], y + s[4])
          const oz = overlap(box.minZ, box.maxZ, z + s[2], z + s[5])
          let face = null
          if (ox > EPS && oy > EPS && oz > EPS) face = 'inside'
          else if (Math.abs(oy) <= EPS && ox > EPS && oz > EPS) face = y + s[1] >= box.maxY - EPS ? 'up' : 'down'
          else if (Math.abs(ox) <= EPS && oy > EPS && oz > EPS) face = x + s[0] >= box.maxX - EPS ? 'east' : 'west'
          else if (Math.abs(oz) <= EPS && ox > EPS && oy > EPS) face = z + s[2] >= box.maxZ - EPS ? 'south' : 'north'
          if (!face) continue
          const key = `${x},${y},${z},${face}`
          if (seen.has(key)) continue
          seen.add(key)
          contacts.push({ x, y, z, name: block.name, face })
        }
      }
    }
  }
  contacts.sort((a, b) => a.face.localeCompare(b.face) || a.x - b.x || a.y - b.y || a.z - b.z)
  return { contacts, inside }
}

/**
 * One line about a planner result: how it ended and the first steps of the route, each with how
 * many blocks it breaks (b) and places (p), and whether it is a boat leg. A route that is meant to
 * dig but has no b in it is the answer to "why did it not dig".
 */
function describePath (results) {
  if (!results) return 'no result'
  const path = Array.isArray(results.path) ? results.path : []
  const steps = path.slice(0, 8).map(n => {
    const b = n.toBreak ? n.toBreak.length : 0
    const p = n.toPlace ? n.toPlace.length : 0
    return `(${n.x},${n.y},${n.z})${b ? ` b${b}` : ''}${p ? ` p${p}` : ''}${n.boat ? ' boat' : ''}`
  })
  const more = path.length > steps.length ? ` ...+${path.length - steps.length}` : ''
  const cost = Number.isFinite(results.cost) ? ` cost=${results.cost.toFixed(1)}` : ''
  const time = Number.isFinite(results.time) ? ` ${Math.round(results.time)}ms` : ''
  return `${results.status} nodes=${path.length}${cost}${time} route=[${steps.join(' ')}${more}]`
}

const fixed = (n) => n.toFixed(3)
const signed = (n) => (n >= 0 ? '+' : '') + n.toFixed(3)

class MovementLog {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {object} [options]
   * @param {string} [options.file] append lines here (truncated at start)
   * @param {boolean} [options.echo] also print every logged line
   * @param {(line: string) => void} [options.write] receive every logged line (for tests)
   * @param {'changes' | 'all'} [options.mode] 'changes' skips samples identical to the last one
   * @param {number} [options.ring] how many recent samples dumpRecent() can show
   * @param {string} [options.label]
   * @param {() => number} [options.now]
   */
  constructor (bot, { file = null, echo = false, write = null, mode = 'changes', ring = 40, label = 'bot', now = Date.now } = {}) {
    this.bot = bot
    this.file = file
    this.echo = echo
    this.sink = write
    this.mode = mode
    this.ringSize = ring
    this.label = label
    this.now = now
    this.t0 = now()
    this.tick = 0
    this.last = null
    this.lastSignature = null
    this.lastLoggedTick = -HEARTBEAT
    this.ring = []
    this.eventRing = []
    this.stream = null
    this.driver = null
    this.handlers = []
    this._boatHook = (driver) => this.sampleBoat(driver)
  }

  start () {
    if (this.file) this.openFile()
    const listen = (emitter, name, fn) => {
      emitter.on(name, fn)
      this.handlers.push([emitter, name, fn])
    }
    const bot = this.bot
    const at = (block) => (block && block.position ? `${block.name}@${block.position.x},${block.position.y},${block.position.z}` : String(block))

    listen(bot, 'physicsTick', () => this.sampleBot())
    listen(bot, 'diggingCompleted', (block) => this.event('DIG-DONE', at(block)))
    listen(bot, 'diggingAborted', (block) => this.event('DIG-ABORTED', at(block)))
    listen(bot, 'blockPlaced', (oldBlock, newBlock) => this.event('PLACED', at(newBlock)))
    listen(bot, 'path_reset', (reason) => this.event('PATH-RESET', String(reason)))
    listen(bot, 'goal_reached', () => this.event('GOAL-REACHED'))
    listen(bot, 'goal_updated', (goal) => this.event('GOAL-UPDATED', goal ? goal.constructor.name : 'none'))
    listen(bot, 'path_update', (results) => this.event('PATH-UPDATE', describePath(results)))
    listen(bot, 'path_stop', () => this.event('PATH-STOP'))
    listen(bot, 'forcedMove', () => this.event('FORCED-MOVE', 'mineflayer applied a position from the server'))
    listen(bot, 'mount', () => {
      this.hookBoatDriver()
      this.event('MOUNT', bot.vehicle ? `${bot.vehicle.name} at ${bot.vehicle.position}` : '')
    })
    listen(bot, 'dismount', () => this.event('DISMOUNT'))
    // What the boat executor is doing (lib/boat.js, index.js) and what the world does about it.
    listen(bot, 'hostile_replan', (v) => this.event('HOSTILE-REPLAN', `${v.name} id=${v.id} ${v.reason} ${Number.isFinite(v.distance) ? v.distance.toFixed(1) + ' blocks away' : ''}${Number.isFinite(v.moved) ? `, moved ${v.moved.toFixed(1)}` : ''}`))
    listen(bot, 'boat_step', (text) => this.event('BOAT-STEP', String(text)))
    listen(bot, 'boat_driver_released', (why) => this.event('BOAT-DRIVER-RELEASED', String(why)))
    listen(bot, 'boat_driver_disabled', (why) => this.event('BOAT-DRIVER-DISABLED', String(why)))
    listen(bot, 'entitySpawn', (entity) => {
      if (entity && BOATLIKE.test(String(entity.name || ''))) this.event('BOAT-SPAWNED', `${entity.name} id=${entity.id} at ${entity.position}`)
    })
    listen(bot, 'entityGone', (entity) => {
      if (entity && BOATLIKE.test(String(entity.name || ''))) this.event('BOAT-GONE', `${entity.name} id=${entity.id}`)
    })
    if (bot._client) {
      listen(bot._client, 'position', (p) => {
        const to = [p.x, p.y, p.z].every(Number.isFinite) ? `(${fixed(p.x)}, ${fixed(p.y)}, ${fixed(p.z)})` : '(unreadable)'
        this.event('SERVER-POSITION', `to ${to} flags=${JSON.stringify(p.flags)}`)
      })
    }
    return this
  }

  /**
   * Logging is a diagnostic: a log that cannot be written (full disk, no permission, the directory
   * removed) has to cost the log, not the bot or the test run. An unhandled stream error would
   * crash the whole process.
   */
  openFile () {
    const failed = (err) => {
      if (this.stream) this.stream.removeAllListeners()
      this.stream = null
      console.warn(`[move:${this.label}] cannot write ${this.file}: ${err.message}. Continuing without a log file.`)
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      this.stream = fs.createWriteStream(this.file, { flags: 'w' })
      this.stream.on('error', failed)
    } catch (err) {
      failed(err)
    }
  }

  stop () {
    for (const [emitter, name, fn] of this.handlers) emitter.removeListener(name, fn)
    this.handlers = []
    if (this.driver && this.driver.onTick === this._boatHook) this.driver.onTick = null
    this.driver = null
    if (this.stream) {
      this.stream.end()
      this.stream = null
    }
  }

  /** The pathfinder loads after the bot joins, so find its boat driver when it is needed. */
  hookBoatDriver () {
    const driver = this.bot.pathfinder && this.bot.pathfinder.boatDriver
    if (driver && driver.onTick !== this._boatHook) {
      driver.onTick = this._boatHook
      this.driver = driver
    }
  }

  blockAt (x, y, z) {
    return this.bot.blockAt(new Vec3(x, y, z), false)
  }

  sampleBot () {
    this.hookBoatDriver()
    const e = this.bot.entity
    if (!e || this.bot.vehicle) return // while riding, the boat driver reports
    const control = this.bot.controlState || {}
    this.sample('walk', {
      pos: e.position,
      vel: e.velocity,
      onGround: e.onGround,
      heading: `yaw=${(e.yaw ?? 0).toFixed(2)} pitch=${(e.pitch ?? 0).toFixed(2)}`,
      keys: KEYS.filter(([name]) => control[name]).map(([, letter]) => letter),
      size: PLAYER
    })
  }

  sampleBoat (d) {
    const keys = [['forward', 'F'], ['back', 'B'], ['left', 'L'], ['right', 'R']].filter(([name]) => d.input[name]).map(([, letter]) => letter)
    this.sample('boat', {
      pos: { x: d.x, y: d.y, z: d.z },
      vel: { x: d.vx, y: d.vy, z: d.vz },
      onGround: d.onGround,
      heading: `yRot=${d.yRot.toFixed(1)} status=${d.status}`,
      keys,
      size: BOAT
    })
  }

  sample (mode, s) {
    this.tick++
    const p = s.pos
    const v = s.vel || { x: 0, y: 0, z: 0 }
    const touch = touchingBlocks((x, y, z) => this.blockAt(x, y, z), p, s.size)
    const contacts = touch.contacts.map(c => `${c.face}:${c.name}@${c.x},${c.y},${c.z}`).join(' ')
    const inside = touch.inside.map(i => `${i.name}@${i.x},${i.y},${i.z}`).join(' ')
    const d = this.last ? { x: p.x - this.last.x, y: p.y - this.last.y, z: p.z - this.last.z } : { x: 0, y: 0, z: 0 }
    this.last = { x: p.x, y: p.y, z: p.z }

    const line = `${this.stamp()} ${mode} pos=(${fixed(p.x)}, ${fixed(p.y)}, ${fixed(p.z)}) ` +
      `d=(${signed(d.x)}, ${signed(d.y)}, ${signed(d.z)}) v=(${fixed(v.x)}, ${fixed(v.y)}, ${fixed(v.z)}) ` +
      `${s.onGround ? 'ground' : 'air'} ${s.heading} keys=[${s.keys.join(',')}] touch[${contacts}]` +
      (inside ? ` in[${inside}]` : '')

    this.remember(line)
    const signature = `${mode}|${fixed(p.x)}|${fixed(p.y)}|${fixed(p.z)}|${s.onGround}|${s.keys.join('')}|${contacts}|${inside}`
    const changed = signature !== this.lastSignature
    this.lastSignature = signature
    if (this.mode === 'all' || changed || this.tick - this.lastLoggedTick >= HEARTBEAT) {
      this.lastLoggedTick = this.tick
      this.emit(line)
    }
  }

  /** Something that is not a sample: always written. */
  event (kind, detail = '') {
    const line = `${this.stamp()} ** ${kind}${detail ? ' ' + detail : ''}`
    this.remember(line)
    this.eventRing.push(line)
    if (this.eventRing.length > 20) this.eventRing.shift()
    this.emit(line)
  }

  stamp () {
    return `${((this.now() - this.t0) / 1000).toFixed(3).padStart(8)}s #${String(this.tick).padStart(5)}`
  }

  remember (line) {
    this.ring.push(line)
    if (this.ring.length > this.ringSize) this.ring.shift()
  }

  emit (line) {
    if (this.stream) this.stream.write(line + '\n')
    if (this.sink) this.sink(line)
    if (this.echo) console.log(`[move:${this.label}] ${line}`)
  }

  /** The last `n` samples and events, including the ones 'changes' mode kept out of the file. */
  recent (n = this.ringSize) {
    return this.ring.slice(-n)
  }

  /** Print the last `n` samples: what a rubber-band needs to be understood. */
  dumpRecent (n = 25, out = console.log) {
    const lines = this.recent(n)
    out(`[move:${this.label}] the last ${lines.length} samples before this${this.file ? ` (full log: ${this.file})` : ''}:`)
    for (const line of lines) out(`[move:${this.label}]   ${line}`)
    // A bot that stands still for a while fills the samples above with identical lines and pushes
    // out what it was doing: keep the events on their own.
    if (this.eventRing.length) {
      out(`[move:${this.label}] the last ${this.eventRing.length} events:`)
      for (const line of this.eventRing) out(`[move:${this.label}]   ${line}`)
    }
  }
}

/**
 * Start logging a bot's movement. Stops when `log.stop()` is called.
 * @param {import('mineflayer').Bot} bot
 * @param {ConstructorParameters<typeof MovementLog>[1]} [options]
 * @returns {MovementLog}
 */
function attachMovementLog (bot, options) {
  return new MovementLog(bot, options).start()
}

module.exports = { MovementLog, attachMovementLog, touchingBlocks, describePath }
