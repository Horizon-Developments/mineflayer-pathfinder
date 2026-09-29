'use strict'

/**
 * Helpers for the fake-server tests (internalTest.js, boatServerTest.js).
 *
 * Two jobs:
 *
 *  1. Build chunks literally: create an empty chunk of the right height for the
 *     version and set every block one at a time by its state id, in world
 *     coordinates. Nothing depends on how a version's chunk.initialize() numbers y.
 *
 *  2. Speak the version's protocol without hard-coding it. The tests used to
 *     hand-write 1.16.5-shaped login / position / map_chunk / block_change /
 *     spawn_entity packets. On 26.1 those are all shaped differently (block_change
 *     carries a state id, not a block id; position has a teleport id, a velocity and a
 *     bitflags field; heightmaps are no longer NBT; ...). node-minecraft-protocol
 *     ends the connection on a serialization error, so a wrongly shaped packet does
 *     not fail politely. Every packet here is built by reading the packet's
 *     declared fields from minecraft-data and filling exactly those, and it throws
 *     a readable error when it is asked for something the version does not have.
 */

const { Vec3 } = require('vec3')
const { v4: uuidv4 } = require('uuid')

const NUMERIC = new Set([
  'i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'f32', 'f64', 'varint', 'varlong',
  'li8', 'li16', 'li32', 'lu8', 'lu16', 'lu32', 'lf32', 'lf64'
])
const LONG = new Set(['i64', 'u64', 'li64', 'lu64'])
const NBT = new Set(['nbt', 'anonymousNbt', 'anonOptionalNbt', 'optionalNbt'])
const VEC3 = new Set(['lpVec3', 'vec3f', 'vec3f64', 'vec3i16'])

const kindOf = (type) => Array.isArray(type) ? type[0] : type

// ---------------------------------------------------------------------------
// Blocks and chunks
// ---------------------------------------------------------------------------

/**
 * The state id a block of this name gets by default. Block *ids* and *state ids* are
 * different numbers from 1.13 on; anything that goes on the wire or into a chunk
 * wants the state id.
 */
function stateIdOf (mcData, name) {
  const block = mcData.blocksByName[name]
  if (!block) throw new Error(`minecraft-data ${mcData.version.minecraftVersion} has no block "${name}"`)
  return block.defaultState ?? block.minStateId ?? block.id
}

/** An empty chunk of the height the version's overworld has. */
function newChunk (version) {
  const mcData = require('minecraft-data')(version)
  const Chunk = require('prismarine-chunk')(version)
  // 1.18+ worlds run from y=-64 to y=320. A chunk built with the legacy 0..256 height
  // does not match the dimension the login packet describes.
  return mcData.supportFeature('tallWorld') ? new Chunk({ minY: -64, worldHeight: 384 }) : new Chunk()
}

/**
 * Build a chunk by editing it literally, one block at a time.
 * @param {string} version
 * @param {(x: number, y: number, z: number) => (string | null | undefined)} pick block
 *   name for chunk-local x/z and world y; falsy or 'air' leaves the block as air
 * @param {{ minY?: number, maxY?: number }} [range] world y range to visit; everything
 *   outside it stays air
 */
function buildChunk (version, pick, { minY = 0, maxY = 64 } = {}) {
  const mcData = require('minecraft-data')(version)
  const chunk = newChunk(version)
  const ids = new Map()
  const pos = new Vec3(0, 0, 0)
  for (let y = minY; y < maxY; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const name = pick(x, y, z)
        if (!name || name === 'air') continue
        if (!ids.has(name)) ids.set(name, stateIdOf(mcData, name))
        chunk.setBlockStateId(pos.set(x, y, z), ids.get(name))
      }
    }
  }
  return chunk
}

/** Set one block of an existing chunk by name. */
function setBlockNamed (chunk, mcData, pos, name) {
  chunk.setBlockStateId(new Vec3(pos.x, pos.y, pos.z), stateIdOf(mcData, name))
}

// ---------------------------------------------------------------------------
// Packets, built from the protocol definition
// ---------------------------------------------------------------------------

function packetTypes (mcData, direction) {
  return mcData.protocol.play[direction].types
}

/**
 * The declared fields of a packet, or null if the version has no such packet.
 * @param {'toClient' | 'toServer'} direction
 * @returns {{ name: string, type: any }[] | null}
 */
function packetFields (mcData, direction, name) {
  const def = packetTypes(mcData, direction)[`packet_${name}`]
  return def && Array.isArray(def[1]) ? def[1] : null
}

/** A value the serializer accepts for a field of this type, or a readable error. */
function defaultValue (mcData, types, type, where) {
  const kind = kindOf(type)
  if (NUMERIC.has(kind)) return 0
  if (LONG.has(kind)) return [0, 0]
  if (kind === 'bool') return false
  if (kind === 'string') return ''
  if (kind === 'array') return []
  if (kind === 'UUID') return uuidv4()
  if (VEC3.has(kind)) return { x: 0, y: 0, z: 0 }
  if (kind === 'bitflags') {
    const flags = type[1].flags
    return Object.fromEntries((Array.isArray(flags) ? flags : Object.keys(flags)).map(f => [f, false]))
  }
  if (kind === 'bitfield') return Object.fromEntries(type[1].map(f => [f.name, 0]))
  if (kind === 'container') {
    return Object.fromEntries(type[1].map(f => [f.name, defaultValue(mcData, types, f.type, `${where}.${f.name}`)]))
  }
  // A named type: a local alias of this packet direction, or a global one.
  const alias = types[kind] !== undefined ? types[kind] : mcData.protocol.types[kind]
  if (alias && alias !== 'native') return defaultValue(mcData, types, alias, where)
  throw new Error(`cannot build a default for ${where} (type ${JSON.stringify(type)}); pass it explicitly`)
}

