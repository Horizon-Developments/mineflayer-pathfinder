const { PlayerState } = require('prismarine-physics')

class Physics {
  constructor (bot) {
    this.bot = bot
    this.world = { getBlock: (pos) => { return bot.blockAt(pos, false) } }
  }

  /**
   *
   * @param {function} goal A function is the goal has been reached or not
   * @param {function} controller Controller that can change the current control State for the next tick
   * @param {number} ticks Number of ticks to simulate
   * @param {object} state Starting control state to begin the simulation with
   * @returns { import('prismarine-physics').PlayerState } A player state of the final simulation tick
   */
  simulateUntil (goal, controller = () => {}, ticks = 1, state = null) {
    if (!state) {
      const simulationControl = {
        forward: this.bot.controlState.forward,
        back: this.bot.controlState.back,
        left: this.bot.controlState.left,
        right: this.bot.controlState.right,
        jump: this.bot.controlState.jump,
        sprint: this.bot.controlState.sprint,
        sneak: this.bot.controlState.sneak
      }
      state = new PlayerState(this.bot, simulationControl)
    }

    for (let i = 0; i < ticks; i++) {
      controller(state, i)
      this.bot.physics.simulatePlayer(state, this.world)
      if (state.isInLava) return state
      if (goal(state)) return state
    }

    return state
  }

  simulateUntilNextTick () {
    return this.simulateUntil(() => false, () => {}, 1)
  }

  simulateUntilOnGround (ticks = 5) {
    return this.simulateUntil(state => state.onGround, () => {}, ticks)
  }

  canStraightLine (path, sprint = false) {
    const reached = this.getReached(path)
    const state = this.simulateUntil(reached, this.getController(path[0], false, sprint), 200)
    if (reached(state)) return true

    if (sprint) {
      if (this.canSprintJump(path, 0)) return false
    } else {
      if (this.canWalkJump(path, 0)) return false
    }

    for (let i = 1; i < 7; i++) {
      if (sprint) {
        if (this.canSprintJump(path, i)) return true
      } else {
        if (this.canWalkJump(path, i)) return true
      }
    }
    return false
  }

  canStraightLineBetween (n1, n2) {
    const reached = (state) => {
      const delta = n2.minus(state.pos)
      const r2 = 0.15 * 0.15
      return (delta.x * delta.x + delta.z * delta.z) <= r2 && Math.abs(delta.y) < 0.001 && (state.onGround || state.isInWater)
    }
    const simulationControl = {
      forward: this.bot.controlState.forward,
      back: this.bot.controlState.back,
      left: this.bot.controlState.left,
      right: this.bot.controlState.right,
      jump: this.bot.controlState.jump,
      sprint: this.bot.controlState.sprint,
      sneak: this.bot.controlState.sneak
    }
    const state = new PlayerState(this.bot, simulationControl)
    state.pos.update(n1)
    this.simulateUntil(reached, this.getController(n2, false, true), Math.floor(5 * n1.distanceTo(n2)), state)
    return reached(state)
  }

  canSprintJump (path, jumpAfter = 0) {
    const reached = this.getReached(path)
    const state = this.simulateUntil(reached, this.getController(path[0], true, true, jumpAfter), 20)
    return reached(state)
  }

  canWalkJump (path, jumpAfter = 0) {
    const reached = this.getReached(path)
    const state = this.simulateUntil(reached, this.getController(path[0], true, false, jumpAfter), 20)
    return reached(state)
  }

  /**
   * Horizontal tolerance for considering a node reached. Kept here so the
   * simulation and the real executor in index.js cannot drift apart - if the
   * simulation says "reached" at a radius the executor doesn't accept, the bot
   * walks into a node it will never register arriving at and stalls.
   * @param {Move} node
   * @returns {number}
   */
  toleranceFor (node) {
    // Physics is also constructed directly by lib/human.js, where bot.pathfinder
    // may not be injected, so fall back to the historical constant.
    const pf = this.bot.pathfinder
    if (!pf) return 0.35
    if (node && node.boat) return pf.boatArrivalTolerance ?? 1.2
    if (node && node.parkour) return pf.parkourArrivalTolerance ?? 0.5
    return pf.arrivalTolerance ?? 0.35
  }

  getReached (path) {
    const tolerance = this.toleranceFor(path[0])
    return (state) => {
      const delta = path[0].minus(state.pos)
      if (Math.abs(delta.x) > tolerance || Math.abs(delta.z) > tolerance) return false
      // Ascending moves (jumping up onto or over a block) must not be marked
      // reached until the bot has essentially risen to the target height. The old
      // symmetric `< 1` let this fire while the bot was still well below the
      // obstacle's top and already horizontally inside its column - i.e. still
      // colliding with its face, not standing on it - which the server then
      // corrects, producing exactly the "stuck jumping over a block" rubberband.
      // A target at or below the bot has nothing to collide with on the way
      // down, so the original loose band is kept there.
      if (delta.y > 0) return delta.y < 0.35
      return Math.abs(delta.y) < 1
    }
  }

  getController (nextPoint, jump, sprint, jumpAfter = 0) {
    return (state, tick) => {
      const dx = nextPoint.x - state.pos.x
      const dz = nextPoint.z - state.pos.z
      state.yaw = Math.atan2(-dx, -dz)

      state.control.forward = true
      state.control.jump = jump && tick >= jumpAfter
      state.control.sprint = sprint
    }
  }
}

module.exports = Physics
