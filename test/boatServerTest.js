/* eslint-env mocha */

// Boat-travel coverage for the *executor* (index.js's embark()/disembark()/
// steerBoat(), which call bot.mount()/bot.dismount()/bot.moveVehicle() and
// listen for mineflayer's 'mount'/'dismount' events), driven against a
// hand-built minecraft-protocol fake server exactly the way
// test/internalTest.js already does for walking moves (see newServer(),
// flatMap(), and the chicken spawn_entity precedent in its "Goals with
// entity" describe block).
//
// getMoveBoatEmbark/Cruise/Disembark generating the *right nodes* is already
// covered at the planner level in test/plannerFixes.js. What is NOT covered
// anywhere else, and what this file exists to prove, is that the real
// executor actually drives a real mount/dismount over the wire rather than
// just planning to.
//
// IMPORTANT - read this before debugging a local failure here:
// This file was written without a working node_modules install (no network
// access in the environment it was authored in), so the exact wire packets
// mineflayer's mount/dismount plumbing sends and listens for could not be
// confirmed against node_modules/mineflayer/lib/plugins/entities.js as the
// task asked. What's below is the standard, version-independent vanilla
// protocol behaviour for these actions, which is a reasonable bet but is
// exactly the kind of thing that silently drifts between mineflayer
// versions. If 'mount' or 'dismount' never fire when you run this locally,
// check these three spots FIRST, in order of how confident I am in them:
//
//   1. Least certain: dismounting. Vanilla dismounts a rider via the sneak
//      input - a serverbound 'entity_action' packet with actionId 0
//      (start_sneaking) while riding a vehicle causes the server to detach
//      the rider. This is standard client behaviour, but whether
//      bot.dismount() in the pinned mineflayer version actually sends this
//      (vs. some other packet, e.g. a steer_vehicle unmount flag) needs
//      confirming against entities.js's dismount() implementation.
//   2. Mounting: a serverbound 'use_entity' packet (interact) against the
//      target entity, confirmed by a clientbound 'set_passengers' packet
//      naming the vehicle and listing the rider's entity id. This is
//      standard >=1.9 protocol (sees packet name/shape hasn't moved across
//      mineflayer versions in memory) but double check against entities.js's
//      mount()/passenger-tracking code if 'mount' never fires.
//   3. Cruise: like a vanilla server, this fake server does NOT move a boat a
//      player is riding. Boats are client-authoritative - the rider's client
//      simulates the boat and reports where it is with serverbound
//      'vehicle_move' packets - so the fake boat only moves when one arrives.
//      An earlier version of this file nudged the boat toward the far shore on a
//      timer as soon as the bot mounted. That passed even though the executor
//      only called bot.moveVehicle() (steering input, which a real server does
//      not act on), and so hid the very bug that left real boats sitting still
//      while the pathfinder reported the bot stuck.
//
// None of this is fork-specific - it's the same "the fake server has to
// speak just enough real protocol" pattern the chicken/spawn_entity test
// already relies on, extended to a two-way interaction instead of a
// read-only spawn.

const mineflayer = require('mineflayer')
const { goals, pathfinder, Movements } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const mc = require('minecraft-protocol')
const assert = require('assert')
const { once } = require('events')
const {
  buildChunk,
  chunkPacket,
  loginPacket,
  positionPacket,
  spawnEntityPacket
} = require('./support/world')

// The newest version mineflayer supports. Chunks are built literally and every packet is
// built from the version's own protocol definition: see test/support/world.js.
const Version = '26.1'
const ServerPort = 25568 // internalTest.js's fake server uses 25567; kept
// separate so the two files' servers can never collide.

// The *runtime* entity id the fake server assigns to the boat. This is a
// per-instance id chosen by the server and is unrelated to the boat's
// *type* id (mcData.entitiesByName.oak_boat.id), which is what goes in the
// spawn_entity packet's `type` field. Kept distinct from the bot's own
// entity id (assigned by the login packet) so the two can't collide.
const BoatEntityId = 100

/**
 * Close a fake server and resolve once its port is actually released, so the
 * next suite's newServer() can't hit EADDRINUSE.
 *
 * minecraft-protocol's API docs document the server 'close' event (emitted
 * once the server is no longer listening) but do not document a
 * server.close() method itself, so the timeout fallback stays as a safety
 * net rather than trusting undocumented behaviour to always emit.
 */
function closeServer (server, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    server.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    try {
      server.close()
    } catch (err) {
      clearTimeout(timer)
      resolve()
    }
  })
}

/**
 * Teardown that is safe to call no matter how far before() got. Every step
 * is independent: a failure in one (e.g. bot.pathfinder never having been
 * loaded) must not prevent the later ones, above all closing the server.
 * @param {import('mineflayer').Bot | null | undefined} bot
 * @param {import('minecraft-protocol').Server | null | undefined} server
 */
