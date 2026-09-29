const { Vec3 } = require('vec3')

class Move extends Vec3 {
  constructor (x, y, z, remainingBlocks, cost, toBreak = [], toPlace = [], parkour = false, boat = false) {
    super(Math.floor(x), Math.floor(y), Math.floor(z))
    this.remainingBlocks = remainingBlocks
    this.cost = cost
    this.toBreak = toBreak
    this.toPlace = toPlace
    this.parkour = parkour
    // Whether the bot is riding a boat while occupying this node. This is part of
    // the search state, not just a label: "standing at X" and "floating at X in a
    // boat" have different neighbours, so they must hash differently or A* will
    // silently merge them and produce paths that change medium without a
    // transition node.
    this.boat = boat

    this.hash = this.x + ',' + this.y + ',' + this.z + (boat ? ',b' : '')
  }
}

module.exports = Move
