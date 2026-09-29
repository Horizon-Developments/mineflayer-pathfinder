'use strict'

/**
 * Client-side boat driver.
 *
 * WHY THIS EXISTS
 * ---------------
 * A vanilla server does not move a boat that a player is riding. Boats are
 * client-authoritative: the rider's client runs the boat physics every tick and
 * reports the result with a serverbound `vehicle_move` packet, which the server
 * only sanity-checks (Boat.tick() on the server zeroes the velocity of a boat that
 * is controlled by a player). Mineflayer's bot.moveVehicle() sends the steering
 * *input* (steer_vehicle / player_input) and nothing else, so a bot that only calls
 * it mounts fine, "steers", and the boat never moves. The executor then times out
 * and reports the node as stuck.
 *
 * This class is the missing half: it ports the boat's per-tick movement (buoyancy,
 * friction, paddle steering, block collision) from the vanilla client and sends
 * `vehicle_move` (plus `steer_boat` for the paddle animation) the way a real
 * client does.
 *
 * It intentionally has no dependency on the rest of the pathfinder: give it a bot,
 * tell it which entity is the vehicle, set the input, call step() about every 50 ms.
 */

const { Vec3 } = require('vec3')

const TICK_MS = 50
const WIDTH = 1.375 // boat and raft hitbox
const HEIGHT = 0.5625
const EPS = 1e-7
const DEG = Math.PI / 180

// Block friction for the block a boat is grounded on. Anything not listed is 0.6.
const FRICTION = {
  ice: 0.98,
  packed_ice: 0.98,
  blue_ice: 0.989,
  frosted_ice: 0.98,
  slime_block: 0.8
}
// Blocks that always contain water, so a boat floats in them like in water.
const ALWAYS_WATER = new Set(['kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column'])

const Status = {
  IN_WATER: 'in_water',
  UNDER_WATER: 'under_water',
  UNDER_FLOWING_WATER: 'under_flowing_water',
  ON_LAND: 'on_land',
  IN_AIR: 'in_air'
}

const wrapDegrees = (d) => {
  d = d % 360
  if (d >= 180) d -= 360
  if (d < -180) d += 360
  return d
}

