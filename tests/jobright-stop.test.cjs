const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const root = path.resolve(__dirname, "..");
const panel = fs.readFileSync(path.join(root, "sidepanel/sidepanel.js"), "utf8");
const content = fs.readFileSync(path.join(root, "content/jobright.js"), "utf8");

function load(source, names, context) {
  for (const name of names) {
    const match = source.match(new RegExp("^(?:async )?function " + name + "\\b[\\s\\S]*?^}\\r?$", "m"));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
}

const flush = () => new Promise(setImmediate);
function timers() {
  const pending = new Map();
  let id = 0;
  return {
    pending,
    setTimeout: (callback, delay) => { pending.set(++id, { callback, delay }); return id; },
    clearTimeout: (key) => pending.delete(key),
    tick: async (delay) => {
      for (const [key, timer] of [...pending]) {
        if (timer.delay !== delay) continue;
        pending.delete(key);
        timer.callback();
      }
      await flush();
    }
  };
}

function panelFixture({ claim, normalize, create, startError } = {}) {
  const clock = timers();
  const calls = { scripts: [], created: [], updates: [], statuses: [], logs: [], refreshes: 0 };
  const button = () => ({ disabled: false, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; },
    querySelector() { return { setAttribute: (key, value) => { this.attributes[key] = value; } }; } });
  let runNumber = 0;
  const context = vm.createContext({
    console: { error() {} }, URL, Date, AbortController, Set, ...clock,
    activeTabId: 8, areActionButtonsDisabled: false, isCurrentTabJobright: true,
    isTabGroupCleanupRunning: false, isJobrightOpening: false, jobrightOpenRun: null,
    openJobrightJobsButton: button(), jobrightPlayButton: button(), jobrightOpenCountInput: { value: "2" },
    createRunId: () => "run-" + ++runNumber,
    clearStatus() {}, updateTabGroupCleanupButtons() {},
    addLogForTab: (tabId, type, message) => calls.logs.push({ tabId, type, message }),
    showStatusForTab: (tabId, type, message) => calls.statuses.push({ tabId, type, message }),
    refreshCurrentTabActionAvailability: async () => { calls.refreshes++; context.updateJobrightOpenControlsDisabledState(); },
    chrome: {
      tabs: {
        get: async id => id === 8 ? { id: 8, windowId: 1, url: "https://jobright.ai/jobs/recommend" }
          : { id, windowId: 1, url: "https://employer.example/" + id },
        query: async () => [{ id: 8, windowId: 1 }],
        create: async options => {
          const tab = create ? await create(options) : { id: 100 + calls.created.length, ...options };
          calls.created.push(tab);
          return tab;
        },
        update: async (id, changes) => { calls.updates.push({ id, changes }); return { id, ...changes }; },
        goBack: async () => assert.fail("This scenario should not navigate back")
      },
      runtime: { sendMessage: async message => normalize ? normalize(message) : { ok: true, url: message.url } },
      scripting: { executeScript: async options => {
        calls.scripts.push({ name: options.func.name, args: [...(options.args || [])], tabId: options.target.tabId });
        switch (options.func.name) {
          case "startJobrightOpenRun": return [{ result: { ok: !startError, error: startError } }];
          case "describeJobrightHarvest": return [{ result: { ok: true, harvestedJobs: 5, harvestedWithUrl: 5 } }];
          case "claimNextJobrightApplication": return [{ result: claim ? await claim(options.args)
            : { found: true, jobId: "job-" + options.args[0].length, applyUrl: "https://employer.example/apply" } }];
          case "markJobrightApplicationAlreadyApplied": return [{ result: { ok: true } }];
          case "stopJobrightOpenRun": return [{ result: { ok: true } }];
          default: assert.fail("Unexpected script: " + options.func.name);
        }
      } }
    }
  });
  load(panel, ["isJobrightRecommendationsUrl", "normalizeJobrightOpenCount", "updateJobrightOpenControlsDisabledState",
    "startJobrightOpenRun", "stopJobrightOpenRun", "claimNextJobrightApplication", "clickJobrightApplyButton",
    "markJobrightApplicationAlreadyApplied", "describeJobrightHarvest", "throwIfJobrightOpenStopped",
    "waitForJobrightOpenOperation", "waitForJobrightOpenDelay", "stopJobrightJobs", "toggleJobrightJobs",
    "waitForJobrightApplicationTab", "filterJobrightApplicationTabUrl", "openJobrightJobs"], context);
  return { context, calls, clock };
}

