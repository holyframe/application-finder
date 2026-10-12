const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const root = path.resolve(__dirname, "..");
const panel = fs.readFileSync(path.join(root, "sidepanel/sidepanel.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");

function load(source, names, context) {
  for (const name of names) {
    const match = source.match(new RegExp("^(?:async )?function " + name + "\\b[\\s\\S]*?^}\\r?$", "m"));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
}
const flush = () => new Promise(setImmediate);
function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    fire: value => Promise.all([...listeners].map(fn => fn(value))) };
}
function fixture() {
  let session = {};
  const local = {};
  const calls = { messages: [], opened: [], logs: [], scripts: [], ports: [] };
  const background = vm.createContext({ console, Promise,
    PLAY_POSTING_BATCH_STORAGE_KEY: "playPostingBatch", PLAY_POSTING_ALARM_NAME: "play-posting-batch",
    playPostingBatchUpdateQueue: Promise.resolve(), registerRunOwnerTab() {}, releaseRunOwnerTab() {},
    sendLog: async (_runId, level, message) => calls.logs.push({ level, message }),
    chrome: { storage: { session: {
      get: async () => structuredClone(session),
      set: async values => { Object.assign(session, structuredClone(values)); }
    } }, alarms: { clear: async () => {}, create: async () => {} },
    scripting: { executeScript: async options => calls.scripts.push(options) } }
  });
  load(worker, ["getPlayPostingBatchState", "updatePlayPostingBatchState", "finishPlayPostingBatch",
    "claimPlayPostingJobright", "stopPlayPostingJobright", "handlePlayPostingJobrightConnection"], background);
  const connect = () => {
    let disconnected = false;
    const client = { name: "play-posting-jobright", onMessage: event(), onDisconnect: event() };
    const server = { name: client.name, onMessage: event(), onDisconnect: event() };
    client.postMessage = message => {
      if (disconnected) throw new Error("Port disconnected.");
      setImmediate(() => server.onMessage.fire(structuredClone(message)));
    };
    server.postMessage = message => {
      if (disconnected) throw new Error("Port disconnected.");
      setImmediate(() => client.onMessage.fire(structuredClone(message)));
    };
    const disconnect = () => {
      if (disconnected) return;
      disconnected = true;
      setImmediate(() => { client.onDisconnect.fire(); server.onDisconnect.fire(); });
    };
    client.disconnect = server.disconnect = disconnect;
    background.handlePlayPostingJobrightConnection(server);
    calls.ports.push(client);
    return client;
  };
  const button = { disabled: false, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; },
    querySelector() { return { setAttribute: (key, value) => { this.attributes[key] = value; } }; } };
  const context = vm.createContext({ console, Promise, AbortController, setInterval, clearInterval,
    doublePlayButton: button, panelWindowId: 9, activeTabId: 1, playPostingBatchState: null,
    isPlayPostingJobrightContinuing: false, isJobrightOpening: false, jobrightOpenRun: null,
    isCheckPostingRunning: false, areActionButtonsDisabled: false, isMakeOrOpenAiTabRunning: false,
    isSaveActionRunning: false, isTabGroupCleanupRunning: false, jobrightOpenCountInput: { value: "5" },
    createRunId: () => "jobright-run", beginRunForTab: ownerTabId => ({ runId: "double-run", ownerTabId }),
    addLog() {}, showStatus() {}, addLogForTab() {}, showStatusForTab() {},
    updateJobrightOpenControlsDisabledState() {},
    updateCheckPostingButtonDisabledState: () => context.updateDoublePlayButtonDisabledState(),
    loadPlayPostingBatchState: async () => { context.playPostingBatchState = session.playPostingBatch || null; },
    openJobrightJobs: async options => calls.opened.push({ ...options }),
    stopJobrightJobs: async () => context.jobrightOpenRun?.controller.abort(),
    chrome: { storage: { local: {
      get: async () => structuredClone(local), set: async values => Object.assign(local, structuredClone(values))
    } }, runtime: { connect, sendMessage: async message => {
      calls.messages.push({ ...message });
      return { ok: true };
    } } }
  });
  load(panel, ["normalizeJobrightOpenCount", "loadJobrightSettings", "saveJobrightSettings",
    "updateDoublePlayButtonDisabledState", "playAllPostingsThenJobright", "continuePlayPostingJobright"], context);
  const ready = { runId: "all", ownerTabId: 1, windowId: 9, allTabs: true, completedCount: 2,
    tabCount: 2, jobrightCount: 10, jobrightTabId: 8, phase: "jobright-ready" };
  return { context, background, calls, button, local, ready,
    state: () => session.playPostingBatch,
    setState: state => { session = { playPostingBatch: structuredClone(state) }; context.playPostingBatchState = state; }
  };
}

