/* eslint-env mocha */

// Tests for the parts of scripts/live-server.js that need no download and no Java: which port it
// uses, and what happens when that port is taken.

const assert = require('assert')
const fs = require('fs')
const net = require('net')
const path = require('path')
const { DEFAULT_PORT, serverProperties, assertPortFree, startServer, createLogWatcher, areaForSuite } = require('../scripts/live-server')

/** Listen on any free port and resolve with the server and the port it got. */
function occupy () {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, () => resolve({ server, port: server.address().port }))
  })
}

describe('live server: port', () => {
  it('defaults to Minecraft Java Edition\'s own port, 25565', () => {
    assert.strictEqual(DEFAULT_PORT, 25565)
  })

  it('writes that port into server.properties', () => {
    assert.match(serverProperties(DEFAULT_PORT), /^server-port=25565$/m)
  })

  it('still lets a different port be asked for explicitly', () => {
    assert.match(serverProperties(25566), /^server-port=25566$/m)
  })

  it('a free port passes the check', async () => {
    const { server, port } = await occupy()
    await new Promise(resolve => server.close(resolve)) // now it is free again
    await assertPortFree(port)
  })

  it('a port something already listens on fails with a message that says what to do', async () => {
    const { server, port } = await occupy()
    try {
      await assert.rejects(
        assertPortFree(port),
        (err) => new RegExp(`Port ${port} is already in use`).test(err.message) && /stop it, or pick another port with --port/.test(err.message)
      )
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('startServer refuses without the EULA flag before it touches the port or the network', async () => {
    const { server, port } = await occupy()
    try {
      await assert.rejects(startServer({ port }), /accept-eula/)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('startServer with the EULA accepted reports a taken port instead of starting a doomed server', async () => {
    const { server, port } = await occupy()
    try {
      await assert.rejects(startServer({ port, acceptEula: true, dir: require('os').tmpdir() }), /already in use/)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})

describe('live server: waiting for a log line', () => {
  const answer = (x) => `pf_bot has the following entity data: [${x}d, 1.0d, 8.5d]`
  const re = /pf_bot has the following entity data: \[([^\]]+)\]/

  it('finds a line that was logged before the call', async () => {
    const w = createLogWatcher()
    w.push('[Server] Done (0.6s)!')
    assert.match(await w.waitForLog(/Done \(/), /Done/)
  })

  it('waits for a line that has not been logged yet', async () => {
    const w = createLogWatcher()
    const pending = w.waitForLog(/joined the game/)
    w.push('pf_bot joined the game')
    assert.match(await pending, /joined the game/)
  })

  it('by default a repeated line is answered from the oldest one (which is wrong for a repeated query)', async () => {
    const w = createLogWatcher()
    w.push(answer('201.5'))
    w.push(answer('258.0'))
    assert.match(await w.waitForLog(re), /201\.5d/)
  })

  it('fresh: true ignores everything logged before the call and returns the answer to THIS request', async () => {
    const w = createLogWatcher()
    w.push(answer('201.5')) // the first request, long ago
    const pending = w.waitForLog(re, 1000, { fresh: true })
    w.push(answer('258.0')) // the answer to the second
    assert.match(await pending, /258\.0d/)
  })

  it('fresh: true times out with the recent log when nothing new arrives', async () => {
    const w = createLogWatcher()
    w.push(answer('201.5'))
    await assert.rejects(w.waitForLog(re, 50, { fresh: true }), /timed out after 50 ms[\s\S]*201\.5d/)
  })

  it('failAll rejects whatever is still waiting, and says why', async () => {
    const w = createLogWatcher()
    const pending = w.waitForLog(/never/, 5000)
    w.failAll('server exited (code 1)')
    await assert.rejects(pending, /server exited \(code 1\) while waiting for \/never\//)
  })

  it('a resolved wait is not resolved again by a later matching line', async () => {
    const w = createLogWatcher()
    const pending = w.waitForLog(/tick/, 1000)
    w.push('tick 1')
    w.push('tick 2')
    assert.strictEqual(await pending, 'tick 1')
  })
})

describe('live server: where the supervising player is sent', () => {
  it('knows the fixed suite titles', () => {
    assert.deepStrictEqual(areaForSuite('pathfinder Goals'), { x: 8.5, y: 1, z: 8.5 })
    assert.deepStrictEqual(areaForSuite('human walker on an island'), { x: 8.5, y: 57, z: 2.5 })
  })

  it('matches the suites whose titles embed the version by a fragment of the title', () => {
    assert.deepStrictEqual(areaForSuite('live boat crossing on a real 26.1 server'), { x: 10.5, y: 100, z: 15.5 })
    assert.deepStrictEqual(areaForSuite('hostile mob avoidance on a real 26.1 server'), { x: 201.5, y: 5, z: 205.5 })
  })

  it('gives no area for a suite that needs none', () => {
    assert.strictEqual(areaForSuite('server movement validation'), null)
  })
})

describe('live server: which test files run', () => {
  const liveFiles = require('../scripts/live-files')

  it('every live test file on disk is in the list, so a new one cannot be left out of a runner', () => {
    // hostileMobTest.js was once only in scripts/test.js, so running scripts/live-server.js never ran it.
    const onDisk = fs.readdirSync(path.join(__dirname, 'live')).filter(f => /Test\.js$/.test(f)).sort()
    assert.deepStrictEqual([...liveFiles].sort(), onDisk, 'test/live/ and scripts/live-files.js disagree')
  })

  it('runs the hostile-mob suite, after the suites that do not change the server difficulty', () => {
    assert.ok(liveFiles.includes('hostileMobTest.js'))
    assert.strictEqual(liveFiles[liveFiles.length - 1], 'hostileMobTest.js')
  })

  it('both runners take their files from that list rather than keeping their own', () => {
    for (const script of ['test.js', 'live-server.js']) {
      const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', script), 'utf8')
      assert.match(source, /require\('\.\/live-files'\)/, `scripts/${script} does not use scripts/live-files.js`)
    }
  })
})
