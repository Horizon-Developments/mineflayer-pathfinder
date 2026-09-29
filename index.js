const { performance } = require('perf_hooks')

const AStar = require('./lib/astar')
const Move = require('./lib/move')
const Movements = require('./lib/movements')
const gotoUtil = require('./lib/goto')
const Lock = require('./lib/lock')
const BoatDriver = require('./lib/boat')
const { boatPlacementAim, watchDismount } = BoatDriver
const { snapshotHostiles, shouldReplanForHostiles } = require('./lib/hostiles')
const boatBreak = require('./lib/boatBreak')

const Vec3 = require('vec3').Vec3

const Physics = require('./lib/physics')
const nbt = require('prismarine-nbt')
const interactableBlocks = require('./lib/interactable.json')

function inject (bot) {
  const waterType = bot.registry.blocksByName.water.id
  const ladderId = bot.registry.blocksByName.ladder.id
  const vineId = bot.registry.blocksByName.vine.id
  let stateMovements = new Movements(bot)
  let stateGoal = null
  let astarContext = null
  let astartTimedout = false
  let dynamicGoal = false
  let path = []
  let pathUpdated = false
  let digging = false
  let placing = false
  let placingBlock = null
  let lastNodeTime = performance.now()
  // Bumped by resetPath() so a dig/equip/place chain still in flight when the goal changes
  // (e.g. the previous goal's placeBlock() promise hasn't resolved yet) can tell it is stale
  // and skip touching shared state (digging/placing/lastNodeTime/returningPos/locks) instead
  // of finishing "on top of" whatever the new goal has already started.
  let moveGeneration = 0
  // Where each hostile mob was when the current path was planned (lib/hostiles.js), so that one that has
  // moved into the way since, or appeared there, can be told apart from one the path already avoids.
  let plannedHostiles = new Map()
  let lastHostileCheck = 0
  let lastHostileReplan = 0
  let returningPos = null
  let stopPathing = false
  const physics = new Physics(bot)
  const lockPlaceBlock = new Lock()
  const lockEquipItem = new Lock()
  const lockUseBlock = new Lock()

  bot.pathfinder = {}

  bot.pathfinder.thinkTimeout = 5000 // ms
  bot.pathfinder.tickTimeout = 40 // ms, amount of thinking per tick (max 50 ms)
  // ms - ceiling for a search that hasn't made real progress yet (bestNode
  // still within 5 blocks of the start). Defaults to 2x thinkTimeout if not
  // set explicitly. See AStar's `failing` handling in lib/astar.js.
  bot.pathfinder.failureTimeout = bot.pathfinder.thinkTimeout * 2
  bot.pathfinder.searchRadius = -1 // in blocks, limits of the search area, -1: don't limit the search
  bot.pathfinder.enablePathShortcut = false // disabled by default as it can cause bugs in specific configurations
  bot.pathfinder.LOSWhenPlacingBlocks = true

  // Horizontal radius at which a node counts as reached. A single 0.35 for every
  // kind of move was too tight: after a jump or a drop the bot routinely lands on
  // the correct block but more than 0.35 off centre, never registers the arrival,
  // and keeps pressing forward into a node it cannot satisfy.
  bot.pathfinder.arrivalTolerance = 0.35
  bot.pathfinder.parkourArrivalTolerance = 0.5
  bot.pathfinder.boatArrivalTolerance = 1.2 // boats carry far more inertia

  // How long without reaching a node before the path is abandoned. Progress now
  // also refreshes this, so a legitimately slow traversal is not killed early.
  bot.pathfinder.stuckTimeout = 3500 // ms
  // Ticks spent with no executable move before forcing a repath. At 20 tps this
  // is ~0.75 s, far quicker than waiting out stuckTimeout while frozen.
  bot.pathfinder.maxStallTicks = 15
  // Rewrite bot.entity.position to recentre on the block when stopping. This is
  // client-side only and servers with movement checks will flag it, so it can be
  // turned off at the cost of slightly sloppier stops.
  bot.pathfinder.recenterOnStop = true
  // Minimum ms between path resets triggered by nearby block updates. Flowing
  // liquids and falling gravel near a path otherwise reset it every tick.
  bot.pathfinder.blockUpdateResetInterval = 250

  // Places the bot got stuck at. When a path is abandoned because the bot could
  // not make progress, the node it was heading for is logged here and the planner
  // refuses to route through it again until the entry expires. Without this every
  // retry replanned the identical path and stalled at the identical spot.
  //   key:   Move.hash of the node the bot could not reach
  //   value: { hash, reason, count, target, from, time, expires }
  bot.pathfinder.stuckPlaces = new Map()
  bot.pathfinder.stuckPlaceTTL = 30000 // ms a stuck place is avoided for
  bot.pathfinder.logStuckPlaces = true // console.warn each place as it is logged
  bot.pathfinder.clearStuckPlaces = () => bot.pathfinder.stuckPlaces.clear()

  // Boarding a boat. Every step of it waits on the server, so each has a bound;
  // running out of any of them abandons the attempt (and logs the stuck place)
  // instead of leaving the bot waiting on a packet that is never coming.
  bot.pathfinder.boatEmbarkTimeout = 15000 // ms, whole embark, watchdog
  bot.pathfinder.boatPlaceAttempts = 2 // times to use the boat item before giving up
  bot.pathfinder.boatSpawnTimeout = 1500 // ms for a placed boat to show up as an entity
  bot.pathfinder.boatMountAttempts = 3 // times to try mounting before giving up
  bot.pathfinder.boatMountTimeout = 1500 // ms to wait for the server to confirm a mount
  bot.pathfinder.boatMountRange = 3 // blocks; walk closer than this before trying to mount
  // Driving. A vanilla server does not move a boat a player is riding: the rider's
  // client simulates it and reports the result in vehicle_move packets, which is
  // what lib/boat.js does. bot.moveVehicle() alone only sends steering input, so
  // the boat sat still and every crossing ended as "stuck". Turn this off only for a
  // server that simulates player-driven boats itself.
  bot.pathfinder.boatDrive = true
  bot.pathfinder.boatMaxCorrections = 8 // server rejections within 2 s before the driver gives up
  bot.pathfinder.boatDismountRetry = 600 // ms after bot.dismount() before forcing the shift input
  bot.pathfinder.debugBoat = false // log the driver's state once a second while cruising
  // Breaking the boat after leaving it and picking it up again (Movements.boatRecycle).
  bot.pathfinder.boatBreakCrits = true // jump-crit when that needs fewer hits; dropped for good if a crit does not break it
  bot.pathfinder.boatBreakDamage = 40 // a boat breaks once its damage is above this; every hit adds 10 x its damage
  bot.pathfinder.boatAttackRange = 3 // blocks from the eye to the boat's centre; walk closer than this before hitting
  bot.pathfinder.boatBreakTimeout = 5000 // ms, hitting until the boat is gone
  bot.pathfinder.boatPickupRange = 5 // blocks in x and z around the boat in which its drop is looked for
  bot.pathfinder.boatPickupTimeout = 4000 // ms, walking to each drop
  // Water bucket clutch (MLG water bucket): placing before a long fall the plain
  // drop-down move won't take (see Movements.getWaterBucketDrop), then scooping
  // the water back up once down.
  bot.pathfinder.waterBucketTimeout = 5000 // ms, whole place-then-scoop attempt, watchdog per phase
  bot.pathfinder.waterBucketAimDelay = 100 // ms between look and activateItem, so the server has the new look before the click
  // Hostile mobs. Movements.avoidHostiles (on by default) puts a cost around each one; these decide when
  // a path that was planned around them is out of date.
  bot.pathfinder.hostileCheckInterval = 250 // ms between looks at where the hostile mobs are
  bot.pathfinder.hostileReplanCooldown = 1000 // ms between replans caused by them, so a chasing mob is not one per tick
  bot.pathfinder.hostileMoveThreshold = 1.5 // blocks a mob must have moved since the path was planned
  bot.pathfinder.hostileLookahead = 12 // how many of the coming steps count as "in the way"

  let stallTicks = 0
  let bestNodeDistance = Infinity
  let lastBlockUpdateReset = 0
  let boatTurnSign = 1
  let lastYawError = null
  let yawErrorGrowing = 0
  let mounting = false
  let dismounting = false
  let disembarking = false
  let disembarkStartedAt = 0
  // Water bucket clutch state (see the dispatch in monitorMovement and
  // placeWaterBucket/scoopWaterBucket below).
  let wbcPlacing = false
  let wbcScooping = false
  let wbcStartedAt = 0
  // Position of a water block this placed and has not scooped back up yet, or
  // null. Deliberately dropped (not retried) on resetPath - see resetPath below -
  // so an abandoned goal does not send the bot back to tidy up a fall from an
  // objective it is no longer pursuing; the water is just left there.
  let wbcPendingScoop = null
  // Bumped on every path reset, same purpose as boatGeneration just below but for
  // the water-bucket-clutch awaits specifically: a place/scoop mid-flight checks
  // this and quietly drops out if the path it was started for no longer exists.
  let wbcGeneration = 0
  // Bumped on every path reset. An embark that is mid-way through its awaits checks
  // it and quietly drops out if the path it was started for no longer exists.
  let boatGeneration = 0
  let embarkStartedAt = 0
  let embarkNode = null // the boat node the current embark is for
  let recycling = false // breaking the boat just left and picking it up; the path waits
  let recycleId = 0
  let ownedBoatId = null // the boat this bot placed itself: the only one it breaks
  let critsWork = true
  const lockBoat = new Lock()
  const boatDriver = new BoatDriver(bot, bot.pathfinder)
  bot.pathfinder.boatDriver = boatDriver
  // mineflayer does not notice when a vanilla server takes the bot out of a boat, so bot.vehicle stays
  // set and 'dismount' never fires. See watchDismount().
  watchDismount(bot)
  /** Trace for lib/movelog.js: where an embark or dismount attempt went wrong. */
  const boatStep = (text) => bot.emit('boat_step', text)
  const wbcStep = (text) => bot.emit('water_bucket_step', text)

  bot.pathfinder.bestHarvestTool = (block) => {
    const availableTools = bot.inventory.items()
    const effects = bot.entity.effects

    let fastest = Number.MAX_VALUE
    let bestTool = null
    for (const tool of availableTools) {
      const enchants = (tool && tool.nbt) ? nbt.simplify(tool.nbt).Enchantments : []
      const digTime = block.digTime(tool ? tool.type : null, false, false, false, enchants, effects)
      if (digTime < fastest) {
        fastest = digTime
        bestTool = tool
      }
    }

    return bestTool
  }

  bot.pathfinder.getPathTo = (movements, goal, timeout) => {
    const generator = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { timeout })
    const { value: { result, astarContext: context } } = generator.next()
    astarContext = context
    return result
  }

  bot.pathfinder.getPathFromTo = function * (movements, startPos, goal, options = {}) {
    const optimizePath = options.optimizePath ?? true
    const resetEntityIntersects = options.resetEntityIntersects ?? true
    const timeout = options.timeout ?? bot.pathfinder.thinkTimeout
    const tickTimeout = options.tickTimeout ?? bot.pathfinder.tickTimeout
    const failureTimeout = options.failureTimeout ?? bot.pathfinder.failureTimeout
    const searchRadius = options.searchRadius ?? bot.pathfinder.searchRadius
    let start
    if (options.startMove) {
      start = options.startMove
    } else {
      const p = startPos.floored()
      const dy = startPos.y - p.y
      const b = bot.blockAt(p) // The block we are standing in
      // Offset the floored bot position by one if we are standing on a block that has not the full height but is solid
      const offset = (b && dy > 0.001 && bot.entity.onGround && !stateMovements.emptyBlocks.has(b.type)) ? 1 : 0
      start = new Move(p.x, p.y + offset, p.z, movements.countScaffoldingItems(), 0)
      // Replanning while afloat has to start from the boat, not from the water cell
      // the boat happens to occupy: a walking node there has swimming neighbours and
      // no way to keep cruising, so the new path would abandon the boat.
      if (movements.allowBoating && bot.vehicle && movements.isBoatEntity(bot.vehicle)) {
        const v = bot.vehicle.position.floored()
        start = new Move(v.x, v.y, v.z, movements.countScaffoldingItems(), 0, [], [], false, true)
      }
    }
    if (movements.allowEntityDetection) {
      if (resetEntityIntersects) {
        movements.clearCollisionIndex()
      }
      movements.updateCollisionIndex()
      // The path about to be planned is priced with the hostiles where they are now.
      plannedHostiles = snapshotHostiles(movements.hostilesSeen)
    }
    const astarContext = new AStar(start, movements, goal, timeout, tickTimeout, searchRadius, failureTimeout)
    let result = astarContext.compute()
    if (optimizePath) result.path = postProcessPath(result.path)
    yield { result, astarContext }
    while (result.status === 'partial') {
      result = astarContext.compute()
      if (optimizePath) result.path = postProcessPath(result.path)
      yield { result, astarContext }
    }
  }

  Object.defineProperties(bot.pathfinder, {
    goal: {
      get () {
        return stateGoal
      }
    },
    movements: {
      get () {
        return stateMovements
      }
    }
  })

  function detectDiggingStopped () {
    digging = false
    bot.removeAllListeners('diggingAborted', detectDiggingStopped)
    bot.removeAllListeners('diggingCompleted', detectDiggingStopped)
  }

  // Reasons for abandoning a path that mean "the bot could not get to path[0]".
  // Replanning after these would otherwise produce the same path, so the node is
  // logged and avoided. Resets that are not the bot's fault (goal moved, blocks
  // changed, chunk loaded, ...) are deliberately not in here.
  const stuckReasons = new Set([
    'stuck', // no progress towards the node within stuckTimeout
    'stuck_no_move', // no executable move for the node
    'no_boat', // planned a boat embark but nothing was there to ride
    'boat_place_error', // the boat never appeared after using the item
    'boat_mount_failed', // the server never confirmed the mount
    'boat_rejected', // the server kept putting the boat back where it was
    'boat_dismount_failed', // the server never let the bot out of the boat
    'water_bucket_error' // couldn't place or scoop the water-bucket clutch: see placeWaterBucket/scoopWaterBucket
  ])

  /**
   * Log the node the bot could not reach, so the planner steers around it. Defaults
   * to path[0]; a boat embark passes the node it actually tried, because a long
   * partial search can swap `path` for a refined one while the embark is in flight.
   */
  function recordStuckPlace (reason, node) {
    const target = node || path[0]
    if (!target || !target.hash) return
    const places = bot.pathfinder.stuckPlaces
    const now = performance.now()
    for (const [hash, place] of places) {
      if (place.expires <= now) places.delete(hash)
    }
    const previous = places.get(target.hash)
    const from = (bot.vehicle && bot.vehicle.position ? bot.vehicle : bot.entity).position.clone()
    const place = {
      hash: target.hash, // the planner's key for this node (before path optimisation moved it)
      reason,
      count: previous ? previous.count + 1 : 1,
      target: new Vec3(target.x, target.y, target.z),
      from,
      time: now,
      expires: now + bot.pathfinder.stuckPlaceTTL
    }
    places.set(target.hash, place)
    bot.emit('stuck_place', place)
    if (bot.pathfinder.logStuckPlaces) {
      const at = [from.x, from.y, from.z].map(v => v.toFixed(1)).join(', ')
      console.warn(`[pathfinder] stuck (${reason}) at ${at} heading for node ${target.hash}; ` +
        `avoiding it for ${Math.round(bot.pathfinder.stuckPlaceTTL / 1000)}s (seen ${place.count}x)`)
    }
  }

  // A goal that is reached proves the map is traversable again, so forget the
  // places that were being routed around.
  bot.on('goal_reached', () => bot.pathfinder.stuckPlaces.clear())

  function resetPath (reason, clearStates = true, stuckNode = null) {
    if (recycling && (reason === 'goal_updated' || reason === 'movements_updated' || stopPathing)) recycling = false
    if (stuckReasons.has(reason)) recordStuckPlace(reason, stuckNode)
    if (!stopPathing && path.length > 0) bot.emit('path_reset', reason)
    moveGeneration++
    path = []
    if (digging) {
      bot.on('diggingAborted', detectDiggingStopped)
      bot.on('diggingCompleted', detectDiggingStopped)
      bot.stopDigging()
    }
    placing = false
    pathUpdated = false
    astarContext = null
    stallTicks = 0
    bestNodeDistance = Infinity
    lastYawError = null
    yawErrorGrowing = 0
    lockEquipItem.release()
    lockPlaceBlock.release()
    lockUseBlock.release()
    lockBoat.release()
    // 'mounting' was never cleared here, so one mount the server ignored left it
    // true for good and every later embark returned immediately.
    mounting = false
    dismounting = false
    disembarking = false
    disembarkStartedAt = 0
    // Neutral steering, but keep the driver going: a replan in mid-crossing (a block
    // update, a chunk loading) must not stop the boat dead, it just coasts until the
    // new path steers it again.
    boatDriver.setInput(0, 0)
    boatGeneration++
    wbcPlacing = false
    wbcScooping = false
    wbcStartedAt = 0
    wbcPendingScoop = null
    wbcGeneration++
    stateMovements.clearCollisionIndex()
    if (clearStates) bot.clearControlStates()
    if (stopPathing) return stop()
  }

  bot.pathfinder.setGoal = (goal, dynamic = false) => {
    stateGoal = goal
    dynamicGoal = dynamic
    bot.emit('goal_updated', goal, dynamic)
    resetPath('goal_updated')
  }

  bot.pathfinder.setMovements = (movements) => {
    stateMovements = movements
    resetPath('movements_updated')
  }

  bot.pathfinder.isMoving = () => path.length > 0
  bot.pathfinder.isMining = () => digging
  bot.pathfinder.isBuilding = () => placing

  bot.pathfinder.goto = (goal) => {
    return gotoUtil(bot, goal)
  }

  bot.pathfinder.stop = () => {
    // Nothing is running, so there is nothing to stop; the flag would otherwise survive until the
    // next goal and stop that one instead.
    if (!stateGoal && path.length === 0) return
    stopPathing = true
  }

  // mineflayer stops emitting 'physicsTick' while the bot is mounted: its physics
  // plugin sets shouldUsePhysics = false on 'mount' and only turns it back on at
  // the next clientbound position packet. monitorMovement is driven by that
  // event, so without the fallback loop below the executor freezes the moment
  // the bot boards a boat: no steering, no dismount, and no stuck timeout either.
  let lastPhysicsTick = 0
  let vehicleTicker = null
  let vehicleTickerGraceUntil = 0

  bot.on('physicsTick', () => {
    lastPhysicsTick = performance.now()
    monitorMovement()
  })

  function startVehicleTicker () {
    vehicleTickerGraceUntil = Infinity
    if (vehicleTicker) return
    vehicleTicker = setInterval(() => {
      const physicsRunning = performance.now() - lastPhysicsTick < 75
      // Once dismounted, hand the loop back as soon as mineflayer's physics is
      // ticking again, or after a short grace period if it never resumes.
      if (!bot.vehicle && (physicsRunning || performance.now() > vehicleTickerGraceUntil)) {
        stopVehicleTicker()
        return
      }
      // If mineflayer's own loop is still ticking it already drives
      // monitorMovement; do not run it twice per tick.
      if (!physicsRunning) monitorMovement()
      // The boat is simulated here whether or not mineflayer's loop is running, and
      // after monitorMovement so it steps with the input that was just chosen.
      boatDriver.step()
    }, 50)
  }

  function stopVehicleTicker () {
    clearInterval(vehicleTicker)
    vehicleTicker = null
  }

  bot.on('end', stopVehicleTicker)

  function postProcessPath (path) {
    for (let i = 0; i < path.length; i++) {
      const curPoint = path[i]
      // A useOne (open a gate/door on the way through) is a click, not a placement:
      // it must not stop the pass, or this node and every one after it keep their
      // raw corner coordinates and the executor steers into the frame
      if (curPoint.toBreak.length > 0 || curPoint.toPlace.some(p => !p.useOne)) break
      const b = bot.blockAt(new Vec3(curPoint.x, curPoint.y, curPoint.z))
      // An openable block is a doorway: its node is the floor centre. getPositionOnTopOf
      // would put it on top of the swung-open leaf (offset ~0.9 and a block up), which
      // the walk simulation can never reach — the bot stands in the open doorway until 'stuck'
      const doorway = stateMovements && stateMovements.openable && b && stateMovements.openable.has(b.type)
      if (b && (b.type === waterType || doorway || ((b.type === ladderId || b.type === vineId) && i + 1 < path.length && path[i + 1].y < curPoint.y))) {
        curPoint.x = Math.floor(curPoint.x) + 0.5
        curPoint.y = Math.floor(curPoint.y)
        curPoint.z = Math.floor(curPoint.z) + 0.5
        continue
      }
      let np = getPositionOnTopOf(b)
      if (np === null) np = getPositionOnTopOf(bot.blockAt(new Vec3(curPoint.x, curPoint.y - 1, curPoint.z)))
      if (np) {
        curPoint.x = np.x
        curPoint.y = np.y
        curPoint.z = np.z
      } else {
        curPoint.x = Math.floor(curPoint.x) + 0.5
        curPoint.y = curPoint.y - 1
        curPoint.z = Math.floor(curPoint.z) + 0.5
      }
    }

    if (!bot.pathfinder.enablePathShortcut || stateMovements.exclusionAreasStep.length !== 0 || path.length === 0) return path

    const newPath = []
    let lastNode = bot.entity.position
    for (let i = 1; i < path.length; i++) {
      const node = path[i]
      if (Math.abs(node.y - lastNode.y) > 0.5 || node.toBreak.length > 0 || node.toPlace.length > 0 || !physics.canStraightLineBetween(lastNode, node)) {
        newPath.push(path[i - 1])
        lastNode = path[i - 1]
      }
    }
    newPath.push(path[path.length - 1])
    return newPath
  }

  // Where the bot effectively is: the boat while riding one. bot.entity.position is
  // left at the boarding point by mineflayer, so anything that measured from it
  // while afloat measured from the shore.
  function currentPosition () {
    return (bot.vehicle && bot.vehicle.position) ? bot.vehicle.position : bot.entity.position
  }

  function pathFromPlayer (path) {
    if (path.length === 0) return
    const here = currentPosition()
    let minI = 0
    let minDistance = 1000
    for (let i = 0; i < path.length; i++) {
      const node = path[i]
      if (node.toBreak.length !== 0 || node.toPlace.length !== 0) break
      const dist = here.distanceSquared(node)
      if (dist < minDistance) {
        minDistance = dist
        minI = i
      }
    }
    // check if we are between 2 nodes
    const n1 = path[minI]
    // check if node already reached
    const dx = n1.x - here.x
    const dy = n1.y - here.y
    const dz = n1.z - here.z
    const reached = Math.abs(dx) <= 0.35 && Math.abs(dz) <= 0.35 && Math.abs(dy) < 1
    if (minI + 1 < path.length && n1.toBreak.length === 0 && n1.toPlace.length === 0) {
      const n2 = path[minI + 1]
      const d2 = here.distanceSquared(n2)
      const d12 = n1.distanceSquared(n2)
      minI += d12 > d2 || reached ? 1 : 0
    }

    path.splice(0, minI)
  }

  function isPositionNearPath (pos, path) {
    let prevNode = null
    for (const node of path) {
      let comparisonPoint = null
      if (
        prevNode === null ||
        (
          Math.abs(prevNode.x - node.x) <= 2 &&
          Math.abs(prevNode.y - node.y) <= 2 &&
          Math.abs(prevNode.z - node.z) <= 2
        )
      ) {
        // Unoptimized path, or close enough to last point
        // to just check against the current point
        comparisonPoint = node
      } else {
        // Optimized path - the points are far enough apart
        //   that we need to check the space between them too

        // First, a quick check - if point it outside the path
        // segment's AABB, then it isn't near.
        const minBound = prevNode.min(node)
        const maxBound = prevNode.max(node)
        if (
          pos.x - 0.5 < minBound.x - 1 ||
          pos.x - 0.5 > maxBound.x + 1 ||
          pos.y - 0.5 < minBound.y - 2 ||
          pos.y - 0.5 > maxBound.y + 2 ||
          pos.z - 0.5 < minBound.z - 1 ||
          pos.z - 0.5 > maxBound.z + 1
        ) {
          continue
        }

        comparisonPoint = closestPointOnLineSegment(pos, prevNode, node)
      }

      const dx = Math.abs(comparisonPoint.x - pos.x - 0.5)
      const dy = Math.abs(comparisonPoint.y - pos.y - 0.5)
      const dz = Math.abs(comparisonPoint.z - pos.z - 0.5)
      if (dx <= 1 && dy <= 2 && dz <= 1) return true

      prevNode = node
    }

    return false
  }

  function closestPointOnLineSegment (point, segmentStart, segmentEnd) {
    const segmentLength = segmentEnd.minus(segmentStart).norm()

    if (segmentLength === 0) {
      return segmentStart
    }

    // t is like an interpolation from segmentStart to segmentEnd
    //  for the closest point on the line
    let t = (point.minus(segmentStart)).dot(segmentEnd.minus(segmentStart)) / segmentLength

    // bound t to be on the segment
    t = Math.max(0, Math.min(1, t))

    return segmentStart.plus(segmentEnd.minus(segmentStart).scaled(t))
  }

  // Return the average x/z position of the highest standing positions
  // in the block.
  function getPositionOnTopOf (block) {
    if (!block || block.shapes.length === 0) return null
    const p = new Vec3(0.5, 0, 0.5)
    let n = 1
    for (const shape of block.shapes) {
      const h = shape[4]
      if (h === p.y) {
        p.x += (shape[0] + shape[3]) / 2
        p.z += (shape[2] + shape[5]) / 2
        n++
      } else if (h > p.y) {
        n = 2
        p.x = 0.5 + (shape[0] + shape[3]) / 2
        p.y = h
        p.z = 0.5 + (shape[2] + shape[5]) / 2
      }
    }
    p.x /= n
    p.z /= n
    return block.position.plus(p)
  }

  /**
   * Stop the bot's movement and recenter to the center off the block when the bot's hitbox is partially beyond the
   * current blocks dimensions.
   */
  function fullStop () {
    bot.clearControlStates()

    if (!bot.pathfinder.recenterOnStop) return

    // Force horizontal velocity to 0 (otherwise inertia can move us too far).
    // This rewrites client-side state the server did not ask for; anticheat and
    // strict movement validation will notice, which is why it is now optional.
    bot.entity.velocity.x = 0
    bot.entity.velocity.z = 0

    const blockX = Math.floor(bot.entity.position.x) + 0.5
    const blockZ = Math.floor(bot.entity.position.z) + 0.5

    // Make sure our bounding box don't collide with neighboring blocks
    // otherwise recenter the position
    if (Math.abs(bot.entity.position.x - blockX) > 0.2) { bot.entity.position.x = blockX }
    if (Math.abs(bot.entity.position.z - blockZ) > 0.2) { bot.entity.position.z = blockZ }
  }

  function moveToEdge (refBlock, edge) {
    // If allowed turn instantly should maybe be a bot option
    const allowInstantTurn = false
    function getViewVector (pitch, yaw) {
      const csPitch = Math.cos(pitch)
      const snPitch = Math.sin(pitch)
      const csYaw = Math.cos(yaw)
      const snYaw = Math.sin(yaw)
      return new Vec3(-snYaw * csPitch, snPitch, -csYaw * csPitch)
    }
    // Target viewing direction while approaching edge
    // The Bot approaches the edge while looking in the opposite direction from where it needs to go
    // The target Pitch angle is roughly the angle the bot has to look down for when it is in the position
    // to place the next block
    const targetBlockPos = refBlock.offset(edge.x + 0.5, edge.y, edge.z + 0.5)
    const targetPosDelta = bot.entity.position.clone().subtract(targetBlockPos)
    const targetYaw = Math.atan2(-targetPosDelta.x, -targetPosDelta.z)
    const targetPitch = -1.421
    const viewVector = getViewVector(targetPitch, targetYaw)
    // While the bot is not in the right position rotate the view and press back while crouching
    if (bot.entity.position.distanceTo(refBlock.clone().offset(edge.x + 0.5, 1, edge.z + 0.5)) > 0.4) {
      bot.lookAt(bot.entity.position.offset(viewVector.x, viewVector.y, viewVector.z), allowInstantTurn)
      bot.setControlState('sneak', true)
      bot.setControlState('back', true)
      return false
    }
    bot.setControlState('back', false)
    return true
  }

  function moveToBlock (pos) {
    // minDistanceSq = Min distance sqrt to the target pos were the bot is centered enough to place blocks around him
    const minDistanceSq = 0.2 * 0.2
    const targetPos = pos.clone().offset(0.5, 0, 0.5)
    if (bot.entity.position.distanceSquared(targetPos) > minDistanceSq) {
      bot.lookAt(targetPos)
      bot.setControlState('forward', true)
      return false
    }
    bot.setControlState('forward', false)
    return true
  }

  function stop () {
    recycling = false
    stopPathing = false
    stateGoal = null
    path = []
    bot.emit('path_stop')
    fullStop()
  }

  bot.on('mount', () => {
    mounting = false
    lockBoat.release()
    lastNodeTime = performance.now()
    // Not engaged yet: the driver starts reporting the boat only once the executor
    // actually steers it, so sitting in one never contradicts a server that moves
    // it by itself.
    if (bot.pathfinder.boatDrive && bot.vehicle && stateMovements.isBoatEntity(bot.vehicle)) {
      boatDriver.attach(bot.vehicle, { engaged: false })
    }
    startVehicleTicker()
  })

  bot.on('boat_driver_disabled', () => {
    if (path.length > 0) resetPath('boat_rejected')
  })

  bot.on('dismount', (vehicle) => {
    boatDriver.detach()
    dismounting = false
    disembarking = false
    disembarkStartedAt = 0
    lockBoat.release()
    lastNodeTime = performance.now()
    vehicleTickerGraceUntil = performance.now() + 2000
    const boat = vehicle && vehicle.id === ownedBoatId ? vehicle : null
    ownedBoatId = null
    if (boat && stateMovements.boatRecycle && !['creative', 'spectator'].includes(bot.game && bot.game.gameMode)) startRecycle(boat)
  })

  function wrapAngle (a) {
    while (a > Math.PI) a -= Math.PI * 2
    while (a < -Math.PI) a += Math.PI * 2
    return a
  }

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

  /**
   * Poll until predicate() is truthy and return its value, or return false on
   * timeout or as soon as stillValid() says the caller has been superseded.
   */
  async function waitFor (predicate, timeout, stillValid) {
    const end = performance.now() + timeout
    while (performance.now() < end) {
      if (!stillValid()) return false
      const value = predicate()
      if (value) return value
      await sleep(50)
    }
    return stillValid() ? predicate() : false
  }

  /**
   * Get into a boat on the target water cell: reuse one already floating there if
   * possible, otherwise place one from the inventory. Returns true once mounted.
   *
   * Any boat counts - see Movements.isBoatEntity(). The work is asynchronous; this
   * just starts it and reports "not yet" until bot.vehicle is set.
   */
  function embark (targetNode) {
    if (bot.vehicle) return true
    if (mounting) {
      // Watchdog. Every step of the attempt is awaited and a server that ignores a
      // packet leaves the wait open forever; without this the bot sat here for good.
      if (performance.now() - embarkStartedAt > bot.pathfinder.boatEmbarkTimeout) {
        resetPath('boat_mount_failed', true, embarkNode)
      }
      return false
    }

    const waterPos = new Vec3(Math.floor(targetNode.x), Math.floor(targetNode.y), Math.floor(targetNode.z))
    if (!stateMovements.getNearbyBoat(waterPos.offset(0.5, 0, 0.5), 3) && !stateMovements.getBoatItem()) {
      resetPath('no_boat', true, targetNode)
      return false
    }
    if (!lockBoat.tryAcquire()) return false
    mounting = true
    embarkStartedAt = performance.now()
    embarkNode = targetNode
    const generation = boatGeneration
    runEmbark(targetNode, waterPos, generation).catch(() => {
      if (generation === boatGeneration) resetPath('boat_place_error', true, targetNode)
    })
    return false
  }

  async function runEmbark (targetNode, waterPos, generation) {
    const pf = bot.pathfinder
    const valid = () => generation === boatGeneration
    const center = waterPos.offset(0.5, 0, 0.5)

    // 1. A boat already floating there, or place one.
    let boat = stateMovements.getNearbyBoat(center, 3)
    const reused = !!boat
    let ranOutOfBoats = false

    // Never place from inside the water itself - a player places a boat by reaching out over the
    // water from the bank, not by wading into it first. The path should already have the bot on the
    // land node here; this is a defensive backstop for whatever got it wet anyway (tolerance overshoot,
    // a reused goal, current pushing it) so placement never happens while the bot is in the water.
    const ensureOnLand = async () => {
      if (!bot.entity.isInWater) return true
      const landSpot = landSpotNear({ position: waterPos }, Math.max(pf.boatMountRange, 4))
      if (!landSpot) {
        boatStep('no dry ground near this water cell; placing the boat from the water')
        return true
      }
      boatStep(`stepping back onto dry ground at ${landSpot} before placing the boat`)
      await waitFor(() => {
        const p = bot.entity.position
        if (Math.hypot(landSpot.x - p.x, landSpot.z - p.z) <= 0.5 && !bot.entity.isInWater) return true
        Promise.resolve(bot.lookAt(landSpot, true)).catch(() => {})
        bot.setControlState('forward', true)
        bot.setControlState('jump', !!bot.entity.isInWater)
        return false
      }, 2500, valid)
      bot.clearControlStates()
      return valid()
    }

    // On ice the bot keeps sliding after it stops walking (about 1.5 blocks from walking speed), which
    // carries it off the bank and into the very water it is about to put the boat on - and a boat
    // cannot be placed from inside the water. So brake first: push back until it is no longer moving
    // forward. Only forward speed counts, so on ordinary ground (which stops in a tick or two) this
    // is a no-op and never reverses the bot.
    const brake = async () => {
      const forwardSpeed = () => {
        const v = bot.entity.velocity
        const yaw = bot.entity.yaw
        if (!v || !Number.isFinite(yaw)) return 0
        return -v.x * Math.sin(yaw) - v.z * Math.cos(yaw)
      }
      if (bot.entity.isInWater || forwardSpeed() <= 0.03) return
      boatStep(`braking from forward speed ${forwardSpeed().toFixed(3)} before placing the boat`)
      await waitFor(() => {
        if (bot.entity.isInWater || forwardSpeed() <= 0.03) return true
        bot.setControlState('forward', false)
        bot.setControlState('back', true)
        return false
      }, 1000, valid)
      bot.clearControlStates()
    }
    if (!boat) {
      await brake()
      if (!valid()) return
    }
    if (!boat && !(await ensureOnLand())) return

    for (let attempt = 0; !boat && attempt < pf.boatPlaceAttempts; attempt++) {
      if (attempt > 0 && !(await ensureOnLand())) return
      const item = stateMovements.getBoatItem()
      if (!item) {
        ranOutOfBoats = true
        break
      }
      bot.clearControlStates()
      await bot.equip(item, 'hand')
      if (!valid()) return
      // Aim at the water surface (a source block tops out ~0.9 up), not the air above the cell, so
      // the placement ray ends on the water - and far enough from the bot that the boat does not
      // spawn overlapping it, which the server refuses without a word.
      const isSurfaceWaterAt = (x, z) => {
        const dx = Math.floor(x) - waterPos.x
        const dz = Math.floor(z) - waterPos.z
        const feet = bot.blockAt(waterPos.offset(dx, 0, dz))
        const head = bot.blockAt(waterPos.offset(dx, 1, dz))
        return !!feet && feet.type === stateMovements.waterId && !!head && head.type !== stateMovements.waterId
      }
      const aim = boatPlacementAim(bot.entity.position, waterPos, isSurfaceWaterAt, { yaw: bot.entity.yaw })
      boatStep(`place attempt ${attempt + 1}: bot at ${bot.entity.position}, water cell ${waterPos}, aiming at (${aim.x.toFixed(2)}, ${aim.y.toFixed(2)}, ${aim.z.toFixed(2)})`)
      await bot.lookAt(new Vec3(aim.x, aim.y, aim.z), true)
      if (!valid()) return
      // The new rotation only reaches the server with the next movement packet. Using
      // the item straight away places the boat where the bot was looking a tick ago.
      await sleep(100)
      if (!valid()) return
      await bot.activateItem()
      // The entity shows up a little later, by an amount that depends on latency.
      boat = await waitFor(() => stateMovements.getNearbyBoat(center, 4), pf.boatSpawnTimeout, valid)
      if (!valid()) return
      boatStep(boat ? `boat appeared at ${boat.position}` : `no boat appeared within ${pf.boatSpawnTimeout} ms of using the item`)
    }
    if (!boat) {
      resetPath(ranOutOfBoats ? 'no_boat' : 'boat_place_error', true, targetNode)
      return
    }
    ownedBoatId = reused ? null : boat.id

    // 2. Servers only accept the interaction from close by. A boat that came to rest
    // a few blocks out is walked up to first rather than "mounted" into the void.
    const inRange = () => bot.entity.position.distanceTo(boat.position) <= pf.boatMountRange
    if (!inRange()) {
      await waitFor(() => {
        if (inRange()) return true
        Promise.resolve(bot.lookAt(boat.position, true)).catch(() => {})
        bot.setControlState('forward', true)
        bot.setControlState('jump', !!bot.entity.isInWater)
        return false
      }, 3000, valid)
      bot.clearControlStates()
      if (!valid()) return
    }

    // 3. Mount, and wait for the server to say it happened. mineflayer only reports
    // a mount on the server's confirmation, and a request that is out of range or
    // ignored produces no reply at all - so a bounded retry, then give up.
    for (let attempt = 0; attempt < pf.boatMountAttempts; attempt++) {
      boat = stateMovements.getNearbyBoat(center, 4) || boat
      await bot.lookAt(boat.position.offset(0, 0.5, 0), true)
      if (!valid()) return
      boatStep(`mount attempt ${attempt + 1}: boat at ${boat.position}, bot at ${bot.entity.position}`)
      bot.mount(boat)
      if (await waitFor(() => bot.vehicle, pf.boatMountTimeout, valid)) return // the 'mount' event finishes the job
      if (!valid()) return
    }
    resetPath('boat_mount_failed', true, targetNode)
  }

  /**
   * Turn the boat toward a target point and paddle, without touching any of the
   * per-path progress bookkeeping (bestNodeDistance / lastNodeTime / stuckTimeout)
   * that steerBoat's caller maintains - this runs outside of following a planned
   * leg, as a last-resort recovery, not as a path node.
   */
  function steerBoatToward (target) {
    const vehicle = bot.vehicle
    if (!vehicle) return
    const dx = target.x - vehicle.position.x
    const dz = target.z - vehicle.position.z
    const desiredYaw = Math.atan2(-dx, -dz)
    const yawError = wrapAngle(desiredYaw - vehicle.yaw)
    const turn = Math.abs(yawError) < 0.1 ? 0 : (yawError > 0 ? boatTurnSign : -boatTurnSign)
    const forward = Math.abs(yawError) < Math.PI / 2 ? 1 : 0
    if (boatDriver.active) {
      boatDriver.engage()
      boatDriver.setInput(turn, forward)
    } else {
      bot.moveVehicle(turn, forward)
    }
  }

  /**
   * Leave the boat. Returns true once the bot is back on foot, false while a
   * dismount attempt (possibly including paddling to dry ground first, see
   * runDisembark) is in flight or hasn't started yet.
   *
   * This has two call sites: one polls it every tick while riding a boat toward
   * a non-boat node, the other calls it exactly once when the path runs out
   * while still mounted. runDisembark is therefore self-driving (its own
   * sleep()-paced loop, like runEmbark) rather than relying on being called
   * again to make progress - the once-only call site would otherwise never
   * advance past its first "not yet".
   */
  function disembark () {
    if (!bot.vehicle) {
      disembarkStartedAt = 0
      return true
    }
    // Watchdog: a dismount the server never honours must not leave the bot waiting
    // here for good, with no stuck timer running while it does. Checked on every
    // call, even while runDisembark is already in flight, so the polling call
    // site still catches a hang the once-only call site's single call cannot.
    if (!disembarkStartedAt) disembarkStartedAt = performance.now()
    if (performance.now() - disembarkStartedAt > bot.pathfinder.boatEmbarkTimeout) {
      disembarkStartedAt = 0
      disembarking = false
      resetPath('boat_dismount_failed')
      return false
    }
    if (dismounting || disembarking) return false
    disembarking = true
    const generation = boatGeneration
    runDisembark(generation).catch(() => {}).finally(() => { disembarking = false })
    return false
  }

  /**
   * Steer to dry ground if currently in water, then dismount. Runs to completion
   * (or gives up) on its own via sleep()-paced polling; the caller does not need
   * to invoke it again.
   *
   * Never let the rider out over water. getMoveBoatDisembark only ever plans a
   * disembark node on dry land, but disembark() above is also the fallback used
   * wherever the bot is still mounted when a path ends or resets, and the boat
   * can then be drifting over open water. Dismounting there puts the rider on top of
   * the boat, which mineflayer does not collide with, and the rider falls
   * straight through into the pond - what actually stranded the bot in the
   * ice_water live test. So: steer to the nearest dry or ice spot first, and
   * only give up and dismount over water once time is almost out - being
   * briefly stuck mounted is recoverable, dismounting into water was not.
   */
  async function runDisembark (generation) {
    const valid = () => generation === boatGeneration && !!bot.vehicle
    const pf = bot.pathfinder
    const deadline = disembarkStartedAt + pf.boatEmbarkTimeout - 500 // leave time for the dismount itself
    const overWater = () => {
      const v = bot.vehicle
      if (!v) return false
      const cell = new Vec3(Math.floor(v.position.x), Math.floor(v.position.y), Math.floor(v.position.z))
      return !!bot.entity.isInWater || !!stateMovements.getBlock(cell, 0, 0, 0).liquid
    }
    // Dismounting puts the rider on the boat's roof unless a side is free, and from the roof the bot
    // falls into the hitbox, so only let go once dry ground is right next to the boat.
    const besideLand = (spot) => !!spot && Math.hypot(spot.x - bot.vehicle.position.x, spot.z - bot.vehicle.position.z) <= 1.7
    const startedInWater = overWater()
    while (overWater()) {
      if (!valid()) return
      const landSpot = performance.now() < deadline ? landSpotNear(bot.vehicle, Math.max(pf.boatMountRange, 6)) : null
      if (!landSpot) {
        boatStep(performance.now() < deadline ? 'no dry ground within range; dismounting over water anyway' : 'out of time steering to dry ground; dismounting over water anyway')
        break
      }
      if (besideLand(landSpot)) break
      steerBoatToward(landSpot)
      await sleep(50)
      if (!valid()) return
    }
    boatDriver.setInput(0, 0)
    if (!valid()) return
    if (startedInWater && !overWater()) boatStep('reached dry ground before dismounting')
    else if (startedInWater) boatStep('dismounting beside dry ground')
    if (!lockBoat.tryAcquire()) return
    dismounting = true
    boatStep(`dismount requested at ${bot.vehicle.position}`)
    try {
      const result = bot.dismount()
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch (e) { /* not riding after all */ }
    // Whether bot.dismount() reaches the server depends on the mineflayer version: the
    // server only ever lets go of a rider on the shift key, and some versions send
    // something it never reads. If it has not worked shortly after, press shift.
    setTimeout(() => {
      if (dismounting && bot.vehicle) {
        const sent = boatDriver.sendShift(true)
        boatStep(sent ? 'bot.dismount() did not take effect; pressed shift directly' : 'bot.dismount() did not take effect and no shift packet could be built')
        if (sent) setTimeout(() => boatDriver.sendShift(false), 150)
      }
    }, bot.pathfinder.boatDismountRetry)
    // Safety net: if the server never confirms, unblock rather than hang forever.
    setTimeout(() => {
      if (dismounting) {
        dismounting = false
        lockBoat.release()
      }
    }, 1000)
  }

  /**
   * Place a water bucket to cushion a long fall (see getMoveWaterBucketDown /
   * getMoveWaterBucketDropDown in movements.js). Returns true once placed, or
   * once giving up - either way the node then counts as ready to walk off the
   * edge for; giving up just means falling unprotected rather than getting
   * stuck here for good over one bad bucket use. False while still in flight.
   */
  function placeWaterBucket (targetNode) {
    if (targetNode.waterBucketPlaced) return true
    if (wbcPlacing) return false
    if (!wbcStartedAt) wbcStartedAt = performance.now()
    if (performance.now() - wbcStartedAt > bot.pathfinder.waterBucketTimeout) {
      wbcStartedAt = 0
      targetNode.waterBucketPlaced = true
      wbcStep('gave up placing the water bucket in time; falling unprotected')
      return true
    }
    wbcPlacing = true
    const generation = wbcGeneration
    runPlaceWaterBucket(targetNode, generation).catch(() => {}).finally(() => { wbcPlacing = false })
    return false
  }

  async function runPlaceWaterBucket (targetNode, generation) {
    const valid = () => generation === wbcGeneration
    const item = stateMovements && stateMovements.getWaterBucketItem()
    if (!item) {
      // The planner already checked this before offering the move, but the
      // inventory can change between planning and walking (the bucket used
      // elsewhere, dropped, ...).
      wbcStep('no water bucket in inventory; falling unprotected')
      targetNode.waterBucketPlaced = true
      return
    }
    // targetNode's own coordinates are the landing cell (see getWaterBucketDrop):
    // the empty air the bot lands standing in, one above the solid floor it
    // clicks on to place the water.
    const landingPos = new Vec3(targetNode.x, targetNode.y, targetNode.z)
    // The tick that just brought the bot to this node may still be holding
    // 'forward' from walking here; left alone that would carry the bot off the
    // edge (or just off the spot) while it is still trying to aim, mirroring why
    // embark() does the same before its own equip/aim/click sequence.
    bot.clearControlStates()
    if (!lockEquipItem.tryAcquire()) return
    try {
      await bot.equip(item, 'hand')
    } finally {
      lockEquipItem.release()
    }
    if (!valid()) return
    // Aim at the top face of the floor block the water will sit on (the bottom of
    // the landing cell itself) - clear line of sight the whole way down is
    // guaranteed by getWaterBucketLandingBlock, which only ever returns a landing
    // whose column back up to the takeoff point is open air.
    try {
      await bot.lookAt(landingPos.offset(0.5, 0, 0.5), true)
    } catch (e) { /* still try the click - close enough is fine */ }
    if (!valid()) return
    // The new rotation only reaches the server with the next movement packet.
    // Using the item straight away places the water where the bot was looking a
    // tick ago.
    await sleep(bot.pathfinder.waterBucketAimDelay)
    if (!valid()) return
    wbcStep(`placing water at ${landingPos}`)
    try {
      await bot.activateItem()
    } catch (e) { /* fall through - the wait below will simply time out */ }
    const remaining = Math.max(500, wbcStartedAt + bot.pathfinder.waterBucketTimeout - performance.now())
    const placed = await waitFor(() => {
      const block = bot.blockAt(landingPos)
      return !!block && block.type === stateMovements.waterId
    }, remaining, valid)
    if (!valid()) return
    if (placed) {
      wbcStep(`water placed at ${landingPos}`)
      wbcPendingScoop = landingPos
    } else {
      wbcStep(`water bucket use did not produce water at ${landingPos}; falling unprotected`)
    }
    targetNode.waterBucketPlaced = true
    // Free the watchdog timer for the scoop phase, which starts fresh once the
    // bot has landed - reusing the place phase's start time here would leave it
    // almost no budget for a fall that took any real time to land.
    wbcStartedAt = 0
  }

  /**
   * Scoop a water-bucket-clutch placement (wbcPendingScoop) back up. Returns
   * true once done (scooped, or given up and left it), false while still in
   * flight - gates moving on to the next path node exactly like disembark(),
   * for the same reason: aiming at the water needs the look control that the
   * normal walk-toward-the-next-node logic would otherwise fight for.
   */
  function scoopWaterBucket () {
    if (!wbcPendingScoop) return true
    if (wbcScooping) return false
    if (!wbcStartedAt) wbcStartedAt = performance.now()
    if (performance.now() - wbcStartedAt > bot.pathfinder.waterBucketTimeout) {
      wbcStartedAt = 0
      wbcStep('gave up scooping the water bucket in time; leaving the water')
      wbcPendingScoop = null
      return true
    }
    wbcScooping = true
    const generation = wbcGeneration
    const pos = wbcPendingScoop
    runScoopWaterBucket(pos, generation).catch(() => {}).finally(() => { wbcScooping = false })
    return false
  }

  async function runScoopWaterBucket (pos, generation) {
    const valid = () => generation === wbcGeneration && wbcPendingScoop && wbcPendingScoop.equals(pos)
    bot.clearControlStates()
    // The bucket used to place this water is now an empty bucket in the same
    // inventory slot (using a water bucket empties it in place); either that or
    // a separate empty bucket works to scoop the water back into a full one.
    const item = stateMovements && stateMovements.getEmptyBucketItem()
    if (!item) {
      wbcStep(`no empty bucket to scoop the water at ${pos}; leaving it`)
      wbcPendingScoop = null
      return
    }
    if (!lockEquipItem.tryAcquire()) return
    try {
      await bot.equip(item, 'hand')
    } finally {
      lockEquipItem.release()
    }
    if (!valid()) return
    try {
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true)
    } catch (e) { /* still try the click - close enough is fine */ }
    if (!valid()) return
    await sleep(bot.pathfinder.waterBucketAimDelay)
    if (!valid()) return
    wbcStep(`scooping water at ${pos}`)
    try {
      await bot.activateItem()
    } catch (e) { /* fall through - the wait below will simply time out */ }
    const remaining = Math.max(500, wbcStartedAt + bot.pathfinder.waterBucketTimeout - performance.now())
    const scooped = await waitFor(() => {
      const block = bot.blockAt(pos)
      return !block || block.type !== stateMovements.waterId
    }, remaining, valid)
    if (!valid()) return
    wbcStep(scooped ? `water scooped at ${pos}` : `water bucket use did not clear the water at ${pos}; leaving it`)
    wbcStartedAt = 0
    wbcPendingScoop = null
  }

  /** Resolve after n physics ticks, or n * 50 + 250 ms if the ticks stop coming. */
  function waitTicks (n, valid = () => true) {
    return new Promise(resolve => {
      if (n <= 0) return resolve()
      let left = n
      const done = () => {
        bot.removeListener('physicsTick', onTick)
        clearTimeout(timer)
        resolve()
      }
      const onTick = () => {
        if (--left <= 0 || !valid()) done()
      }
      const timer = setTimeout(done, n * 50 + 250)
      bot.on('physicsTick', onTick)
    })
  }

  const isItemEntity = (e) => String(e.name || '').toLowerCase() === 'item' || e.objectType === 'Item'

  function droppedItemType (e) {
    try {
      const stack = e.getDroppedItem && e.getDroppedItem()
      return stack ? stack.type : null
    } catch (err) {
      return null
    }
  }

  /**
   * A dry, standable block near the boat, close enough to also attack it from - so a jump-crit is
   * physically possible there. Boats sit on water, and a crit can never land while the bot is in water,
   * so hunting for shore is what makes boatBreakCrits do anything at all; without it every "crit" plan
   * is a crit that can't happen. Returns the closest candidate, or null if the boat is stranded with no
   * shore in reach.
   */
  function landSpotNear (boat, range) {
    const bx = Math.floor(boat.position.x)
    const by = Math.floor(boat.position.y)
    const bz = Math.floor(boat.position.z)
    const base = new Vec3(bx, by, bz)
    let best = null
    let bestDist = Infinity
    for (let dx = -range; dx <= range; dx++) {
      for (let dz = -range; dz <= range; dz++) {
        const dist = Math.hypot(bx + dx + 0.5 - boat.position.x, bz + dz + 0.5 - boat.position.z)
        if (dist > range) continue
        for (const dy of [0, -1, 1]) {
          const feet = stateMovements.getBlock(base, dx, dy, dz)
          const head = stateMovements.getBlock(base, dx, dy + 1, dz)
          const below = stateMovements.getBlock(base, dx, dy - 1, dz)
          if (!feet.safe || feet.liquid || !head.safe || head.liquid || !below.physical || below.liquid) continue
          if (dist < bestDist) {
            best = new Vec3(bx + dx + 0.5, by + dy, bz + dz + 0.5)
            bestDist = dist
          }
          break
        }
      }
    }
    return best
  }

  const isOnIce = () => {
    const b = bot.blockAt(bot.entity.position.offset(0, -0.5, 0))
    return !!b && /ice/.test(b.name)
  }
  const horizontalSpeed = () => Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z)

  /**
   * Walk to a spot without overshooting: ice keeps the bot sliding (about 1.5 blocks), so near the target
   * on ice stop pushing and brake with back instead of holding forward until inside the tolerance.
   */
  function walkToward (spot, tolerance = 0.5) {
    const p = bot.entity.position
    const dist = Math.hypot(spot.x - p.x, spot.z - p.z)
    if (bot.entity.isInWater) {
      Promise.resolve(bot.lookAt(spot, true)).catch(() => {})
      bot.setControlState('back', false)
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      return false
    }
    if (isOnIce()) {
      const speed = horizontalSpeed()
      if (dist <= tolerance && speed < 0.03) return true
      if (dist < 1.6 + speed * 6) {
        bot.setControlState('forward', false)
        bot.setControlState('jump', false)
        bot.setControlState('back', speed > 0.04 && dist < 1.0 + speed * 6)
        return speed < 0.02 && dist < 1.6
      }
    } else if (dist <= tolerance) return true
    Promise.resolve(bot.lookAt(spot, true)).catch(() => {})
    bot.setControlState('back', false)
    bot.setControlState('jump', false)
    bot.setControlState('forward', true)
    return false
  }

  /**
   * After a dismount the server can put the rider on top of the boat (its hitbox top is 0.5625 above its
   * position). mineflayer has no entity collision, so the bot falls into the hitbox and the server
   * silently teleports it back forever. Jump off sideways toward land instead (the server accepts an
   * upward move, and once clear of the hitbox the fall is fine), then brake if that put it on ice.
   */
  async function escapeBoatTop (boat, valid) {
    const onTop = () => {
      const b = bot.entities[boat.id]
      if (!b) return false
      const p = bot.entity.position
      return Math.abs(p.x - b.position.x) < 1.0 && Math.abs(p.z - b.position.z) < 1.0 && p.y > b.position.y + 0.3 && p.y < b.position.y + 1.2
    }
    await sleep(250)
    if (!valid() || !onTop()) return
    const spot = landSpotNear(boat, 4)
    boatStep(`standing on top of the boat; jumping off toward ${spot || 'nearest side'}`)
    const force = () => { if (onTop()) bot.entity.onGround = true }
    bot.on('physicsTick', force)
    try {
      await waitFor(() => {
        if (!bot.entities[boat.id] || !onTop()) return true
        if (spot) Promise.resolve(bot.lookAt(spot, true)).catch(() => {})
        bot.setControlState('forward', true)
        bot.setControlState('jump', true)
        return false
      }, 2000, valid)
    } finally {
      bot.removeListener('physicsTick', force)
      bot.clearControlStates()
    }
    // Brake: leaving the boat toward ice must not slide the bot into the pond on the far side.
    await waitFor(() => {
      if (bot.entity.isInWater || horizontalSpeed() < 0.03) return true
      bot.setControlState('forward', false)
      bot.setControlState('back', true)
      return false
    }, 1000, valid)
    bot.clearControlStates()
  }

  /** Jump and wait until the bot is falling: that is when a hit is a critical one. */
  async function jumpUntilFalling (valid) {
    bot.setControlState('sprint', false)
    bot.setControlState('jump', true)
    await waitTicks(1, valid)
    bot.setControlState('jump', false)
    for (let i = 0; i < 20 && valid(); i++) {
      if (!bot.entity.onGround && bot.entity.velocity.y < 0) return true
      await waitTicks(1, valid)
    }
    return false
  }

  function startRecycle (boat) {
    const id = ++recycleId
    recycling = true
    recycleBoat(boat, () => recycling && id === recycleId)
      .catch(() => {})
      .then(() => {
        // A new goal already ended this recycle and owns the path now.
        if (id !== recycleId || !recycling) return
        recycling = false
        bot.clearControlStates()
        resetPath('boat_recycled', false)
      })
  }

  /**
   * Break the boat the bot just left and pick up what it drops, so the boat can be placed again. Hits
   * until the boat entity is gone, so the plan from lib/boatBreak.js only chooses the tool and whether
   * to jump for crits; a plan that turns out wrong costs a few more hits.
   */
  async function recycleBoat (boat, valid) {
    const pf = bot.pathfinder
    const alive = () => !!bot.entities[boat.id]
    if (!alive()) return
    const before = new Set(Object.values(bot.entities).filter(isItemEntity).map(e => e.id))
    const eye = () => bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
    await escapeBoatTop(boat, valid)
    if (!valid() || !alive()) return

    // A jump-crit needs the bot out of the water - a crit can never land while swimming - and a boat
    // sits on water by definition, so wading straight out to it (the old approach) makes every "crit"
    // plan one that can never actually happen. Look for shore first, and walk there, before planning.
    if (pf.boatBreakCrits && critsWork) {
      const landSpot = landSpotNear(boat, Math.max(pf.boatAttackRange, 4))
      if (landSpot) {
        boatStep(`walking to dry ground at ${landSpot} to jump-crit the boat`)
        await waitFor(() => {
          if (!alive()) return true
          return walkToward(landSpot, 0.5)
        }, 3000, valid)
        bot.clearControlStates()
        if (!valid()) return
      } else {
        boatStep('no dry ground near this boat; breaking it without crits')
      }
    }

    // Only plan for crits once we actually know the bot made it out of the water - not just because
    // boatBreakCrits is on. That mismatch (planning a crit that water then made impossible) was what
    // silently under-counted the damage needed and left the boat standing.
    const canCrit = pf.boatBreakCrits && critsWork && !bot.entity.isInWater
    const plan = boatBreak.choose(bot.inventory.items(), { held: bot.heldItem, crits: canCrit, threshold: pf.boatBreakDamage })
    boatStep(`recycle: ${plan.name || 'fist'}${plan.crit ? ' with crits' : ''}, ${plan.hits} hit(s), about ${plan.ticks} ticks`)

    const held = bot.heldItem
    if (plan.item) {
      if (!held || held.name !== plan.item.name) await bot.equip(plan.item, 'hand')
    } else if (held && boatBreak.attackStats(held.name).tool) {
      await bot.unequip('hand')
    }
    if (!valid()) return

    if (eye().distanceTo(boat.position) > pf.boatAttackRange) {
      await waitFor(() => {
        if (eye().distanceTo(boat.position) <= pf.boatAttackRange || !alive()) return true
        Promise.resolve(bot.lookAt(boat.position, true)).catch(() => {})
        bot.setControlState('forward', true)
        return false
      }, 2500, valid)
      bot.clearControlStates()
      if (!valid()) return
    }

    // Switching the held item resets the attack cooldown, and a hit before it is over is a weak one.
    let ticks = 0
    const onTick = () => ticks++
    bot.on('physicsTick', onTick)
    let crit = plan.crit
    let hits = 0
    let landedRealCrit = false
    let totalDamage = 0
    let nextHitAt = plan.first
    const maxHits = boatBreak.hitsToBreak(1, { threshold: pf.boatBreakDamage }) + 2
    const started = performance.now()
    try {
      // Keep hitting until the boat is really gone (bounded): hits landed inside the attack cooldown deal
      // less than planned, so the planned damage total being reached does not mean the boat broke.
      while (valid() && alive() && hits < maxHits + 8 && performance.now() - started < pf.boatBreakTimeout) {
        await bot.lookAt(boat.position.offset(0, 0.3, 0), true)
        let jumped = false
        if (crit && !bot.entity.isInWater) {
          await waitTicks(nextHitAt - ticks - 7, valid)
          jumped = await jumpUntilFalling(valid)
        }
        await waitTicks(nextHitAt - ticks, valid)
        if (!valid() || !alive()) break
        // Whether this specific hit really was a crit, from the bot's actual physics state right now -
        // not just because a crit was the plan. Trusting the plan instead of reality is exactly what
        // let a "crit" get claimed from inside the water, where it silently never happened, and left
        // the loop thinking it had dealt more damage than the boat actually took.
        const didCrit = crit && jumped && !bot.entity.isInWater && !bot.entity.onGround && bot.entity.velocity.y < 0
        bot.attack(boat)
        hits++
        totalDamage += boatBreak.damageOf(plan.item ? plan.item.name : null, didCrit)
        if (didCrit) landedRealCrit = true
        nextHitAt = ticks + (crit ? Math.max(plan.cooldown, boatBreak.CRIT_CYCLE_TICKS) : plan.cooldown)
        // The destroy packet comes a few ticks after the hit.
        if (await waitFor(() => !alive(), 150, valid)) break
        if (crit && hits >= plan.hits && totalDamage <= pf.boatBreakDamage && hits < maxHits) {
          if (!landedRealCrit) {
            // Never actually landed a crit (still couldn't get clear of the water) - a fact about this
            // boat's spot, not about crits in general, so finish it out plainly rather than giving up
            // on crits everywhere from now on.
            boatStep('could not land a real crit here; finishing without crits')
          } else {
            // A genuine crit landed and it still was not enough - the damage assumption itself is off,
            // so stop planning crits for good rather than repeat the same shortfall on every boat.
            critsWork = false
            boatStep('a crit did not break the boat; hitting without crits from now on')
          }
          crit = false
        }
      }
    } finally {
      bot.removeListener('physicsTick', onTick)
    }
    if (!valid()) return
    if (alive()) {
      boatStep(`the boat is still there after ${hits} hit(s)`)
      bot.emit('boat_recycle_failed', { hits, recovered: 0 })
      return
    }

    // The drop appears where the boat was: look for what is new within pickupRange of it.
    const range = pf.boatPickupRange
    const at = boat.position.clone()
    const findDrops = () => Object.values(bot.entities).filter(e => {
      if (!isItemEntity(e) || before.has(e.id)) return false
      if (Math.abs(e.position.x - at.x) > range || Math.abs(e.position.z - at.z) > range || Math.abs(e.position.y - at.y) > 3) return false
      const type = droppedItemType(e)
      return type === null || stateMovements.boatItems.has(type)
    })
    const drops = await waitFor(() => {
      const found = findDrops()
      return found.length > 0 && found
    }, 1000, valid)
    if (!drops) {
      if (valid()) bot.emit('boat_recycle_failed', { hits, recovered: 0 })
      return
    }

    let recovered = 0
    for (const drop of drops) {
      const got = await waitFor(() => {
        if (!bot.entities[drop.id]) return true
        Promise.resolve(bot.lookAt(drop.position, true)).catch(() => {})
        const p = bot.entity.position
        bot.setControlState('forward', Math.hypot(drop.position.x - p.x, drop.position.z - p.z) > 0.35)
        bot.setControlState('jump', !!bot.entity.isInWater || drop.position.y > p.y + 0.7)
        return false
      }, pf.boatPickupTimeout, valid)
      if (!valid()) return
      bot.clearControlStates()
      if (got) recovered++
    }
    bot.emit(recovered > 0 ? 'boat_recycled' : 'boat_recycle_failed', { hits, recovered })
  }

  /**
   * Steer the boat toward the next node.
   *
   * Boats are not steered by look direction - since 1.9 they rotate from the
   * sideways steer input and accelerate from the forward one. The yaw sign
   * convention for vehicle entities varies between versions, so rather than
   * hard-coding it the controller watches whether turning is actually reducing
   * the heading error and flips the sign if it is not.
   */
  function steerBoat (nextPoint) {
    const vehicle = bot.vehicle
    // Normally attached by the 'mount' handler; this covers a mount that was already
    // in place when the pathfinder was loaded, or an event ordering that missed it.
    if (bot.pathfinder.boatDrive && boatDriver.vehicle !== vehicle && stateMovements.isBoatEntity(vehicle)) {
      boatDriver.attach(vehicle, { engaged: false })
    }
    // postProcessPath has already moved a water node to the middle of its cell, so
    // adding 0.5 here aimed every leg half a block south-east of where it should go
    // and steadily pulled the boat into whatever bank was on that side. Flooring
    // first gives the centre for both an optimised and a raw node.
    const dx = Math.floor(nextPoint.x) + 0.5 - vehicle.position.x
    const dz = Math.floor(nextPoint.z) + 0.5 - vehicle.position.z

    const desiredYaw = Math.atan2(-dx, -dz)
    const yawError = wrapAngle(desiredYaw - vehicle.yaw)
    const absError = Math.abs(yawError)

    // The sign guess below exists only for the legacy path, where the game turns the
    // boat and its convention was unknown. The driver turns it itself, in a convention
    // it owns, so there is nothing to guess and a false "diverging" reading (an
    // overshoot while the turn rate unwinds) must not flip a correct sign.
    const driven = boatDriver.active
    if (!driven && lastYawError !== null && absError > Math.abs(lastYawError) + 0.01) {
      yawErrorGrowing++
      // Sustained divergence while actively turning means the sign is inverted
      // for this server/version. Flip it once and reset the counter.
      if (yawErrorGrowing > 10) {
        boatTurnSign = -boatTurnSign
        stateMovements.boatYawSign = boatTurnSign
        yawErrorGrowing = 0
      }
    } else {
      yawErrorGrowing = 0
    }
    lastYawError = yawError

    // Deadband so the boat does not oscillate around the target heading.
    const turn = absError < 0.1 ? 0 : (yawError > 0 ? boatTurnSign : -boatTurnSign)
    // Do not accelerate while pointing away from the target; rotate first.
    const forward = absError < Math.PI / 2 ? 1 : 0

    if (driven) {
      boatDriver.engage()
      boatDriver.setInput(turn, forward)
    } else {
      bot.moveVehicle(turn, forward)
    }
  }

  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (!oldBlock || !newBlock) return
    if (isPositionNearPath(oldBlock.position, path) && oldBlock.type !== newBlock.type) {
      // Rate limited: flowing water/lava and falling gravel next to a path emit a
      // steady stream of these, and resetting on every one means the bot spends
      // all its time replanning and none of it moving.
      const now = performance.now()
      if (now - lastBlockUpdateReset < bot.pathfinder.blockUpdateResetInterval) return
      lastBlockUpdateReset = now
      resetPath('block_updated', false)
    }
  })

  bot.on('chunkColumnLoad', (chunk) => {
    // Reset only if the new chunk is adjacent to a visited chunk
    if (astarContext) {
      const cx = chunk.x >> 4
      const cz = chunk.z >> 4
      if (astarContext.visitedChunks.has(`${cx - 1},${cz}`) ||
          astarContext.visitedChunks.has(`${cx},${cz - 1}`) ||
          astarContext.visitedChunks.has(`${cx + 1},${cz}`) ||
          astarContext.visitedChunks.has(`${cx},${cz + 1}`)) {
        resetPath('chunk_loaded', false)
      }
    }
  })

  /**
   * A path is priced with every hostile mob where it stood when the path was planned. A mob that has moved
   * into the way since, or appeared there, makes it stale, so replan: at most once per
   * hostileReplanCooldown, and only for a mob near the bot or the steps still to come.
   * @returns {boolean} whether the path was reset
   */
  function checkHostiles () {
    const movements = stateMovements
    if (!movements || !movements.avoidHostiles || movements.allowEntityDetection === false) return false
    if (bot.vehicle) return false // on a boat: the shore is not where the danger is
    const now = performance.now()
    if (now - lastHostileCheck < bot.pathfinder.hostileCheckInterval) return false
    lastHostileCheck = now

    const verdict = shouldReplanForHostiles({
      planned: plannedHostiles,
      current: movements.scanHostiles(),
      path,
      botPosition: bot.entity.position,
      moveThreshold: bot.pathfinder.hostileMoveThreshold,
      lookahead: bot.pathfinder.hostileLookahead,
      msSinceReplan: now - lastHostileReplan,
      cooldown: bot.pathfinder.hostileReplanCooldown
    })
    if (!verdict.replan) return false

    lastHostileReplan = now
    bot.emit('hostile_replan', verdict)
    resetPath(`hostile_${verdict.reason}`, false)
    return true
  }

  /** The hostile mobs the pathfinder currently plans around, nearest first (empty when it is not avoiding them). */
  bot.pathfinder.hostilesNearby = () => (stateMovements ? stateMovements.scanHostiles() : [])

  function monitorMovement () {
    if (recycling) {
      lastNodeTime = performance.now()
      return
    }
    // Test freemotion
    if (stateMovements && stateMovements.allowFreeMotion && stateGoal && stateGoal.entity) {
      const target = stateGoal.entity
      if (physics.canStraightLine([target.position])) {
        bot.lookAt(target.position.offset(0, 1.6, 0))

        if (target.position.distanceSquared(bot.entity.position) > stateGoal.rangeSq) {
          bot.setControlState('forward', true)
        } else {
          bot.clearControlStates()
        }
        return
      }
    }
    if (stateGoal) {
      if (!stateGoal.isValid()) {
        stop()
      } else if (stateGoal.hasChanged()) {
        resetPath('goal_moved', false)
      }
    }

    if (astarContext && astartTimedout) {
      const results = astarContext.compute()
      results.path = postProcessPath(results.path)
      pathFromPlayer(results.path)
      bot.emit('path_update', results)
      path = results.path
      astartTimedout = results.status === 'partial'
    }

    if (bot.pathfinder.LOSWhenPlacingBlocks && returningPos) {
      if (!moveToBlock(returningPos)) return
      returningPos = null
    }

    if (path.length === 0) {
      lastNodeTime = performance.now()
      if (stateGoal && stateMovements) {
        if (stateGoal.isEnd(bot.entity.position.floored())) {
          if (!dynamicGoal) {
            bot.emit('goal_reached', stateGoal)
            stateGoal = null
            fullStop()
          }
        } else if (!pathUpdated) {
          const results = bot.pathfinder.getPathTo(stateMovements, stateGoal)
          bot.emit('path_update', results)
          path = results.path
          astartTimedout = results.status === 'partial'
          pathUpdated = true
        }
      }
    }

    if (path.length === 0) {
      return
    }

    if (checkHostiles()) return

    let nextPoint = path[0]
    // While riding, measure from the vehicle: bot.entity.position can lag it, and
    // the boat is where the bot effectively is for arrival and progress checks.
    const p = (bot.vehicle && nextPoint.boat) ? bot.vehicle.position : bot.entity.position

    // Handle digging
    if (digging || nextPoint.toBreak.length > 0) {
      if (!digging && bot.entity.onGround) {
        digging = true
        const generation = moveGeneration
        const b = nextPoint.toBreak.shift()
        const block = bot.blockAt(new Vec3(b.x, b.y, b.z), false)
        const tool = bot.pathfinder.bestHarvestTool(block)
        fullStop()

        const digBlock = () => {
          bot.dig(block, true)
            .catch(_ignoreError => {
              if (generation === moveGeneration) resetPath('dig_error')
            })
            .then(function () {
              // The goal moved on (resetPath already forced digging back to false and released
              // the state) while this dig was in flight; do not resurrect stale state on top of
              // whatever the new goal is now doing.
              if (generation !== moveGeneration) return
              lastNodeTime = performance.now()
              digging = false
            })
        }

        if (!tool) {
          digBlock()
        } else {
          bot.equip(tool, 'hand')
            .catch(_ignoreError => {})
            .then(() => {
              if (generation === moveGeneration) digBlock()
            })
        }
      }
      return
    }
    // Handle block placement
    // TODO: sneak when placing or make sure the block is not interactive
    if (placing || nextPoint.toPlace.length > 0) {
      const placeGeneration = moveGeneration
      if (!placing) {
        placing = true
        placingBlock = nextPoint.toPlace.shift()
        fullStop()
      }

      // Open gates or doors
      if (placingBlock?.useOne) {
        if (!lockUseBlock.tryAcquire()) return
        bot.activateBlock(bot.blockAt(new Vec3(placingBlock.x, placingBlock.y, placingBlock.z))).then(() => {
          lockUseBlock.release()
          if (placeGeneration === moveGeneration) placingBlock = nextPoint.toPlace.shift()
        }, err => {
          console.error(err)
          lockUseBlock.release()
        })
        return
      }
      const block = stateMovements.getScaffoldingItem()
      if (!block) {
        resetPath('no_scaffolding_blocks')
        return
      }
      if (bot.pathfinder.LOSWhenPlacingBlocks && placingBlock.y === bot.entity.position.floored().y - 1 && placingBlock.dy === 0) {
        if (!moveToEdge(new Vec3(placingBlock.x, placingBlock.y, placingBlock.z), new Vec3(placingBlock.dx, 0, placingBlock.dz))) return
      }
      let canPlace = true
      if (placingBlock.jump) {
        bot.setControlState('jump', true)
        canPlace = placingBlock.y + 1 < bot.entity.position.y
      }
      if (canPlace) {
        if (!lockEquipItem.tryAcquire()) return
        bot.equip(block, 'hand')
          .then(function () {
            lockEquipItem.release()
            if (placeGeneration !== moveGeneration) return
            const refBlock = bot.blockAt(new Vec3(placingBlock.x, placingBlock.y, placingBlock.z), false)
            if (!lockPlaceBlock.tryAcquire()) return
            if (interactableBlocks.includes(refBlock.name)) {
              bot.setControlState('sneak', true)
            }
            bot.placeBlock(refBlock, new Vec3(placingBlock.dx, placingBlock.dy, placingBlock.dz))
              .then(function () {
                // Dont release Sneak if the block placement was not successful
                bot.setControlState('sneak', false)
                // A stale placement (the goal moved on while this was in flight) must not push
                // the bot toward a returnPos that belonged to the previous, abandoned goal.
                if (placeGeneration === moveGeneration && bot.pathfinder.LOSWhenPlacingBlocks && placingBlock.returnPos) returningPos = placingBlock.returnPos.clone()
              })
              .catch(_ignoreError => {
                if (placeGeneration === moveGeneration) resetPath('place_error')
              })
              .then(() => {
                lockPlaceBlock.release()
                // resetPath() already released the lock and cleared `placing` for the current
                // goal; a stale chain finishing later must not flip that state back on.
                if (placeGeneration !== moveGeneration) return
                placing = false
                lastNodeTime = performance.now()
              })
          })
          .catch(_ignoreError => {})
      }
      return
    }

    // Handle getting into / out of a boat before anything else. While mounted the
    // walking control states below are meaningless, and the medium transition has
    // to complete before the node can be followed.
    if (nextPoint.boat && !bot.vehicle) {
      if (!embark(nextPoint)) return
    } else if (!nextPoint.boat && bot.vehicle) {
      if (!disembark()) return
    }

    // Water bucket clutch: place a water bucket before a long fall (see
    // getMoveWaterBucketDown / getMoveWaterBucketDropDown in movements.js) so the
    // landing is water instead of bare ground, then scoop the water back up once
    // down and before moving on to the next node, so the terrain is left as it
    // was found and the bucket is ready to use again. Same shape as the boat
    // dispatch just above: a gate that returns early while the async action
    // (placeWaterBucket / scoopWaterBucket below) is still in flight.
    if (nextPoint.waterBucket && !nextPoint.waterBucketPlaced) {
      if (!placeWaterBucket(nextPoint)) return
    } else if (wbcPendingScoop && !nextPoint.waterBucket) {
      if (!scoopWaterBucket()) return
    }

    // Tolerance depends on the kind of move. A boat cannot stop inside a 0.35
    // box, and a parkour landing routinely misses the centre by more than that.
    const tolerance = physics.toleranceFor(nextPoint)

    let dx = nextPoint.x - p.x
    const dy = nextPoint.y - p.y
    let dz = nextPoint.z - p.z
    // Mirrors physics.js getReached(): an ascending target (dy > 0, e.g. jumping
    // up onto or over a block) must not count as reached until the bot has
    // essentially risen to it. The old symmetric `< 1` let this fire while the
    // bot was still below the obstacle's top and already horizontally inside its
    // column, i.e. colliding with its face rather than standing on it - the
    // server then corrects the position, which is the "stuck jumping over a
    // block" rubberband. A target at or below the bot has nothing to collide
    // with on the way down, so it keeps the original loose band.
    const verticalReached = dy > 0 ? dy < 0.35 : Math.abs(dy) < 1
    if (Math.abs(dx) <= tolerance && Math.abs(dz) <= tolerance && verticalReached) {
      // arrived at next point
      lastNodeTime = performance.now()
      stallTicks = 0
      bestNodeDistance = Infinity
      if (stopPathing) {
        stop()
        return
      }
      path.shift()
      if (path.length === 0) { // done
        // If the block the bot is standing on is not a full block only checking for the floored position can fail as
        // the distance to the goal can get greater then 0 when the vector is floored.
        if (!dynamicGoal && stateGoal && (stateGoal.isEnd(p.floored()) || stateGoal.isEnd(p.floored().offset(0, 1, 0)))) {
          bot.emit('goal_reached', stateGoal)
          stateGoal = null
        } else {
          // A partial path (the astar budget ran out before reaching the goal) was
          // walked to its own end without satisfying the goal. Without this, path
          // stays empty and pathUpdated stays true forever - monitorMovement's
          // "path.length === 0 && !pathUpdated" replan never fires again, and the
          // bot just stands here for good. Clear it so the next tick starts a
          // fresh search (a new astar context, with its own time budget) from here.
          pathUpdated = false
        }
        if (bot.vehicle) disembark()
        if (wbcPendingScoop) scoopWaterBucket()
        fullStop()
        return
      }
      // not done yet
      nextPoint = path[0]
      if (nextPoint.toBreak.length > 0 || nextPoint.toPlace.length > 0) {
        fullStop()
        return
      }
      dx = nextPoint.x - p.x
      dz = nextPoint.z - p.z
    }

    // Boat cruising has its own controller; none of the player control states apply.
    if (bot.vehicle && nextPoint.boat) {
      steerBoat(nextPoint)
      trackProgress(nextPoint, p)
      return
    }

    // Force the look instead of turning smoothly. With smooth turning the yaw
    // lags the target by several ticks, and when dx/dz are small - which is
    // exactly the situation on the lip of an edge - the heading oscillates and
    // the bot shuffles in place instead of committing to a direction.
    bot.look(Math.atan2(-dx, -dz), 0, true)
    bot.setControlState('forward', true)
    bot.setControlState('jump', false)

    if (bot.entity.isInWater) {
      bot.setControlState('jump', true)
      bot.setControlState('sprint', false)
      stallTicks = 0
    } else if (stateMovements.allowSprinting && physics.canStraightLine(path, true)) {
      bot.setControlState('jump', false)
      bot.setControlState('sprint', true)
      stallTicks = 0
    } else if (stateMovements.allowSprinting && physics.canSprintJump(path)) {
      bot.setControlState('jump', true)
      bot.setControlState('sprint', true)
      stallTicks = 0
    } else if (physics.canStraightLine(path)) {
      bot.setControlState('jump', false)
      bot.setControlState('sprint', false)
      stallTicks = 0
    } else if (physics.canWalkJump(path)) {
      bot.setControlState('jump', true)
      bot.setControlState('sprint', false)
      stallTicks = 0
    } else if (nextPoint.parkour) {
      // The planner only produced this node because parkour was allowed, so it is
      // a jump by construction. The predicates above search for a jump delay and
      // can all fail on the approach - historically that dropped the bot into the
      // do-nothing branch below and it walked to the lip and stopped. Honour the
      // planner's intent instead: commit to the sprint jump.
      bot.setControlState('jump', true)
      bot.setControlState('sprint', stateMovements.allowSprinting)
      stallTicks = 0
    } else {
      // No predicate accepted the move and it is not a jump node. Previously this
      // released forward and did nothing at all, so the bot froze on the spot for
      // the full futility timeout and then replanned into the identical path -
      // the classic stall on the edge of a drop or gap.
      //
      // Instead keep trying: hold forward and jump, which is the action most
      // likely to clear a lip or a small rise, and count the ticks. If it has not
      // resolved shortly, repath immediately rather than waiting out the timer.
      stallTicks++
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      bot.setControlState('sprint', false)
      if (stallTicks > bot.pathfinder.maxStallTicks) {
        stallTicks = 0
        resetPath('stuck_no_move')
        return
      }
    }

    trackProgress(nextPoint, p)
  }

  /**
   * Refresh the futility timer whenever the bot is measurably closer to the node
   * than it has ever been. Without this a legitimately slow traversal - a long
   * jump approach, a swim, a boat crossing - is killed at stuckTimeout even
   * though it is making progress the whole way.
   */
  function trackProgress (nextPoint, p) {
    const d = nextPoint.distanceSquared(p)
    if (d < bestNodeDistance - 0.01) {
      bestNodeDistance = d
      lastNodeTime = performance.now()
    }

    if (performance.now() - lastNodeTime > bot.pathfinder.stuckTimeout) {
      // should never take this long to go to the next node
      resetPath('stuck')
    }
  }
}

module.exports = {
  pathfinder: inject,
  Movements: require('./lib/movements'),
  goals: require('./lib/goals'),
  createHuman: require('./lib/human').createHuman
}
