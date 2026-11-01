const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'mine-bot.user.js'), 'utf8');

function functionSource(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  if (start < 0) return null;
  const end = /\r?\n  }\r?\n/.exec(source.slice(start));
  assert.ok(end, `Missing end of ${name}`);
  return source.slice(start, start + end.index + end[0].length);
}

function miningContext() {
  const clock = { now: 1_000_000 };
  const state = { n: 3, deep: 3, seed: 'floor3', dug: '00000' };
  const clicks = [];
  const rides = [];
  const categories = { 0: 'rock', 1: 'gold', 2: 'coal', 3: 'gold' };
  const g = { __mineBotRunning: true, __lgMineState: state, __lgMineS: { st: state, here: 1, hw: 1 } };
  const context = vm.createContext({
    G: g, oreFirst: true, isRatingMode: false, oreTargetLock: null,
    currentMineId: 'home', activeMiningRockIndex: 1, lastTargetKey: '1',
    targetAssignedTime: clock.now - 10_000, lastRockSwitchTime: clock.now - 100_000,
    lastMiningConfirmedTime: 0, lastKnownMiningProgress: null, idleHeroDetectedTime: 0,
    lastMineStatePoll: clock.now, lastMineOpenAttempt: 0, lastFloorTransitionTime: 0,
    isRidingLift: false, pendingLiftRide: null, autoLiftBestFloor: true, isPaused: false,
    isCheckingLiftFloors: false, lastLiftCheckTime: clock.now,
    blacklist: new Map(), mode: 'screen', ratingCrowdRange: '2-5', mining: true,
    customPriorities: ['coal', 'iron', 'gold', 'rock'].map(id => ({ id, enabled: true })),
    Date: class extends Date { static now() { return clock.now; } },
    document: { querySelector: () => null, body: { textContent: '' } },
    st: { textContent: '', style: {} }, pMineWrap: null, pMinePct: null,
    pMineTime: null, pMineBar: null,
    closeNewsModal: () => {}, isDailyMiningCapReached: () => false,
    isMining: () => context.mining,
    getActiveMiningRockIndex: () => context.activeMiningRockIndex,
    getCandidateRocks: () => context.candidates,
    getRockCategory: index => categories[index] || 'rock',
    getRockDistance: () => 1, isRockPathReachable: () => true,
    getRockMiningProgress: () => ({ pct: 20, remPct: 80, etaText: '10s' }),
    getCandidateHpProgress: () => ({ remPct: 80 }),
    isValuableRock: index => categories[index] !== 'rock',
    parseRatingCrowdRange: () => [2, 5],
    formatRockName: () => 'ore', getCurrentMiningRockName: () => 'ore',
    isTargetMineOpen: () => true, checkTipError: () => null,
    refreshMineStateFromServer: () => { context.lastMineStatePoll = clock.now; },
    scheduleOreRefreshAfterDig: () => {}, showToast: () => {},
    clickTarget: candidate => { clicks.push(String(candidate.rockId)); return true; },
    executeLiftRide: (floor, count, percent) => { rides.push({ floor, count, percent }); },
    gameApi: async url => {
      const room = new URL(url, 'https://example.test').searchParams.get('c');
      const floor = Number(room.split('.')[1] || state.deep);
      return { ok: true, st: { n: floor }, here: floor === 1 ? 30 : 3, hw: 1 };
    },
    setTimeout: fn => { fn(); return 1; }, console,
  });
  context.candidates = [
    { rockId: '1', count: 1, isMe: true, isFar: false, inBlacklist: false },
    { rockId: '2', count: 20, isMe: false, isFar: false, inBlacklist: false },
  ];
  for (const name of ['getRockPriorityTier', 'rememberOreTarget', 'getOreTargetLock', 'stepScreen', 'checkAndSelectBestFloor', 'checkAutoLiftStep']) {
    const code = functionSource(name);
    if (code) vm.runInContext(code, context);
  }
  return { context, clock, state, clicks, rides };
}

test('ore mode finishes the current vein despite a higher-priority ore and larger crowd', () => {
  const { context, clicks } = miningContext();
  context.stepScreen();
  assert.deepEqual(clicks, []);
  assert.equal(context.lastTargetKey, '1');
});

test('ore mode does not switch to a larger crowd on the same ore category', () => {
  const { context, clicks } = miningContext();
  context.candidates[1].rockId = '3';
  context.stepScreen();
  assert.deepEqual(clicks, []);
  assert.equal(context.lastTargetKey, '1');
});

test('a chosen vein remains selected through walking timeouts and transient UI loss', () => {
  const { context, clock, clicks } = miningContext();
  context.mining = false;
  context.activeMiningRockIndex = -1;
  context.lastTargetKey = null;
  context.candidates = [{ rockId: '1', count: 1, isMe: false }];
  context.stepScreen();
  assert.deepEqual(clicks, ['1']);
  clock.now += 30_000;
  context.candidates = [
    { rockId: '1', count: 0, isMe: false, isFar: true, inBlacklist: true },
    { rockId: '2', count: 20, isMe: false },
  ];
  context.stepScreen();
  assert.ok(clicks.every(index => index === '1'));
  assert.equal(context.lastTargetKey, '1');
});

