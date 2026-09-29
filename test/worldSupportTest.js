/* eslint-env mocha */

// Tests for test/support/world.js, the helper the fake-server suites use to build
// chunks and to speak each version's protocol. No server and no minecraft-data: the
// protocol definitions below are hand-written in the shape minecraft-data uses,
// modelled on the old (1.16.5) and new (26.x) layouts of the packets that changed.

const assert = require('assert')
const support = require('./support/world')

const container = (...fields) => ['container', fields.map(([name, type]) => ({ name, type }))]

const oldPacketTypes = {
  packet_position: container(['x', 'f64'], ['y', 'f64'], ['z', 'f64'], ['yaw', 'f32'], ['pitch', 'f32'], ['flags', 'i8'], ['teleportId', 'varint']),
  packet_block_change: container(['location', 'position'], ['type', 'varint']),
  packet_map_chunk: container(['x', 'i32'], ['z', 'i32'], ['groundUp', 'bool'], ['bitMap', 'varint'], ['heightmaps', 'nbt'], ['chunkData', 'buffer'], ['blockEntities', ['array', {}]]),
  packet_spawn_entity: container(['entityId', 'varint'], ['objectUUID', 'UUID'], ['type', 'varint'], ['x', 'f64'], ['y', 'f64'], ['z', 'f64'], ['pitch', 'i8'], ['yaw', 'i8'], ['objectData', 'i32'], ['velocityX', 'i16'], ['velocityY', 'i16'], ['velocityZ', 'i16'])
}

const newPacketTypes = {
  // The relative-flags field is a named type here, as it is in the real definition.
  PositionUpdateRelatives: ['bitflags', { type: 'i32', flags: ['x', 'y', 'z', 'yaw', 'pitch', 'dx', 'dy', 'dz', 'yawDelta'] }],
  packet_position: container(['teleportId', 'varint'], ['x', 'f64'], ['y', 'f64'], ['z', 'f64'], ['dx', 'f64'], ['dy', 'f64'], ['dz', 'f64'], ['yaw', 'f32'], ['pitch', 'f32'], ['flags', 'PositionUpdateRelatives']),
  packet_block_change: container(['location', 'position'], ['type', 'varint']),
  packet_map_chunk: container(['x', 'i32'], ['z', 'i32'], ['heightmaps', ['array', { countType: 'varint', type: 'container' }]], ['chunkData', 'buffer'], ['blockEntities', ['array', {}]], ['skyLightMask', ['array', {}]], ['blockLightMask', ['array', {}]]),
  packet_spawn_entity: container(['entityId', 'varint'], ['objectUUID', 'UUID'], ['type', 'varint'], ['x', 'f64'], ['y', 'f64'], ['z', 'f64'], ['velocity', 'lpVec3'], ['pitch', 'i8'], ['yaw', 'i8'], ['headPitch', 'i8'], ['objectData', 'varint'])
}

function fakeMcData (minecraftVersion, toClient) {
  return {
    version: { minecraftVersion },
    // Block ids and state ids deliberately differ, as they do on any modern version.
    blocksByName: {
      air: { id: 0, minStateId: 0, defaultState: 0 },
      dirt: { id: 10, minStateId: 3000, defaultState: 3000 },
      water: { id: 80, minStateId: 5000, defaultState: 5000 }
    },
    entitiesByName: { chicken: { id: 25 }, oak_boat: { id: 87 } },
    loginPacket: { entityId: 1, gameMode: 0 },
    protocol: { types: { position: ['bitfield', [{ name: 'x', size: 26 }, { name: 'z', size: 26 }, { name: 'y', size: 12 }]] }, play: { toClient: { types: toClient }, toServer: { types: {} } } }
  }
}

const oldData = fakeMcData('1.16.5', oldPacketTypes)
const newData = fakeMcData('26.1', newPacketTypes)