test("Jobright Play becomes an enabled Stop during a main-button run and keeps opened tabs", async () => {
  const { context, calls, clock } = panelFixture();
  const running = context.openJobrightJobs();
  await flush();
  assert.equal(calls.created.length, 1);
  assert.equal(context.openJobrightJobsButton.disabled, true);
  assert.equal(context.jobrightPlayButton.disabled, false);
  assert.equal(context.jobrightPlayButton.attributes["aria-label"], "Stop Jobright");
  assert.equal(context.jobrightPlayButton.attributes.d, "M7 7h10v10H7z");

  // Stop must remain reachable after switching away from Recommendations.
  context.activeTabId = 99;
  context.isCurrentTabJobright = false;
  context.areActionButtonsDisabled = true;
  context.updateJobrightOpenControlsDisabledState();
  assert.equal(context.jobrightPlayButton.disabled, false);
  await context.toggleJobrightJobs();
  await running;
  assert.equal(clock.pending.size, 0);
  assert.equal(calls.created.length, 1);
  assert.equal(calls.scripts.filter(call => call.name === "markJobrightApplicationAlreadyApplied").length, 0);
  assert.ok(calls.scripts.filter(call => call.name === "stopJobrightOpenRun").every(call => call.tabId === 8 && call.args[0] === "run-1"));
  assert.deepEqual(calls.statuses, [{ tabId: 8, type: "info", message: "Open Jobright stopped. Kept 1 application tab already opened." }]);
  assert.equal(context.isJobrightOpening, false);
  assert.equal(context.jobrightOpenRun, null);
  assert.equal(context.jobrightPlayButton.attributes.d, "m8 5 11 7-11 7z");
  assert.equal(context.jobrightPlayButton.attributes["aria-label"], "Play Jobright");
});

test("Stop during a pending scan blocks its late result and prevents overlapping restarts", async () => {
  let completeScan;
  const { context, calls } = panelFixture({ claim: () => new Promise(resolve => { completeScan = resolve; }) });
  const running = context.toggleJobrightJobs();
  await flush();
  await context.toggleJobrightJobs();
  assert.equal(context.jobrightPlayButton.disabled, true);
  assert.match(context.jobrightPlayButton.title, /Stopping/);
  await context.toggleJobrightJobs();
  await context.openJobrightJobs();
  completeScan({ found: true, jobId: "late", applyUrl: "https://employer.example/late" });
  await running;
  assert.equal(calls.created.length, 0);
  assert.equal(calls.scripts.filter(call => call.name === "claimNextJobrightApplication").length, 1);
  assert.equal(context.jobrightPlayButton.disabled, false);
});

test("Stop during URL filtering keeps the application and prevents later navigation and marking", async () => {
  let completeNormalization;
  const { context, calls } = panelFixture({ normalize: () => new Promise(resolve => { completeNormalization = resolve; }) });
  const running = context.openJobrightJobs();
  await flush();
  await context.stopJobrightJobs();
  completeNormalization({ ok: true, url: "https://employer.example/filtered" });
  await running;
  assert.equal(calls.created.length, 1);
  assert.deepEqual(calls.updates, []);
  assert.equal(calls.scripts.filter(call => call.name === "markJobrightApplicationAlreadyApplied").length, 0);
});

test("Stop keeps a tab creation already sent to Chrome and counts it when it finishes", async () => {
  let completeCreation;
  const { context, calls } = panelFixture({ create: () => new Promise(resolve => { completeCreation = resolve; }) });
  const running = context.openJobrightJobs();
  await flush();
  await context.stopJobrightJobs();
  completeCreation({ id: 100, url: "https://employer.example/apply" });
  await running;
  assert.equal(calls.created.length, 1);
  assert.match(calls.statuses.at(-1).message, /Kept 1 application tab/);
  assert.equal(calls.scripts.filter(call => call.name === "markJobrightApplicationAlreadyApplied").length, 0);
});

test("Stop cancels empty-list retries and application-tab polling", async () => {
  const { context, calls, clock } = panelFixture({ claim: async () => ({ found: false }) });
  const running = context.openJobrightJobs();
  await flush();
  assert.equal([...clock.pending.values()][0].delay, 2000);
  await context.stopJobrightJobs();
  await running;
  assert.equal(calls.scripts.filter(call => call.name === "claimNextJobrightApplication").length, 1);
  const controller = new AbortController();
  const polling = context.waitForJobrightApplicationTab(8, 1, [8], 6000, controller.signal);
  await flush();
  controller.abort();
  await assert.rejects(polling, /stopped/);
  assert.equal(clock.pending.size, 0);
});

test("both Jobright start buttons complete normally, restore Play, and can run again", async () => {
  const { context, calls } = panelFixture();
  context.waitForJobrightOpenDelay = async () => {};
  await context.openJobrightJobs();
  await context.toggleJobrightJobs();
  assert.equal(calls.created.length, 4);
  assert.equal(calls.scripts.filter(call => call.name === "markJobrightApplicationAlreadyApplied").length, 4);
  assert.equal(calls.statuses.filter(status => status.type === "success").length, 2);
  assert.equal(context.jobrightPlayButton.disabled, false);
  assert.equal(context.jobrightPlayButton.attributes.d, "m8 5 11 7-11 7z");
});

