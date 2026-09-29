/* eslint-env mocha */

// Unit tests for lib/boat.js, the client-side boat driver.
//
// These need no server and no minecraft-data: the bot, the world and the
// vehicle entity are all fakes. What they pin down is the behaviour the pathfinder
// depends on - a boat that accelerates to vanilla cruising speed, turns the right
// way, stops at a shore, and is only ever *reported* to the server through
// `vehicle_move` (a vanilla server does not move a player-driven boat itself).

const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const BoatDriver = require('../lib/boat')

const WATER = 10
const STONE = 1

/**
 * A lake: stone floor at y=62, water at y=63 for x in [0, lakeX), z in [0, 40),
 * dry stone (top at y=64) beyond the lake so it can be driven into a shore.
 */
function lakeWorld ({ lakeX = 40 } = {}) {
  const air = { type: 0, name: 'air', shapes: [] }
  const stone = { type: STONE, name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]] }
  const water = { type: WATER, name: 'water', shapes: [], getProperties: () => ({ level: 0 }) }
  return (x, y, z) => {
    x = Math.floor(x)
    y = Math.floor(y)
    z = Math.floor(z)
    if (z < 0 || z >= 40) return stone
    if (y <= 62) return stone
    if (x >= lakeX && y <= 63) return stone
    if (x >= 0 && x < lakeX && y === 63) return water
    return air
  }
}

function makeBot (world) {
  const client = new EventEmitter()
  client.written = []
  client.write = (name, payload) => { client.written.push({ name, payload }) }
  const bot = new EventEmitter()
  Object.assign(bot, {
    registry: { blocksByName: { water: { id: WATER } } },
    _client: client,
    entity: { position: new Vec3(0, 0, 0) },
    blockAt: (pos) => world(pos.x, pos.y, pos.z)
  })
  return bot
}

// A boat placed on water spawns at the water surface and settles ~0.37 blocks below it.
// Spawning one on the lake floor instead leaves the hull fully submerged, which vanilla
// treats as UNDER_WATER (heavy friction, no lift), so tests start it at y=63.5.
function makeBoat (x, y, z, yaw = 0) {
  return { name: 'oak_boat', position: new Vec3(x, y, z), yaw, velocity: new Vec3(0, 0, 0) }
}

/** Attach a driver to a fresh boat and run `ticks` game ticks with fixed input. */
function drive ({ ticks, turn = 0, forward = 0, world = lakeWorld(), at = [10.5, 63.5, 20.5], yaw = 0 }) {
  const bot = makeBot(world)
  const boat = makeBoat(...at, yaw)
  const driver = new BoatDriver(bot, { logStuckPlaces: false })
  driver.attach(boat)
  driver.setInput(turn, forward)
  let now = 1000
  for (let i = 0; i < ticks; i++) {
    now += 50
    driver.step(now)
  }
  return { bot, boat, driver }
}

describe('boat driver: reporting', () => {
  it('reports movement with vehicle_move, once per tick', () => {
    const { bot, driver } = drive({ ticks: 20, forward: 1 })
    const moves = bot._client.written.filter(w => w.name === 'vehicle_move')
    assert.strictEqual(moves.length, 20)
    assert.strictEqual(driver.sent, 20)
    for (const m of moves) {
      for (const k of ['x', 'y', 'z', 'yaw', 'pitch', 'onGround']) assert.ok(k in m.payload, `vehicle_move is missing ${k}`)
    }
  })

  it('never sends the boat somewhere that is not a number', () => {
    const { bot } = drive({ ticks: 40, forward: 1, turn: 1 })
    for (const w of bot._client.written.filter(w => w.name === 'vehicle_move')) {
      for (const k of ['x', 'y', 'z', 'yaw']) assert.ok(Number.isFinite(w.payload[k]), `${k} = ${w.payload[k]}`)
    }
  })

  it('mirrors the simulated state onto the vehicle and the rider', () => {
    const { bot, boat, driver } = drive({ ticks: 30, forward: 1 })
    assert.ok(Math.abs(boat.position.z - driver.z) < 1e-9)
    // mineflayer leaves the rider at the boarding point unless something moves it.
    assert.ok(Math.abs(bot.entity.position.z - driver.z) < 1e-9)
  })

  it('does nothing when it is not attached', () => {
    const bot = makeBot(lakeWorld())
    const driver = new BoatDriver(bot, { logStuckPlaces: false })
    assert.strictEqual(driver.step(1000), false)
    assert.strictEqual(bot._client.written.length, 0)
  })

  it('catches up at most three ticks after the event loop stalls', () => {
    const bot = makeBot(lakeWorld())
    const driver = new BoatDriver(bot, { logStuckPlaces: false })
    driver.attach(makeBoat(10.5, 63.5, 20.5))
    driver.step(1000)
    bot._client.written.length = 0
    driver.step(1000 + 5000) // five seconds of lag
    assert.strictEqual(bot._client.written.filter(w => w.name === 'vehicle_move').length, 3)
  })

  it('sends the paddle state only when it changes', () => {
    const bot = makeBot(lakeWorld())
    const driver = new BoatDriver(bot, { logStuckPlaces: false })
    driver.attach(makeBoat(10.5, 63.5, 20.5))
    driver.setInput(0, 1)
    let now = 1000
    for (let i = 0; i < 10; i++) driver.step(now += 50)
    assert.strictEqual(bot._client.written.filter(w => w.name === 'steer_boat').length, 1)
    driver.setInput(1, 0)
    for (let i = 0; i < 5; i++) driver.step(now += 50)
    assert.strictEqual(bot._client.written.filter(w => w.name === 'steer_boat').length, 2)
  })
})

