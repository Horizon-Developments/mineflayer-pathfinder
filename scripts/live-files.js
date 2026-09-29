'use strict'

/**
 * The live test files, in the order they run, relative to test/live/.
 *
 * Both ways of running them read this one list: `npm run test:live` (scripts/test.js) and
 * `node scripts/live-server.js` (which keeps the server up for you to join). Each used to hard-code
 * its own, and hostileMobTest.js was only in one of them, so the hostile-mob suite never ran from
 * live-server.js. test/liveServerTest.js fails if a *Test.js file in test/live/ is missing from here.
 *
 * Order matters: the boat crossing first, then every suite ported to the real server, then the
 * hostile-mob-avoidance suite (it switches the server to Easy for its own duration).
 */
module.exports = ['boatLiveTest.js', 'wholeSuiteLiveTest.js', 'movementTest.js', 'hostileMobTest.js']
