const { performance } = require('perf_hooks')
const { Vec3 } = require('vec3')
const nbt = require('prismarine-nbt')
const Move = require('./move')
const hostiles = require('./hostiles')
const boatBreak = require('./boatBreak')

// Every boat variant, item or entity, by name: boat, oak_boat, oak_chest_boat,
// bamboo_raft, bamboo_chest_raft, ... Matching the suffix instead of listing names
// keeps this working as new wood types are added. Entities were once all called
// plain 'boat'; since the per-wood split they are 'oak_boat' etc., which an
// exact-name check silently stops matching.
const BOAT_NAME = /(^|_)(boat|raft)$/
// Some versions only fill in the display name ("Oak Boat", "Bamboo Raft").
const BOAT_DISPLAY_NAME = /(^|[\s_])(boat|raft)$/
const isBoatDisplayName = (displayName) => BOAT_DISPLAY_NAME.test(String(displayName ?? '').toLowerCase())

const cardinalDirections = [
  { x: -1, z: 0 }, // West
  { x: 1, z: 0 }, // East
  { x: 0, z: -1 }, // North
  { x: 0, z: 1 } // South
]
const diagonalDirections = [
  { x: -1, z: -1 },
  { x: -1, z: 1 },
  { x: 1, z: -1 },
  { x: 1, z: 1 }
]

class Movements {
  constructor (bot) {
    const registry = bot.registry
    this.bot = bot

    this.canDig = true
    this.digCost = 1
    this.placeCost = 1
    this.liquidCost = 1
    this.entityCost = 1

    this.dontCreateFlow = true
    this.dontMineUnderFallingBlock = true
    this.allow1by1towers = true
    this.allowFreeMotion = false
    this.allowParkour = true
    // Diagonal steps are only generated when BOTH flanking cells are already open.
    // With one side blocked the step squeezes past the corner of a block: the
    // bot's hitbox catches on it and slides round the edge instead of walking a
    // straight line, which is also where it snags and stalls. Turn it back on to
    // get the old, shorter, corner-hugging diagonals.
    this.allowCornerCutting = false
    this.allowSprinting = true
    this.allowEntityDetection = true

    // Vanilla player step height. Anything taller than this needs a jump, so a
    // plain walk move must never be generated across a larger rise.
    this.stepHeight = 0.6
    // Tallest rise a jump can clear. Matches the existing 1.2 checks in
    // getMoveJumpUp and getMoveDiagonal.
    this.maxJumpUp = 1.2

    // Boat travel. Off by default: it changes the shape of the search space and
    // needs a boat in the inventory (or one already floating nearby) to be useful.
    this.allowBoating = false
    // Per-cell cruise cost. Boats are substantially faster than walking, so this
    // is below the walking cost of 1 to make A* actually prefer water routes.
    this.boatCost = 0.35
    // One-off costs for the medium transitions, covering place + mount latency
    // and the dismount stall respectively.
    this.boatEmbarkCost = 6
    this.boatDisembarkCost = 3
    // Break the boat after leaving it and pick it up again, so it can be placed again further on. Off by
    // default: it makes the bot stop on the shore, and a crossing is priced with that (getBoatRecycleCost).
    this.boatRecycle = false
    this.boatPickupTicks = 20 // walking to the drop plus its 10 tick pickup delay
    // Steering sign for moveVehicle(). Entity yaw conventions vary across
    // versions; the controller flips this automatically if it detects that
    // turning is making the heading error worse. See index.js.
    this.boatYawSign = 1

    this.entitiesToAvoid = new Set()
    this.passableEntities = new Set(require('./passableEntities.json'))
    this.interactableBlocks = new Set(require('./interactable.json'))

    this.blocksCantBreak = new Set()
    this.blocksCantBreak.add(registry.blocksByName.chest.id)

    registry.blocksArray.forEach(block => {
      if (block.diggable) return
      this.blocksCantBreak.add(block.id)
    })

    this.blocksToAvoid = new Set()
    this.blocksToAvoid.add(registry.blocksByName.fire.id)
    if (registry.blocksByName.cobweb) this.blocksToAvoid.add(registry.blocksByName.cobweb.id)
    if (registry.blocksByName.web) this.blocksToAvoid.add(registry.blocksByName.web.id)
    this.blocksToAvoid.add(registry.blocksByName.lava.id)

    this.liquids = new Set()
    this.liquids.add(registry.blocksByName.water.id)
    this.liquids.add(registry.blocksByName.lava.id)

    // Boating needs water specifically, not "any liquid" - riding into lava is
    // not a travel mode.
    this.waterId = registry.blocksByName.water.id

    // Every boat/raft variant, including the chest ones. Matched by name so this
    // keeps working as new wood types are added.
    this.boatItems = new Set()
    for (const item of registry.itemsArray) {
      if (BOAT_NAME.test(item.name)) this.boatItems.add(item.id)
    }

    // For the water-bucket clutch: using a water bucket empties it in place (the
    // same inventory item flips to a plain bucket), and scooping the placed water
    // back up fills that same bucket again - one water_bucket is enough for a
    // full place-then-scoop cycle. Undefined on a registry with no buckets at
    // all; getWaterBucketItem then simply never finds one, same as running out
    // of boats.
    this.waterBucketItemId = registry.itemsByName.water_bucket ? registry.itemsByName.water_bucket.id : undefined
    this.emptyBucketItemId = registry.itemsByName.bucket ? registry.itemsByName.bucket.id : undefined

    this.gravityBlocks = new Set()
    this.gravityBlocks.add(registry.blocksByName.sand.id)
    this.gravityBlocks.add(registry.blocksByName.gravel.id)

    this.climbables = new Set()
    this.climbables.add(registry.blocksByName.ladder.id)
    // this.climbables.add(registry.blocksByName.vine.id)
    this.emptyBlocks = new Set()

    this.replaceables = new Set()
    this.replaceables.add(registry.blocksByName.air.id)
    if (registry.blocksByName.cave_air) this.replaceables.add(registry.blocksByName.cave_air.id)
    if (registry.blocksByName.void_air) this.replaceables.add(registry.blocksByName.void_air.id)
    this.replaceables.add(registry.blocksByName.water.id)
    this.replaceables.add(registry.blocksByName.lava.id)

    this.scafoldingBlocks = []
    this.scafoldingBlocks.push(registry.itemsByName.dirt.id)
    this.scafoldingBlocks.push(registry.itemsByName.cobblestone.id)

    const Block = require('prismarine-block')(bot.registry)
    this.fences = new Set()
    this.carpets = new Set()
    this.openable = new Set()
    registry.blocksArray.map(x => Block.fromStateId(x.minStateId, 0)).forEach(block => {
      if (block.shapes.length > 0) {
        // Fences or any block taller than 1, they will be considered as non-physical to avoid
        // trying to walk on them
        if (block.shapes[0][4] > 1) this.fences.add(block.type)
        // Carpets or any blocks smaller than 0.1, they will be considered as safe to walk in
        if (block.shapes[0][4] < 0.1) this.carpets.add(block.type)
      } else if (block.shapes.length === 0) {
        this.emptyBlocks.add(block.type)
      }
    })
    registry.blocksArray.forEach(block => {
      if (this.interactableBlocks.has(block.name) && block.name.toLowerCase().includes('gate') && !block.name.toLowerCase().includes('iron')) {
        // console.info(block)
        this.openable.add(block.id)
      }
    })

    this.canOpenDoors = false // Causes issues. Probably due to none paper servers.

    this.exclusionAreasStep = []
    this.exclusionAreasBreak = []
    this.exclusionAreasPlace = []

    this.maxDropDown = 4
    this.infiniteLiquidDropdownDistance = true

    // Water-bucket clutch (MLG water bucket): place a water bucket to cushion a
    // fall the plain drop-down move won't take (a dry landing more than
    // maxDropDown blocks down - vanilla fall damage itself starts past 3 blocks,
    // which is exactly maxDropDown's default of 4), then scoop the water back up
    // once down. See getWaterBucketDrop below and the executor in index.js
    // (waterBucketClutch / runPlaceWaterBucket / runScoopWaterBucket).
    this.allowWaterBucketClutch = true
    // A flat per-move cost regardless of fall distance (place, fall, scoop - all
    // roughly constant real time), same order of magnitude as boatEmbarkCost.
    // Chosen so it beats routing around via a dug-out staircase: each block dug
    // through costs digCost (scaled up by dig time in safeOrBreak), so any detour
    // breaking more than a handful of blocks already costs more than one flat WBC
    // move straight down.
    this.waterBucketClutchCost = 6
    // How far down a water-bucket-clutched fall may still search for a landing.
    // Not vanilla-accurate (a real water bucket clutch works from any height with
    // line of sight to the ground) - just a sanity bound on the search.
    this.maxWaterBucketDropDown = 32

    this.entityIntersections = {}

    // Hostile mobs (lib/hostiles.js). They are detected from the registry, so nothing has to be listed
    // by hand (entitiesToAvoid still works, separately), and each one puts a cost around itself that
    // fades with distance, so routes keep away from it instead of merely not walking through it.
    this.avoidHostiles = true
    // Blocks from the bot: farther mobs are not worth planning around yet. Kept comfortably past a
    // typical vanilla follow range (16) plus hostiles.FOLLOW_RANGE_MARGIN, since profileForEntity can
    // widen a mob's avoidance radius that far - a mob this filter skips is never scanned closely
    // enough to have its attributes read at all, so its real radius would go unused.
    this.hostileScanRange = 34
    this.maxTrackedHostiles = 32 // the nearest this many
    this.hostileCostScale = 1 // multiplies every hostile cost; 0 keeps the tracking but drops the cost
    this.hostileNames = new Set() // extra names to treat as hostile
    this.hostileExclusions = new Set() // names never to treat as hostile, e.g. 'enderman'
    this.hostileProfiles = {} // name -> { radius, cost } overrides, see hostiles.PROFILES
    this.hostilesSeen = [] // the hostiles the current search is planned around
    this.dangerField = {}
    this.hostileNameCache = new Map()
  }

