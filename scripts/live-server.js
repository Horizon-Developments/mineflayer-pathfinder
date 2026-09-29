#!/usr/bin/env node
'use strict'

/* global fetch */

/**
 * Download and run the official vanilla Minecraft server, for the live tests.
 *
 *   node scripts/live-server.js --accept-eula            # runs 26.1 in ./.mc-server AND runs the
 *                                                        # live boat test against it, in this window
 *   node scripts/live-server.js --accept-eula --no-tests # just the server
 *   node scripts/live-server.js --accept-eula --log-moves # also print every movement sample
 *   node scripts/live-server.js --version 26.1 --port 25566 --dir C:\mc --accept-eula
 *
 * Also used by test/live/boatLiveTest.js through startServer().
 *
 * Nothing is guessed about the version: the download URL, its SHA-1 and the Java
 * major version it needs all come from Mojang's own version manifest.
 */

const fs = require('fs')
const path = require('path')
const liveFiles = require('./live-files')
const crypto = require('crypto')
const net = require('net')
const { spawn, spawnSync } = require('child_process')

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

/** Minecraft Java Edition's default port. The live tests always use it unless told otherwise. */
const DEFAULT_PORT = 25565

async function getJson (url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  return res.json()
}

/**
 * Fail early, and say why, if something already listens on the port. The default is the port a
 * normal Minecraft server uses, so "a server of mine is still running" is the likely reason.
 * @param {number} port
 */
function assertPortFree (port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', (err) => {
      reject(new Error(err.code === 'EADDRINUSE'
        ? `Port ${port} is already in use. Another Minecraft server (or an earlier live-server) is probably still running: stop it, or pick another port with --port.`
        : `Cannot use port ${port}: ${err.message}`))
    })
    probe.once('listening', () => probe.close(() => resolve()))
    probe.listen(port)
  })
}

/**
 * Collects a process's output lines and lets callers wait for one.
 *
 * waitForLog() normally also looks at lines already collected, which is what you want when the
 * thing you wait for may already have happened ("Done", a player joining). It is wrong when the
 * same line is printed again for each request, as with `data get entity <name> Pos`: the first
 * answer would satisfy every later request, so each one would be handed the position from the
 * first. Pass { fresh: true } to wait only for lines logged after the call.
 */
function createLogWatcher () {
  const logs = []
  const waiters = []
  return {
    logs,
    push (line) {
      logs.push(line)
      for (const w of waiters.slice()) {
        if (w.re.test(line)) {
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve(line)
        }
      }
    },
    waitForLog (re, ms = 60000, { fresh = false } = {}) {
      return new Promise((resolve, reject) => {
        if (!fresh) {
          const seen = logs.find(l => re.test(l))
          if (seen) return resolve(seen)
        }
        const w = { re, resolve: (l) => { clearTimeout(t); resolve(l) }, reject: (e) => { clearTimeout(t); reject(e) } }
        const t = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1)
          reject(new Error(`timed out after ${ms} ms waiting for ${re}\n${logs.slice(-15).join('\n')}`))
        }, ms)
        waiters.push(w)
      })
    },
    /** Reject everything still waiting, e.g. because the process died. */
    failAll (reason) {
      for (const w of waiters.splice(0)) w.reject(new Error(`${reason} while waiting for ${w.re}`))
    }
  }
}

/** Major version of the `java` on PATH (or `javaBin`), or null if it cannot be run. */
/**
 * server.properties for the live tests. Conditions are close to a real survival server on
 * purpose: no flight allowed, so the server's own vehicle movement checks are the real ones.
 * @param {number} port
 */
