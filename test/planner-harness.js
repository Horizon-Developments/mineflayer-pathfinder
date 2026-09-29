/**
 * Lightweight planner harness.
 *
 * Drives Movements.getNeighbors() against a synthetic voxel world without needing
 * a Minecraft server, so move-generation logic can be exercised directly.
 */
const { Vec3 } = require('vec3')
const Move = require('../lib/move')

const VERSION = process.env.PF_TEST_VERSION || '26.1'

function makeWorld (version = VERSION) {
  const registry = require('minecraft-data')(version)
  const Block = require('prismarine-block')(registry)

  const blocks = new Map() // "x,y,z" -> block name
  const key = (x, y, z) => `${x},${y},${z}`

  const cache = new Map()
  function blockFor (name) {
    if (!cache.has(name)) {
      const def = registry.blocksByName[name]
      if (!def) throw new Error(`unknown block ${name} in ${version}`)
      cache.set(name, def.minStateId)
    }
    return cache.get(name)
  }

  const world = {
    registry,
    set (x, y, z, name) { blocks.set(key(x, y, z), name); return world },
    fill (x1, y1, z1, x2, y2, z2, name) {
      for (let x = x1; x <= x2; x++) {
        for (let y = y1; y <= y2; y++) {
          for (let z = z1; z <= z2; z++) world.set(x, y, z, name)
        }
      }
      return world
    },
    blockAt (pos) {
      const name = blocks.get(key(pos.x, pos.y, pos.z)) ?? 'air'
      const b = Block.fromStateId(blockFor(name), 0)
      b.position = new Vec3(pos.x, pos.y, pos.z)
      return b
    }
  }
  return world
}

function makeBot (world, { items = [], entities = {}, vehicle = null } = {}) {
  const registry = world.registry
  const bot = {
    registry,
    version: VERSION,
    entities,
    vehicle,
    game: { minY: -64 },
    entity: { position: new Vec3(0, 64, 0), effects: {}, onGround: true },
    inventory: {
      items: () => items.map(name => ({
        type: registry.itemsByName[name].id,
        name,
        count: 1,
        nbt: null
      }))
    },
    blockAt: (pos) => world.blockAt(pos)
  }
  bot.pathfinder = { bestHarvestTool: () => null }
  return bot
}

/** Build a Move for the bot standing with feet at (x,y,z). */
function nodeAt (x, y, z, opts = {}) {
  return new Move(x, y, z, opts.remainingBlocks ?? 0, 0, [], [], false, opts.boat ?? false)
}

function describe (neighbors) {
  return neighbors.map(n => ({
    pos: `${n.x},${n.y},${n.z}`,
    cost: Number(n.cost.toFixed(3)),
    parkour: n.parkour,
    boat: n.boat
  }))
}

module.exports = { makeWorld, makeBot, nodeAt, describe, VERSION }