describe('boat driver: physics', () => {
  it('floats on the surface instead of sinking or flying', () => {
    const { driver } = drive({ ticks: 200 })
    // Water block at y=63 is a source (surface 63.889); a boat rides about a third of
    // its height below that.
    assert.ok(driver.y > 63.3 && driver.y < 63.8, `settled at y=${driver.y}`)
    assert.strictEqual(driver.status, 'in_water')
  })

  it('accelerates to about 8 blocks per second on water', () => {
    // East along the long axis of a long lake, so nothing is hit inside 120 ticks.
    const { driver } = drive({ ticks: 120, forward: 1, yaw: -Math.PI / 2, at: [2.5, 63.5, 20.5], world: lakeWorld({ lakeX: 400 }) })
    const speed = Math.hypot(driver.vx, driver.vz) * 20
    assert.ok(speed > 7 && speed < 8.5, `cruise speed ${speed.toFixed(2)} b/s`)
  })

  it('drives in the direction it faces', () => {
    // mineflayer yaw 0 faces -z (north).
    const { driver } = drive({ ticks: 40, forward: 1, yaw: 0 })
    assert.ok(driver.z < 20.5 - 3, `expected to move towards -z, z=${driver.z}`)
    assert.ok(Math.abs(driver.x - 10.5) < 0.05, `expected no sideways drift, x=${driver.x}`)
  })

  it('turns left when asked to turn left', () => {
    // Left is positive in mineflayer yaw: the report must show the yaw increasing.
    const { boat } = drive({ ticks: 12, turn: 1, forward: 1, yaw: 0 })
    assert.ok(boat.yaw > 0.05 && boat.yaw < Math.PI, `yaw after turning left: ${boat.yaw}`)
    // Driving north and curving left means heading west: x must be decreasing.
    assert.ok(boat.position.x < 10.5, `expected to curve towards -x, x=${boat.position.x}`)
  })

  it('turns right when asked to turn right', () => {
    const { boat } = drive({ ticks: 12, turn: -1, forward: 1, yaw: 0 })
    assert.ok(boat.yaw > Math.PI, `yaw after turning right: ${boat.yaw}`)
    assert.ok(boat.position.x > 10.5, `expected to curve towards +x, x=${boat.position.x}`)
  })

  it('coasts to a stop once the input is released', () => {
    const bot = makeBot(lakeWorld())
    const driver = new BoatDriver(bot, { logStuckPlaces: false })
    driver.attach(makeBoat(10.5, 63.5, 30.5))
    driver.setInput(0, 1)
    let now = 1000
    for (let i = 0; i < 30; i++) driver.step(now += 50)
    driver.setInput(0, 0)
    for (let i = 0; i < 120; i++) driver.step(now += 50)
    assert.ok(Math.hypot(driver.vx, driver.vz) < 0.001, 'boat should have coasted to rest')
  })

  it('is stopped by a shore instead of driving through it', () => {
    // Drive east into the stone bank at x=lakeX.
    const { driver } = drive({ ticks: 200, forward: 1, yaw: -Math.PI / 2, at: [30.5, 63.5, 20.5], world: lakeWorld({ lakeX: 40 }) })
    const halfWidth = 1.375 / 2
    assert.ok(driver.x + halfWidth <= 40 + 1e-6, `boat hull is inside the bank: x=${driver.x}`)
    assert.ok(driver.x > 38, `boat should have reached the bank, x=${driver.x}`)
  })

  it('treats an unloaded chunk as a wall', () => {
    const open = lakeWorld()
    const world = (x, y, z) => (Math.floor(x) >= 20 ? null : open(x, y, z))
    const { driver } = drive({ ticks: 200, forward: 1, yaw: -Math.PI / 2, at: [10.5, 63.5, 20.5], world })
    assert.ok(driver.x < 20, `boat drove into unloaded terrain: x=${driver.x}`)
  })
})