function serverProperties (port) {
  // Flat worlds need their layers spelled out: without generator-settings the server logs
  // "No key layers in MapLike[{}]" and falls back to something else.
  const flat = {
    biome: 'minecraft:plains',
    layers: [
      { block: 'minecraft:bedrock', height: 1 },
      { block: 'minecraft:stone', height: 2 },
      { block: 'minecraft:grass_block', height: 1 }
    ]
  }
  return [
    'online-mode=false',
    `server-port=${port}`,
    'gamemode=survival',
    'difficulty=peaceful',
    'spawn-monsters=false',
    'spawn-protection=0',
    'allow-flight=false',
    'view-distance=8',
    'level-type=minecraft\\:flat',
    `generator-settings=${JSON.stringify(flat)}`,
    // Tests build their own arenas by hand; a village or other structure spawning into one
    // (superflat worlds still generate structures unless this is off) would silently change
    // the blocks a test thinks it owns.
    'generate-structures=false',
    // 26.x pauses an empty server after 60 s by default; never let that stall a test.
    'pause-when-empty-seconds=-1',
    'motd=pathfinder live test',
    ''
  ].join('\n')
}

function javaMajor (javaBin = 'java') {
  const r = spawnSync(javaBin, ['-version'], { encoding: 'utf8' })
  if (r.error) return null
  const m = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr}${r.stdout}`)
  if (!m) return null
  return m[1] === '1' ? Number(m[2]) : Number(m[1]) // "1.8.0" style
}

async function ensureJar (dir, version) {
  const manifest = await getJson(MANIFEST)
  const entry = manifest.versions.find(v => v.id === version)
  if (!entry) {
    const recent = manifest.versions.slice(0, 8).map(v => v.id).join(', ')
    throw new Error(`Mojang's manifest has no version "${version}". Most recent: ${recent}`)
  }
  const meta = await getJson(entry.url)
  const jar = path.join(dir, `server-${version}.jar`)
  const needJava = meta.javaVersion && meta.javaVersion.majorVersion

  const ok = () => fs.existsSync(jar) &&
    crypto.createHash('sha1').update(fs.readFileSync(jar)).digest('hex') === meta.downloads.server.sha1
  if (!ok()) {
    console.log(`[live-server] downloading ${version} server (${meta.downloads.server.size} bytes)...`)
    const res = await fetch(meta.downloads.server.url)
    if (!res.ok) throw new Error(`server download -> HTTP ${res.status}`)
    fs.writeFileSync(jar, Buffer.from(await res.arrayBuffer()))
    if (!ok()) throw new Error('downloaded server jar does not match the SHA-1 in the manifest')
  }
  return { jar, needJava }
}

/**
 * @param {object} o
 * @param {string} [o.dir]
 * @param {string} [o.version]
 * @param {number} [o.port]
 * @param {boolean} [o.acceptEula] you must opt in: the EULA is yours to accept, not this script's
 * @param {string} [o.java]
 * @param {boolean} [o.echo] copy the server's output to this process's stdout
 * @param {boolean} [o.freshWorld] delete the world before starting (default true)
 */
async function startServer ({ dir = path.join(process.cwd(), '.mc-server'), version = '26.1', port = DEFAULT_PORT, acceptEula = false, java = process.env.JAVA || 'java', echo = false, freshWorld = true } = {}) {
  if (!acceptEula) {
    throw new Error('Pass acceptEula / --accept-eula to confirm you accept the Minecraft EULA (https://aka.ms/MinecraftEULA).')
  }
  await assertPortFree(port)
  fs.mkdirSync(dir, { recursive: true })
  const { jar, needJava } = await ensureJar(dir, version)
  const have = javaMajor(java)
  if (have === null) throw new Error(`Could not run "${java}". Install Java ${needJava || ''} or set the JAVA environment variable.`)
  if (needJava && have < needJava) {
    throw new Error(`Minecraft ${version} needs Java ${needJava} or newer; "${java}" is Java ${have}. Set JAVA to a newer java executable.`)
  }

  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n')
  // Conditions close to a real survival server on purpose: no flight allowed, so the
  // server's vehicle movement checks are the real ones.
  if (freshWorld) {
    // The server is disposable test infrastructure, and a world made under different
    // settings would keep its old generator, so start from nothing every time.
    fs.rmSync(path.join(dir, 'world'), { recursive: true, force: true })
  }
  fs.writeFileSync(path.join(dir, 'server.properties'), serverProperties(port))

  const watcher = createLogWatcher()
  const logs = watcher.logs
  const proc = spawn(java, ['-Xmx1G', '-jar', path.basename(jar), 'nogui'], { cwd: dir })

  const onData = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (!line) continue
      watcher.push(line)
      if (/\bhorizon\b.* joined the game/.test(line) && !exited) proc.stdin.write('op horizon\ngamemode creative horizon\n')
      if (echo) console.log(`[server] ${line}`)
    }
  }
  
  proc.stdout.on('data', onData)
  proc.stderr.on('data', onData)
  let exited = false
  process.on('exit', () => { if (!exited) proc.kill() }) // never leave a server running behind us
  proc.on('exit', (code) => { exited = true; watcher.failAll(`server exited (code ${code})`) })

  const server = {
    proc,
    port,
    dir: path.resolve(dir),
    logs,
    send: (cmd) => { if (!exited) proc.stdin.write(`${cmd}\n`) },
    waitForLog: watcher.waitForLog,
    stop: () => new Promise((resolve) => {
      if (exited) return resolve()
      proc.once('exit', resolve)
      server.send('stop')
      setTimeout(() => { if (!exited) proc.kill() }, 15000)
    })
  }
  await server.waitForLog(/Done \(/, 180000)
  return server
}