  exclusionPlace (block) {
    if (this.exclusionAreasPlace.length === 0) return 0
    let weight = 0
    for (const a of this.exclusionAreasPlace) {
      weight += a(block)
    }
    return weight
  }

  exclusionStep (block) {
    if (this.exclusionAreasStep.length === 0) return 0
    let weight = 0
    for (const a of this.exclusionAreasStep) {
      weight += a(block)
    }
    return weight
  }

  exclusionBreak (block) {
    if (this.exclusionAreasBreak.length === 0) return 0
    let weight = 0
    for (const a of this.exclusionAreasBreak) {
      weight += a(block)
    }
    return weight
  }

  countScaffoldingItems () {
    let count = 0
    const items = this.bot.inventory.items()
    for (const id of this.scafoldingBlocks) {
      for (const j in items) {
        const item = items[j]
        if (item.type === id) count += item.count
      }
    }
    return count
  }

  getScaffoldingItem () {
    const items = this.bot.inventory.items()
    for (const id of this.scafoldingBlocks) {
      for (const j in items) {
        const item = items[j]
        if (item.type === id) return item
      }
    }
    return null
  }

  /**
   * First boat item in the inventory, or null.
   * @returns {import('prismarine-item').Item | null}
   */
  getBoatItem () {
    for (const item of this.bot.inventory.items()) {
      if (this.boatItems.has(item.type)) return item
    }
    return null
  }

  getWaterBucketItem () {
    if (this.waterBucketItemId === undefined) return null
    for (const item of this.bot.inventory.items()) {
      if (item.type === this.waterBucketItemId) return item
    }
    return null
  }

  getEmptyBucketItem () {
    if (this.emptyBucketItemId === undefined) return null
    for (const item of this.bot.inventory.items()) {
      if (item.type === this.emptyBucketItemId) return item
    }
    return null
  }

  /**
   * True for any boat entity: plain and per-wood boats (oak_boat, cherry_boat, ...),
   * chest boats, bamboo rafts and chest rafts, and the pre-1.14 'Boat' object type.
   *
   * This used to compare against the two names 'boat' and 'chest_boat', so on any
   * version with per-wood entities a boat the bot had just placed was never
   * recognised: it was never mounted, and the executor placed another one.
   *
   * It is also on the planner's hot path (every land node asks whether a boat is
   * nearby, and that scans every loaded entity), so it must stay cheap. In
   * particular it must not read `entity.objectType` on a real entity: that getter
   * is deprecated in prismarine-entity and prints a stack trace on every access,
   * which at a few thousand nodes a search froze the event loop long enough for
   * the search to time out and the path to be reported as stuck.
   * @param {import('prismarine-entity').Entity} ent
   * @returns {boolean}
   */
  isBoatEntity (ent) {
    if (!ent) return false
    const name = ent.name
    const displayName = ent.displayName
    if (name) return BOAT_NAME.test(String(name).toLowerCase()) || isBoatDisplayName(displayName)
    if (displayName) return isBoatDisplayName(displayName)
    // Only a bare object with neither name (never a real prismarine entity, which
    // always has one) can still identify itself as the pre-1.14 boat object.
    return ent.objectType === 'Boat'
  }

