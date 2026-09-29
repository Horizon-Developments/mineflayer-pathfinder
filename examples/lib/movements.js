const { performance } = require('perf_hooks')
const { Vec3 } = require('vec3')
const nbt = require('prismarine-nbt')
const Move = require('./move')
const hostiles = require('./hostiles')

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
    // Diagonal counterpart to allowParkour: jump a 1-block gap at an outside
    // corner (see getMoveParkourDiagonal) instead of only walking or cutting
    // around it. Off by default like allowCornerCutting - a diagonal jump
    // grazes two corners instead of one, so the clipping risk is higher than
    // a straight parkour jump.
    this.allowParkourDiagonal = false

    // Vanilla player step height. Anything taller than this needs a jump, so a
    // plain walk move must never be generated across a larger rise.
    this.stepHeight = 0.6
    // Tallest rise a jump can clear. Matches the existing 1.2 checks in
    // getMoveJumpUp and getMoveDiagonal.
    this.maxJumpUp = 1.2

    // Vanilla: a fall of this many blocks or fewer deals no damage.
    this.maxFallDistanceNoDamage = 3
    // Cost added per block of fall distance beyond maxFallDistanceNoDamage,
    // modelling the fact that the extra blocks actually hurt. Kept above the
    // per-block walk cost (1) so a damaging drop only wins over a same-length
    // safe route when it also saves real distance, not merely because it's
    // reachable. Only applied to drops that land outside liquid - a liquid
    // landing takes no fall damage in vanilla, same assumption getLandingBlock
    // already makes when it returns a liquid block without consulting
    // maxDropDown at all.
    this.fallDamageCostPerBlock = 4

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
    // Fully-grown sweet berry bushes deal contact damage and slow the bot down
    // while pushing through, the same category of hazard as cobweb/fire - not
    // impassable, just somewhere routes shouldn't be planned through when a
    // way around exists. (Vanilla only damages/slows on the "grown" stage, but
    // this classification is per-block-type, not per-growth-state, so it
    // treats every stage the same - conservative, but growth-state-aware
    // costing would need block metadata this layer doesn't currently read.)
    if (registry.blocksByName.sweet_berry_bush) this.blocksToAvoid.add(registry.blocksByName.sweet_berry_bush.id)

    // Blocks that change what a fall onto them costs, for getFallDamageCost.
    // Vanilla: slime and honey blocks negate fall damage entirely (slime also
    // bounces, which this planner-level model does not attempt to represent -
    // see conventions-and-gotchas in CACHE.md); powder snow lets the bot sink
    // in gently, also with no damage. Hay bales cut fall damage rather than
    // negating it. Beds are a similar vanilla case (roughly half damage) but
    // are deliberately left out here: a bed is two block-halves (head/foot)
    // and landing on either half needs the block-state read this layer
    // doesn't currently do for anything else, so it's flagged rather than
    // guessed at - see CACHE.md open_items.
    this.fallDamageNegatingBlocks = new Set()
    if (registry.blocksByName.slime_block) this.fallDamageNegatingBlocks.add(registry.blocksByName.slime_block.id)
    if (registry.blocksByName.honey_block) this.fallDamageNegatingBlocks.add(registry.blocksByName.honey_block.id)
    if (registry.blocksByName.powder_snow) this.fallDamageNegatingBlocks.add(registry.blocksByName.powder_snow.id)
    this.fallDamageReducingBlocks = new Map()
    // Cuts damage to 20%, matching vanilla's 80% reduction. Block is named
    // hay_block pre-1.13-ish and hay_bale on newer registries; both guarded
    // since only one will exist on any given registry.
    if (registry.blocksByName.hay_block) this.fallDamageReducingBlocks.set(registry.blocksByName.hay_block.id, 0.2)
    if (registry.blocksByName.hay_bale) this.fallDamageReducingBlocks.set(registry.blocksByName.hay_bale.id, 0.2)

    // Ice family: walking across it is far faster than normal ground (vanilla
    // near-frictionless sliding). Modelled here purely as a cheaper move cost -
    // the same trick boatCost already uses to make water routes attractive -
    // so A* naturally prefers a built "ice highway" once crossing it is priced
    // as genuinely cheaper than walking, without needing a dedicated ice move
    // generator. Values fall as slipperiness rises (plain ice -> packed ice ->
    // blue ice), matching vanilla's relative friction ordering; the exact
    // numbers are a judgment call, not a derived physics constant.
    // Deliberately NOT modelled: momentum preservation while sliding, cornering,
    // braking, or overshoot risk - all of these are about *how* a slide plays
    // out tick-by-tick, which is execution-layer (the missing index.js-level
    // controller), the same call already made for sprinting/sneaking/momentum
    // in cluster #1. This planner only ever reasons in discrete cells.
    this.iceCostMultipliers = new Map()
    if (registry.blocksByName.ice) this.iceCostMultipliers.set(registry.blocksByName.ice.id, 0.7)
    if (registry.blocksByName.packed_ice) this.iceCostMultipliers.set(registry.blocksByName.packed_ice.id, 0.55)
    if (registry.blocksByName.blue_ice) this.iceCostMultipliers.set(registry.blocksByName.blue_ice.id, 0.4)

    // Soul sand alone slows a walking player in vanilla; soul soil looks
    // almost identical but does NOT slow movement - a common point of
    // confusion worth calling out explicitly since both get classified here
    // but only soul sand gets the cost penalty. soulSoilBlocks exists purely
    // for recognition/future use (e.g. nether-build or strider-path features)
    // and currently has no effect on cost.
    this.soulSandSlowdownBlocks = new Set()
    if (registry.blocksByName.soul_sand) this.soulSandSlowdownBlocks.add(registry.blocksByName.soul_sand.id)
    this.soulSandCostMultiplier = 1.5
    this.soulSoilBlocks = new Set()
    if (registry.blocksByName.soul_soil) this.soulSoilBlocks.add(registry.blocksByName.soul_soil.id)

    this.liquids = new Set()
    this.liquids.add(registry.blocksByName.water.id)
    this.liquids.add(registry.blocksByName.lava.id)
    // bubble_column is its own block (not water) but behaves as a liquid in
    // every way that matters here: it's swimmable, not walkable, applies fall
    // physics like water on landing, and can't be jumped/parkoured from. It
    // was previously missing from this set entirely, so every generic
    // liquid-handling check in this file (fall-damage-on-landing, walk-through
    // liquidCost, "can't jump from water", etc.) silently treated a bubble
    // column as solid/normal ground. Added here, alongside waterId/lavaId,
    // rather than only in the swim-specific checks below, so it's covered
    // everywhere `.liquid` is read, not just in getMoveSwimUp/Down.
    if (registry.blocksByName.bubble_column) this.liquids.add(registry.blocksByName.bubble_column.id)

    // Boating needs water specifically, not "any liquid" - riding into lava is
    // not a travel mode.
    this.waterId = registry.blocksByName.water.id

    // Vertical swimming (cluster #4). Off the same switch as the horizontal
    // in-water moves that getMoveForward/getMoveDiagonal already generate
    // (they add liquidCost but never refused a liquid destination outright),
    // so this is a new capability, not a cost tweak - hence its own allowX
    // flag, following the allowParkour/allowSprinting convention for "basic,
    // common, not risky" mechanics defaulting on. See getMoveSwimUp/Down for
    // what it actually enables and why it was missing before.
    this.allowSwimming = true
    this.swimCost = 1
    // Bubble columns (from a magma block = pushes up, or soul sand = pushes
    // down, placed under water) genuinely speed vertical swimming in vanilla,
    // so a cheaper cost nudges A* to route through one when available - same
    // idea as the ice discount. Direction IS read directly off the bubble
    // column block's own state, not off the source block at the bottom of
    // the column: bubble_column carries a boolean `drag` block-state property
    // (drag: false -> pushes up, drag: true -> pushes down/drags under), and
    // block.getProperties() (prismarine-block) exposes it the same way any
    // other block-state read would, same mechanism this file could always
    // have used but hadn't needed until now. A move that swims WITH the
    // column's push is discounted; a move that swims AGAINST it (fighting
    // the current) is penalized instead, since that's the actually-harder
    // vanilla case, not just a non-discounted default. If the running
    // registry's block objects don't expose getProperties() (older
    // protocol/version support), direction is simply unknown and the move
    // falls back to the flat swim cost - a graceful degrade, not a crash.
    this.bubbleColumnBlocks = new Set()
    if (registry.blocksByName.bubble_column) this.bubbleColumnBlocks.add(registry.blocksByName.bubble_column.id)
    this.bubbleColumnCostMultiplier = 0.6
    this.bubbleColumnOpposingCostMultiplier = 1.7

    // Every boat/raft variant, including the chest ones. Matched by name so this
    // keeps working as new wood types are added.
    this.boatItems = new Set()
    for (const item of registry.itemsArray) {
      if (BOAT_NAME.test(item.name)) this.boatItems.add(item.id)
    }

    this.gravityBlocks = new Set()
    this.gravityBlocks.add(registry.blocksByName.sand.id)
    this.gravityBlocks.add(registry.blocksByName.gravel.id)

    // Anything the bot can ascend/descend in place, the same way it does a
    // ladder: b.climbable (getBlock) feeds getMoveUp's "no need to place a
    // block, just go up" branch and getBlock's generic .safe computation
    // (safe = empty OR climbable OR carpet). Ladder is the only one that was
    // ever wired up; vines and scaffolding were previously not climbable at
    // all despite PROMPT.md asking for both.
    // Caveat, not verified against a running bot (see missing-dependencies in
    // CACHE.md): ladders occupy a thin slice against one face and vines hang
    // similarly, so both are reasonable fits for the existing .empty-ish
    // "safe to stand/pass through" treatment - but this is the same
    // *classification*, not identical collision geometry, and scaffolding in
    // particular also has fall-through behavior (dropping through it with
    // sneak) that this generic climbable flag does not model at all.
    this.climbables = new Set()
    this.climbables.add(registry.blocksByName.ladder.id)
    if (registry.blocksByName.vine) this.climbables.add(registry.blocksByName.vine.id)
    if (registry.blocksByName.weeping_vines) this.climbables.add(registry.blocksByName.weeping_vines.id)
    if (registry.blocksByName.weeping_vines_plant) this.climbables.add(registry.blocksByName.weeping_vines_plant.id)
    if (registry.blocksByName.twisting_vines) this.climbables.add(registry.blocksByName.twisting_vines.id)
    if (registry.blocksByName.twisting_vines_plant) this.climbables.add(registry.blocksByName.twisting_vines_plant.id)
    // Cave vines are what glow berries grow on (PROMPT.md's "glow berries" item)
    // and are climbable the same way regular vines are.
    if (registry.blocksByName.cave_vines) this.climbables.add(registry.blocksByName.cave_vines.id)
    if (registry.blocksByName.cave_vines_plant) this.climbables.add(registry.blocksByName.cave_vines_plant.id)
    // Real scaffolding block (distinct from this.scafoldingBlocks below, which
    // is a list of solid items the bot places to build up/across - a naming
    // collision, not the same feature). Was entirely unclassified before this
    // step: scaffolding was neither climbable nor anything else, so a bot
    // could not path up an existing scaffolding tower at all.
    if (registry.blocksByName.scaffolding) this.climbables.add(registry.blocksByName.scaffolding.id)
    // Cost of one controlled step down a climbable column (see getMoveClimbDown,
    // added step 6). Kept equal to the base walk cost of 1: descending a ladder
    // is not meaningfully faster or slower than walking, it is just the only
    // safe option when the alternative is a fall. Its own knob rather than a
    // bare literal so it can be tuned independently later, per this file's
    // existing convention for new move-specific costs.
    this.climbCost = 1
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

    this.entityIntersections = {}

    // Hostile mobs (lib/hostiles.js). They are detected from the registry, so nothing has to be listed
    // by hand (entitiesToAvoid still works, separately), and each one puts a cost around itself that
    // fades with distance, so routes keep away from it instead of merely not walking through it.
    this.avoidHostiles = true
    this.hostileScanRange = 24 // blocks from the bot: farther mobs are not worth planning around yet
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
        ...hostiles.profileFor(ent.name, this.hostileProfiles)
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
    if (!pos) {
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
    const x = pos.x + dx
    const y = pos.y + dy
    const z = pos.z + dz
    if (this._blockCache) {
      const key = `${x},${y},${z}`
      const cached = this._blockCache.get(key)
      if (cached) return cached
      const block = this._computeBlock(x, y, z, dy)
      this._blockCache.set(key, block)
      return block
    }
    return this._computeBlock(x, y, z, dy)
  }

  _computeBlock (x, y, z, dy) {
    const b = this.bot.blockAt(new Vec3(x, y, z), false)
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
    b.height = y
    b.canFall = this.gravityBlocks.has(b.type)
    b.openable = this.openable.has(b.type)
    // bubbleDrag: undefined = not a bubble column, or column found but
    // direction unreadable on this version. false = drag:false (pushes up).
    // true = drag:true (pushes/drags down). See constructor comment.
    b.bubbleDrag = undefined
    if (this.bubbleColumnBlocks.has(b.type)) {
      const props = typeof b.getProperties === 'function' ? b.getProperties() : b._properties
      if (props && typeof props.drag === 'boolean') b.bubbleDrag = props.drag
    }

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

  /**
   * Cost delta for walking across a surface block that is cheaper or more
   * expensive than plain ground: negative for ice (making the move cheaper,
   * so A* prefers it) and positive for soul sand (making it pricier). Scaled
   * by baseMoveCost (1 for a cardinal step, Math.SQRT2 for a diagonal) so the
   * adjustment only touches the "walking across this cell" portion of the
   * cost, not any dig/place/entity/exclusion cost added alongside it.
   * Returns 0 for any block that is neither - the common case - so call
   * sites can add this unconditionally.
   */
  getSurfaceCostDelta (block, baseMoveCost) {
    if (!block) return 0
    const iceMultiplier = this.iceCostMultipliers.get(block.type)
    if (iceMultiplier !== undefined) return baseMoveCost * (iceMultiplier - 1)
    if (this.soulSandSlowdownBlocks.has(block.type)) return baseMoveCost * (this.soulSandCostMultiplier - 1)
    return 0
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
    cost += this.getSurfaceCostDelta(blockD, 1) // ice is cheaper, soul sand pricier - see getSurfaceCostDelta
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
      // Ice/soul-sand surface adjustment - same reasoning as getMoveForward.
      // Only applied to this same-height branch (not the jump-up or
      // drop-down branches below): the diagonal's ice/soul-sand-relevant
      // floor is unambiguous here, whereas the other two branches land on a
      // block whose relationship to "the surface being walked across" is
      // less direct - left as base cost there rather than guessed at.
      cost += this.getSurfaceCostDelta(blockD, Math.SQRT2)
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

  /**
   * Cost penalty for landing on solid ground after falling `distance` blocks,
   * modelling vanilla fall damage: nothing up to maxFallDistanceNoDamage, then
   * a per-block cost standing in for the actual damage taken. A drop that
   * lands in liquid should never be passed through here - see the `!liquid`
   * guards at each call site and the comment on fallDamageCostPerBlock.
   *
   * landingBlock (added this step, optional for compatibility with any other
   * caller): the block actually landed on. When it's a fall-damage-negating
   * or -reducing block (slime, honey, powder snow, hay bale - see the Sets
   * built in the constructor) this is priced in exactly like the
   * maxFallDistanceNoDamage cutoff, letting the planner recognise "long drop
   * onto a hay bale" as cheap the same way it already recognises "short drop"
   * as cheap.
   */
  getFallDamageCost (distance, landingBlock) {
    if (distance <= this.maxFallDistanceNoDamage) return 0
    if (landingBlock && this.fallDamageNegatingBlocks.has(landingBlock.type)) return 0
    const multiplier = (landingBlock && this.fallDamageReducingBlocks.get(landingBlock.type)) ?? 1
    return (distance - this.maxFallDistanceNoDamage) * this.fallDamageCostPerBlock * multiplier
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
    if (!blockLand.liquid) cost += this.getFallDamageCost(node.y - blockLand.position.y, blockLand)

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
    if (!blockLand.liquid) cost += this.getFallDamageCost(node.y - blockLand.position.y, blockLand)

    neighbors.push(new Move(blockLand.position.x, blockLand.position.y, blockLand.position.z, node.remainingBlocks - toPlace.length, cost, toBreak, toPlace))
  }

  /**
   * Climb straight down a ladder/vine/scaffolding column, one cell at a time.
   * Counterpart to getMoveUp's existing `block1.climbable` branch, which already
   * lets the bot ascend such a column without placing blocks (see that method
   * and the climbables Set built in the constructor, cluster #2/step 3) - there
   * was previously no equivalent for descending. Without this, the only way
   * down from a climbable column was getMoveDown/getLandingBlock, which walks
   * straight past any climbable cells in between (they count as `safe`, i.e.
   * pass-through, same as air) all the way to solid ground and prices the
   * entire drop as one uncontrolled fall - even a ladder bolted the whole way
   * down got priced past maxFallDistanceNoDamage as if the bot had jumped off
   * the top and free-fallen.
   *
   * In vanilla, climbing down is fully controlled: no fall, no damage, one
   * block at a time. Firing whenever the destination cell is itself climbable
   * gives A* a cheap per-cell alternative that a real ladder/vine/scaffolding
   * column will win on cost against the fall-damage-priced getMoveDown move to
   * the same eventual floor. It also doubles as the vine/ladder/scaffolding
   * "catching" a fall that CACHE.md's cluster #6 (landing & MLG saves) asks
   * for: because this only ever resolves one cell down rather than searching
   * all the way to the ground the way getLandingBlock does, a bot partway down
   * a fall that reaches a climbable cell simply continues via this move
   * instead of the fall-damage one, capping the effective fall distance at
   * that point - the same real-world "grab the ladder" save, without a
   * separate MLG-specific code path.
   *
   * Deliberately NOT covered here (left for a future step, see CACHE.md
   * open_items): climbing down scaffolding specifically also supports a
   * sneak-to-fall-through shortcut in vanilla that skips the climb entirely;
   * that is a distinct move this generic climbable-cell treatment does not
   * attempt to model, same caveat already on record for scaffolding's
   * classification in the constructor.
   */
  getMoveClimbDown (node, neighbors) {
    const below = this.getBlock(node, 0, -1, 0)
    if (!below.climbable) return
    let cost = this.climbCost
    cost += this.exclusionStep(below)
    cost += this.getNumEntitiesAt(node, 0, -1, 0) * this.entityCost
    neighbors.push(new Move(node.x, node.y - 1, node.z, node.remainingBlocks, cost, [], []))
  }

  /**
   * Swim straight up through a water column. Before this step there was no
   * way to move vertically while submerged at all: getMoveUp refuses liquid
   * outright (`if (block1.liquid) return` - climbing/building logic doesn't
   * apply to a liquid cell), and getMoveDropDown/getMoveDown's liquid
   * handling only ever goes one way (falling/dropping INTO water from
   * above). Requires both the current cell and the cell above to already be
   * liquid - reaching the surface and climbing out onto land/a boat is
   * getMoveForward/getMoveDiagonal's job, not this one, so this deliberately
   * stops one cell short of dry land rather than trying to guess an exit.
   */
  getMoveSwimUp (node, neighbors) {
    if (!this.allowSwimming) return
    const current = this.getBlock(node, 0, 0, 0)
    // A bubble column is its own block type, not water, so this used to
    // reject the current/destination cell outright whenever either one was
    // actually a bubble column - meaning the bubbleDrag discount/penalty
    // logic just below could never run, and a bot could never swim through
    // or into a real bubble column at all. Both checks now accept water OR
    // bubble_column.
    if (current.type !== this.waterId && !this.bubbleColumnBlocks.has(current.type)) return
    const above = this.getBlock(node, 0, 1, 0)
    if (above.type !== this.waterId && !this.bubbleColumnBlocks.has(above.type)) return
    // drag:false pushes up (helps this move), drag:true drags down (fights
    // this move); undefined means not a bubble column, or direction unknown.
    let multiplier = 1
    if (this.bubbleColumnBlocks.has(above.type)) {
      if (above.bubbleDrag === false) multiplier = this.bubbleColumnCostMultiplier
      else if (above.bubbleDrag === true) multiplier = this.bubbleColumnOpposingCostMultiplier
    }
    let cost = this.swimCost * multiplier
    cost += this.exclusionStep(above)
    cost += this.getNumEntitiesAt(node, 0, 1, 0) * this.entityCost
    neighbors.push(new Move(node.x, node.y + 1, node.z, node.remainingBlocks, cost, [], []))
  }

  /**
   * Swim straight down through a water column - counterpart to
   * getMoveSwimUp, same reasoning. Stops one cell short of a solid floor or
   * the open air below a waterfall; getMoveDown/getMoveDropDown already
   * handle continuing past that point (walking off a ledge, dropping through
   * a hole, etc.), so this only fires while still fully submerged.
   */
  getMoveSwimDown (node, neighbors) {
    if (!this.allowSwimming) return
    const current = this.getBlock(node, 0, 0, 0)
    // Same fix as getMoveSwimUp: accept bubble_column as well as water, or
    // the bubbleDrag logic below is unreachable and a bot can never swim
    // through/into a real bubble column.
    if (current.type !== this.waterId && !this.bubbleColumnBlocks.has(current.type)) return
    const below = this.getBlock(node, 0, -1, 0)
    if (below.type !== this.waterId && !this.bubbleColumnBlocks.has(below.type)) return
    // drag:true drags down (helps this move), drag:false pushes up (fights
    // this move); undefined means not a bubble column, or direction unknown.
    let multiplier = 1
    if (this.bubbleColumnBlocks.has(below.type)) {
      if (below.bubbleDrag === true) multiplier = this.bubbleColumnCostMultiplier
      else if (below.bubbleDrag === false) multiplier = this.bubbleColumnOpposingCostMultiplier
    }
    let cost = this.swimCost * multiplier
    cost += this.exclusionStep(below)
    cost += this.getNumEntitiesAt(node, 0, -1, 0) * this.entityCost
    neighbors.push(new Move(node.x, node.y - 1, node.z, node.remainingBlocks, cost, [], []))
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
   * Diagonal counterpart to getMoveParkourForward: jump a 1-block gap at an
   * outside corner, landing 2 cells away along the diagonal, in cases where
   * getMoveDiagonal has no floor to land on partway across and would
   * otherwise force a walk-around via two cardinal moves.
   *
   * Deliberately only handles the flat, same-height case - no climbing or
   * dropping while also jumping a corner. Combining "up/down" with "diagonal"
   * would compound the corner-clipping risk that getMoveParkourForward's
   * cardinal-only up/down branches don't have to worry about; those stay a
   * plain walk-around instead of a jump.
   */
  getMoveParkourDiagonal (node, dir, neighbors) {
    if (this.getBlock(node, 0, 0, 0).liquid) return // cant jump from water

    const block0 = this.getBlock(node, 0, -1, 0)

    // If the first diagonal step already has a floor, this isn't a gap -
    // getMoveDiagonal (a walk, not a jump) already covers it.
    const gapFloor = this.getBlock(node, dir.x, -1, dir.z)
    if (gapFloor.physical) return

    // The two flanking cells the bot's hitbox sweeps past on the way across -
    // same corner-cutting reasoning as getMoveDiagonal. Jumping the gap still
    // collides with a solid corner, just in the air instead of on the ground.
    const blockB1 = this.getBlock(node, 0, 1, dir.z)
    const blockC1 = this.getBlock(node, 0, 0, dir.z)
    const blockB2 = this.getBlock(node, dir.x, 1, 0)
    const blockC2 = this.getBlock(node, dir.x, 0, 0)
    if (!this.allowCornerCutting && !(blockB1.safe && blockC1.safe && blockB2.safe && blockC2.safe)) return

    // Landing two cells out, at the same height as the start.
    const blockA = this.getBlock(node, dir.x * 2, 2, dir.z * 2)
    const blockB = this.getBlock(node, dir.x * 2, 1, dir.z * 2)
    const blockC = this.getBlock(node, dir.x * 2, 0, dir.z * 2)
    const blockD = this.getBlock(node, dir.x * 2, -1, dir.z * 2)
    if (!blockA.safe || !blockB.safe || !blockC.safe || !blockD.physical) return
    if (blockD.height - block0.height > 1.2) return // too high to jump

    let cost = Math.SQRT2 + 1 // diagonal move cost, plus a jump
    cost += this.exclusionStep(blockC)
    cost += this.getNumEntitiesAt(blockC.position, 0, 0, 0) * this.entityCost
    if (cost > 100) return

    neighbors.push(new Move(blockC.position.x, blockC.position.y, blockC.position.z, node.remainingBlocks, cost, [], [], true))
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
      let cost = this.boatDisembarkCost
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
    // Cleared per node: several generators re-fetch the same absolute block
    // (e.g. getMoveDown and getMoveClimbDown both fetch (node, 0, -1, 0)).
    // Scoping the cache to one generateNeighbors call avoids stale reuse
    // across nodes while still killing the redundant chunk lookups.
    this._blockCache = new Map()

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
      this._blockCache = null
      return neighbors
    }

    const canEmbark = this.allowBoating && this.hasBoatSource(node)

    // Simple moves in 4 cardinal points
    for (const i in cardinalDirections) {
      const dir = cardinalDirections[i]
      this.getMoveForward(node, dir, neighbors)
      this.getMoveJumpUp(node, dir, neighbors)
      this.getMoveDropDown(node, dir, neighbors)
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
      if (this.allowParkour && this.allowParkourDiagonal) {
        this.getMoveParkourDiagonal(node, dir, neighbors)
      }
    }

    this.getMoveDown(node, neighbors)
    this.getMoveClimbDown(node, neighbors)
    this.getMoveUp(node, neighbors)
    this.getMoveSwimUp(node, neighbors)
    this.getMoveSwimDown(node, neighbors)

    this._blockCache = null
    return neighbors
  }
}

module.exports = Movements