describe('test support: packets follow the version\'s own protocol', () => {
  describe('position', () => {
    it('old layout: numeric flags, no velocity fields', () => {
      const p = support.positionPacket(oldData, { x: 1, y: 2, z: 3 })
      assert.deepStrictEqual(Object.keys(p).sort(), ['flags', 'pitch', 'teleportId', 'x', 'y', 'yaw', 'z'])
      assert.strictEqual(p.flags, 0)
      assert.strictEqual(p.x, 1)
    })

    it('new layout: teleport id, velocity and a bitflags object (through a named type)', () => {
      const p = support.positionPacket(newData, { x: 1, y: 2, z: 3 })
      assert.strictEqual(p.dx, 0)
      assert.strictEqual(p.dy, 0)
      assert.strictEqual(p.dz, 0)
      assert.strictEqual(typeof p.teleportId, 'number')
      assert.deepStrictEqual(p.flags, { x: false, y: false, z: false, yaw: false, pitch: false, dx: false, dy: false, dz: false, yawDelta: false })
      assert.strictEqual(p.z, 3)
    })
  })

  describe('block_change', () => {
    it('sends the state id, not the block id', () => {
      const p = support.blockChangePacket(newData, { x: 4, y: 5, z: 6 }, 'dirt')
      assert.strictEqual(p.type, 3000, 'dirt is block id 10 but state id 3000')
      assert.deepStrictEqual(p.location, { x: 4, y: 5, z: 6 })
    })

    it('rejects a block the version does not have', () => {
      assert.throws(() => support.blockChangePacket(newData, { x: 0, y: 0, z: 0 }, 'not_a_block'), /no block "not_a_block"/)
    })
  })

  describe('spawn_entity', () => {
    it('uses the registry id as the type and the declared velocity shape (new)', () => {
      const p = support.spawnEntityPacket(newData, { entityId: 100, entity: 'oak_boat', x: 1, y: 2, z: 3 })
      assert.strictEqual(p.type, 87)
      assert.deepStrictEqual(p.velocity, { x: 0, y: 0, z: 0 })
      assert.ok(!('velocityX' in p))
      assert.strictEqual(typeof p.headPitch, 'number')
    })

    it('uses the declared velocity shape (old)', () => {
      const p = support.spawnEntityPacket(oldData, { entityId: 100, entity: 'chicken', x: 1, y: 2, z: 3 })
      assert.strictEqual(p.type, 25)
      assert.strictEqual(p.velocityX, 0)
      assert.ok(!('velocity' in p))
    })

    it('rejects an entity the version does not have', () => {
      assert.throws(() => support.spawnEntityPacket(newData, { entityId: 1, entity: 'boat', x: 0, y: 0, z: 0 }), /no entity "boat"/)
    })
  })

  describe('map_chunk', () => {
    const chunk = {
      dumpLight: () => ({ skyLightMask: [1], blockLightMask: [2], emptySkyLightMask: [3], emptyBlockLightMask: [4], skyLight: [], blockLight: [] }),
      dump: () => Buffer.from([1, 2, 3]),
      getMask: () => 7
    }

    it('old layout: NBT heightmaps and the ground-up fields', () => {
      const p = support.chunkPacket(oldData, chunk, 2, 3)
      assert.strictEqual(p.x, 2)
      assert.strictEqual(p.z, 3)
      assert.strictEqual(p.groundUp, true)
      assert.strictEqual(p.bitMap, 7)
      assert.strictEqual(p.heightmaps.type, 'compound')
    })

    it('new layout: array heightmaps, no ground-up fields, only declared light fields', () => {
      const p = support.chunkPacket(newData, chunk)
      assert.deepStrictEqual(p.heightmaps, [])
      assert.ok(!('groundUp' in p))
      assert.ok(!('bitMap' in p))
      assert.deepStrictEqual(p.skyLightMask, [1])
      assert.ok(!('emptySkyLightMask' in p), 'a field this version does not declare must not be sent')
      assert.deepStrictEqual([...p.chunkData], [1, 2, 3])
    })

    it('says so when the heightmaps type is one it cannot build', () => {
      const odd = fakeMcData('99', { ...newPacketTypes, packet_map_chunk: container(['x', 'i32'], ['z', 'i32'], ['heightmaps', 'mystery'], ['chunkData', 'buffer']) })
      assert.throws(() => support.chunkPacket(odd, chunk), /heightmaps/)
    })
  })

  describe('fillPacket', () => {
    it('drops values for fields the version does not declare', () => {
      const p = support.fillPacket(newData, 'toClient', 'block_change', { location: { x: 1, y: 1, z: 1 }, type: 1, bogus: 1 })
      assert.ok(!('bogus' in p))
    })

    it('fails loudly when a required field was renamed, instead of sending an empty packet', () => {
      assert.throws(
        () => support.fillPacket(newData, 'toClient', 'block_change', { pos: 1 }, { required: ['pos'] }),
        /no "pos" field \(it declares: location, type\)/
      )
    })

    it('fails loudly for a packet the version does not have', () => {
      assert.throws(() => support.fillPacket(newData, 'toClient', 'no_such_packet'), /no toClient packet "no_such_packet"/)
    })

    it('fails loudly for a field type it cannot default', () => {
      const odd = fakeMcData('99', { packet_x: container(['weird', 'mystery']) })
      assert.throws(() => support.fillPacket(odd, 'toClient', 'x'), /cannot build a default for x\.weird/)
    })

    it('defaults nested containers, bitfields and 64-bit values', () => {
      const data = fakeMcData('99', {
        packet_x: container(['pos', 'position'], ['big', 'i64'], ['nested', ['container', [{ name: 'a', type: 'u8' }, { name: 'b', type: 'bool' }]]])
      })
      assert.deepStrictEqual(support.fillPacket(data, 'toClient', 'x'), { pos: { x: 0, z: 0, y: 0 }, big: [0, 0], nested: { a: 0, b: false } })
    })
  })

  describe('login and block state ids', () => {
    it('login packet has the bot at entity id 0 and leaves the shared original alone', () => {
      const p = support.loginPacket(newData)
      assert.strictEqual(p.entityId, 0)
      assert.strictEqual(newData.loginPacket.entityId, 1)
    })

    it('stateIdOf prefers the default state', () => {
      assert.strictEqual(support.stateIdOf(newData, 'water'), 5000)
    })
  })
})