async function teardown (bot, server) {
  try {
    bot?.pathfinder?.setGoal(null)
  } catch (err) {
    // pathfinder may be half-initialised if before() threw; nothing to undo
  }
  try {
    bot?.end()
  } catch (err) {
    // bot may already be disconnected
  }
  if (server) await closeServer(server)
}

/**
 * A shoreline: land on the west side, a surface-water strip a few blocks
 * wide, land on the east side. Same construction as flatMap()/trenchMap() in
 * test/internalTest.js - a flat bedrock floor with everything above it air,
 * except a water strip.
 * @param {string} version
 * @returns {import('prismarine-chunk').Chunk}
 */
function shoreMap (version) {
  const waterMinX = 5
  const waterMaxX = 10 // inclusive: a 6-block-wide crossing
  return buildChunk(version, (x, y, z) => {
    if (y === 0) return 'bedrock' // floor everywhere
    if (y === 1 && x >= waterMinX && x <= waterMaxX) return 'water' // the default state is a source block
    return null
  }, { minY: 0, maxY: 4 })
}

/**
 * Adapted from test/internalTest.js's newServer(), which is not exported
 * from that file. Simplified to this file's needs (always binds ServerPort above).
 */
async function newServer (chunk, spawnPos, version) {
  const mcData = require('minecraft-data')(version)
  const server = mc.createServer({
    'online-mode': false,
    version,
    port: ServerPort
  })
  // 'playerJoin', not 'login': from 1.20.2 on a freshly logged-in client is still in the
  // configuration phase, where play packets cannot be sent yet.
  server.on('playerJoin', (client) => {
    client.write('login', loginPacket(mcData))
    client.write('map_chunk', chunkPacket(mcData, chunk))
    client.write('position', positionPacket(mcData, spawnPos))
  })
  await once(server, 'listening')
  return server
}

/** Poll `predicate` until it's true or `timeoutMs` elapses. */
async function waitUntil (predicate, timeoutMs, intervalMs = 50) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return predicate()
}