/**
 * Walk up the Mocha suite chain and return the title of the top-level suite
 * (the one whose parent is the invisible root).
 * @param {import('mocha').Test} test
 */
function getTopSuiteTitle (test) {
  let s = test.parent
  while (s && s.parent && !s.parent.root) s = s.parent
  return s ? s.title : ''
}

/**
 * Spawn position horizon is teleported to before each test when --supervising is active.
 * Keyed by the top-level suite title; unrecognised suites get no TP.
 */
const SUITE_TO_AREA = {
  'pathfinder Goals': { x: 8.5, y: 1, z: 8.5 }, // flatArena
  'pathfinder events': { x: 8.5, y: 1, z: 8.5 },
  'pathfinder util functions': { x: 8.5, y: 1, z: 8.5 },
  'pathfinder Movement': { x: 8.5, y: 1, z: 8.5 },
  'human walker': { x: 8.5, y: 1, z: 8.5 },
  'Parkour path test': { x: 0.5, y: 3, z: 12.5 }, // parkourArena
  'Physics test': { x: 0.5, y: 3, z: 12.5 },
  'pathfinder entity avoidance test': { x: 0.5, y: 3, z: 12.5 },
  'human walker on an island': { x: 8.5, y: 57, z: 2.5 } // trenchArena
  // 'server movement validation' needs no TP: it only checks recorded rubber-bands
}

/** Suite titles that embed the version, so they are matched by a fragment of the title. */
const SUITE_FRAGMENT_TO_AREA = [
  ['boat crossing', { x: 10.5, y: 100, z: 15.5 }],
  ['hostile mob avoidance', { x: 201.5, y: 5, z: 231.5 }], // hostileArena, 62 wide: the bot starts in the middle
  ['bot pathfinds through the maze', { x: 401.5, y: 201, z: 413.5 }] // mazeArena, movementTest.js
]

/** Where the supervising player should stand for a top-level suite, or null for none. */
function areaForSuite (title) {
  if (SUITE_TO_AREA[title]) return SUITE_TO_AREA[title]
  const match = SUITE_FRAGMENT_TO_AREA.find(([fragment]) => title.includes(fragment))
  return match ? match[1] : null
}

/**
 * Run every live test file (scripts/live-files.js) in this process, against the server that is
 * already up. The tests find that server through `module.exports.current`.
 * @param {string} version
 * @param {{ supervising?: boolean, retries?: number, server?: object }} [opts]
 * @returns {Promise<number>} the number of failed tests
 */