describe('boat driver: server disagreement', () => {
  it('adopts the position the server puts the boat back at', () => {
    const { bot, driver } = drive({ ticks: 10, forward: 1 })
    bot._client.emit('vehicle_move', { x: 1, y: 63.5, z: 2, yaw: 90, pitch: 0 })
    assert.strictEqual(driver.x, 1)
    assert.strictEqual(driver.z, 2)
    assert.strictEqual(driver.vz, 0)
    assert.strictEqual(driver.yRot, 90)
  })

  it('gives up if the server keeps rejecting the reported position', () => {
    const { bot, driver } = drive({ ticks: 5, forward: 1 })
    let reason = null
    bot.on('boat_driver_disabled', (r) => { reason = r })
    for (let i = 0; i < 10; i++) bot._client.emit('vehicle_move', { x: 1, y: 63.5, z: 2, yaw: 0, pitch: 0 })
    assert.ok(driver.disabled, 'driver should have disabled itself')
    assert.ok(/rejecting/.test(reason), reason)
    assert.strictEqual(driver.active, false)
    // ...and stays quiet afterwards.
    const before = bot._client.written.length
    driver.step(Date.now() + 1000)
    assert.strictEqual(bot._client.written.length, before)
  })

  it('disables itself, rather than throwing, if the packet cannot be written', () => {
    const bot = makeBot(lakeWorld())
    bot._client.write = () => { throw new Error('unknown packet vehicle_move') }
    const driver = new BoatDriver(bot, { logStuckPlaces: false })
    driver.attach(makeBoat(10.5, 63.5, 20.5))
    driver.setInput(0, 1)
    assert.doesNotThrow(() => driver.step(1100))
    assert.ok(/vehicle_move/.test(driver.disabled), driver.disabled)
  })

  it('stops listening for server corrections after detach', () => {
    const { bot, driver } = drive({ ticks: 3 })
    assert.strictEqual(bot._client.listenerCount('vehicle_move'), 1)
    driver.detach()
    assert.strictEqual(bot._client.listenerCount('vehicle_move'), 0)
    assert.strictEqual(driver.active, false)
  })
})

describe('boat driver: yaw convention', () => {
  it('round-trips between the game and mineflayer conventions', () => {
    for (const deg of [0, 45, 90, 135, -90, -170]) {
      const back = BoatDriver.toGameYaw(BoatDriver.toMineflayerYaw(deg))
      const diff = ((back - deg) % 360 + 540) % 360 - 180
      assert.ok(Math.abs(diff) < 1e-9, `${deg} -> ${back}`)
    }
  })

  it('maps game yaw 0 (facing +z) to mineflayer yaw PI (facing +z) and 180 to 0 (-z)', () => {
    assert.ok(Math.abs(BoatDriver.toMineflayerYaw(0) - Math.PI) < 1e-9)
    assert.ok(Math.abs(BoatDriver.toMineflayerYaw(180) - 0) < 1e-9 || Math.abs(BoatDriver.toMineflayerYaw(180) - 2 * Math.PI) < 1e-9)
  })
})

