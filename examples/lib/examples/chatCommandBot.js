/**
 * Chat-command bot with a web viewer.
 *
 * - Connects to 0.0.0.0:25565 (default Java Edition port), version 26.1.
 * - Any chat message that contains "bot " ANYWHERE is treated as a command line -
 *   it does not have to start with "bot ", and it is not restricted to messages
 *   from players in the player list: the raw 'message' event is used instead of
 *   the player-only 'chat' event, so /say, /tellraw, command blocks and other
 *   bots can all issue commands too.
 * - `travel x,y,z` or `travel x,z` pathfinds to a point (boats are used
 *   automatically where they're faster - this fork's allowBoating is on).
 * - Serves a third-person web viewer at http://<this machine's IP>:3000, bound to
 *   all interfaces, so it's reachable from another device on the network.
 *
 * Usage: node chatCommandBot.js [username]
 *
 * In-game / in any chat that reaches the server, e.g.:
 *   bot travel 100,64,-40
 *   bot travel 100,-40
 *   bot stop
 */
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalNear, GoalXZ } = goals
const viewer = require('prismarine-viewer')

const VIEWER_PORT = 3000
const TRIGGER = 'bot ' // matched anywhere in the message, case-insensitive

const bot = mineflayer.createBot({
  host: '0.0.0.0',
  port: 25565,
  username: process.argv[2] ?? 'chatbot',
  version: '26.1'
})

bot.loadPlugin(pathfinder)

// Messages the bot has itself sent recently. Since commands are matched on any
// message containing "bot " and not just messages from real players, the bot's
// own replies (which are broadcast back to it like any other chat) have to be
// filtered out explicitly, or a reply that happens to contain "bot " could
// trigger itself in a loop.
const recentOwnMessages = new Set()

function say (text) {
  recentOwnMessages.add(text)
  // Bounded lifetime: only needs to survive the round trip back from the server.
  setTimeout(() => recentOwnMessages.delete(text), 5000)
  bot.chat(text)
}

/**
 * Parse "x,y,z" or "x,z" (with or without spaces around the commas) into a
 * pathfinder goal. Three numbers is a specific block; two is a column, letting
 * the pathfinder pick the y itself.
 */
function parseTravelArgs (raw) {
  const parts = raw.split(',').map(s => s.trim()).filter(s => s.length > 0)
  const nums = parts.map(Number)
  if (nums.length < 2 || nums.length > 3 || nums.some(Number.isNaN)) return null

  if (nums.length === 3) {
    const [x, y, z] = nums
    return { goal: new GoalNear(x, y, z, 1), label: `${x}, ${y}, ${z}` }
  }
  const [x, z] = nums
  return { goal: new GoalXZ(x, z), label: `${x}, ${z}` }
}

const commands = {
  travel (args) {
    const parsed = parseTravelArgs(args.join(' ').replace(/\s+/g, ''))
    if (!parsed) {
      say('travel needs "x,y,z" or "x,z" - e.g. bot travel 100,64,-40')
      return
    }
    say(`travelling to ${parsed.label}`)
    bot.pathfinder.setGoal(parsed.goal)
  },

  stop () {
    bot.pathfinder.stop()
    say('stopped')
  }
}

/**
 * Everything after the FIRST "bot " in the message is the command line, so
 * "please bot travel 10,20" and "bot travel 10,20" both work.
 */
function dispatch (rawMessage) {
  const idx = rawMessage.toLowerCase().indexOf(TRIGGER)
  if (idx === -1) return

  const commandLine = rawMessage.slice(idx + TRIGGER.length).trim()
  if (!commandLine) return

  const [name, ...args] = commandLine.split(/\s+/)
  const handler = commands[name.toLowerCase()]
  if (!handler) {
    say(`unknown command: ${name}`)
    return
  }
  handler(args)
}

// The 'message' event fires for every chat-type packet the client receives -
// player chat, /say, /tellraw, command block output, other bots - unlike 'chat',
// which mineflayer restricts to real player chat packets. This is what makes
// the trigger not player-only.
bot.on('message', (jsonMsg) => {
  const text = jsonMsg.toString()
  if (recentOwnMessages.has(text)) return
  dispatch(text)
})

bot.once('spawn', () => {
  const movements = new Movements(bot)
  movements.allowBoating = true
  bot.pathfinder.setMovements(movements)

  viewer.mineflayer(bot, { port: VIEWER_PORT, firstPerson: false })
  console.log(`Third-person viewer: http://localhost:${VIEWER_PORT} (or this machine's LAN IP)`)
})

bot.on('goal_reached', () => say('arrived'))
bot.on('path_reset', (reason) => say(`path reset: ${reason}`))

bot.on('kicked', console.log)
bot.on('error', console.log)