test("a helper startup error restores Play and the main button", async () => {
  const { context, calls } = panelFixture({ startError: "Reload the Jobright tab." });
  await context.openJobrightJobs();
  assert.equal(calls.created.length, 0);
  assert.equal(calls.statuses.at(-1).type, "error");
  assert.equal(calls.statuses.at(-1).message, "Reload the Jobright tab.");
  assert.equal(context.isJobrightOpening, false);
  assert.equal(context.openJobrightJobsButton.disabled, false);
  assert.equal(context.jobrightPlayButton.attributes["aria-label"], "Play Jobright");
});

function contentFixture({ cardsPresent = true } = {}) {
  const clock = timers();
  const calls = { apply: 0, dislike: 0, applied: 0, scroll: 0, nativeOpen: 0 };
  class Element {
    getClientRects() { return [1]; }
    scrollIntoView() {}
  }
  const apply = Object.assign(new Element(), { textContent: "APPLY NOW", dispatchEvent() { calls.apply++; } });
  const dislike = Object.assign(new Element(), { dispatchEvent() {}, click() { calls.dislike++; } });
  const action = Object.assign(new Element(), { click() { calls.applied++; }, closest() { return null; } });
  const label = Object.assign(new Element(), { textContent: "Already Applied", closest: selector => selector.includes("menuitem") ? action : {} });
  const card = Object.assign(new Element(), {
    id: "0123456789abcdef01234567", classList: { contains: () => true },
    closest: () => ({ getAttribute: () => "0" }),
    querySelectorAll: () => [apply],
    querySelector: selector => selector.includes("dislike") ? { closest: () => dislike } : null
  });
  let menuVisible = false;
  const document = {
    readyState: "complete",
    querySelectorAll: selector => selector.startsWith("div.job-card") ? cardsPresent ? [card] : [] : selector === "span" && menuVisible ? [label] : [],
    querySelector: () => null, getElementById: () => cardsPresent ? card : null,
    contains: () => true, dispatchEvent() {}
  };
  const window = {
    innerHeight: 800, scrollBy() { calls.scroll++; },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    open() { calls.nativeOpen++; return {}; }
  };
  class XMLHttpRequest { open() {} send() {} }
  const context = vm.createContext({ window, document, location: { href: "https://jobright.ai/jobs/recommend" },
    URL, Date, Element, AbortController, XMLHttpRequest, MouseEvent: class {}, KeyboardEvent: class {}, ...clock });
  vm.runInContext(content, context);
  return { store: window.__applicationHelperJobright, window, calls, clock, card, showMenu: () => { menuVisible = true; } };
}

test("page Stop aborts delayed Apply and disarms capture so manual clicks can open tabs", async () => {
  const { store, window, calls, clock, card } = contentFixture();
  assert.equal(store.startOpenRun("one").ok, true);
  const applying = store.clickApply(card.id, "one");
  store.stopOpenRun("one");
  await assert.rejects(applying, /stopped/);
  await clock.tick(100);
  assert.equal(calls.apply, 0);
  assert.equal(clock.pending.size, 0);
  window.open("https://employer.example/manual");
  assert.equal(calls.nativeOpen, 1);
});

test("page Stop prevents a late Already Applied menu action and ends scrolling", async () => {
  const { store, calls, clock, card, showMenu } = contentFixture();
  store.startOpenRun("mark");
  const marking = store.markAlreadyApplied(card.id, "mark");
  await clock.tick(100);
  assert.equal(calls.dislike, 1);
  store.stopOpenRun("mark");
  showMenu();
  await assert.rejects(marking, /stopped/);
  await clock.tick(100);
  assert.equal(calls.applied, 0);

  const empty = contentFixture({ cardsPresent: false });
  empty.store.startOpenRun("scan");
  const scanning = empty.store.claimNext([], "scan");
  empty.store.stopOpenRun("scan");
  await assert.rejects(scanning, /stopped/);
  await empty.clock.tick(700);
  assert.equal(empty.calls.scroll, 1);
  assert.equal(empty.clock.pending.size, 0);
});

test("stale page commands cannot restart a stopped run or cancel a newer one", async () => {
  const { store, card, calls } = contentFixture();
  store.stopOpenRun("old");
  assert.equal(store.startOpenRun("old").ok, false);
  store.startOpenRun("new");
  store.stopOpenRun("old");
  await assert.rejects(store.clickApply(card.id, "old"), /stopped/);
  assert.equal((await store.claimNext([], "new")).found, true);
  assert.equal(calls.apply, 0);
  store.stopOpenRun("new");
});

test("a fresh page run retires an abandoned panel's delayed actions", async () => {
  const { store, card, calls } = contentFixture();
  store.startOpenRun("abandoned");
  const applying = store.clickApply(card.id, "abandoned");
  store.startOpenRun("reopened");
  await assert.rejects(applying, /stopped/);
  assert.equal(store.startOpenRun("abandoned").cancelled, true);
  assert.equal((await store.claimNext([], "reopened")).found, true);
  assert.equal(calls.apply, 0);
  store.stopOpenRun("reopened");
});
