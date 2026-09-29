Add these
Predictive movement for basically everything and
Walking\nSprinting\nSneaking\nJumping\nSprint-jumping\nBunny hopping\nDiagonal movement\nStrafing\nAir strafing\nMomentum preservation\nMomentum-based turning\nJump timing optimization\nEdge jumps\nCorner cutting\nDirect-line movement\nShortest safe fall\nControlled falling\nDrop shortcuts\nAuto-step movement\n1-block jumps\n2-block jumps\nLong jumps\nNeo jumps\nCorner jumps\nFence jumps\nWall jumps\nHead-hitter jumps\nHead-hitter sprint jumps\nLow-ceiling sprint jumps\nTrapdoor jumps\nSlab jumps\nStair jumps\nLadder jumps\nLadder jumps around corners\nMomentum jumps\nJump chaining\nEdge-to-edge jumps\nPrecision landing\nJump-through gaps\nVertical parkour\nHorizontal parkour\nSlabs\nStairs\nWalls\nFences\nFence gates\nTrapdoors\nDoors\nScaffolding\nLadders\nVines\nWeeping vines\nTwisting vines\nGlow berries\nPowder snow\nSweet berry bushes\nCobwebs\nHoney blocks\nSlime blocks\nIce\nPacked ice\nBlue ice\nSoul sand\nSoul soil\nIce sliding\nPacked-ice sliding\nBlue-ice sliding\nIce momentum preservation\nIce cornering\nIce braking\nIce-to-normal-ground transitions\nIce-to-water transitions\nIce highways\nBoat-on-ice travel\nBoat-on-packed-ice travel\nBoat-on-blue-ice travel\nSwimming\nSprint swimming\nWater-entry momentum\nWater-exit momentum\nSwimming through 1-block gaps\nWater shortcuts\nWater currents\nBubble columns\nBubble-column ascent\nBubble-column descent\nDolphin's Grace movement\nWater-to-land transitions\nLand-to-water transitions\nWaterlogged-block movement\nBoat travel\nBoat acceleration\nBoat steering\nBoat turning\nBoat braking\nBoat launching\nBoat retrieval\nBoat shortcuts\nBoat-to-land transitions\nLand-to-boat transitions\nPillaring\nTowering\nJump-place\nJump-place-jump\nBlock stacking while moving\nFast staircase construction\nLadder climbing\nVine climbing\nScaffolding climbing\nWater-column climbing\nBubble-column climbing\nClimb-to-jump transitions\nClimb-to-fall shortcuts\nVertical drop shortcuts\nSafe fall detection\nFall-distance optimization\nWater landing\nPowder-snow landing\nHay-bale landing\nSlime landing\nBed landing\nBoat landing\nVine landing\nLadder catching\nScaffolding catching\nWater-bucket MLG\nPowder-snow MLG\nVine MLG\nLadder MLG\nScaffolding MLG\nBoat MLG\nHay-bale MLG\nSlime MLG\nElytra activation\nElytra takeoff\nElytra gliding\nElytra turning\nElytra diving\nElytra climbing\nDive-to-pull-up\nTerrain-following flight\nFirework boosting\nRocket timing\nRocket conservation\nFlight trajectory prediction\nMidair correction\nLanding prediction\nElytra landing\nElytra-to-ground transition\nElytra-to-water transition\nElytra-to-boat transition\nTower launches\nCliff launches\nPistons\nSlime launchers\nTNT launchers\nFlying machines\nMinecart travel\nPowered rails\nDetector-rail routing\nRail shortcuts\nMinecart launches\nMinecart braking\nMinecart-to-land transitions\nNether roof travel\nNether highway travel\nIce-boat Nether highways\nLava swimming\nStrider riding\nStrider steering\nStrider lava shortcuts\nNether portal travel\nPortal route optimization\nPortal chaining\nCoordinate-based Nether shortcuts\nEnder pearl movement\nPearl trajectory prediction\nPearl landing prediction\nPearl-to-movement transition\nChorus fruit teleportation\nEnd gateway travel\nEnd portal travel\nVoid-safe movement\nEnder pearls\nChorus fruit\nNether portals\nEnd portals\nEnd gateways\nHorse riding\nHorse jumping\nHorse sprinting\nHorse turning\nHorse acceleration\nDonkey riding\nMule riding\nPig riding\nStrider riding\nCamel riding\nBoat riding\nMinecart riding\nEntity collision pushing\nWater-current entities\nBoat collision\nMinecart collision\nPiston propulsion\nSlime propulsion\nTNT propulsion\nWind-charge propulsion\nProjectile trajectory prediction\nMomentum chaining\nWind charges\nFirework rockets\nCrawl movement\nCrawl-to-stand transitions\nSwimming-to-crawling\nSwimming-to-walking\nSneak-edge movement\nPowder-snow traversal\nCobweb traversal\nSweet-berry traversal\nBubble-column transitions\nPortal transitions\nDimension-transition routing