test("double-play starts the entire workflow from the clicked tab and saves Jobright's count", async () => {
  const { context, calls, local } = fixture();
  await context.playAllPostingsThenJobright();
  assert.deepEqual(calls.messages, [{ type: "PLAY_ALL_POSTINGS_THEN_JOBRIGHT", runId: "double-run", ownerTabId: 1 }]);
  assert.equal(local.jobrightConfig.openCount, 5);
  context.jobrightOpenCountInput.value = "3";
  await context.loadJobrightSettings();
  assert.equal(context.jobrightOpenCountInput.value, "5");
});

test("double-play Stop cancels checks from any tab in the original window", async () => {
  const { context, calls, button, setState, ready } = fixture();
  setState({ ...ready, phase: "waiting" });
  context.activeTabId = 99;
  context.updateDoublePlayButtonDisabledState();
  assert.equal(button.attributes["aria-label"], "Stop Double Play");
  assert.equal(button.disabled, false);
  await context.playAllPostingsThenJobright();
  assert.deepEqual(calls.messages, [{ type: "CANCEL_PLAY_POSTING_BATCH", runId: "double-run", ownerTabId: 1 }]);
});

test("saving settings during startup cannot redirect Double Play to a newly selected tab", async () => {
  const { context, calls } = fixture();
  let completeSave;
  context.chrome.storage.local.set = () => new Promise(resolve => { completeSave = resolve; });
  const running = context.playAllPostingsThenJobright();
  context.activeTabId = 99;
  completeSave();
  await running;
  assert.equal(calls.messages[0].ownerTabId, 1);
});

test("the Jobright handoff uses its explicit tab and saved count, starts once, and clears the batch", async () => {
  const { context, calls, setState, ready, state } = fixture();
  setState(ready);
  context.activeTabId = 99;
  await Promise.all([context.continuePlayPostingJobright(), context.continuePlayPostingJobright()]);
  assert.deepEqual(calls.opened, [{ ownerTabId: 8, count: 10, runId: "jobright-run" }]);
  assert.equal(state(), null);
  assert.equal(context.isPlayPostingJobrightContinuing, false);
  assert.ok(!calls.logs.some(log => /side panel closed/.test(log.message)));
});

test("a handoff waits for the original window and leaves checking batches alone", async () => {
  const { context, calls, ready, setState } = fixture();
  setState({ ...ready, phase: "waiting" });
  await context.continuePlayPostingJobright();
  setState(ready);
  context.panelWindowId = 10;
  await context.continuePlayPostingJobright();
  assert.equal(calls.ports.length, 0);
  assert.equal(calls.opened.length, 0);
});

test("only a ready handoff can be claimed, including duplicate claims with the same run ID", async () => {
  const { background, setState, ready } = fixture();
  setState(ready);
  assert.ok(await background.claimPlayPostingJobright('all', 9, 'same-id'));
  assert.equal(await background.claimPlayPostingJobright('all', 9, 'same-id'), null);
});

test("losing the panel's connection stops automated Jobright actions and releases the batch", async () => {
  const { context, calls, ready, setState, state } = fixture();
  setState(ready);
  context.openJobrightJobs = async options => {
    context.jobrightOpenRun = { id: options.runId, controller: new AbortController() };
    await new Promise(resolve => context.jobrightOpenRun.controller.signal.addEventListener("abort", resolve));
  };
  const running = context.continuePlayPostingJobright();
  while (!context.jobrightOpenRun) await flush();
  calls.ports[0].disconnect();
  await running;
  await flush();
  assert.equal(state(), null);
  assert.equal(calls.scripts[0].target.tabId, 8);
  assert.equal(calls.scripts[0].args[0], "jobright-run");
  assert.ok(calls.logs.some(log => /side panel closed/.test(log.message)));
});

test("Double Play blocks overlapping starts and leaves Stop accessible during the automatic Jobright run", async () => {
  const { context, button, ready, setState } = fixture();
  context.isJobrightOpening = true;
  context.updateDoublePlayButtonDisabledState();
  assert.equal(button.disabled, true);
  setState({ ...ready, phase: "jobright-running" });
  const controller = new AbortController();
  context.jobrightOpenRun = { id: "jobright-run", controller };
  context.updateDoublePlayButtonDisabledState();
  assert.equal(button.disabled, false);
  await context.playAllPostingsThenJobright();
  assert.equal(controller.signal.aborted, true);
  context.updateDoublePlayButtonDisabledState();
  assert.equal(button.disabled, true);
});