function runLiveTests (version, { supervising = false, retries = 0, server = null } = {}) {
  return new Promise((resolve) => {
    let Mocha
    try {
      Mocha = require('mocha')
    } catch (e) {
      console.error('[live-server] mocha is not installed, so the tests cannot run (run `npm install`). The server is still up.')
      return resolve(1)
    }
    process.env.PF_LIVE = '1'
    process.env.PF_LIVE_VERSION = version
    const mocha = new Mocha({ timeout: 300000 })
    if (process.env.PF_LIVE_GREP) mocha.grep(process.env.PF_LIVE_GREP)

    // --retry=N: re-run each failing test up to N extra times before counting it as failed.
    if (retries > 0) mocha.suite.retries(retries)

    // --supervising: mirror every bot tp onto horizon, 5 blocks higher.
    if (supervising && server) {
      const send = server.send
      server.send = (cmd) => {
        send(cmd)
        const m = /^tp pf_\S+ (\S+) (\S+) (\S+)$/.exec(cmd)
        if (m) send(`tp horizon ${m[1]} ${Number(m[2]) + 5} ${m[3]}`)
      }
    }

    for (const file of liveFiles) mocha.addFile(path.join(__dirname, '..', 'test', 'live', file))
    mocha.run((failures) => resolve(failures))
  })
}

module.exports = { startServer, javaMajor, serverProperties, runLiveTests, assertPortFree, createLogWatcher, areaForSuite, DEFAULT_PORT, current: null }

if (require.main === module) {
  const args = process.argv.slice(2)
  const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def }
  if (args.includes('--help')) {
    console.log([
      'usage: node scripts/live-server.js --accept-eula [options]',
      '',
      'options:',
      '  --version <id>   Minecraft version to run (default: 26.1)',
      '  --port <n>       Server port (default: 25565)',
      '  --dir <path>     Server directory (default: .mc-server)',
      '  --keep-world     Do not wipe the world on start',
      '  --no-tests       Start server only, do not run tests',
      '  --log-moves      Print every movement sample to stdout',
      '  --supervising    Wait for player "horizon" to join before starting tests,',
      '                   then TP them to the right area before each test (3 s pause)',
      '  --retry=N        Re-run each failing test up to N extra times'
    ].join('\n'))
    process.exit(0)
  }
  const version = opt('version', '26.1')
  const supervising = args.includes('--supervising')
  const retryArg = args.find(a => /^--retry=\d+$/.test(a))
  const retryN = retryArg ? parseInt(retryArg.split('=')[1], 10) : 0
  startServer({ dir: opt('dir'), version, port: Number(opt('port', DEFAULT_PORT)), acceptEula: args.includes('--accept-eula'), echo: true, freshWorld: !args.includes('--keep-world') })
    .then(async (server) => {
      module.exports.current = server
      if (args.includes('--log-moves')) process.env.PF_LIVE_MOVELOG = 'console'
      console.log(`[live-server] up on port ${server.port}. Type server commands here; Ctrl+C to stop.`)
      process.stdin.on('data', d => server.send(d.toString().trim()))
      process.on('SIGINT', () => server.stop().then(() => process.exit(0)))
      if (args.includes('--no-tests')) return
      if (supervising) {
        // In supervising mode, block until horizon actually joins rather than waiting for Enter.
        console.log('[live-server] supervising mode — waiting for player "horizon" to join...')
        await server.waitForLog(/\bhorizon\b.* joined the game/, 24 * 60 * 60 * 1000)
        console.log('[live-server] horizon is in — starting supervised test run...')
      } else {
        console.log('[live-server] ready — join localhost:' + server.port + ' now, then press Enter here to start the first test...')
        await new Promise(resolve => process.stdin.once('data', resolve))
        console.log('[live-server] running the live tests against it: the boat crossing, then every suite ported to the real server (--no-tests to skip)...')
      }
      const failures = await runLiveTests(version, { supervising, retries: retryN, server })
      console.log(failures === 0
        ? '[live-server] all live tests passed. The server is still up: join localhost:' + server.port + ', or Ctrl+C to stop.'
        : `[live-server] ${failures} live test(s) FAILED. The server is still up for inspection; Ctrl+C to stop.`)
    })
    .catch((err) => { console.error(`[live-server] ${err.message}`); process.exit(1) })
}