/**
 * Build a packet for `name` holding exactly the fields this version declares.
 * Fields not in `values` get a neutral default. Values for fields the version does not
 * have are dropped - except the ones named in `required`, which must exist, so that a
 * renamed field is an error here instead of a silently empty packet.
 * @param {'toClient' | 'toServer'} direction
 * @param {string} name
 * @param {object} [values]
 * @param {{ required?: string[] }} [options]
 */
function fillPacket (mcData, direction, name, values = {}, { required = [] } = {}) {
  const fields = packetFields(mcData, direction, name)
  const version = mcData.version.minecraftVersion
  if (!fields) throw new Error(`${version} has no ${direction} packet "${name}"`)
  const declared = fields.map(f => f.name)
  for (const key of required) {
    if (!declared.includes(key)) {
      throw new Error(`${version} ${name} has no "${key}" field (it declares: ${declared.join(', ')})`)
    }
  }
  const types = packetTypes(mcData, direction)
  const packet = {}
  for (const field of fields) {
    packet[field.name] = values[field.name] !== undefined
      ? values[field.name]
      : defaultValue(mcData, types, field.type, `${name}.${field.name}`)
  }
  return packet
}

/**
 * Heightmaps are an NBT compound up to 1.21.4 and an array of typed entries after it.
 * The client only ever ignores them, so the smallest valid value of either shape will do.
 */
function heightmapsFor (mcData, type) {
  const types = packetTypes(mcData, 'toClient')
  let kind = kindOf(type)
  // Follow aliases until something concrete is left.
  while (types[kind] !== undefined && types[kind] !== 'native' && !NBT.has(kind) && kind !== 'array') {
    kind = kindOf(types[kind])
  }
  if (NBT.has(kind)) {
    return { type: 'compound', name: '', value: { MOTION_BLOCKING: { type: 'longArray', value: new Array(36).fill([0, 0]) } } }
  }
  if (kind === 'array') return []
  throw new Error(`do not know how to build heightmaps of type ${JSON.stringify(type)}`)
}

/** The map_chunk packet for a chunk at chunk coordinates x, z. */
function chunkPacket (mcData, chunk, x = 0, z = 0) {
  const lights = chunk.dumpLight()
  const fields = packetFields(mcData, 'toClient', 'map_chunk')
  if (!fields) throw new Error(`${mcData.version.minecraftVersion} has no map_chunk packet`)
  const heightmaps = fields.find(f => f.name === 'heightmaps')
  return fillPacket(mcData, 'toClient', 'map_chunk', {
    x,
    z,
    groundUp: true,
    biomes: chunk.dumpBiomes !== undefined ? chunk.dumpBiomes() : undefined,
    heightmaps: heightmaps ? heightmapsFor(mcData, heightmaps.type) : undefined,
    bitMap: chunk.getMask ? chunk.getMask() : undefined,
    chunkData: chunk.dump(),
    blockEntities: [],
    trustEdges: false,
    skyLightMask: lights?.skyLightMask,
    blockLightMask: lights?.blockLightMask,
    emptySkyLightMask: lights?.emptySkyLightMask,
    emptyBlockLightMask: lights?.emptyBlockLightMask,
    skyLight: lights?.skyLight,
    blockLight: lights?.blockLight
  }, { required: ['x', 'z', 'chunkData'] })
}

/** The play login packet, with the bot's entity id fixed at 0. */
function loginPacket (mcData) {
  if (!mcData.loginPacket) throw new Error(`minecraft-data has no login packet for ${mcData.version.minecraftVersion}`)
  return { ...mcData.loginPacket, entityId: 0 }
}

/** Teleport the client to `pos`. */
function positionPacket (mcData, pos, teleportId = 1) {
  return fillPacket(mcData, 'toClient', 'position', {
    teleportId,
    x: pos.x,
    y: pos.y,
    z: pos.z
  }, { required: ['x', 'y', 'z'] })
}

/** Change one block to the named block. `location` is anything with x, y, z. */
function blockChangePacket (mcData, location, name) {
  return fillPacket(mcData, 'toClient', 'block_change', {
    location,
    type: stateIdOf(mcData, name)
  }, { required: ['location', 'type'] })
}

/**
 * Spawn an entity of the named registry type (e.g. 'chicken', 'oak_boat').
 * @param {object} mcData
 * @param {{ entityId: number, entity: string, x: number, y: number, z: number }} spec
 */
function spawnEntityPacket (mcData, { entityId, entity, x, y, z }) {
  const type = mcData.entitiesByName[entity]
  if (!type) throw new Error(`minecraft-data ${mcData.version.minecraftVersion} has no entity "${entity}"`)
  return fillPacket(mcData, 'toClient', 'spawn_entity', {
    entityId,
    objectUUID: uuidv4(),
    // The registry id of the entity type. (The old test passed prismarine-entity's
    // `type` here, which is the string 'mob' or 'object' and not a protocol number.)
    type: type.id,
    x,
    y,
    z,
    // Both velocity shapes minecraft-data has used; only the declared one is kept.
    velocity: { x: 0, y: 0, z: 0 },
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0
  }, { required: ['entityId', 'type', 'x', 'y', 'z'] })
}

module.exports = {
  stateIdOf,
  newChunk,
  buildChunk,
  setBlockNamed,
  packetFields,
  fillPacket,
  defaultValue,
  heightmapsFor,
  chunkPacket,
  loginPacket,
  positionPacket,
  blockChangePacket,
  spawnEntityPacket
}
