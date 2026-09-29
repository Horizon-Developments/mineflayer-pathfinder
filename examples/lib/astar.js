const { performance } = require('perf_hooks')

const Heap = require('./heap.js')

class PathNode {
  constructor () {
    this.data = null
    this.g = 0
    this.h = 0
    this.f = 0
    this.parent = null
  }

  set (data, g, h, parent = null) {
    this.data = data
    this.g = g
    this.h = h
    this.f = g + h
    this.parent = parent
    return this
  }
}

function reconstructPath (node) {
  const path = []
  while (node.parent) {
    path.push(node.data)
    node = node.parent
  }
  return path.reverse()
}

// A candidate/best-so-far node has to be at least this far (in blocks) from
// the start before a search that times out is allowed to hand back its
// partial path as 'timeout' rather than being given extra time. Mirrors
// Baritone's MIN_DIST_PATH: a search that's barely left the start hasn't
// told us anything useful yet, so it's worth a longer budget before
// concluding it's genuinely stuck. Squared to avoid a sqrt per comparison.
const MIN_DIST_PATH_SQ = 5 * 5

class AStar {
  constructor (start, movements, goal, timeout, tickTimeout = 40, searchRadius = -1, failureTimeout = timeout * 2) {
    this.startTime = performance.now()

    this.movements = movements
    this.goal = goal
    this.timeout = timeout
    // Ceiling for a search that hasn't made real progress yet (see `failing`
    // below) - always at least `timeout`, so passing a smaller value here
    // can't make things worse than before this change.
    this.failureTimeout = Math.max(failureTimeout, timeout)
    this.tickTimeout = tickTimeout

    this.closedDataSet = new Set()
    this.openHeap = new Heap()
    this.openDataMap = new Map()

    const startNode = new PathNode().set(start, 0, goal.heuristic(start))
    this.openHeap.push(startNode)
    this.openDataMap.set(startNode.data.hash, startNode)
    this.bestNode = startNode
    this.startX = start.x
    this.startY = start.y
    this.startZ = start.z
    // True until bestNode clears MIN_DIST_PATH_SQ from the start. While true,
    // a `timeout` cutoff is deferred (up to failureTimeout) instead of being
    // taken at face value - see the two-tier check in compute().
    this.failing = true
    this._warnedBadCost = false

    this.maxCost = searchRadius < 0 ? -1 : startNode.h + searchRadius
    this.visitedChunks = new Set()
  }

  distFromStartSq (data) {
    const dx = data.x - this.startX
    const dy = data.y - this.startY
    const dz = data.z - this.startZ
    return dx * dx + dy * dy + dz * dz
  }

  makeResult (status, node) {
    return {
      status,
      cost: node.g,
      time: performance.now() - this.startTime,
      visitedNodes: this.closedDataSet.size,
      generatedNodes: this.closedDataSet.size + this.openHeap.size(),
      path: reconstructPath(node),
      context: this
    }
  }

  compute () {
    const computeStartTime = performance.now()
    while (!this.openHeap.isEmpty()) {
      if (performance.now() - computeStartTime > this.tickTimeout) { // compute time per tick
        return this.makeResult('partial', this.bestNode)
      }
      const elapsed = performance.now() - this.startTime
      if (elapsed > this.timeout) {
        // Two-tier timeout (mirrors Baritone's primary/failure timeout split):
        // if bestNode is still within MIN_DIST_PATH_SQ of the start, this
        // search hasn't told us anything useful yet, so give it until
        // failureTimeout before cutting it off - a search that's about to
        // break out of a slow start shouldn't die on the same clock as one
        // that's already found a decent partial route. Once real progress
        // exists (failing === false), this cuts off at `timeout` exactly as
        // before. Either way the returned status is still 'timeout' - only
        // the deadline moves, not the status vocabulary other code depends on.
        if (!(this.failing && elapsed < this.failureTimeout)) {
          return this.makeResult('timeout', this.bestNode)
        }
      }
      const node = this.openHeap.pop()
      if (this.goal.isEnd(node.data)) {
        return this.makeResult('success', node)
      }
      // not done yet
      this.openDataMap.delete(node.data.hash)
      this.closedDataSet.add(node.data.hash)
      this.visitedChunks.add(`${node.data.x >> 4},${node.data.z >> 4}`)

      const neighbors = this.movements.getNeighbors(node.data)
      for (const neighborData of neighbors) {
        if (this.closedDataSet.has(neighborData.hash)) {
          continue // skip closed neighbors
        }
        // Defensive sanity check: a movement should only ever hand back a
        // finite, positive cost - impossible moves are supposed to not be
        // pushed to the neighbors array at all (this file's convention),
        // never pushed with a 0/negative/NaN cost. A* assumes non-negative
        // edge weights, and combined with the permanently-closed set above,
        // a bad cost here could silently produce a wrong path rather than an
        // obvious crash. Mirrors Baritone's ActionCosts check in
        // AStarPathFinder (which hard-throws on the same condition); this
        // logs once and skips the neighbor instead of throwing, since taking
        // down a running bot over one bad move is worse than one skipped edge.
        if (!(neighborData.cost > 0) || !Number.isFinite(neighborData.cost)) {
          if (!this._warnedBadCost) {
            this._warnedBadCost = true
            console.warn(`[pathfinder] a movement produced an invalid cost (${neighborData.cost}) for node ${neighborData.hash}; skipping it. This indicates a bug in a movement's cost calculation.`)
          }
          continue
        }
        const gFromThisNode = node.g + neighborData.cost
        let neighborNode = this.openDataMap.get(neighborData.hash)
        let update = false

        const heuristic = this.goal.heuristic(neighborData)
        if (this.maxCost > 0 && gFromThisNode + heuristic > this.maxCost) continue

        if (neighborNode === undefined) {
          // add neighbor to the open set
          neighborNode = new PathNode()
          // properties will be set later
          this.openDataMap.set(neighborData.hash, neighborNode)
        } else {
          // NOTE: Baritone additionally ignores improvements below a small
          // epsilon (MIN_IMPROVEMENT). Deliberately not ported: measured on
          // random grids it gave no speedup but changed which of several
          // equal-cost paths is chosen, which risks the branch-preference
          // assertions in test/internalTest.js.
          if (neighborNode.g < gFromThisNode) {
            // skip this one because another route is faster
            continue
          }
          update = true
        }
        // found a new or better route.
        // update this neighbor with this node as its new parent
        neighborNode.set(neighborData, gFromThisNode, heuristic, node)
        if (neighborNode.h < this.bestNode.h) {
          this.bestNode = neighborNode
          if (this.failing && this.distFromStartSq(neighborNode.data) > MIN_DIST_PATH_SQ) {
            this.failing = false
          }
        }
        if (update) {
          this.openHeap.update(neighborNode)
        } else {
          this.openHeap.push(neighborNode)
        }
      }
    }
    // all the neighbors of every accessible node have been exhausted
    return this.makeResult('noPath', this.bestNode)
  }
}

module.exports = AStar
