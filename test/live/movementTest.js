/* eslint-env mocha */

// Live movement/pathfinding test against a REAL vanilla server (26.1 by default).
//
// Skipped unless PF_LIVE=1, because it downloads and starts the official server and
// takes a minute or two. Everything else in this repo runs against fakes; this is
// the test that can tell whether the bot really walked there, because the server's
// own movement checks (and a `data get entity ... Pos` query) decide the outcome,
// not just what the client believes locally.
//
//   node scripts/live-server.js --accept-eula   starts a server AND can run this alongside it
//   PF_LIVE=1 PF_LIVE_ACCEPT_EULA=1 npx mocha test/live/movementTest.js --timeout 300000 --exit
//
// Environment:
//   PF_LIVE_ACCEPT_EULA=1  required to launch a server: you accept the Minecraft EULA
//   PF_LIVE_VERSION        default 26.1
//   PF_LIVE_PORT           default 25565 (Minecraft's own default)
//   PF_LIVE_DEBUG=1        echo server console output while the test runs
//
// The bot's username is pf_movement_test.
//
// The arena is the actual maze: a 22x14 grid of red_concrete walls (3 blocks tall) with a
// lime_concrete path winding from a blue_concrete start tile to a yellow_concrete goal
// tile, built at y=200 in its own chunk (well away from every other live arena) so it
// never collides with flatArena/trenchArena/hostileArena. The bot has to actually walk
// the corridor - there is no shortcut through a wall.

'use strict'

const assert = require('assert')
const { Vec3 } = require('vec3')
const realWorld = require('./realWorld')

const live = process.env.PF_LIVE === '1'
const suite = live ? describe : describe.skip

const Version = realWorld.Version

// ---------------------------------------------------------------------------
// The maze, as extracted from the reference image. '.' = wall, 'G' = path,
// 'B' = start, 'O' = goal.
// ---------------------------------------------------------------------------
const GRID = [
  '......................',
  '......GGG..........GO.',
  '.....GG.GGG.......GG..',
  '....GG...GGG.....GG...',
  '...GG......GG...GG....',
  '..GG........GG.GG.....',
  '.GG..........GGG......',
  '.G....................',
  '.G.....G..GGG.GGG.GGG.',
  '.GGG.GGG..GGGGG.GGG.G.',
  '...GGG.GGGG.GGG.GGG.G.',
  '....................G.',
  '...GGG.GGGG.GGG.GGG.G.',
  '.BGG.GGG..GGG.GGG.GGG.'
]
const ROWS = GRID.length
const COLS = GRID[0].length

// Its own chunk, far from flatArena/trenchArena/parkourArena (all chunk (0,0), y 0..96)
// and hostileArena (200,5,200 .. 259,25,261): no player has been near here before, so it
// needs forceload before /fill will actually take effect (see join(..., { remote: true })).
const ORIGIN = new Vec3(400, 200, 400)

function findCell (ch) {
  for (let r = 0; r < ROWS; r++) {
    const c = GRID[r].indexOf(ch)
    if (c !== -1) return { row: r, col: c }
  }
  throw new Error(`no '${ch}' cell in the maze grid`)
}

const startCell = findCell('B')
const goalCell = findCell('O')