  /**
   * Nearest already-placed boat entity within range, or null. Lets the bot reuse
   * a boat it parked earlier instead of burning an item every embark.
   * @param {import('vec3').Vec3} pos
   * @param {number} maxDistance
   * @returns {import('prismarine-entity').Entity | null}
   */
  getNearbyBoat (pos, maxDistance = 4) {
    let best = null
    let bestDist = maxDistance * maxDistance
    for (const ent of Object.values(this.bot.entities)) {
      if (!this.isBoatEntity(ent) || !ent.position) continue
      const d = ent.position.distanceSquared(pos)
      if (d < bestDist) {
        bestDist = d
        best = ent
      }
    }
    return best
  }

  /**
   * True if a boat can float in this cell: the cell is water and the space above
   * it is clear. A submerged water block is not boatable - boats ride the surface.
   * @param {Move} node
   * @param {number} dx
   * @param {number} dy
   * @param {number} dz
   * @returns {boolean}
   */
  isBoatable (node, dx, dy, dz) {
    const feet = this.getBlock(node, dx, dy, dz)
    if (!feet.position || feet.type !== this.waterId) return false
    const head = this.getBlock(node, dx, dy + 1, dz)
    // Head space must be open and must not itself be water, otherwise this cell
    // is below the surface.
    return head.safe && head.type !== this.waterId && this.exclusionStep(feet) < 100
  }

  clearCollisionIndex () {
    this.entityIntersections = {}
    this.hostilesSeen = []
    this.dangerField = {}
  }

  /**
   * Finds blocks intersected by entity bounding boxes
   * and sets the number of ents intersecting in a dict.
   * Ignores entities that do not affect block placement
   */
  updateCollisionIndex () {
    for (const ent of Object.values(this.bot.entities)) {
      if (ent === this.bot.entity) { continue }

      const avoidedEnt = this.entitiesToAvoid.has(ent.name)
      if (avoidedEnt || !this.passableEntities.has(ent.name)) {
        const entSquareRadius = ent.width / 2.0
        const minY = Math.floor(ent.position.y)
        const maxY = Math.ceil(ent.position.y + ent.height)
        const minX = Math.floor(ent.position.x - entSquareRadius)
        const maxX = Math.ceil(ent.position.x + entSquareRadius)
        const minZ = Math.floor(ent.position.z - entSquareRadius)
        const maxZ = Math.ceil(ent.position.z + entSquareRadius)

        const cost = avoidedEnt ? 100 : 1

        for (let y = minY; y < maxY; y++) {
          for (let x = minX; x < maxX; x++) {
            for (let z = minZ; z < maxZ; z++) {
              this.entityIntersections[`${x},${y},${z}`] = this.entityIntersections[`${x},${y},${z}`] ?? 0
              this.entityIntersections[`${x},${y},${z}`] += cost // More ents = more weight
            }
          }
        }
      }
    }
    this.updateHostileField()
  }

  /**
   * The hostile mobs near the bot, nearest first, as lib/hostiles.js describes them. Cheap enough to
   * call every few ticks: it only reads bot.entities.
   * @returns {import('./hostiles').Hostile[]}
   */
  scanHostiles () {
    if (!this.avoidHostiles || this.allowEntityDetection === false) return []
    const me = this.bot.entity
    if (!me) return []
    const context = { registry: this.bot.registry, extraNames: this.hostileNames, excludedNames: this.hostileExclusions, cache: this.hostileNameCache }
    const rangeSq = this.hostileScanRange * this.hostileScanRange
    const found = []
    for (const ent of Object.values(this.bot.entities)) {
      if (ent === me || ent.isValid === false || !ent.position) continue
      if (!hostiles.isHostile(ent, context)) continue
      const distanceSq = ent.position.distanceSquared(me.position)
      if (distanceSq > rangeSq) continue
      found.push({
        id: ent.id,
        name: ent.name,
        x: ent.position.x,
        y: ent.position.y,
        z: ent.position.z,
        distanceSq,
        // profileForEntity widens PROFILES' radius to the mob's own follow-range attribute + a
        // margin when mineflayer has it, so e.g. a creeper is kept away from at the distance it can
        // actually notice the bot from rather than the flat guess in PROFILES.
        ...hostiles.profileForEntity(ent, this.hostileProfiles)
      })
    }
    found.sort((a, b) => a.distanceSq - b.distanceSq)
    return found.slice(0, this.maxTrackedHostiles)
  }

  /** Plan around the hostiles as they are now: remember them, and cost the cells around each. */
  updateHostileField () {
    this.hostilesSeen = this.scanHostiles()
    this.dangerField = hostiles.buildDangerField(this.hostilesSeen, { scale: this.hostileCostScale })
  }

  /**
   * Gets number of entities who's bounding box intersects the node + offset
   * @param {import('vec3').Vec3} pos node position
   * @param {number} dx X axis offset
   * @param {number} dy Y axis offset
   * @param {number} dz Z axis offset
   * @returns {number} Number of entities intersecting block
   */
  getNumEntitiesAt (pos, dx, dy, dz) {
    if (this.allowEntityDetection === false) return 0
    if (!pos) return 0
    const y = pos.y + dy
    const x = pos.x + dx
    const z = pos.z + dz

    return this.entityIntersections[`${x},${y},${z}`] ?? 0
  }

