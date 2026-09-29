const { Vec3 } = require('vec3')

class Move extends Vec3 {
  constructor (x, y, z, remainingBlocks, cost, toBreak = [], toPlace = [], parkour = false, boat = false, waterBucket = false) {
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
    // Whether reaching this node is a water-bucket-clutched fall (see
    // getWaterBucketDrop in movements.js): the executor places a water bucket
    // before the drop and scoops it back up after. Also just a label, not part
    // of the search state - the bot ends this node on foot on dry ground exactly
    // like any other grounded node, so it has the same neighbours either way.
    this.waterBucket = waterBucket

    this.hash = this.x + ',' + this.y + ',' + this.z + (boat ? ',b' : '')
  }
}

module.exports = Move