/** Run-length-encode a row of walls/path along x so the build is a handful of /fill, not hundreds of /setblock. */
function mazeArena () {
  const { x: x0, y: y0, z: z0 } = ORIGIN
  const x1 = x0 + COLS - 1
  const z1 = z0 + ROWS - 1
  const commands = [
    `kill @e[type=item,x=${x0},y=${y0},z=${z0},dx=${COLS},dy=10,dz=${ROWS}]`,
    `fill ${x0} ${y0} ${z0} ${x1} ${y0 + 9} ${z1} air`
  ]

  for (let r = 0; r < ROWS; r++) {
    const z = z0 + r
    let c = 0
    while (c < COLS) {
      const ch = GRID[r][c]
      let end = c
      while (end + 1 < COLS && GRID[r][end + 1] === ch) end++
      const xa = x0 + c
      const xb = x0 + end
      if (ch === '.') {
        commands.push(`fill ${xa} ${y0} ${z} ${xb} ${y0 + 2} ${z} minecraft:bedrock`)
      } else if (ch === 'G') {
        commands.push(`fill ${xa} ${y0} ${z} ${xb} ${y0} ${z} minecraft:bedrock`)
      } else if (ch === 'B') {
        commands.push(`setblock ${xa} ${y0} ${z} minecraft:bedrock`)
      } else if (ch === 'O') {
        commands.push(`setblock ${xa} ${y0} ${z} minecraft:bedrock`)
      }
      c = end + 1
    }
  }

  return {
    name: 'maze',
    commands,
    checks: [
      [x0 + startCell.col, y0, z0 + startCell.row, 'bedrock'],
      [x0 + goalCell.col, y0, z0 + goalCell.row, 'bedrock'],
      [x0, y0, z0, 'bedrock'],
      [x0, y0 + 2, z0, 'bedrock']
    ],
    bounds: { x0, z0, x1, z1 }
  }
}

suite(`movement: bot pathfinds through the maze on a real ${Version} server`, function () {
  this.timeout(180000)

  let bot = null
  let goalReached = false
  let pathUpdates = 0

  const start = new Vec3(ORIGIN.x + startCell.col + 0.5, ORIGIN.y + 1, ORIGIN.z + startCell.row + 0.5)
  const goal = { x: ORIGIN.x + goalCell.col, y: ORIGIN.y, z: ORIGIN.z + goalCell.row }

  const diagnostics = () => [
    `goalReached=${goalReached} pathUpdates=${pathUpdates} problems=${JSON.stringify(bot && bot.pfWorld && bot.pfWorld.problems)}`,
    `bot at ${bot && bot.entity && bot.entity.position}`
  ].join('\n')

  before(async function () {
    realWorld.markTest(this.test.parent.title)

    // remote: true because ORIGIN is a chunk nobody has ever visited - it needs
    // forceload before the /fill commands actually land (see realWorld.join()).
    bot = await realWorld.join('movement_test', mazeArena(), start, { remote: true })

    const { pathfinder, Movements, goals } = require('../..')
    bot.loadPlugin(pathfinder)
    const movements = new Movements(bot)
    bot.pathfinder.setMovements(movements)

    bot.on('path_update', () => { pathUpdates++ })
    bot.once('goal_reached', () => { goalReached = true })

    // GoalNear, not GoalBlock: the goal tile is a walkable floor block, not something to dig into.
    bot.pathfinder.setGoal(new goals.GoalNear(goal.x, goal.y, goal.z, 1))
    await realWorld.waitUntil(() => goalReached || bot.pfWorld.problems.length > 0, 120000)
  })

  after(async function () {
    await realWorld.leave(bot)
  })

  it('never got kicked or errored while pathing', function () {
    assert.deepStrictEqual(bot.pfWorld.problems, [], `the bot had a connection problem. ${diagnostics()}`)
  })

  it('actually planned at least one path through the maze (did not just sit still)', function () {
    assert.ok(pathUpdates > 0, `pathfinder never reported a path. ${diagnostics()}`)
  })

  it('reaches the goal tile', function () {
    assert.ok(goalReached, `goal_reached never fired within the timeout. ${diagnostics()}`)
  })

  it('the server itself agrees the bot ended up at the goal (not just the client)', async function () {
    const pos = await realWorld.getServerPos(bot)
    const distance = Math.sqrt((pos.x - (goal.x + 0.5)) ** 2 + (pos.z - (goal.z + 0.5)) ** 2)
    assert.ok(distance < 2, `server reports the bot at ${pos}, too far from the goal (${goal.x}, ${goal.y}, ${goal.z}). ${diagnostics()}`)
  })

  it('the server never logged the bot moving wrongly or too quickly', function () {
    const complaints = realWorld.serverMovementComplaints()
    assert.deepStrictEqual(complaints, [], `the server rejected reported positions:\n${complaints.slice(0, 5).join('\n')}`)
  })
})