test('a missing DOM candidate cannot replace an unfinished locked vein', () => {
  const { context, clock, clicks } = miningContext();
  context.stepScreen();
  context.mining = false;
  clock.now += 10_000;
  context.candidates = [{ rockId: '2', count: 20, isMe: false }];
  context.stepScreen();
  assert.ok(clicks.every(index => index === '1'));
  assert.equal(context.lastTargetKey, '1');
});

test('a long walk to the locked vein is not restarted by repeated clicks', () => {
  const { context, clock, clicks } = miningContext();
  context.mining = false;
  context.activeMiningRockIndex = -1;
  context.lastTargetKey = null;
  context.candidates = [{ rockId: '1', count: 1, isMe: false }];
  context.stepScreen();
  context.G.__lgMineS.path = [{ x: 1, y: 1 }, { x: 2, y: 2 }];
  clock.now += 30_000;
  context.stepScreen();
  assert.deepEqual(clicks, ['1']);
});

test('an apparent 100 percent progress does not unlock a vein before server confirmation', () => {
  const { context, clock, clicks } = miningContext();
  context.stepScreen();
  context.mining = false;
  clock.now += 10_000;
  context.getRockMiningProgress = () => ({ pct: 100, remPct: 0, etaText: '0s' });
  context.candidates[0].isMe = false;
  context.stepScreen();
  assert.ok(clicks.every(index => index === '1'));
  assert.equal(context.lastTargetKey, '1');
});

test('server-confirmed depletion allows the next vein to be selected', () => {
  const { context, clock, state, clicks } = miningContext();
  context.stepScreen();
  state.dug = '01000';
  context.mining = false;
  clock.now += 10_000;
  context.candidates = [{ rockId: '2', count: 20, isMe: false }];
  context.stepScreen();
  assert.deepEqual(clicks, ['2']);
  assert.equal(context.lastTargetKey, '2');
});

test('changing floors releases the previous vein', () => {
  const { context, clock, state, clicks } = miningContext();
  context.stepScreen();
  Object.assign(state, { n: 4, deep: 4, seed: 'floor4' });
  context.mining = false;
  clock.now += 10_000;
  context.candidates = [{ rockId: '2', count: 20, isMe: false }];
  context.stepScreen();
  assert.deepEqual(clicks, ['2']);
});

test('rating mode keeps its existing finish-current-rock behavior', () => {
  const { context, clicks } = miningContext();
  context.isRatingMode = true;
  context.oreFirst = false;
  context.stepScreen();
  assert.deepEqual(clicks, []);
});

test('crowd mode can still switch when ore mode is disabled', () => {
  const { context, clicks } = miningContext();
  context.oreFirst = false;
  context.stepScreen();
  assert.deepEqual(clicks, ['2']);
});

test('ordinary rock can still be abandoned for ore in ore mode', () => {
  const { context, clicks } = miningContext();
  context.activeMiningRockIndex = 0;
  context.lastTargetKey = '0';
  context.candidates[0].rockId = '0';
  context.stepScreen();
  assert.deepEqual(clicks, ['2']);
});

test('a late lift request cannot stop an unfinished locked vein', async () => {
  const { context } = miningContext();
  let stops = 0;
  context.stopMiningInGame = async () => { stops++; };
  context.candidates = [context.candidates[0]];
  context.stepScreen();
  vm.runInContext(functionSource('executeLiftRide'), context);
  await context.executeLiftRide(1, 30, 100);
  assert.equal(stops, 0);
  assert.equal(context.isRidingLift, false);
  assert.equal(context.activeMiningRockIndex, 1);
  assert.equal(context.pendingLiftRide.floor, 1);
});

test('a more populated floor waits for the selected vein to finish', async () => {
  const { context, rides } = miningContext();
  context.candidates = [context.candidates[0]];
  context.stepScreen();
  await context.checkAndSelectBestFloor();
  assert.deepEqual(rides, []);
  assert.equal(context.pendingLiftRide.floor, 1);
});

test('a queued crowd lift cannot exploit a transient mining-indicator gap', () => {
  const { context, rides } = miningContext();
  context.candidates = [context.candidates[0]];
  context.stepScreen();
  context.mining = false;
  context.pendingLiftRide = { floor: 1, count: 30, percent: 100 };
  context.checkAutoLiftStep();
  assert.deepEqual(rides, []);
});

test('a newly opened deeper floor can interrupt ore mining and supersedes a crowd lift', () => {
  const { context, state, rides } = miningContext();
  context.candidates = [context.candidates[0]];
  context.stepScreen();
  state.deep = 4;
  context.pendingLiftRide = { floor: 1, count: 30, percent: 100 };
  context.checkAutoLiftStep();
  assert.equal(rides.length, 1);
  assert.equal(rides[0].floor, 4);
});

test('a queued crowd lift is allowed after confirmed vein completion', () => {
  const { context, state, rides } = miningContext();
  context.candidates = [context.candidates[0]];
  context.stepScreen();
  state.dug = '01000';
  context.mining = false;
  context.pendingLiftRide = { floor: 1, count: 30, percent: 100 };
  context.checkAutoLiftStep();
  assert.equal(rides.length, 1);
  assert.equal(rides[0].floor, 1);
});
