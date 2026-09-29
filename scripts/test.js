#!/usr/bin/env node
'use strict'

/**
 * `npm test`          the existing suite ("test:v1": lint + the fake-server tests, which run
 *                     at 26.1 with chunks built literally). No real server.
 * `npm test --v2`     everything: the suite above AND then the live boat crossing against a
 *                     real vanilla 26.1 server that this starts (test/live/boatLiveTest.js).
 *                     Both results are reported even if the first fails, so a lint error
 *                     cannot hide the live one. Exit code is non-zero if either failed.
 * `npm run test:live` only the real-server part.
 *
 * npm turns `--v2` into the environment variable npm_config_v2; `node scripts/test.js
 * --v2` and `npm test -- --v2` work too. Other knobs are the PF_LIVE_* variables
 * documented in test/live/boatLiveTest.js (PF_LIVE_VERSION, PF_LIVE_PORT, JAVA, ...).
 *
 * The Minecraft EULA is yours to accept, so the first run that starts a server asks. The
 * answer is remembered in .mc-server/.eula-accepted; non-interactive runs (CI) must set
 * PF_LIVE_ACCEPT_EULA=1 instead.
 */

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const { spawn } = require('child_process')
const liveFiles = require('./live-files')

const root = path.join(__dirname, '..')
const v2 = process.argv.includes('--v2') || /^(1|true)$/i.test(process.env.npm_config_v2 || '')
const liveOnly = process.argv.includes('--live')

function run (cmd, args, env = {}, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env }, ...opts })
    const forward = (sig) => () => { try { child.kill(sig) } catch (e) { /* gone */ } }
    process.on('SIGINT', forward('SIGINT'))
    process.on('SIGTERM', forward('SIGTERM'))
    child.on('error', (err) => { console.error(`[test] could not start ${cmd}: ${err.message}`); resolve(1) })
    child.on('exit', (code, signal) => resolve(code === null ? (signal ? 1 : 0) : code))
  })
}

async function eulaAccepted () {
  if (process.env.PF_LIVE_ACCEPT_EULA === '1') return true
  const marker = path.join(root, '.mc-server', '.eula-accepted')
  if (fs.existsSync(marker)) return true
  if (!process.stdin.isTTY) {
    console.error('[test] --v2 downloads and runs the official Minecraft server. Set PF_LIVE_ACCEPT_EULA=1 to confirm you accept the EULA (https://aka.ms/MinecraftEULA).')
    return false
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise(resolve => rl.question('--v2 downloads and runs the official Minecraft server.\nDo you accept the Minecraft EULA (https://aka.ms/MinecraftEULA)? [y/N] ', resolve))
  rl.close()
  if (!/^y(es)?$/i.test(answer.trim())) return false
  fs.mkdirSync(path.dirname(marker), { recursive: true })
  fs.writeFileSync(marker, `accepted ${new Date().toISOString()}\n`)
  return true
}

function runFakeServerSuite () {
  const npm = process.env.npm_execpath
  return npm
    ? run(process.execPath, [npm, 'run', 'test:v1'])
    : run('npm', ['run', 'test:v1'], {}, { shell: true })
}

async function runLiveSuite () {
  if (!(await eulaAccepted())) return 1

  let mocha
  try {
    mocha = require.resolve('mocha/bin/mocha.js', { paths: [root] })
  } catch (e) {
    console.error('[test] mocha is not installed. Run `npm install` first.')
    return 1
  }
  console.log(`[test] live: real Minecraft ${process.env.PF_LIVE_VERSION || '26.1'} server (first run downloads it; expect a minute or two)`)
  const grep = process.env.PF_LIVE_GREP ? ['--grep', process.env.PF_LIVE_GREP] : []
  // The files and their order live in scripts/live-files.js, shared with scripts/live-server.js.
  return run(process.execPath, [mocha, ...liveFiles.map(file => `test/live/${file}`), '--timeout', '300000', '--exit', ...grep], {
    PF_LIVE: '1',
    PF_LIVE_ACCEPT_EULA: '1'
  })
}

async function main () {
  if (liveOnly) return runLiveSuite()
  // Exactly what `npm test` did before this runner existed.
  if (!v2) return runFakeServerSuite()

  const fake = await runFakeServerSuite()
  const live = await runLiveSuite()
  const verdict = (code) => code === 0 ? 'passed' : `FAILED (exit ${code})`
  console.log(`\n[test] v2 summary: fake-server suite ${verdict(fake)}; live real-server suite ${verdict(live)}`)
  return fake !== 0 ? fake : live
}

main().then(code => process.exit(code))