describe('boat driver: staying out of the way', () => {
  it('does not report anything until it is engaged', () => {
    const bot = makeBot(lakeWorld())
    const driver = new BoatDriver(bot, { logStuckPlaces: false })
    driver.attach(makeBoat(10.5, 63.5, 20.5), { engaged: false })
    driver.setInput(0, 1)
    let now = 1000
    for (let i = 0; i < 10; i++) driver.step(now += 50)
    assert.strictEqual(bot._client.written.length, 0, 'a boat nobody is steering must be left to the server')
  })

  it('picks the boat up from where the server has it when engaged', () => {
    const bot = makeBot(lakeWorld())
    const boat = makeBoat(10.5, 63.5, 20.5)
    const driver = new BoatDriver(bot, { logStuckPlaces: false })
    driver.attach(boat, { engaged: false })
    boat.position.set(15.5, 63.5, 12.5) // the server (or something else) moved it meanwhile
    driver.engage()
    assert.strictEqual(driver.x, 15.5)
    assert.strictEqual(driver.z, 12.5)
    assert.strictEqual(driver.vx, 0)
  })

  it('release() stops reporting and leaves the boat where it was', () => {
    const { bot, driver } = drive({ ticks: 10, forward: 1 })
    const before = bot._client.written.length
    driver.release()
    driver.step(Date.now() + 5000)
    assert.strictEqual(bot._client.written.length, before)
  })
})

describe('boat driver: protocol shape', () => {
  function botWithProtocol (types) {
    const bot = makeBot(lakeWorld())
    bot.registry.protocol = { play: { toServer: { types } } }
    return bot
  }
  const pkt = (...names) => ['container', names.map(name => ({ name, type: 'f64' }))]

  function run (bot) {
    const driver = new BoatDriver(bot, { logStuckPlaces: false })
    driver.attach(makeBoat(10.5, 63.5, 20.5))
    driver.setInput(0, 1)
    driver.step(1000)
    driver.step(1050)
    return driver
  }

  it('sends exactly the fields the version declares (1.21.2+ has onGround)', () => {
    const bot = botWithProtocol({ packet_vehicle_move: pkt('x', 'y', 'z', 'yaw', 'pitch', 'onGround') })
    run(bot)
    const sent = bot._client.written.find(w => w.name === 'vehicle_move').payload
    assert.deepStrictEqual(Object.keys(sent), ['x', 'y', 'z', 'yaw', 'pitch', 'onGround'])
  })

  it('omits onGround where the version has none (pre-1.21.2)', () => {
    const bot = botWithProtocol({ packet_vehicle_move: pkt('x', 'y', 'z', 'yaw', 'pitch') })
    run(bot)
    const sent = bot._client.written.find(w => w.name === 'vehicle_move').payload
    assert.deepStrictEqual(Object.keys(sent), ['x', 'y', 'z', 'yaw', 'pitch'])
  })

  it('fills yRot/xRot spellings too', () => {
    const bot = botWithProtocol({ packet_vehicle_move: pkt('x', 'y', 'z', 'yRot', 'xRot', 'onGround') })
    run(bot)
    const sent = bot._client.written.find(w => w.name === 'vehicle_move').payload
    assert.deepStrictEqual(Object.keys(sent), ['x', 'y', 'z', 'yRot', 'xRot', 'onGround'])
  })

  it('refuses to send a packet the version does not have (that would end the connection)', () => {
    const bot = botWithProtocol({})
    const driver = run(bot)
    assert.strictEqual(bot._client.written.filter(w => w.name === 'vehicle_move').length, 0)
    assert.ok(/no vehicle_move/.test(driver.disabled), driver.disabled)
  })

  it('refuses to guess at fields it cannot fill', () => {
    const bot = botWithProtocol({ packet_vehicle_move: pkt('x', 'y', 'z', 'yaw', 'pitch', 'someNewFlag') })
    const driver = run(bot)
    assert.strictEqual(bot._client.written.filter(w => w.name === 'vehicle_move').length, 0)
    assert.ok(/someNewFlag/.test(driver.disabled), driver.disabled)
  })

  it('skips the cosmetic paddle packet where it does not exist, without disabling', () => {
    const bot = botWithProtocol({ packet_vehicle_move: pkt('x', 'y', 'z', 'yaw', 'pitch', 'onGround') })
    const driver = run(bot)
    assert.strictEqual(bot._client.written.filter(w => w.name === 'steer_boat').length, 0)
    assert.strictEqual(driver.disabled, null)
  })

  it('sendShift uses the named-key input packet where the version has it', () => {
    const bot = botWithProtocol({ packet_player_input: ['container', [{ name: 'inputs', type: 'bitflags' }]] })
    const driver = new BoatDriver(bot, { logStuckPlaces: false })
    assert.strictEqual(driver.sendShift(true), true)
    const sent = bot._client.written[0]
    assert.strictEqual(sent.name, 'player_input')
    assert.strictEqual(sent.payload.inputs.shift, true)
    assert.strictEqual(sent.payload.inputs.forward, false)
  })

  it('sendShift uses the unmount bit of steer_vehicle on older versions', () => {
    const bot = botWithProtocol({ packet_steer_vehicle: pkt('sideways', 'forward', 'jump') })
    const driver = new BoatDriver(bot, { logStuckPlaces: false })
    assert.strictEqual(driver.sendShift(true), true)
    assert.strictEqual(bot._client.written[0].payload.jump, 0x02)
  })

  it('sendShift sends nothing rather than guess when neither shape is known', () => {
    const bot = botWithProtocol({})
    const driver = new BoatDriver(bot, { logStuckPlaces: false })
    assert.strictEqual(driver.sendShift(true), false)
    assert.strictEqual(bot._client.written.length, 0)
  })
})