  getBlock (pos, dx, dy, dz) {
    const b = pos ? this.bot.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz), false) : null
    if (!b) {
      return {
        replaceable: false,
        canFall: false,
        safe: false,
        physical: false,
        liquid: false,
        climbable: false,
        height: dy,
        openable: false
      }
    }
    b.climbable = this.climbables.has(b.type)
    b.safe = (b.boundingBox === 'empty' || b.climbable || this.carpets.has(b.type)) && !this.blocksToAvoid.has(b.type)
    b.physical = b.boundingBox === 'block' && !this.fences.has(b.type)
    b.replaceable = this.replaceables.has(b.type) && !b.physical
    b.liquid = this.liquids.has(b.type)
    b.height = pos.y + dy
    b.canFall = this.gravityBlocks.has(b.type)
    b.openable = this.openable.has(b.type)

    for (const shape of b.shapes) {
      b.height = Math.max(b.height, pos.y + dy + shape[4])
    }
    return b
  }

  /**
   * Takes into account if the block is within a break exclusion area.
   * @param {import('prismarine-block').Block} block
   * @returns
   */
  safeToBreak (block) {
    if (!this.canDig) {
      return false
    }

    if (this.dontCreateFlow) {
      // false if next to liquid
      if (this.getBlock(block.position, 0, 1, 0).liquid) return false
      if (this.getBlock(block.position, -1, 0, 0).liquid) return false
      if (this.getBlock(block.position, 1, 0, 0).liquid) return false
      if (this.getBlock(block.position, 0, 0, -1).liquid) return false
      if (this.getBlock(block.position, 0, 0, 1).liquid) return false
    }

    if (this.dontMineUnderFallingBlock) {
      // TODO: Determine if there are other blocks holding the entity up
      if (this.getBlock(block.position, 0, 1, 0).canFall || (this.getNumEntitiesAt(block.position, 0, 1, 0) > 0)) {
        return false
      }
    }

    return block.type && !this.blocksCantBreak.has(block.type) && this.exclusionBreak(block) < 100
  }

  /**
   * Takes into account if the block is within the stepExclusionAreas. And returns 100 if a block to be broken is within break exclusion areas.
   * @param {import('prismarine-block').Block} block block
   * @param {[]} toBreak
   * @returns {number}
   */
  safeOrBreak (block, toBreak) {
    let cost = 0
    cost += this.exclusionStep(block) // Is excluded so can't move or break
    cost += this.getNumEntitiesAt(block.position, 0, 0, 0) * this.entityCost
    if (block.safe) return cost
    if (!this.safeToBreak(block)) return 100 // Can't break, so can't move
    toBreak.push(block.position)

    if (block.physical) cost += this.getNumEntitiesAt(block.position, 0, 1, 0) * this.entityCost // Add entity cost if there is an entity above (a breakable block) that will fall

    const tool = this.bot.pathfinder.bestHarvestTool(block)
    const enchants = (tool && tool.nbt) ? nbt.simplify(tool.nbt).Enchantments : []
    const effects = this.bot.entity.effects
    const digTime = block.digTime(tool ? tool.type : null, false, false, false, enchants, effects)
    const laborCost = (1 + 3 * digTime / 1000) * this.digCost
    cost += laborCost
    return cost
  }

  getMoveJumpUp (node, dir, neighbors) {
    const blockA = this.getBlock(node, 0, 2, 0)
    const blockH = this.getBlock(node, dir.x, 2, dir.z)
    const blockB = this.getBlock(node, dir.x, 1, dir.z)
    const blockC = this.getBlock(node, dir.x, 0, dir.z)

    let cost = 2 // move cost (move+jump)
    const toBreak = []
    const toPlace = []

    if (blockA.physical && (this.getNumEntitiesAt(blockA.position, 0, 1, 0) > 0)) return // Blocks A, B and H are above C, D and the player's space, we need to make sure there are no entities that will fall down onto our building space if we break them
    if (blockH.physical && (this.getNumEntitiesAt(blockH.position, 0, 1, 0) > 0)) return
    if (blockB.physical && !blockH.physical && !blockC.physical && (this.getNumEntitiesAt(blockB.position, 0, 1, 0) > 0)) return // It is fine if an ent falls on B so long as we don't need to replace block C

    if (!blockC.physical) {
      if (node.remainingBlocks === 0) return // not enough blocks to place

      if (this.getNumEntitiesAt(blockC.position, 0, 0, 0) > 0) return // Check for any entities in the way of a block placement

      const blockD = this.getBlock(node, dir.x, -1, dir.z)
      if (!blockD.physical) {
        if (node.remainingBlocks === 1) return // not enough blocks to place

        if (this.getNumEntitiesAt(blockD.position, 0, 0, 0) > 0) return // Check for any entities in the way of a block placement

        if (!blockD.replaceable) {
          if (!this.safeToBreak(blockD)) return
          cost += this.exclusionBreak(blockD)
          toBreak.push(blockD.position)
        }
        cost += this.exclusionPlace(blockD)
        toPlace.push({ x: node.x, y: node.y - 1, z: node.z, dx: dir.x, dy: 0, dz: dir.z, returnPos: new Vec3(node.x, node.y, node.z) })
        cost += this.placeCost // additional cost for placing a block
      }

      if (!blockC.replaceable) {
        if (!this.safeToBreak(blockC)) return
        cost += this.exclusionBreak(blockC)
        toBreak.push(blockC.position)
      }
      cost += this.exclusionPlace(blockC)
      toPlace.push({ x: node.x + dir.x, y: node.y - 1, z: node.z + dir.z, dx: 0, dy: 1, dz: 0 })
      cost += this.placeCost // additional cost for placing a block

      blockC.height += 1
    }

    const block0 = this.getBlock(node, 0, -1, 0)
    if (blockC.height - block0.height > 1.2) return // Too high to jump

    cost += this.safeOrBreak(blockA, toBreak)
    if (cost > 100) return
    cost += this.safeOrBreak(blockH, toBreak)
    if (cost > 100) return
    cost += this.safeOrBreak(blockB, toBreak)
    if (cost > 100) return

    neighbors.push(new Move(blockB.position.x, blockB.position.y, blockB.position.z, node.remainingBlocks - toPlace.length, cost, toBreak, toPlace))
  }

  getMoveForward (node, dir, neighbors) {
    const blockB = this.getBlock(node, dir.x, 1, dir.z)
    const blockC = this.getBlock(node, dir.x, 0, dir.z)
    const blockD = this.getBlock(node, dir.x, -1, dir.z)

    let cost = 1 // move cost
    cost += this.exclusionStep(blockC)

    const toBreak = []
    const toPlace = []

    if (!blockD.physical && !blockC.liquid) {
      if (node.remainingBlocks === 0) return // not enough blocks to place

      if (this.getNumEntitiesAt(blockD.position, 0, 0, 0) > 0) return // D intersects an entity hitbox

      if (!blockD.replaceable) {
        if (!this.safeToBreak(blockD)) return
        cost += this.exclusionBreak(blockD)
        toBreak.push(blockD.position)
      }
      cost += this.exclusionPlace(blockD)
      toPlace.push({ x: node.x, y: node.y - 1, z: node.z, dx: dir.x, dy: 0, dz: dir.z })
      cost += this.placeCost // additional cost for placing a block
    }

    cost += this.safeOrBreak(blockB, toBreak)
    if (cost > 100) return

    // Open fence gates
    if (this.canOpenDoors && blockC.openable && blockC.shapes && blockC.shapes.length !== 0) {
      toPlace.push({ x: node.x + dir.x, y: node.y, z: node.z + dir.z, dx: 0, dy: 0, dz: 0, useOne: true }) // Indicate that a block should be used on this block not placed
    } else {
      cost += this.safeOrBreak(blockC, toBreak)
      if (cost > 100) return
    }

    if (this.getBlock(node, 0, 0, 0).liquid) cost += this.liquidCost

    // Classify the rise onto the destination surface. getMoveJumpUp guards this
    // (`blockC.height - block0.height > 1.2`) but getMoveForward historically did
    // not, so the planner emitted a plain walk onto surfaces the physics engine
    // cannot climb - the executor then failed every predicate and stalled.
    //
    // Dropping the move outright would make legitimately reachable cells
    // unreachable (standing on a carpet next to a full block is a 0.94 rise, well
    // within jump height), so instead anything above the auto-step but within
    // jump range is emitted as a jump and the executor commits to it.
    let needsJump = false
    if (toPlace.length === 0) {
      const block0 = this.getBlock(node, 0, -1, 0)
      // The surface we actually arrive standing on: normally the floor (D), but a
      // walkable raised block in the feet cell (carpet, snow layer) wins if taller.
      const surface = (blockC.safe && blockC.height > blockD.height) ? blockC : blockD
      const rise = surface.height - block0.height
      if (rise > this.maxJumpUp) return // not reachable without placing
      if (rise > this.stepHeight) {
        needsJump = true
        cost += 1 // a jump costs more than a stride
      }
    }

    neighbors.push(new Move(blockC.position.x, blockC.position.y, blockC.position.z, node.remainingBlocks - toPlace.length, cost, toBreak, toPlace, needsJump))
  }

  getMoveDiagonal (node, dir, neighbors) {
    let cost = Math.SQRT2 // move cost
    const toBreak = []

    const blockC = this.getBlock(node, dir.x, 0, dir.z) // Landing block or standing on block when jumping up by 1
    const y = blockC.physical ? 1 : 0

    const block0 = this.getBlock(node, 0, -1, 0)

    // The two flanking columns: the cells either side of the diagonal that the
    // bot's hitbox sweeps past on the way to the landing cell.
    const blockB1 = this.getBlock(node, 0, y + 1, dir.z)
    const blockC1 = this.getBlock(node, 0, y, dir.z)
    const blockD1 = this.getBlock(node, 0, y - 1, dir.z)
    const blockB2 = this.getBlock(node, dir.x, y + 1, 0)
    const blockC2 = this.getBlock(node, dir.x, y, 0)
    const blockD2 = this.getBlock(node, dir.x, y - 1, 0)

    // Never round the corner of a block. If either flank is closed the diagonal
    // grazes that block's edge, so refuse it outright - the planner then goes
    // round with two straight cardinal steps through cells that are actually
    // open. Deliberately does not fall back to digging the flank out: that would
    // trade the corner for a hole.
    if (!this.allowCornerCutting && !(blockB1.safe && blockC1.safe && blockB2.safe && blockC2.safe)) return

    let cost1 = 0
    const toBreak1 = []
    cost1 += this.safeOrBreak(blockB1, toBreak1)
    cost1 += this.safeOrBreak(blockC1, toBreak1)
    if (blockD1.height - block0.height > 1.2) cost1 += this.safeOrBreak(blockD1, toBreak1)

    let cost2 = 0
    const toBreak2 = []
    cost2 += this.safeOrBreak(blockB2, toBreak2)
    cost2 += this.safeOrBreak(blockC2, toBreak2)
    if (blockD2.height - block0.height > 1.2) cost2 += this.safeOrBreak(blockD2, toBreak2)

    if (cost1 < cost2) {
      cost += cost1
      toBreak.push(...toBreak1)
    } else {
      cost += cost2
      toBreak.push(...toBreak2)
    }
    if (cost > 100) return

    cost += this.safeOrBreak(this.getBlock(node, dir.x, y, dir.z), toBreak)
    if (cost > 100) return
    cost += this.safeOrBreak(this.getBlock(node, dir.x, y + 1, dir.z), toBreak)
    if (cost > 100) return

    if (this.getBlock(node, 0, 0, 0).liquid) cost += this.liquidCost

    const blockD = this.getBlock(node, dir.x, -1, dir.z)
    if (y === 1) { // Case jump up by 1
      if (blockC.height - block0.height > 1.2) return // Too high to jump
      cost += this.safeOrBreak(this.getBlock(node, 0, 2, 0), toBreak)
      if (cost > 100) return
      cost += 1
      neighbors.push(new Move(blockC.position.x, blockC.position.y + 1, blockC.position.z, node.remainingBlocks, cost, toBreak))
    } else if (blockD.physical || blockC.liquid) {
      // Same rise classification as getMoveForward: walk, jump, or unreachable.
      let needsJump = false
      if (!blockC.liquid) {
        const surface = (blockC.safe && blockC.height > blockD.height) ? blockC : blockD
        const rise = surface.height - block0.height
        if (rise > this.maxJumpUp) return
        if (rise > this.stepHeight) {
          needsJump = true
          cost += 1
        }
      }
      neighbors.push(new Move(blockC.position.x, blockC.position.y, blockC.position.z, node.remainingBlocks, cost, toBreak, [], needsJump))
    } else if (this.getBlock(node, dir.x, -2, dir.z).physical || blockD.liquid) {
      if (!blockD.safe) return // don't self-immolate
      cost += this.getNumEntitiesAt(blockC.position, 0, -1, 0) * this.entityCost
      neighbors.push(new Move(blockC.position.x, blockC.position.y - 1, blockC.position.z, node.remainingBlocks, cost, toBreak))
    }
  }

  getLandingBlock (node, dir) {
    let blockLand = this.getBlock(node, dir.x, -2, dir.z)
    while (blockLand.position && blockLand.position.y > this.bot.game.minY) {
      if (blockLand.liquid && blockLand.safe) return blockLand
      if (blockLand.physical) {
        if (node.y - blockLand.position.y <= this.maxDropDown) return this.getBlock(blockLand.position, 0, 1, 0)
        return null
      }
      if (!blockLand.safe) return null
      blockLand = this.getBlock(blockLand.position, 0, -1, 0)
    }
    return null
  }

  getMoveDropDown (node, dir, neighbors) {
    const blockB = this.getBlock(node, dir.x, 1, dir.z)
    const blockC = this.getBlock(node, dir.x, 0, dir.z)
    const blockD = this.getBlock(node, dir.x, -1, dir.z)

    let cost = 1 // move cost
    const toBreak = []
    const toPlace = []

    const blockLand = this.getLandingBlock(node, dir)
    if (!blockLand) return
    if (!this.infiniteLiquidDropdownDistance && ((node.y - blockLand.position.y) > this.maxDropDown)) return // Don't drop down into water

    cost += this.safeOrBreak(blockB, toBreak)
    if (cost > 100) return
    cost += this.safeOrBreak(blockC, toBreak)
    if (cost > 100) return
    cost += this.safeOrBreak(blockD, toBreak)
    if (cost > 100) return

    if (blockC.liquid) return // dont go underwater

    cost += this.getNumEntitiesAt(blockLand.position, 0, 0, 0) * this.entityCost // add cost for entities

    neighbors.push(new Move(blockLand.position.x, blockLand.position.y, blockLand.position.z, node.remainingBlocks - toPlace.length, cost, toBreak, toPlace))
  }

  getMoveDown (node, neighbors) {
    const block0 = this.getBlock(node, 0, -1, 0)

    let cost = 1 // move cost
    const toBreak = []
    const toPlace = []

    const blockLand = this.getLandingBlock(node, { x: 0, z: 0 })
    if (!blockLand) return

    cost += this.safeOrBreak(block0, toBreak)
    if (cost > 100) return

    if (this.getBlock(node, 0, 0, 0).liquid) return // dont go underwater

    cost += this.getNumEntitiesAt(blockLand.position, 0, 0, 0) * this.entityCost // add cost for entities

    neighbors.push(new Move(blockLand.position.x, blockLand.position.y, blockLand.position.z, node.remainingBlocks - toPlace.length, cost, toBreak, toPlace))
  }

  /**
   * Like getLandingBlock, but for a water-bucket-clutched fall: keeps scanning
   * down past maxDropDown, up to maxWaterBucketDropDown, for a dry (physical)
   * landing only - a liquid landing needs no bucket and is already free via
   * getLandingBlock/infiniteLiquidDropdownDistance, so this returns null for one
   * rather than duplicate it.
   */
  getWaterBucketLandingBlock (node, dir) {
    let blockLand = this.getBlock(node, dir.x, -2, dir.z)
    while (blockLand.position && blockLand.position.y > this.bot.game.minY) {
      if (blockLand.liquid) return null // already free without a bucket
      if (blockLand.physical) {
        if (node.y - blockLand.position.y > this.maxWaterBucketDropDown) return null
        return this.getBlock(blockLand.position, 0, 1, 0)
      }
      if (!blockLand.safe) return null
      blockLand = this.getBlock(blockLand.position, 0, -1, 0)
    }
    return null
  }

  /**
   * Shared by getMoveWaterBucketDown/getMoveWaterBucketDropDown: the gating for
   * a water-bucket-clutched fall onto blockLand (from getWaterBucketLandingBlock
   * above). extraCost/toBreak carry the ordinary safeOrBreak cost of actually
   * getting to and off the edge, exactly like getMoveDown/getMoveDropDown.
   */
  getWaterBucketDrop (node, blockLand, extraCost, toBreak, neighbors) {
    if (!blockLand) return
    const distance = node.y - blockLand.position.y
    // The plain drop-down move already reaches this landing for free, no bucket
    // needed, up to maxDropDown (whose default of 4 is exactly the vanilla point
    // fall damage starts - "more than 3 blocks"). WBC only makes sense, and is
    // only offered, beyond that - otherwise it would just be a slower, wasteful
    // way to do what the plain move already does for a flat cost of 1.
    if (distance <= this.maxDropDown) return
    // "make sure you can place water on the dropdown": blockLand is already
    // guaranteed a safe, non-liquid standing cell over a physical floor by
    // getWaterBucketLandingBlock; re-checked here defensively so a future change
    // to that method can't silently send a WBC move somewhere it shouldn't.
    if (!blockLand.position || !blockLand.safe || blockLand.liquid) return
    if (!this.getWaterBucketItem()) return
    const cost = this.waterBucketClutchCost + extraCost + this.getNumEntitiesAt(blockLand.position, 0, 0, 0) * this.entityCost
    if (cost > 100) return
    neighbors.push(new Move(blockLand.position.x, blockLand.position.y, blockLand.position.z, node.remainingBlocks, cost, toBreak, [], false, false, true))
  }

  getMoveWaterBucketDown (node, neighbors) {
    if (!this.allowWaterBucketClutch) return
    const block0 = this.getBlock(node, 0, -1, 0)
    const toBreak = []
    const cost = this.safeOrBreak(block0, toBreak)
    if (cost > 100) return
    if (this.getBlock(node, 0, 0, 0).liquid) return // dont go underwater
    const blockLand = this.getWaterBucketLandingBlock(node, { x: 0, z: 0 })
    this.getWaterBucketDrop(node, blockLand, cost, toBreak, neighbors)
  }

  getMoveWaterBucketDropDown (node, dir, neighbors) {
    if (!this.allowWaterBucketClutch) return
    const blockB = this.getBlock(node, dir.x, 1, dir.z)
    const blockC = this.getBlock(node, dir.x, 0, dir.z)
    const blockD = this.getBlock(node, dir.x, -1, dir.z)
    const toBreak = []
    let cost = this.safeOrBreak(blockB, toBreak)
    if (cost > 100) return
    cost += this.safeOrBreak(blockC, toBreak)
    if (cost > 100) return
    cost += this.safeOrBreak(blockD, toBreak)
    if (cost > 100) return
    if (blockC.liquid) return
    const blockLand = this.getWaterBucketLandingBlock(node, dir)
    this.getWaterBucketDrop(node, blockLand, cost, toBreak, neighbors)
  }

  getMoveUp (node, neighbors) {
    const block1 = this.getBlock(node, 0, 0, 0)
    if (block1.liquid) return
    if (this.getNumEntitiesAt(node, 0, 0, 0) > 0) return // an entity (besides the player) is blocking the building area

    const block2 = this.getBlock(node, 0, 2, 0)

    let cost = 1 // move cost
    const toBreak = []
    const toPlace = []
    cost += this.safeOrBreak(block2, toBreak)
    if (cost > 100) return

    if (!block1.climbable) {
      if (!this.allow1by1towers || node.remainingBlocks === 0) return // not enough blocks to place

      if (!block1.replaceable) {
        if (!this.safeToBreak(block1)) return
        toBreak.push(block1.position)
      }

      const block0 = this.getBlock(node, 0, -1, 0)
      if (block0.physical && block0.height - node.y < -0.2) return // cannot jump-place from a half block

      cost += this.exclusionPlace(block1)
      toPlace.push({ x: node.x, y: node.y - 1, z: node.z, dx: 0, dy: 1, dz: 0, jump: true })
      cost += this.placeCost // additional cost for placing a block
    }

    if (cost > 100) return

    neighbors.push(new Move(node.x, node.y + 1, node.z, node.remainingBlocks - toPlace.length, cost, toBreak, toPlace))
  }

  // Jump up, down or forward over a 1 block gap
  getMoveParkourForward (node, dir, neighbors) {
    const block0 = this.getBlock(node, 0, -1, 0)
    const block1 = this.getBlock(node, dir.x, -1, dir.z)
    if ((block1.physical && block1.height >= block0.height) ||
      !this.getBlock(node, dir.x, 0, dir.z).safe ||
      !this.getBlock(node, dir.x, 1, dir.z).safe) return
    if (this.getBlock(node, 0, 0, 0).liquid) return // cant jump from water

    let cost = 1

    // Leaving entities at the ceiling level (along path) out for now because there are few cases where that will be important
    cost += this.getNumEntitiesAt(node, dir.x, 0, dir.z) * this.entityCost

    // If we have a block on the ceiling, we cannot jump but we can still fall
    let ceilingClear = this.getBlock(node, 0, 2, 0).safe && this.getBlock(node, dir.x, 2, dir.z).safe

    // Similarly for the down path.
    // Was `!getBlock(...).physical`, which is not the same question (upstream
    // issue #207). Lava is not physical and not safe, so `!physical` reported the
    // flight path as clear over lava and the down-parkour branch would happily
    // launch the bot into it. `.safe` excludes blocksToAvoid (lava, fire, cobweb)
    // while still allowing air, water and carpets.
    let floorCleared = this.getBlock(node, dir.x, -2, dir.z).safe

    const maxD = this.allowSprinting ? 4 : 2

    for (let d = 2; d <= maxD; d++) {
      const dx = dir.x * d
      const dz = dir.z * d
      const blockA = this.getBlock(node, dx, 2, dz)
      const blockB = this.getBlock(node, dx, 1, dz)
      const blockC = this.getBlock(node, dx, 0, dz)
      const blockD = this.getBlock(node, dx, -1, dz)
      const blockE = this.getBlock(node, dx, -2, dz)

      if (blockC.safe) cost += this.getNumEntitiesAt(blockC.position, 0, 0, 0) * this.entityCost

      if (ceilingClear && blockB.safe && blockC.safe && blockD.physical) {
        cost += this.exclusionStep(blockB)
        // Forward
        neighbors.push(new Move(blockC.position.x, blockC.position.y, blockC.position.z, node.remainingBlocks, cost, [], [], true))
        break
      } else if (ceilingClear && blockB.safe && blockC.physical) {
        // Up
        if (blockA.safe && d !== 4) { // 4 Blocks forward 1 block up is very difficult and fails often
          cost += this.exclusionStep(blockA)
          if (blockC.height - block0.height > 1.2) break // Too high to jump
          cost += this.getNumEntitiesAt(blockB.position, 0, 0, 0) * this.entityCost
          neighbors.push(new Move(blockB.position.x, blockB.position.y, blockB.position.z, node.remainingBlocks, cost, [], [], true))
          break
        }
      } else if ((ceilingClear || d === 2) && blockB.safe && blockC.safe && blockD.safe && floorCleared) {
        // Down
        if (blockE.physical) {
          cost += this.exclusionStep(blockD)
          cost += this.getNumEntitiesAt(blockD.position, 0, 0, 0) * this.entityCost
          neighbors.push(new Move(blockD.position.x, blockD.position.y, blockD.position.z, node.remainingBlocks, cost, [], [], true))
        }
      } else if (!blockB.safe || !blockC.safe) {
        break
      }

      // Both clearance flags track the whole flight path, so they must advance on
      // every iteration. floorCleared used to be updated only inside the "Down"
      // branch, so once any other branch was taken it froze at a stale value for
      // the rest of the scan.
      ceilingClear = ceilingClear && blockA.safe
      floorCleared = floorCleared && blockE.safe && !blockE.physical
    }
  }

  /**
   * True if the bot could get into a boat from here: it is carrying one to place, or
   * one is already floating within reach. Asked once per node rather than once per
   * direction, because the second half scans every loaded entity.
   * @param {import('vec3').Vec3} node
   * @returns {boolean}
   */
  hasBoatSource (node) {
    return !!this.getBoatItem() || !!this.getNearbyBoat(node, 6)
  }

  /**
   * What breaking the boat we just left and picking it up costs, in walking blocks, from the best tool
   * in the inventory. Cached for a second: it is asked for by every water node.
   * @returns {number}
   */
  getBoatRecycleCost () {
    if (!this.boatRecycle) return 0
    const now = performance.now()
    if (!this.recycleCostAt || now - this.recycleCostAt > 1000) {
      const plan = boatBreak.choose(this.bot.inventory.items(), { held: this.bot.heldItem })
      this.recycleCost = (plan.ticks + this.boatPickupTicks) / boatBreak.TICKS_PER_COST
      this.recycleCostAt = now
    }
    return this.recycleCost
  }

  /**
   * Land -> water. Emits a boat node on an adjacent surface-water cell, which is
   * the transition the executor turns into "place boat, mount, start steering".
   *
   * The shoreline is usually one block above the water surface, so both dy 0 and
   * dy -1 are considered.
   */
  getMoveBoatEmbark (node, dir, neighbors, hasBoat = this.hasBoatSource(node)) {
    // Need something to ride: an item to place, or a boat already floating there.
    if (!hasBoat) return

    for (const dy of [0, -1]) {
      if (!this.isBoatable(node, dir.x, dy, dir.z)) continue
      const cell = this.getBlock(node, dir.x, dy, dir.z)
      const cost = this.boatEmbarkCost + this.getNumEntitiesAt(cell.position, 0, 0, 0) * this.entityCost
      if (cost > 100) continue
      neighbors.push(new Move(cell.position.x, cell.position.y, cell.position.z, node.remainingBlocks, cost, [], [], false, true))
      // One embark per direction is enough; prefer the same-level cell.
      return
    }
  }

  /**
   * Water -> water. Flat-plane movement across the surface, cardinals and
   * diagonals. No jumping, digging, placing or dropping: a boat does none of
   * those, which conveniently sidesteps most of the walking move machinery.
   */
  getMoveBoatCruise (node, dir, neighbors, diagonal = false) {
    if (!this.isBoatable(node, dir.x, 0, dir.z)) return
    if (diagonal) {
      // Do not cut a corner the boat cannot physically fit through.
      if (!this.isBoatable(node, dir.x, 0, 0) || !this.isBoatable(node, 0, 0, dir.z)) return
    }
    const cell = this.getBlock(node, dir.x, 0, dir.z)
    let cost = this.boatCost * (diagonal ? Math.SQRT2 : 1)
    cost += this.getNumEntitiesAt(cell.position, 0, 0, 0) * this.entityCost
    if (cost > 100) return
    neighbors.push(new Move(cell.position.x, cell.position.y, cell.position.z, node.remainingBlocks, cost, [], [], false, true))
  }

  /**
   * Water -> land. Emits a walking node on an adjacent shore cell. Without an
   * explicit transition node A* would hop media implicitly and the executor would
   * stall at the shoreline still mounted.
   */
  getMoveBoatDisembark (node, dir, neighbors) {
    // Shore is typically level with, or one above, the water surface.
    for (const dy of [1, 0]) {
      const feet = this.getBlock(node, dir.x, dy, dir.z)
      const head = this.getBlock(node, dir.x, dy + 1, dir.z)
      const floor = this.getBlock(node, dir.x, dy - 1, dir.z)
      if (!feet.safe || !head.safe) continue
      if (!floor.physical) continue
      // Do not "disembark" back into water.
      if (feet.type === this.waterId) continue
      let cost = this.boatDisembarkCost + this.getBoatRecycleCost()
      cost += this.exclusionStep(feet)
      cost += this.getNumEntitiesAt(feet.position, 0, 0, 0) * this.entityCost
      if (cost > 100) continue
      neighbors.push(new Move(feet.position.x, feet.position.y, feet.position.z, node.remainingBlocks, cost, [], [], false, false))
      return
    }
  }

  /**
   * True if this move lands on a place the executor logged as somewhere it got
   * stuck (see bot.pathfinder.stuckPlaces in index.js) and that has not expired.
   * Planning through such a place just reproduces the stall, so it is left out
   * of the search until the entry times out.
   * @param {Move} move
   * @returns {boolean}
   */
  isStuckPlace (move) {
    const places = this.bot.pathfinder && this.bot.pathfinder.stuckPlaces
    if (!places || places.size === 0) return false
    const place = places.get(move.hash)
    if (!place) return false
    if (place.expires <= performance.now()) {
      places.delete(move.hash)
      return false
    }
    return true
  }

  // for each cardinal direction:
  // "." is head. "+" is feet and current location.
  // "#" is initial floor which is always solid. "a"-"u" are blocks to check
  //
  //   --0123-- horizontalOffset
  //  |
  // +2  aho
  // +1  .bip
  //  0  +cjq
  // -1  #dkr
  // -2   els
  // -3   fmt
  // -4   gn
  //  |
  //  dy

  getNeighbors (node) {
    let neighbors = this.generateNeighbors(node)
    const places = this.bot.pathfinder && this.bot.pathfinder.stuckPlaces
    if (places && places.size > 0) neighbors = neighbors.filter(move => !this.isStuckPlace(move))
    if (this.hostilesSeen && this.hostilesSeen.length > 0) {
      // Priced here, once, for every kind of move, rather than in each of the move generators.
      for (const move of neighbors) move.cost += hostiles.getDangerAt(this.dangerField, move.x, move.y, move.z)
    }
    return neighbors
  }

  generateNeighbors (node) {
    const neighbors = []

    // A node occupied in a boat has an entirely different move set - no walking,
    // jumping, digging or placing. Expanding it with the land moves below would
    // produce paths the executor cannot follow while mounted.
    if (this.allowBoating && node.boat) {
      for (const i in cardinalDirections) {
        const dir = cardinalDirections[i]
        this.getMoveBoatCruise(node, dir, neighbors)
        this.getMoveBoatDisembark(node, dir, neighbors)
      }
      for (const i in diagonalDirections) {
        this.getMoveBoatCruise(node, diagonalDirections[i], neighbors, true)
      }
      return neighbors
    }

    const canEmbark = this.allowBoating && this.hasBoatSource(node)

    // Simple moves in 4 cardinal points
    for (const i in cardinalDirections) {
      const dir = cardinalDirections[i]
      this.getMoveForward(node, dir, neighbors)
      this.getMoveJumpUp(node, dir, neighbors)
      this.getMoveDropDown(node, dir, neighbors)
      this.getMoveWaterBucketDropDown(node, dir, neighbors)
      if (this.allowParkour) {
        this.getMoveParkourForward(node, dir, neighbors)
      }
      if (canEmbark) {
        this.getMoveBoatEmbark(node, dir, neighbors, true)
      }
    }

    // Diagonals
    for (const i in diagonalDirections) {
      const dir = diagonalDirections[i]
      this.getMoveDiagonal(node, dir, neighbors)
    }

    this.getMoveDown(node, neighbors)
    this.getMoveWaterBucketDown(node, neighbors)
    this.getMoveUp(node, neighbors)

    return neighbors
  }
}

module.exports = Movements
