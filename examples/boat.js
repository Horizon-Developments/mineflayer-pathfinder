/**
 * Boat travel example.
 *
 * Give the bot a boat, then tell it to go somewhere across water:
 *   <player> boat 1200 -400
 *
 * The planner decides on its own whether the water route is worth it - cruising is
 * cheaper per block than walking, so it will prefer a crossing over a long detour
 * around a lake, but it will still walk when walking is shorter.
 *
 * Usage: node boat.js [host] [port] [name]
 */
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalXZ, GoalNear } = goals

if (process.argv.length > 5) {
  console.log('Usage : node boat.js [host] [port] [name]')
  process.exit(1)
}

const bot = mineflayer.createBot({
  host: process.argv[2] ?? 'localhost',
  port: parseInt(process.argv[3] ?? '25565'),
  username: process.argv[4] ?? 'boater',
  version: '26.1'
})

bot.loadPlugin(pathfinder)

bot.once('spawn', () => {
  const boatMoves = new Movements(bot)
  boatMoves.allowBoating = true

  // A walking-only instance, so the two can be compared in game.
  const walkMoves = new Movements(bot)
  walkMoves.allowBoating = false

  bot.pathfinder.setMovements(boatMoves)

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    const args = message.split(' ')

    if (args[0] === 'boat') {
      if (!boatMoves.getBoatItem()) {
        bot.chat('I have no boat - give me one first.')
        return
      }
      bot.pathfinder.setMovements(boatMoves)
      bot.pathfinder.setGoal(new GoalXZ(parseInt(args[1]), parseInt(args[2])))
      return
    }

    if (args[0] === 'walk') {
      bot.pathfinder.setMovements(walkMoves)
      bot.pathfinder.setGoal(new GoalXZ(parseInt(args[1]), parseInt(args[2])))
      return
    }

    if (args[0] === 'come') {
      const target = bot.players[username]?.entity
      if (!target) {
        bot.chat("I can't see you.")
        return
      }
      bot.pathfinder.setGoal(new GoalNear(target.position.x, target.position.y, target.position.z, 1))
      return
    }

    if (args[0] === 'stop') {
      bot.pathfinder.stop()
    }
  })
})

bot.on('mount', () => {
  bot.chat('aboard')
})

bot.on('dismount', () => {
  bot.chat('ashore')
})

bot.on('path_reset', (reason) => {
  // 'no_boat' means boating was planned but nothing is available to ride.
  if (reason === 'no_boat') bot.chat('I need a boat for that route.')
})

bot.on('goal_reached', () => {
  bot.chat('arrived')
})

bot.on('kicked', console.log)
bot.on('error', console.log)