describe('pathfinder boat travel', function () {
  const mcData = require('minecraft-data')(Version)

  const spawnPos = new Vec3(2.5, 1, 8.5) // west shore
  const farShoreTarget = new Vec3(13, 1, 8) // east shore, past the water

  describe('embark, cruise and disembark with a boat already on the water', function () {
    this.timeout(20000)

    // mid-crossing, well within mount range of the embark cell. Water is the y=1 layer
    // (surface at 1.889); a placed boat rests about a third of its height below that.
    const boatSpawnPos = new Vec3(7, 1.52, 8)

    /** @type { import('mineflayer').Bot & { pathfinder: import('mineflayer-pathfinder').Pathfinder } } */
    let bot
    /** @type { import('minecraft-protocol').Server } */
    let server
    /** @type { import('minecraft-protocol').Client } */
    let serverClient
    let mountCount = 0
    let dismountCount = 0
    let steerCount = 0
    let vehicleMoveCount = 0
    let serverBoatPos = null // where the server believes the boat is: only ever set by vehicle_move
    const pathResetReasons = []
    let goalReached = false
    // Serverbound packet names seen after the mount. A failing cruise or
    // disembark assertion prints these, so it says what the executor actually
    // sent instead of only that an expected packet never arrived.
    const packetsAfterMount = {}
    const diagnostics = () => {
      let state
      try {
        state = JSON.stringify({
          vehicle: bot?.vehicle ? { id: bot.vehicle.id, name: bot.vehicle.name, type: bot.vehicle.type } : null,
          isMoving: bot?.pathfinder?.isMoving(),
          goal: bot?.pathfinder?.goal?.constructor?.name,
          pos: bot?.entity?.position
        })
      } catch (err) {
        state = `unavailable (${err.message})`
      }
      return `mounts=${mountCount} dismounts=${dismountCount} steer_vehicle=${steerCount} vehicle_move=${vehicleMoveCount} ` +
        `serverBoat=${serverBoatPos ? serverBoatPos.toString() : null} ` +
        `path_resets=[${pathResetReasons.join(', ')}] goalReached=${goalReached} ` +
        `serverbound after mount=${JSON.stringify(packetsAfterMount)} state=${state}`
    }

    before(async function () {
      const chunk = shoreMap(Version)
      server = await newServer(chunk, spawnPos, Version)

      bot = mineflayer.createBot({ username: 'player', version: Version, port: ServerPort })
      await once(bot, 'chunkColumnLoad')
      serverClient = Object.values(server.clients)[0]

      // Spawn a boat entity on the water, the same way the existing "Goals
      // with entity" describe block spawns its chicken. getBoatItem() is
      // deliberately left unsatisfied (no boat item given) so this test
      // exercises the "mount a boat already floating there" branch of
      // embark() specifically, per the task's suggestion that either giving
      // an item or spawning an entity is an acceptable way to satisfy
      // getBoatItem()/getNearbyBoat().
      serverClient.write('spawn_entity', spawnEntityPacket(mcData, { entityId: BoatEntityId, entity: 'oak_boat', x: boatSpawnPos.x, y: boatSpawnPos.y, z: boatSpawnPos.z }))
      serverBoatPos = boatSpawnPos.clone()
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.ok(bot.nearestEntity((e) => /boat$/.test(e.name)), 'fake boat entity did not register on the bot')

      // --- Mount handshake --------------------------------------------
      // See the file-level comment above (point 2) for the protocol
      // assumption here.
      let riding = false
      serverClient.on('use_entity', (packet) => {
        // The target is `target` before 26.x and `entityId` from 26.x on.
        if ((packet.target ?? packet.entityId) !== BoatEntityId) return
        riding = true
        serverClient.write('set_passengers', { entityId: BoatEntityId, passengers: [bot.entity.id] })
      })

      // --- Dismount -----------------------------------------------------
      // See the file-level comment above (point 1) - this is the least
      // certain packet mapping in this file, so two encodings are accepted:
      // a serverbound 'steer_vehicle' with the unmount bit (0x02) set in
      // `jump`, or a sneak 'entity_action' (actionId 0). Whichever arrives,
      // detach the rider, then teleport it to where it now stands.
      //
      // Two mineflayer specifics (read from lib/plugins/entities.js and
      // lib/plugins/physics.js, not guessed):
      //  - it only clears bot.vehicle and emits 'dismount' on a
      //    'set_passengers' packet with entityId -1 that lists the bot. An
      //    empty passenger list sent for the boat itself (which is what I
      //    believe a vanilla server sends) is ignored, so it is NOT used here.
      //    That means this test passes on the packet shape mineflayer reacts
      //    to, not necessarily the one a real server sends: verify disembark
      //    against a real server before trusting it there.
      //  - it only re-enables its physics (and with it the pathfinder's tick
      //    loop) on a clientbound 'position' packet after a mount, so without
      //    the teleport the bot would dismount and then never move again.
      const dismountRider = () => {
        if (!riding) return // one request per ride, however many encodings arrive
        riding = false
        const at = serverBoatPos || bot.entity.position
        serverClient.write('set_passengers', { entityId: -1, passengers: [bot.entity.id] })
        serverClient.write('position', positionPacket(mcData, at))
      }
      // Up to 1.21.5 the sneak key arrives as entity_action; from 1.21.6 as the shift
      // bit of player_input, which is the one a 26.x server acts on.
      serverClient.on('entity_action', (packet) => {
        if (packet.actionId !== 0) return // 0 = start_sneaking
        dismountRider()
      })
      serverClient.on('player_input', (packet) => {
        if (packet.inputs && packet.inputs.shift) dismountRider()
      })

      // --- Cruise -----------------------------------------------------------
      // See the file-level comment above (point 3). Nothing here moves the boat
      // except the client's own vehicle_move reports.
      serverClient.on('packet', (data, meta) => {
        if (mountCount === 0) return
        packetsAfterMount[meta.name] = (packetsAfterMount[meta.name] || 0) + 1
      })

      serverClient.on('vehicle_move', (packet) => {
        vehicleMoveCount++
        serverBoatPos = new Vec3(packet.x, packet.y, packet.z)
      })

      serverClient.on('steer_vehicle', (packet) => {
        // The unmount bit marks a dismount request, not steering. Counting it
        // as a steer would let the cruise assertion pass on a dismount alone.
        if ((packet.jump & 0x02) !== 0) {
          dismountRider()
          return
        }
        steerCount++
      })

      bot.on('mount', () => { mountCount++ })
      bot.on('dismount', () => { dismountCount++ })
      bot.on('path_reset', (reason) => { pathResetReasons.push(reason) })
      bot.once('goal_reached', () => { goalReached = true })

      bot.loadPlugin(pathfinder)
      const movements = new Movements(bot, mcData)
      movements.allowBoating = true
      bot.pathfinder.setMovements(movements)

      bot.entity.position = spawnPos.clone()
      bot.pathfinder.setGoal(new goals.GoalNear(farShoreTarget.x, farShoreTarget.y, farShoreTarget.z, 1))

      // Wait for the whole crossing to settle (success or not) before
      // letting the individual `it`s below make assertions, so they inspect
      // a finished journey instead of racing it themselves.
      await waitUntil(() => goalReached, 15000)
    })

    after(async function () {
      // Must tolerate a before() that threw at any point: bot, pathfinder
      // and server may each be unset.
      await teardown(bot, server)
      bot = null
      server = null
    })

    it('embark: the real executor drives an actual mount, not just a planned boat move', function () {
      assert.ok(mountCount >= 1, 'bot never mounted a boat - embark() did not complete a real mount handshake')
    })

    it('cruise: makes forward progress without thrashing on repeated path_reset events', function () {
      // What a vanilla server acts on is vehicle_move, not steering input.
      assert.ok(vehicleMoveCount > 0, `the bot never reported the boat's position with vehicle_move - a real server would never have moved it. ${diagnostics()}`)
      assert.ok(
        serverBoatPos.x - boatSpawnPos.x > 2,
        `the server-side boat only travelled from x=${boatSpawnPos.x} to x=${serverBoatPos.x}. ${diagnostics()}`
      )
      // Some replanning around the medium transitions is normal (e.g. once
      // around embark, once around disembark); a thrashing loop would fire
      // many more resets than that over one short crossing.
      assert.ok(
        pathResetReasons.length <= 5,
        `too many path_reset events during the crossing (${pathResetReasons.length}: ${pathResetReasons.join(', ')}) - looks like thrashing`
      )
    })

    it('disembark: dismounts and reaches the goal on the far shore, not still in the water', function () {
      assert.ok(dismountCount >= 1, `bot never dismounted - disembark() did not complete. ${diagnostics()}`)
      assert.ok(goalReached, 'goal_reached never fired')
      assert.ok(!bot.vehicle, 'bot is still mounted at the end of the crossing')
      assert.ok(bot.entity.position.x > 10, `bot ended up at x=${bot.entity.position.x}, still over the water`)
    })
  })

  describe('embark with allowBoating on but no boat reachable at mount time', function () {
    this.timeout(10000)

    // A boat entity is placed within the planner's getNearbyBoat(node, 6)
    // radius (so A* actually generates a boat-embark move - without any
    // candidate boat at all, getMoveBoatEmbark() returns before generating a
    // node and the crossing simply has no path, which would exercise
    // 'noPath' planning rather than embark()'s own failure branch) but
    // outside the *executor's* getNearbyBoat(node, 3) radius used inside
    // embark() at mount time, with no boat item to fall back on either. That
    // reproduces the specific runtime failure this test is after: a plan
    // that expected a boat to be there, and an executor that finds out at
    // mount time that it is not.
    const farBoatSpawnPos = new Vec3(9, 1, 8) // ~4 blocks from the (5,1,8) embark cell: outside
    // the executor's radius-3 mount check, inside the planner's radius-6 check.

    /** @type { import('mineflayer').Bot & { pathfinder: import('mineflayer-pathfinder').Pathfinder } } */
    let bot
    /** @type { import('minecraft-protocol').Server } */
    let server
    let mounted = false
    const pathResetReasons = []

    before(async function () {
      const chunk = shoreMap(Version)
      server = await newServer(chunk, spawnPos, Version)

      bot = mineflayer.createBot({ username: 'player', version: Version, port: ServerPort })
      await once(bot, 'chunkColumnLoad')
      const serverClient = Object.values(server.clients)[0]

      serverClient.write('spawn_entity', spawnEntityPacket(mcData, { entityId: BoatEntityId, entity: 'oak_boat', x: farBoatSpawnPos.x, y: farBoatSpawnPos.y, z: farBoatSpawnPos.z }))
      await new Promise((resolve) => setTimeout(resolve, 100))

      // No boat item is ever given, and 'use_entity'/'set_passengers' are
      // deliberately left unhandled - if the bot ever attempts to mount
      // despite the above, that attempt should just go unanswered rather
      // than being able to accidentally succeed.

      bot.on('mount', () => { mounted = true })
      bot.on('path_reset', (reason) => { pathResetReasons.push(reason) })

      bot.loadPlugin(pathfinder)
      const movements = new Movements(bot, mcData)
      movements.allowBoating = true
      bot.pathfinder.setMovements(movements)

      bot.entity.position = spawnPos.clone()
      bot.pathfinder.setGoal(new goals.GoalNear(farShoreTarget.x, farShoreTarget.y, farShoreTarget.z, 1))

      await waitUntil(() => pathResetReasons.length > 0, 8000)
    })

    after(async function () {
      await teardown(bot, server)
      bot = null
      server = null
    })

    it('never mounts, and resets the path with a reason instead of hanging silently', function () {
      assert.strictEqual(mounted, false, 'bot mounted something despite no reachable boat item or boat entity at mount time')
      assert.ok(pathResetReasons.length > 0, 'path was never reset - embark() left the bot stuck with no goal_reached and no error')
      assert.ok(
        pathResetReasons.includes('no_boat'),
        `expected a 'no_boat' path_reset reason, got: ${pathResetReasons.join(', ')}`
      )
    })
  })
})