// mineflayer keeps entity yaw in radians with 0 = facing -z and turning left as
// positive; the game keeps it in degrees with 0 = facing +z and turning right as
// positive. They are related by yaw = PI - yRot.
const toMineflayerYaw = (yRotDeg) => {
  const r = Math.PI - yRotDeg * DEG
  return ((r % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
}
const toGameYaw = (yawRad) => 180 - yawRad / DEG

class BoatDriver {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {object} [settings] live settings object (bot.pathfinder); read on every use
   */
  constructor (bot, settings = {}) {
    this.bot = bot
    this.settings = settings
    this.waterId = bot.registry.blocksByName.water.id

    this.vehicle = null
    /**
     * Optional observer, called with this driver after every simulated tick (see lib/movelog.js).
     * Whatever it does, including throwing, must not affect the boat.
     * @type {((driver: BoatDriver) => void) | null}
     */
    this.onTick = null
    this.engaged = false // only simulate while something is actually steering
    this.disabled = null // reason string once the driver has given up
    this.input = { left: false, right: false, forward: false, back: false }

    this.corrections = [] // timestamps of server rejections
    this.sent = 0
    this.lastPaddle = null
    this.lastDebug = 0
    this.lastStepAt = 0
    this.owed = 0 // ms of simulation time not yet run

    this.resetState(0, 0, 0, 0)

    this._onServerMove = (packet) => this.onServerMove(packet)
    this._onPassengers = (packet) => this.onPassengers(packet)
    this._listening = false
  }

  /** True while this driver is the thing moving the boat. */
  get active () {
    return !!this.vehicle && !this.disabled
  }

  get position () {
    return new Vec3(this.x, this.y, this.z)
  }

  resetState (x, y, z, yRot) {
    this.x = x
    this.y = y
    this.z = z
    this.vx = 0
    this.vy = 0
    this.vz = 0
    this.yRot = yRot
    this.deltaRotation = 0
    this.status = null
    this.oldStatus = null
    this.waterLevel = 0
    this.lastYd = 0
    this.landFriction = 0.6
    this.onGround = false
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start tracking `vehicle`. Call from the 'mount' handler.
   *
   * @param {import('prismarine-entity').Entity} vehicle
   * @param {object} [options]
   * @param {boolean} [options.engaged=true] false leaves the boat alone until engage()
   *   is called. The pathfinder uses that so that merely sitting in a boat, or riding
   *   one a server moves by itself, never has the client contradicting the server.
   */
  attach (vehicle, { engaged = true } = {}) {
    this.vehicle = vehicle
    this.engaged = engaged
    this.disabled = null
    this.corrections = []
    this.lastPaddle = null
    this.owed = 0
    this.lastStepAt = 0
    this.setInput(0, 0)
    const p = vehicle.position
    this.resetState(p.x, p.y, p.z, Number.isFinite(vehicle.yaw) ? toGameYaw(vehicle.yaw) : 0)
    if (!this._listening && this.bot._client) {
      this.bot._client.on('vehicle_move', this._onServerMove)
      this.bot._client.on('set_passengers', this._onPassengers)
      this._listening = true
    }
  }

  /** Stop driving. Call from the 'dismount' handler. */
  detach () {
    this.vehicle = null
    this.engaged = false
    this.setInput(0, 0)
    if (this._listening && this.bot._client) {
      this.bot._client.removeListener('vehicle_move', this._onServerMove)
      this.bot._client.removeListener('set_passengers', this._onPassengers)
    }
    this._listening = false
  }

  /**
   * Begin simulating and reporting. Starts from the boat as the server last put it,
   * not from wherever the simulation was left when it was last released.
   */
  engage () {
    if (this.engaged || !this.vehicle) return
    this.engaged = true
    this.resyncFromEntity()
    this.owed = 0
    this.lastStepAt = 0
  }

  /** Stop simulating and reporting; the boat stays where it was last reported. */
  release () {
    this.engaged = false
    this.setInput(0, 0)
  }

  /**
   * @param {number} turn positive turns left, negative turns right
   * @param {number} forward positive drives forward, negative reverses
   */
  setInput (turn, forward) {
    this.input.left = turn > 0
    this.input.right = turn < 0
    this.input.forward = forward > 0
    this.input.back = forward < 0
  }

  disable (reason) {
    if (this.disabled) return
    this.disabled = reason
    this.setInput(0, 0)
    if (this.settings.logStuckPlaces !== false) console.warn(`[pathfinder] boat driver disabled: ${reason}`)
    this.bot.emit('boat_driver_disabled', reason)
  }

  // ---------------------------------------------------------------------------
  // Stepping
  // ---------------------------------------------------------------------------

  /**
   * Run however many 50 ms ticks are due (at most 3, so a stalled event loop
   * cannot make the boat lurch) and report the result. Safe to call at any rate.
   * @param {number} [now] ms timestamp, injectable for tests
   * @returns {boolean} true if at least one tick ran
   */
  step (now = Date.now()) {
    if (!this.active || !this.engaged) return false
    if (!this.lastStepAt) this.lastStepAt = now - TICK_MS
    this.owed += now - this.lastStepAt
    this.lastStepAt = now
    let ticks = Math.floor(this.owed / TICK_MS)
    if (ticks <= 0) return false
    this.owed -= ticks * TICK_MS
    if (ticks > 3) ticks = 3
    this.owed = Math.min(this.owed, TICK_MS)

    for (let i = 0; i < ticks; i++) {
      this.tick()
      if (this.onTick) {
        try {
          this.onTick(this)
        } catch (e) { /* an observer must never stop the boat */ }
      }
      if (!this.finite()) {
        // Never send a NaN: the server disconnects for invalid vehicle movement.
        this.resyncFromEntity()
        return false
      }
      if (!this.send()) return false
    }
    this.publish()
    this.debug(now)
    return true
  }

  finite () {
    return [this.x, this.y, this.z, this.vx, this.vy, this.vz, this.yRot].every(Number.isFinite)
  }

  resyncFromEntity () {
    if (!this.vehicle) return
    const p = this.vehicle.position
    this.resetState(p.x, p.y, p.z, Number.isFinite(this.vehicle.yaw) ? toGameYaw(this.vehicle.yaw) : 0)
  }

  /** One game tick of Boat.tick() as the controlling client runs it. */
  tick () {
    this.oldStatus = this.status
    this.status = this.getStatus()
    this.floatBoat()
    this.controlBoat()
    this.moveWithCollision(this.vx, this.vy, this.vz)
    this.lastYd = this.vy
  }

  // ---------------------------------------------------------------------------
  // World access
  // ---------------------------------------------------------------------------

  blockAt (x, y, z) {
    return this.bot.blockAt(new Vec3(x, y, z), false)
  }

  isWaterBlock (b) {
    if (!b) return false
    if (b.type === this.waterId) return true
    if (b.name && ALWAYS_WATER.has(b.name)) return true
    try {
      const props = b.getProperties ? b.getProperties() : null
      return !!props && (props.waterlogged === true || props.waterlogged === 'true')
    } catch (e) {
      return false
    }
  }

  waterLevelOf (b) {
    // 0 is a source block; 1-7 flowing, 8+ falling.
    try {
      const props = b.getProperties ? b.getProperties() : null
      if (props && props.level !== undefined) return Number(props.level) || 0
    } catch (e) { /* fall through */ }
    if (b.type === this.waterId && Number.isFinite(b.metadata)) return b.metadata & 0xf
    return 0
  }

  /** Height of the fluid surface inside this cell, 0 if there is no water. */
  waterHeightAt (x, y, z) {
    const b = this.blockAt(x, y, z)
    if (!this.isWaterBlock(b)) return 0
    if (this.isWaterBlock(this.blockAt(x, y + 1, z))) return 1
    if (b.type !== this.waterId) return 8 / 9 // waterlogged block, kelp, ...
    const level = this.waterLevelOf(b)
    if (level === 0) return 8 / 9
    if (level >= 8) return 1
    return (8 - level) / 9
  }

  isSourceAt (x, y, z) {
    const b = this.blockAt(x, y, z)
    if (!this.isWaterBlock(b)) return false
    return b.type !== this.waterId || this.waterLevelOf(b) === 0
  }

  /**
   * World-space collision boxes of a cell. An unloaded chunk is treated as solid,
   * so a boat cannot be driven off into the void.
   * @returns {number[][]} [minX, minY, minZ, maxX, maxY, maxZ]
   */
  boxesAt (x, y, z) {
    const b = this.blockAt(x, y, z)
    if (!b) return [[x, y, z, x + 1, y + 1, z + 1]]
    if (!b.shapes || b.shapes.length === 0) return []
    return b.shapes.map(s => [x + s[0], y + s[1], z + s[2], x + s[3], y + s[4], z + s[5]])
  }

  box () {
    const r = WIDTH / 2
    return { minX: this.x - r, minY: this.y, minZ: this.z - r, maxX: this.x + r, maxY: this.y + HEIGHT, maxZ: this.z + r }
  }

  // ---------------------------------------------------------------------------
  // Status (AbstractBoat.getStatus and friends)
  // ---------------------------------------------------------------------------

  getStatus () {
    const under = this.isUnderwater()
    if (under) {
      this.waterLevel = this.box().maxY
      return under
    }
    if (this.checkInWater()) return Status.IN_WATER
    const friction = this.getGroundFriction()
    if (friction > 0) {
      this.landFriction = friction
      return Status.ON_LAND
    }
    return Status.IN_AIR
  }

  isUnderwater () {
    const b = this.box()
    const top = b.maxY + 0.001
    let under = false
    for (let x = Math.floor(b.minX); x < Math.ceil(b.maxX); x++) {
      for (let y = Math.floor(b.maxY); y < Math.ceil(top); y++) {
        for (let z = Math.floor(b.minZ); z < Math.ceil(b.maxZ); z++) {
          const h = this.waterHeightAt(x, y, z)
          if (h > 0 && top < y + h) {
            if (!this.isSourceAt(x, y, z)) return Status.UNDER_FLOWING_WATER
            under = true
          }
        }
      }
    }
    return under ? Status.UNDER_WATER : null
  }

  checkInWater () {
    const b = this.box()
    let inWater = false
    this.waterLevel = -Number.MAX_VALUE
    for (let x = Math.floor(b.minX); x < Math.ceil(b.maxX); x++) {
      for (let y = Math.floor(b.minY); y < Math.ceil(b.minY + 0.001); y++) {
        for (let z = Math.floor(b.minZ); z < Math.ceil(b.maxZ); z++) {
          const h = this.waterHeightAt(x, y, z)
          if (h > 0) {
            const level = y + h
            this.waterLevel = Math.max(this.waterLevel, level)
            inWater = inWater || b.minY < level
          }
        }
      }
    }
    return inWater
  }

  getGroundFriction () {
    const b = this.box()
    const lo = b.minY - 0.001
    let total = 0
    let count = 0
    for (let x = Math.floor(b.minX); x < Math.ceil(b.maxX); x++) {
      for (let y = Math.floor(lo); y < Math.ceil(b.minY); y++) {
        for (let z = Math.floor(b.minZ); z < Math.ceil(b.maxZ); z++) {
          const block = this.blockAt(x, y, z)
          if (block && block.name === 'lily_pad') continue
          const hit = this.boxesAt(x, y, z).some(shape => overlapsSlab(shape, b, lo))
          if (hit) {
            total += (block && FRICTION[block.name]) || 0.6
            count++
          }
        }
      }
    }
    return count === 0 ? 0 : total / count
  }

  getWaterLevelAbove () {
    const b = this.box()
    const y1 = Math.ceil(b.maxY - this.lastYd)
    for (let y = Math.floor(b.maxY); y < y1; y++) {
      let f = 0
      for (let x = Math.floor(b.minX); x < Math.ceil(b.maxX) && f < 1; x++) {
        for (let z = Math.floor(b.minZ); z < Math.ceil(b.maxZ) && f < 1; z++) {
          f = Math.max(f, this.waterHeightAt(x, y, z))
        }
      }
      if (f < 1) return y + f
    }
    return y1 + 1
  }

  // ---------------------------------------------------------------------------
  // Movement (AbstractBoat.floatBoat / controlBoat)
  // ---------------------------------------------------------------------------

  floatBoat () {
    let gravity = -0.04
    let buoyancy = 0
    let invFriction = 0.05

    if (this.oldStatus === Status.IN_AIR && this.status !== Status.IN_AIR && this.status !== Status.ON_LAND) {
      // Just hit the water: pop up to the surface and drop the vertical speed.
      this.waterLevel = this.y + 1
      this.y = this.getWaterLevelAbove() - HEIGHT + 0.101
      this.vy = 0
      this.lastYd = 0
      this.status = Status.IN_WATER
      return
    }

    if (this.status === Status.IN_WATER) {
      buoyancy = (this.waterLevel - this.y) / HEIGHT
      invFriction = 0.9
    } else if (this.status === Status.UNDER_FLOWING_WATER) {
      gravity = -7.0e-4
      invFriction = 0.9
    } else if (this.status === Status.UNDER_WATER) {
      buoyancy = 0.01
      invFriction = 0.45
    } else if (this.status === Status.IN_AIR) {
      invFriction = 0.9
    } else if (this.status === Status.ON_LAND) {
      invFriction = this.landFriction
      this.landFriction /= 2 // the rider is a player
    }

    this.vx *= invFriction
    this.vy += gravity
    this.vz *= invFriction
    this.deltaRotation *= invFriction
    if (buoyancy > 0) this.vy = (this.vy + buoyancy * 0.06153846016296973) * 0.75
  }

  controlBoat () {
    const { left, right, forward, back } = this.input
    let accel = 0
    if (left) this.deltaRotation -= 1
    if (right) this.deltaRotation += 1
    if (right !== left && !forward && !back) accel += 0.005
    this.yRot += this.deltaRotation
    if (forward) accel += 0.04
    if (back) accel -= 0.005
    this.vx += Math.sin(-this.yRot * DEG) * accel
    this.vz += Math.cos(this.yRot * DEG) * accel
  }

  /** Entity.move(): clip the movement against block collision boxes, y first. */
  moveWithCollision (dx, dy, dz) {
    const b = this.box()
    const boxes = []
    const x0 = Math.floor(b.minX + Math.min(dx, 0)) - 1
    const x1 = Math.ceil(b.maxX + Math.max(dx, 0)) + 1
    const y0 = Math.floor(b.minY + Math.min(dy, 0)) - 1
    const y1 = Math.ceil(b.maxY + Math.max(dy, 0)) + 1
    const z0 = Math.floor(b.minZ + Math.min(dz, 0)) - 1
    const z1 = Math.ceil(b.maxZ + Math.max(dz, 0)) + 1
    for (let x = x0; x < x1; x++) {
      for (let y = y0; y < y1; y++) {
        for (let z = z0; z < z1; z++) boxes.push(...this.boxesAt(x, y, z))
      }
    }

    const ry = clip(b, boxes, 'y', dy)
    b.minY += ry
    b.maxY += ry
    let rx = dx
    let rz = dz
    if (Math.abs(dx) >= Math.abs(dz)) {
      rx = clip(b, boxes, 'x', dx)
      b.minX += rx
      b.maxX += rx
      rz = clip(b, boxes, 'z', dz)
    } else {
      rz = clip(b, boxes, 'z', dz)
      b.minZ += rz
      b.maxZ += rz
      rx = clip(b, boxes, 'x', dx)
    }

    this.x += rx
    this.y += ry
    this.z += rz
    this.onGround = dy < 0 && ry !== dy
    if (rx !== dx) this.vx = 0
    if (ry !== dy) this.vy = 0
    if (rz !== dz) this.vz = 0
  }

  // ---------------------------------------------------------------------------
  // Reporting
  // ---------------------------------------------------------------------------

  /** Push the simulated state into the entities mineflayer (and the pathfinder) read. */
  publish () {
    const v = this.vehicle
    if (!v) return
    v.position.set(this.x, this.y, this.z)
    v.yaw = toMineflayerYaw(this.yRot)
    if (v.velocity && v.velocity.set) v.velocity.set(this.vx, this.vy, this.vz)
    // mineflayer does not move a rider with its vehicle, which left
    // bot.entity.position at the boarding point and made every replan start there.
    const rider = this.bot.entity
    if (rider && rider.position && rider !== v) rider.position.set(this.x, this.y, this.z)
  }

  /**
   * Field names of a serverbound packet in this version's protocol.
   *   undefined - the protocol definition is not available to inspect
   *   null      - the version has no such packet
   *   string[]  - the packet's fields
   *
   * Worth the trouble: node-minecraft-protocol ends the connection on a serialization
   * error, so a packet that is unknown or wrongly shaped for this version does not
   * fail politely, it disconnects the bot.
   */
  serverFields (name) {
    const protocol = this.bot.registry && this.bot.registry.protocol
    const types = protocol && protocol.play && protocol.play.toServer && protocol.play.toServer.types
    if (!types) return undefined
    const def = types[`packet_${name}`]
    if (!def) return null
    if (!Array.isArray(def) || !Array.isArray(def[1])) return undefined
    return def[1].map(f => f && f.name).filter(Boolean)
  }

  write (name, payload) {
    try {
      this.bot._client.write(name, payload)
      return true
    } catch (err) {
      this.disable(`could not write ${name}: ${err.message}`)
      return false
    }
  }

  send () {
    const yaw = wrapDegrees(this.yRot)
    // The game calls the fields x/y/z/yaw/pitch (older) or x/y/z/yRot/xRot plus
    // onGround (newer). Build whatever this version declares, and give up loudly
    // rather than send something it does not.
    const values = { x: this.x, y: this.y, z: this.z, yaw, yRot: yaw, pitch: 0, xRot: 0, onGround: this.onGround }
    const fields = this.serverFields('vehicle_move')
    if (fields === null) {
      this.disable('this protocol version has no vehicle_move packet')
      return false
    }
    let payload = { x: this.x, y: this.y, z: this.z, yaw, pitch: 0, onGround: this.onGround }
    if (fields) {
      const unknown = fields.filter(f => values[f] === undefined)
      if (unknown.length) {
        this.disable(`vehicle_move has fields this driver does not know how to fill: ${unknown.join(', ')}`)
        return false
      }
      payload = Object.fromEntries(fields.map(f => [f, values[f]]))
    }
    if (!this.write('vehicle_move', payload)) return false
    this.sent++

    const { left, right, forward } = this.input
    const paddle = [(right && !left) || forward, (left && !right) || forward].map(Boolean)
    if (!this.lastPaddle || paddle[0] !== this.lastPaddle[0] || paddle[1] !== this.lastPaddle[1]) {
      this.lastPaddle = paddle
      // Cosmetic (the paddle animation other players see): skip it where the packet
      // is missing, and never let it stop the boat.
      if (this.serverFields('steer_boat') !== null) {
        try {
          this.bot._client.write('steer_boat', { leftPaddle: paddle[0], rightPaddle: paddle[1] })
        } catch (e) { /* not fatal */ }
      }
    }
    return true
  }

  /**
   * Ask the server to let go of the vehicle by sending the shift input directly. The
   * server only ever dismounts a rider on the shift key (Player.rideTick), and not
   * every mineflayer version sends it for bot.dismount() - and while mounted its own
   * physics loop, which is what normally sends input, may not be running.
   * @param {boolean} down
   * @returns {boolean} whether a packet was sent
   */
  sendShift (down) {
    const client = this.bot._client
    if (!client) return false
    const input = this.serverFields('player_input')
    try {
      if (input && input.includes('inputs')) {
        // 1.21.6+: a bitfield of named keys.
        client.write('player_input', { inputs: { forward: false, backward: false, left: false, right: false, jump: false, shift: down, sprint: false } })
        return true
      }
      const legacy = this.serverFields('steer_vehicle')
      if (legacy && legacy.includes('sideways') && legacy.includes('jump')) {
        // Before 1.21.2: bit 0x02 of the flags is "unmount".
        client.write('steer_vehicle', { sideways: 0, forward: 0, jump: down ? 0x02 : 0 })
        return true
      }
    } catch (e) { /* fall through */ }
    return false
  }

  /**
   * The server took the rider out of the boat. From then on the bot is an ordinary player again and
   * the server checks its walking; a driver that carried on overwriting the bot's position with the
   * boat's would have it report positions the server rejects, over and over.
   */
  onPassengers ({ entityId, passengers }) {
    const rider = this.bot.entity
    if (!this.vehicle || !rider || entityId !== this.vehicle.id) return
    if (Array.isArray(passengers) && passengers.includes(rider.id)) return
    this.detach()
    this.bot.emit('boat_driver_released', 'the server removed the bot from the boat')
  }

  /**
   * The server disagreed with a reported position and put the boat back. Adopt its
   * position, and give up if it keeps happening - the alternative is a bot that
   * fights the server for the boat forever.
   */
  onServerMove (packet) {
    if (!this.active || !packet) return
    const yaw = packet.yaw ?? packet.yRot
    if ([packet.x, packet.y, packet.z].every(Number.isFinite)) {
      this.x = packet.x
      this.y = packet.y
      this.z = packet.z
      if (Number.isFinite(yaw)) this.yRot = yaw
      this.vx = 0
      this.vy = 0
      this.vz = 0
      this.deltaRotation = 0
    }
    const now = Date.now()
    this.corrections = this.corrections.filter(t => now - t < 2000)
    this.corrections.push(now)
    if (this.corrections.length >= (this.settings.boatMaxCorrections ?? 8)) {
      this.disable('the server keeps rejecting the reported boat position')
    }
  }

  debug (now) {
    if (!this.settings.debugBoat || now - this.lastDebug < 1000) return
    this.lastDebug = now
    const speed = Math.hypot(this.vx, this.vz) * 20
    console.log(`[boat] pos=${this.x.toFixed(2)},${this.y.toFixed(2)},${this.z.toFixed(2)} ` +
      `yaw=${wrapDegrees(this.yRot).toFixed(0)} status=${this.status} speed=${speed.toFixed(1)}b/s ` +
      `input=${JSON.stringify(this.input)} sent=${this.sent} corrections=${this.corrections.length}`)
  }
}

/**
 * Whether a collision box touches the thin slab directly under the boat's footprint.
 * @param {number[]} s [minX, minY, minZ, maxX, maxY, maxZ]
 * @param {{minX:number,minY:number,minZ:number,maxX:number,maxY:number,maxZ:number}} b the boat
 * @param {number} lo bottom of the slab
 */
function overlapsSlab (s, b, lo) {
  return s[0] < b.maxX && s[3] > b.minX && s[1] < b.minY && s[4] > lo && s[2] < b.maxZ && s[5] > b.minZ
}

/**
 * Largest movement along `axis` (at most `delta`) that keeps `b` out of `boxes`.
 * @param {{minX:number,minY:number,minZ:number,maxX:number,maxY:number,maxZ:number}} b
 * @param {number[][]} boxes
 * @param {'x'|'y'|'z'} axis
 * @param {number} delta
 */
function clip (b, boxes, axis, delta) {
  if (delta === 0) return 0
  const lo = { x: 'minX', y: 'minY', z: 'minZ' }[axis]
  const hi = { x: 'maxX', y: 'maxY', z: 'maxZ' }[axis]
  const i = { x: 0, y: 1, z: 2 }[axis]
  const others = ['x', 'y', 'z'].filter(a => a !== axis)
  for (const s of boxes) {
    // Only boxes that overlap on the other two axes can block this one.
    let overlaps = true
    for (const a of others) {
      const j = { x: 0, y: 1, z: 2 }[a]
      const bl = { x: 'minX', y: 'minY', z: 'minZ' }[a]
      const bh = { x: 'maxX', y: 'maxY', z: 'maxZ' }[a]
      if (!(b[bh] > s[j] + EPS && b[bl] < s[j + 3] - EPS)) { overlaps = false; break }
    }
    if (!overlaps) continue
    if (delta > 0 && b[hi] <= s[i] + EPS) delta = Math.min(delta, s[i] - b[hi])
    else if (delta < 0 && b[lo] >= s[i + 3] - EPS) delta = Math.max(delta, s[i + 3] - b[lo])
  }
  return delta
}

/**
 * Where to aim when placing a boat, so that the server accepts it.
 *
 * A boat cannot be placed where it would overlap the player placing it, and the game does not
 * say so: the item is simply not used. The boat spawns at the point the crosshair meets the
 * water, and its hitbox is 1.375 wide, so the point has to be at least
 * (1.375 + 0.6) / 2 = 0.99 blocks from the player's centre, plus some margin. Aiming at the middle
 * of a water cell right next to the bot, or when the bot is already standing in the water,
 * misses that, which is where the embark attempts were failing.
 *
 * @param {{ x: number, z: number }} from the bot's position
 * @param {{ x: number, y: number, z: number }} waterCell the water cell the path wants the boat in
 * @param {(x: number, z: number) => boolean} isWaterAt whether there is open surface water at x, z
 * @param {{ minDistance?: number, yaw?: number }} [options] yaw (mineflayer convention) says which way
 *   to aim when the bot is exactly on top of the cell
 * @returns {{ x: number, y: number, z: number }}
 */
function boatPlacementAim (from, waterCell, isWaterAt, { minDistance = 1.3, yaw = 0 } = {}) {
  const y = waterCell.y + 0.8 // a source block's surface is ~0.9 up: aim at the water, not the air above it
  const centre = { x: waterCell.x + 0.5, y, z: waterCell.z + 0.5 }
  const dx = centre.x - from.x
  const dz = centre.z - from.z
  const dist = Math.hypot(dx, dz)
  if (dist >= minDistance) return centre

  // Too close. Keep the direction of the path and go further out, over water.
  const ux = dist > 1e-6 ? dx / dist : -Math.sin(yaw)
  const uz = dist > 1e-6 ? dz / dist : -Math.cos(yaw)
  for (const d of [minDistance, minDistance + 0.4, minDistance + 0.8, minDistance + 1.2, minDistance + 1.6]) {
    const x = from.x + ux * d
    const z = from.z + uz * d
    if (isWaterAt(x, z)) return { x, y, z }
  }
  return centre // nowhere better: the old behaviour
}

/**
 * Notice when the server takes the bot out of a vehicle.
 *
 * mineflayer clears bot.vehicle for a set_passengers packet that still lists the bot and for a
 * legacy attach_entity, and its "vehicle is gone" cleanup is registered on the wrong emitter so it
 * never runs. A vanilla server does neither when a rider leaves: it sends the vehicle's remaining
 * passengers, which is an empty list when the bot was the only one. bot.vehicle then stays set
 * forever, 'dismount' never fires, and anything waiting for it waits for good.
 *
 * Registered after mineflayer's own handlers, so if a mineflayer version does clear it, there is
 * nothing left to do here and 'dismount' is not emitted twice.
 * @param {import('mineflayer').Bot} bot
 * @returns {() => void} stop watching
 */
function watchDismount (bot) {
  const leave = () => {
    const vehicle = bot.vehicle
    if (!vehicle) return
    const rider = bot.entity
    bot.vehicle = null
    if (rider) {
      if (Array.isArray(vehicle.passengers)) {
        const i = vehicle.passengers.indexOf(rider)
        if (i !== -1) vehicle.passengers.splice(i, 1)
      }
      rider.vehicle = null
    }
    bot.emit('dismount', vehicle)
  }
  const onPassengers = ({ entityId, passengers }) => {
    const vehicle = bot.vehicle
    if (!vehicle || !bot.entity || vehicle.id !== entityId) return
    if (Array.isArray(passengers) && passengers.includes(bot.entity.id)) return
    leave()
  }
  const onGone = (entity) => {
    if (bot.vehicle && entity === bot.vehicle) leave()
  }
  if (bot._client) bot._client.on('set_passengers', onPassengers)
  bot.on('entityGone', onGone)
  return () => {
    if (bot._client) bot._client.removeListener('set_passengers', onPassengers)
    bot.removeListener('entityGone', onGone)
  }
}

module.exports = BoatDriver
module.exports.boatPlacementAim = boatPlacementAim
module.exports.watchDismount = watchDismount
module.exports.Status = Status
module.exports.TICK_MS = TICK_MS
module.exports.toMineflayerYaw = toMineflayerYaw
module.exports.toGameYaw = toGameYaw