describe('boat driver: observer hook', () => {
  it('calls onTick with the driver after every simulated tick', () => {
    const bot = makeBot(lakeWorld())
    const driver = new BoatDriver(bot, { logStuckPlaces: false })
    driver.attach(makeBoat(10.5, 63.5, 20.5))
    driver.setInput(0, 1)
    const seen = []
    driver.onTick = (d) => seen.push([d === driver, d.z])
    let now = 1000
    for (let i = 0; i < 5; i++) driver.step(now += 50)
    assert.strictEqual(seen.length, 5)
    assert.ok(seen.every(([same]) => same))
    assert.ok(seen[4][1] < seen[0][1], 'the observer should see the boat move')
  })

  it('an observer that throws does not stop the boat or its reports', () => {
    const bot = makeBot(lakeWorld())
    const driver = new BoatDriver(bot, { logStuckPlaces: false })
    driver.attach(makeBoat(10.5, 63.5, 20.5))
    driver.setInput(0, 1)
    driver.onTick = () => { throw new Error('logger blew up') }
    let now = 1000
    for (let i = 0; i < 5; i++) driver.step(now += 50)
    assert.strictEqual(bot._client.written.filter(w => w.name === 'vehicle_move').length, 5)
    assert.strictEqual(driver.disabled, null)
  })
})

describe('leaving a boat: what a vanilla server actually sends', () => {
  const { watchDismount } = BoatDriver

  /** A bot that is riding boat 77 as entity 5, with mineflayer's bookkeeping as it leaves it. */
  function riding () {
    const bot = makeBot(lakeWorld())
    bot.entity.id = 5
    const boat = makeBoat(10.5, 63.5, 20.5)
    boat.id = 77
    boat.passengers = [bot.entity]
    bot.entity.vehicle = boat
    bot.vehicle = boat
    const dismounts = []
    bot.on('dismount', (vehicle) => dismounts.push(vehicle))
    return { bot, boat, dismounts }
  }

  it('an empty passenger list for the boat is the bot leaving it (what the real server sent)', () => {
    const { bot, boat, dismounts } = riding()
    watchDismount(bot)
    bot._client.emit('set_passengers', { entityId: 77, passengers: [] })
    assert.strictEqual(bot.vehicle, null)
    assert.strictEqual(bot.entity.vehicle, null)
    assert.deepStrictEqual(boat.passengers, [])
    assert.deepStrictEqual(dismounts, [boat], "'dismount' must fire, once")
  })

  it('a passenger list that still has the bot in it changes nothing', () => {
    const { bot, dismounts } = riding()
    watchDismount(bot)
    bot._client.emit('set_passengers', { entityId: 77, passengers: [5, 9] })
    assert.ok(bot.vehicle)
    assert.strictEqual(dismounts.length, 0)
  })

  it('someone else leaving the boat, or another vehicle\'s passengers, changes nothing', () => {
    const { bot, dismounts } = riding()
    watchDismount(bot)
    bot._client.emit('set_passengers', { entityId: 77, passengers: [5] })
    bot._client.emit('set_passengers', { entityId: 1234, passengers: [] })
    assert.ok(bot.vehicle)
    assert.strictEqual(dismounts.length, 0)
  })

  it('does not report a dismount twice if mineflayer already cleared bot.vehicle itself', () => {
    const { bot, dismounts } = riding()
    watchDismount(bot)
    bot.vehicle = null // a mineflayer version that handles it
    bot._client.emit('set_passengers', { entityId: 77, passengers: [] })
    assert.strictEqual(dismounts.length, 0)
  })

  it('the boat being removed from the world is a dismount too (mineflayer\'s own cleanup is on the wrong emitter)', () => {
    const { bot, boat, dismounts } = riding()
    watchDismount(bot)
    bot.emit('entityGone', boat)
    assert.strictEqual(bot.vehicle, null)
    assert.deepStrictEqual(dismounts, [boat])
  })

  it('an unrelated entity disappearing does not', () => {
    const { bot, dismounts } = riding()
    watchDismount(bot)
    bot.emit('entityGone', { id: 999 })
    assert.ok(bot.vehicle)
    assert.strictEqual(dismounts.length, 0)
  })

  it('stops watching when asked', () => {
    const { bot, dismounts } = riding()
    const stop = watchDismount(bot)
    stop()
    bot._client.emit('set_passengers', { entityId: 77, passengers: [] })
    assert.ok(bot.vehicle)
    assert.strictEqual(dismounts.length, 0)
    assert.strictEqual(bot._client.listenerCount('set_passengers'), 0)
  })

  it('the driver lets go of the boat by itself when the server takes the rider out, so it stops overwriting the bot\'s position', () => {
    const { bot, boat } = riding()
    const driver = new BoatDriver(bot, { logStuckPlaces: false })
    driver.attach(boat)
    let released = null
    bot.on('boat_driver_released', (why) => { released = why })
    bot._client.emit('set_passengers', { entityId: 77, passengers: [] })
    assert.strictEqual(driver.active, false)
    assert.match(released, /removed the bot/)

    // From here the bot's own position belongs to mineflayer and the server again.
    bot.entity.position.set(41.5, 100, 15.5)
    driver.step(Date.now() + 1000)
    assert.strictEqual(bot.entity.position.x, 41.5, 'the driver overwrote the bot\'s position after the server let it out')
  })

  it('and stays attached while the rider is still listed', () => {
    const { bot, boat } = riding()
    const driver = new BoatDriver(bot, { logStuckPlaces: false })
    driver.attach(boat)
    bot._client.emit('set_passengers', { entityId: 77, passengers: [5] })
    assert.strictEqual(driver.active, true)
  })
})

