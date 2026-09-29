/*
 * Hostile mobs: the pathfinder keeps away from them by itself.
 *
 * Nothing has to be listed. Hostile mobs (zombies, creepers, skeletons, ...) are recognised from the
 * registry, each one puts a cost around itself that fades with distance (a creeper, which explodes,
 * and a skeleton, which shoots, get a wider berth than a zombie), and the bot replans when one walks
 * into the way or appears in it after the path was planned.
 *
 * Below are the settings. Every one has a sensible default: this is only to show what can be changed.
 */

const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { GoalNear } = require('mineflayer-pathfinder').goals

const bot = mineflayer.createBot({
  host: process.argv[2],
  port: parseInt(process.argv[3]),
  username: process.argv[4] ? process.argv[4] : 'hostilesbot',
  password: process.argv[5]
})

bot.loadPlugin(pathfinder)

bot.once('spawn', () => {
  const movements = new Movements(bot)

  movements.avoidHostiles = true // the default; false goes back to ignoring them
  movements.hostileScanRange = 24 // only plan around mobs this close (blocks)
  movements.hostileCostScale = 1 // 2 makes routes twice as timid, 0 stops the cost but keeps the events
  movements.hostileExclusions.add('enderman') // never treat these as hostile
  movements.hostileNames.add('my_modded_mob') // ...and treat these as hostile, whatever the registry says
  movements.hostileProfiles.zombie = { radius: 6, cost: 40 } // keep further from zombies than the default

  bot.pathfinder.setMovements(movements)

  // How the bot decides a path has gone stale because of a mob.
  bot.pathfinder.hostileCheckInterval = 250 // ms between looks at where the mobs are
  bot.pathfinder.hostileReplanCooldown = 1000 // ms between replans, so a chasing mob is not one per tick
  bot.pathfinder.hostileMoveThreshold = 1.5 // blocks a mob must have moved since the path was planned

  bot.on('hostile_replan', (v) => {
    console.log(`replanning: a ${v.name} ${v.reason} ${v.distance.toFixed(1)} blocks from the route`)
  })
})

bot.on('chat', (username, message) => {
  if (username === bot.username) return
  const target = bot.players[username] && bot.players[username].entity
  if (message === 'come' && target) {
    bot.pathfinder.setGoal(new GoalNear(target.position.x, target.position.y, target.position.z, 1))
  }
  if (message === 'mobs') {
    const near = bot.pathfinder.hostilesNearby()
    bot.chat(near.length ? near.map(m => `${m.name} (${Math.sqrt(m.distanceSq).toFixed(0)}m)`).join(', ') : 'no hostile mobs near')
  }
})