N = 6
First step just warms up cache (reads all files & cache to cache.md)
<instructions>
N AIs will contribute to one coding task, one step at a time. Each AI has no memory of prior AIs and no access to any conversation — everything it needs must be recoverable from the ZIP alone.

The only context provided to each AI is a ZIP containing:

- "CONTEXT.md"
- "PROMPT.md"
- "CACHE.md"
- "*files"

Create "CONTEXT.md" and "CACHE.md" if they do not exist.
</instructions>

<session_start priority="mandatory">
Read in this exact order before touching any source file:

1. <read_first>PROMPT.md</read_first> — the task.
2. <read_second>CONTEXT.md</read_second> — current progress and what to do this step.
3. <read_third>CACHE.md</read_third> — the file index and known facts.
4. Only then open source files — and only the ones relevant to this step. See <file_reading> below. Do not read the whole project tree by default.
</session_start>

<file id="PROMPT.md">
<purpose>Contains the actual task.</purpose>
<edit_permission>NEVER EDIT THIS FILE.</edit_permission>
</file>

<file id="CONTEXT.md">
<purpose>Editable persistent context that carries across sessions and steps.</purpose>
<edit_permission>Overwrite/append per the schema below every step.</edit_permission>
<required_schema>
<status>
step: <N> / <max 6>
completed_steps:
  - <one line: what was done, not how>
  - ...
</status>

<next_step>
<!-- Exactly what the next AI should do. Be specific — the next AI has no other source of intent. -->
</next_step>

<open_items>
<!-- Unresolved decisions or blockers, and why. Remove/resolve once settled — don't let these pile up. -->
</open_items>
</required_schema>
<update_rule>Overwrite <status> and <next_step> each session. Append to completed_steps. Resolve or remove entries in <open_items> as they close.</update_rule>
</file>

<file id="CACHE.md">
<purpose>Fast, searchable context — structured, not narrative — so a later AI can jump straight to what it needs instead of reading everything.</purpose>
<required_schema>
<file_index>
<path>...</path><purpose>one line</purpose>
<path>...</path><purpose>one line</purpose>
</file_index>

<topic name="...">
<!-- Terse facts, decisions, gotchas, function signatures, env vars, endpoints relevant to this topic. No prose. -->
</topic>
</required_schema>
<update_rule>When you learn something later steps will likely need (an API shape, a convention, a gotcha, a reason something was done a certain way), add it under the relevant &lt;topic&gt;. Update &lt;file_index&gt; whenever you add or rename a file.</update_rule>
</file>

<file_reading>
- Do not re-read the entire project every step.
- Read only: the files you are editing this step, plus whatever CACHE.md's file_index/topics already tell you about files you aren't touching.
- If CACHE.md doesn't cover something you need from a file you aren't editing, read just that file — then summarize what you learned into CACHE.md so the next AI does not repeat the read.
</file_reading>

<steps>
- Maximum 6 steps.
- Each AI handles one slice of the task.
- If a step is difficult, split it into smaller steps.
- Code does not have to be finished in one step.
- After completing a slice: update CONTEXT.md per its schema, update CACHE.md per its schema, then pass the resulting project ZIP to the next AI.
</steps>

<hard_rules>
- Do not edit PROMPT.md.
- CONTEXT.md and CACHE.md are the only continuity between isolated AIs — treat their schemas as contracts, not suggestions.
</hard_rules>
</final>