describe('placing a boat: aiming so the server accepts it', () => {
  const { boatPlacementAim } = BoatDriver
  const allWater = () => true
  const cell = { x: 21, y: 99, z: 15 }

  it('aims at the middle of the water cell when the bot is far enough away', () => {
    const aim = boatPlacementAim({ x: 19.5, z: 15.5 }, cell, allWater)
    assert.deepStrictEqual(aim, { x: 21.5, y: 99.8, z: 15.5 })
  })

  it('aims further out when the middle of the cell is too close: the boat would spawn inside the bot', () => {
    // The failing case from the real server: the bot stood in the water at x=20.8, the cell centre is 0.7 away.
    const aim = boatPlacementAim({ x: 20.8, z: 15.5 }, cell, allWater)
    const distance = Math.hypot(aim.x - 20.8, aim.z - 15.5)
    // A 1.375-wide boat next to a 0.6-wide player needs the centres at least 0.99 apart.
    assert.ok(distance >= 1.3 - 1e-9, `aim is only ${distance.toFixed(2)} away`)
    assert.ok(distance > (1.375 + 0.6) / 2)
    assert.ok(Math.abs(aim.z - 15.5) < 1e-9, 'it should keep the direction of the path')
    assert.ok(aim.x > 20.8)
  })

  it('only aims at places that are water', () => {
    const waterOnlyBeyond = (x) => x >= 22.5
    const aim = boatPlacementAim({ x: 20.8, z: 15.5 }, cell, waterOnlyBeyond)
    assert.ok(aim.x >= 22.5, `aimed at x=${aim.x}, which is not water`)
  })

  it('falls back to the cell centre when there is no better water', () => {
    const aim = boatPlacementAim({ x: 20.8, z: 15.5 }, cell, () => false)
    assert.deepStrictEqual(aim, { x: 21.5, y: 99.8, z: 15.5 })
  })

  it('still gives a direction when the bot is exactly on top of the cell centre', () => {
    const aim = boatPlacementAim({ x: 21.5, z: 15.5 }, cell, allWater, { yaw: -Math.PI / 2 }) // facing +x
    assert.ok(Number.isFinite(aim.x) && Number.isFinite(aim.z))
    assert.ok(aim.x > 21.5, 'it should aim the way the bot is facing')
    assert.ok(Math.hypot(aim.x - 21.5, aim.z - 15.5) >= 1.3 - 1e-9)
  })
})
