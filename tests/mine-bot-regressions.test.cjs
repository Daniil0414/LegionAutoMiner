const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'mine-bot.user.js'), 'utf8');

// Exercise the userscript's actual functions without loading its UI or contacting the game.
function functionSource(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `Missing function: ${name}`);
  const end = /\r?\n  }\r?\n/.exec(source.slice(start));
  assert.ok(end, `Missing function end: ${name}`);
  return source.slice(start, start + end.index + end[0].length);
}

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing section: ${start}`);
  return source.slice(from, to);
}

function jsonResponse(payload, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(payload),
    json: async () => structuredClone(payload),
    clone: () => jsonResponse(payload, status),
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function mineContext(transport) {
  const active = { n: 3, deep: 3, seed: 'floor3', dug: '0', drills: [] };
  const g = {
    ME: { user: { login: 'me' } },
    __mineBotRunning: true,
    __lgMineState: active,
    __lgMineS: { st: active, me: { at: 3 } },
    fetch: transport,
  };
  const context = vm.createContext({
    G: g, window: g, URL, location: { href: 'https://example.test/c/test' },
    fetch: (...args) => g.fetch(...args), basePath: '/c/test',
    isPaused: false, currentMineId: 'home', lastFloorN: 3, lastFloorSeed: 'floor3',
    lastDugString: '', lastDg: {}, lastTargetKey: 7, activeMiningRockIndex: 7,
    cachedFloorCellMap: new Map(), timer: null, lastMineStatePoll: 0,
    isMineStatePolling: false, getMyNick: () => 'me', updateMineSelectorUI: () => {},
    updateStatsUI: () => {}, makeStealthNative: () => {}, step: () => {},
    setTimeout: () => 1, clearTimeout: () => {},
  });
  vm.runInContext(functionSource('handleStateUpdate'), context);
  g.__mineHandleStateUpdate = context.handleStateUpdate;
  vm.runInContext(section('  if (!G.__mineFetchHooked) {', '  // Перехват контекста Города'), context);
  vm.runInContext(functionSource('gameApi') + functionSource('refreshMineStateFromServer'), context);
  return context;
}

test('floor snapshots do not replace the active floor, target, or player position', async () => {
  let sentOptions;
  const context = mineContext(async (_url, options) => {
    sentOptions = options;
    return jsonResponse({ ok: true, st: { n: 1, deep: 3, seed: 'floor1', dug: '0' }, me: { at: 3 } });
  });
  await context.gameApi('/api/mine/state?c=home.1', { mineSnapshotOnly: true });
  await flush();
  assert.equal(context.currentMineId, 'home');
  assert.equal(context.G.__lgMineState.n, 3);
  assert.equal(context.G.__lgMineS.me.at, 3);
  assert.equal(context.lastTargetKey, 7);
  assert.equal(sentOptions.mineSnapshotOnly, undefined);
});

test('a native preview of another floor does not update active mine state', async () => {
  const context = mineContext(async () => jsonResponse({ ok: true, st: { n: 1, deep: 3, seed: 'floor1' } }));
  await context.G.fetch('/api/mine/state?c=home.1');
  await flush();
  assert.equal(context.currentMineId, 'home');
  assert.equal(context.G.__lgMineState.n, 3);
});

test('active floor polling still updates mine state', async () => {
  const context = mineContext(async () => jsonResponse({ ok: true, st: { n: 3, deep: 3, seed: 'floor3', dug: '1' } }));
  await context.gameApi('/api/mine/state?c=home');
  await flush();
  assert.equal(context.G.__lgMineState.dug, '1');
  assert.equal(context.currentMineId, 'home');
});

test('a delayed poll cannot overwrite state after switching mines', async () => {
  let release;
  const context = mineContext(() => new Promise(resolve => { release = resolve; }));
  const polling = context.refreshMineStateFromServer(true);
  context.currentMineId = 'home.2';
  context.G.__lgMineState = { n: 2, deep: 3, seed: 'floor2' };
  release(jsonResponse({ ok: true, st: { n: 3, deep: 3, seed: 'floor3' } }));
  await polling;
  await flush();
  assert.equal(context.currentMineId, 'home.2');
  assert.equal(context.G.__lgMineState.n, 2);
});

for (const status of [409, 429, 503]) {
  test(`JSON errors retain HTTP ${status} even when a native API is available`, async () => {
    let nativeCalls = 0;
    const context = vm.createContext({
      G: { __lgAucContext: { api: async () => { nativeCalls++; return { ok: false, error: 'busy' }; } } },
      basePath: '/c/test', fetch: async () => jsonResponse({ ok: false, error: 'busy' }, status),
    });
    vm.runInContext(functionSource('gameApi'), context);
    const result = await context.gameApi('/api/aucBuy', { method: 'POST', body: '{"lot":"one"}' });
    assert.equal(result.status, status);
    assert.equal(result.ok, false);
    assert.equal(nativeCalls, 0);
  });
}

test('an HTTP error cannot be treated as a successful purchase', async () => {
  const context = vm.createContext({ G: {}, basePath: '', fetch: async () => jsonResponse({ ok: true }, 429) });
  vm.runInContext(functionSource('gameApi'), context);
  const result = await context.gameApi('/api/aucBuy', { method: 'POST', body: '{}' });
  assert.equal(result.status, 429);
  assert.equal(result.ok, false);
});

test('non-purchase actions retain the native API path', async () => {
  const context = vm.createContext({
    G: { __lgMineContext: { api: async () => ({ ok: true, native: true }) } },
    fetch: async () => { throw new Error('Unexpected fetch'); }, basePath: '',
  });
  vm.runInContext(functionSource('gameApi'), context);
  assert.equal((await context.gameApi('/api/mineDrill', { method: 'POST', body: '{}' })).native, true);
});

function auctionContext(buyResults) {
  const lot = { id: 'one', p: 100, i: 'ore', n: 1 };
  const g = { __mineBotRunning: true, ME: {} };
  const requests = [];
  const context = vm.createContext({
    G: g, window: g, isAutoBuy: true, isAutoBuyInProgress: false,
    attemptedAutoBuyLots: new Set(), lastAutoBuyCandidates: [], isFetchingAuction: false,
    cityStockLoaded: true, lastAuctionData: null, aucStatus: null, aucClaimBtn: null,
    bAucAutoBuy: { checked: true }, cachedHeroCoins: 1000, aucFilter: { value: 'deals50' },
    aucSearch: { value: '' }, ENCH_BONUS: [], aucBadge: null, aucList: null,
    getLotEvaluation: () => ({ name: 'item', discount: 60 }), isRarityAllowed: () => true,
    setSuperDealTitle: () => {}, updateMiniDealUI: () => {}, updateStatsUI: () => {},
    getMyCoins: () => 1000, refreshMyCoinsFromApi: async () => 1000,
    showToast: () => {}, formatCoins: String, scanPlayers: () => {},
    setTimeout: fn => { fn(); return 1; }, clearTimeout: () => {}, clearInterval: () => {},
    gameApi: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/auction') return context.pollResult;
      const next = buyResults.shift();
      if (typeof next === 'function') return next();
      assert.ok(next, 'Unexpected extra purchase');
      return next;
    },
  });
  context.pollResult = { ok: true, v: 1, lots: [lot] };
  for (const name of ['fetchAuctionData', 'renderMarketLots', 'processAutoBuy']) {
    vm.runInContext(functionSource(name), context);
  }
  return { context, requests, lot, buys: () => requests.filter(r => r.url === '/api/aucBuy').length };
}

test('a temporary failure is retried when the auction version is unchanged', async () => {
  const { context, buys } = auctionContext([{ ok: false, error: 'network failure' }, { ok: true }]);
  await context.fetchAuctionData(true);
  await flush();
  await context.fetchAuctionData(true);
  await flush();
  assert.equal(buys(), 2);
  await context.fetchAuctionData(true);
  await flush();
  assert.equal(buys(), 2, 'A successful lot must not be purchased twice');
});

test('a rate-limited purchase is retried after an unchanged HTTP 304 snapshot', async () => {
  const { context, buys } = auctionContext([{ ok: false, status: 429, error: 'busy' }, { ok: true }]);
  await context.fetchAuctionData(true);
  await flush();
  context.pollResult = { ok: true, notModified: true, status: 304 };
  await context.fetchAuctionData(true);
  await flush();
  assert.equal(buys(), 2);
});

test('sold lots remain excluded from retries', async () => {
  const { context, buys } = auctionContext([{ ok: false, status: 409, error: 'busy' }]);
  await context.fetchAuctionData(true);
  await flush();
  await context.fetchAuctionData(true);
  context.pollResult.v = 2;
  await context.fetchAuctionData(true);
  await flush();
  assert.equal(buys(), 1);
});

test('closing the bot stops the remaining purchase queue and follow-up polling', async () => {
  let release;
  const { context, requests, buys } = auctionContext([
    () => new Promise(resolve => { release = resolve; }), { ok: true },
  ]);
  Object.assign(context, {
    isPaused: false, timer: null, liveProgressTimer: null, refreshMinesTimer: null,
    aucPollTimer: null, titleBlinkInterval: null, bgWorker: null, bgAudioCtx: null,
    document: { title: 'Game', getElementById: () => null, body: { classList: { remove: () => {} } } },
    originalDocumentTitle: 'Game', hideAucTooltip: () => {}, aucTooltip: null,
    setGhostVisuals: () => {}, ghostBodyObserver: null, w: { remove: () => {} },
  });
  vm.runInContext(section('  window.__mineBotStop = () => {', "  w.querySelector('#b-cls')"), context);
  const pending = context.processAutoBuy([
    { lot: { id: 'first', p: 100 }, ev: { name: 'first' } },
    { lot: { id: 'second', p: 100 }, ev: { name: 'second' } },
  ]);
  context.window.__mineBotStop();
  release({ ok: true });
  await pending;
  assert.equal(buys(), 1);
  assert.equal(requests.length, 1, 'No refresh should start after shutdown');
  assert.equal(context.isAutoBuy, false);
  assert.equal(context.isPaused, true);
});
