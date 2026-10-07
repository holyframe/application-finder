const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
const panel = fs.readFileSync(path.join(root, "sidepanel/sidepanel.js"), "utf8");
const chatgpt = fs.readFileSync(path.join(root, "content/chatgpt.js"), "utf8");

function load(source, names, context) {
  for (const name of names) {
    const match = source.match(
      new RegExp("^(?:async )?function " + name + "\\b[\\s\\S]*?^}\\r?$", "m")
    );
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
}

function fixture({ aiUrl = "https://chatgpt.com/c/current", afterQuery } = {}) {
  const tabs = [
    { id: 1, windowId: 9, index: 3, groupId: 44, url: aiUrl },
    { id: 2, windowId: 9, index: 1, groupId: -1, url: "https://jobs.example/first" },
    { id: 3, windowId: 9, index: 6, groupId: -1, url: "https://jobs.example/last" },
    { id: 4, windowId: 9, index: 8, groupId: 55, url: "https://jobs.example/grouped" },
    { id: 5, windowId: 9, index: 9, groupId: -1, pinned: true, url: "https://jobs.example/pinned" },
    { id: 6, windowId: 10, index: 12, groupId: -1, url: "https://jobs.example/other-window" }
  ];
  const calls = { grouped: [], sent: [], focused: [], remembered: [], queries: [], numbered: [] };
  const context = vm.createContext({
    URL,
    console,
    getRunOwnerTabId: () => 1,
    isPinnedTabSupportedUrl: () => false,
    isGoogleSheetsDocumentUrl: () => false,
    isJobrightRecommendationsUrl: () => false,
    getAiProviderConfig: (id) => ({ id, label: id, promptSettleDelayMs: { min: 0, max: 0 } }),
    getCheckPostingConfig: () => assert.fail("Play must target the clicked chat, regardless of settings."),
    rememberCheckPostingJob: async (tabId, job) => calls.remembered.push({ tabId, ...job }),
    markPostingSubmission: async (tabId, jobUrl) => {
      calls.numbered.push({ tabId, jobUrl });
      return calls.numbered.length;
    },
    arrangeAndGroupJobWithAiTab: async (jobTabId, aiTabId) => {
      calls.grouped.push({ jobTabId, aiTabId });
      tabs.find((tab) => tab.id === jobTabId).groupId = 44;
    },
    waitForTabToMatchUrl: async (tabId, matches) => {
      assert.equal(matches(tabs.find((tab) => tab.id === tabId).url), true);
    },
    randomDelayMs: () => 0,
    sendLog() {},
    focusBrowserTab: async (tabId) => calls.focused.push(tabId),
    sendFillAndSendToTab: async (tabId, text, runId, options) => {
      calls.sent.push({ tabId, text, runId, options });
      return { submitted: true };
    },
    chrome: { tabs: {
      get: async (id) => {
        const tab = tabs.find((entry) => entry.id === id);
        if (!tab) throw new Error("Tab closed.");
        return { ...tab };
      },
      query: async (query) => {
        calls.queries.push(query);
        const result = tabs.filter((tab) => tab.windowId === query.windowId).map((tab) => ({ ...tab }));
        afterQuery?.(tabs);
        return result;
      },
      create: () => assert.fail("Play must reuse the clicked AI chat.")
    } }
  });
  load(worker, [
    "isTabInGroup", "isCopilotChatUrl", "isCheckPostingAiUrl", "getPostingAiProviderId",
    "assertActiveJobTabUsable", "selectRightmostUngroupedPostingTab",
    "playRightmostPostingToAi", "checkPostingOnce", "sendPlayPostingTabToAi", "sendCheckPostingToCopilot"
  ], context);
  return { context, tabs, calls };
}

function withRealTabOrdering(base) {
  const { context, tabs, calls } = base;
  const storageKey = "checkPostingJobByTabId";
  context.CHECK_POSTING_JOB_STORAGE_KEY = storageKey;
  context.CHECK_POSTING_TAB_GROUP_TITLE = "Check with AI";
  const session = context.chrome.storage?.session || { get: async () => ({}) };
  const getSession = session.get;
  context.chrome.storage ||= {};
  context.chrome.storage.session = {
    ...session,
    get: async (key) => ({
      ...await getSession(key),
      [storageKey]: Object.fromEntries(calls.remembered.map((job) => [String(job.tabId), job]))
    })
  };

  const inWindow = (windowId) => tabs.filter((tab) => tab.windowId === windowId)
    .sort((left, right) => left.index - right.index);
  for (const windowId of new Set(tabs.map((tab) => tab.windowId))) {
    inWindow(windowId).forEach((tab, index) => { tab.index = index; });
  }
  calls.moves = [];
  context.chrome.tabs.move = async (tabId, { windowId, index }) => {
    calls.moves.push(tabId);
    const moving = tabs.find((tab) => tab.id === tabId);
    const oldWindowId = moving.windowId;
    const destination = inWindow(windowId).filter((tab) => tab.id !== tabId);
    destination.splice(index < 0 ? destination.length : index, 0, moving);
    moving.windowId = windowId;
    destination.forEach((tab, nextIndex) => { tab.index = nextIndex; });
    if (oldWindowId !== windowId) {
      inWindow(oldWindowId).forEach((tab, nextIndex) => { tab.index = nextIndex; });
    }
    return { ...moving };
  };
  context.chrome.tabs.query = async (query) => tabs.filter((tab) =>
    query.groupId !== undefined ? tab.groupId === query.groupId : tab.windowId === query.windowId
  ).map((tab) => ({ ...tab }));
  context.chrome.tabs.group = async ({ tabIds, groupId = 77 }) => {
    for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
      const joining = tabs.find((tab) => tab.id === tabId);
      const last = tabs.filter((tab) => tab.groupId === groupId && tab.id !== tabId)
        .sort((left, right) => right.index - left.index)[0];
      if (last) {
        await context.chrome.tabs.move(tabId, {
          windowId: last.windowId,
          index: context.indexImmediatelyRightOf(last.index, joining.index, joining.windowId === last.windowId)
        });
      }
      joining.groupId = groupId;
    }
    return groupId;
  };
  context.chrome.tabGroups = { update: async () => {} };
  load(worker, ["indexImmediatelyRightOf", "indexImmediatelyLeftOf",
    "moveTabImmediatelyRightOf", "moveTabImmediatelyLeftOf", "nameCheckPostingTabGroup",
    "arrangeAndGroupJobWithAiTab"], context);
  return { ...base, groupOrder: () => tabs.filter((tab) => tab.groupId === tabs[0].groupId)
    .sort((left, right) => left.index - right.index).map((tab) => tab.id) };
}

test("Play takes the highest-index eligible tab in the clicked chat's window", async () => {
  const { context, calls } = fixture();
  const result = await context.playRightmostPostingToAi("play-run", { ownerTabId: 1 });
  assert.equal(result.jobUrl, "https://jobs.example/last");
  assert.equal(result.tabId, 1);
  assert.equal(result.submissionNumber, null);
  assert.deepEqual(calls.numbered, []);
  assert.deepEqual(calls.grouped, [{ jobTabId: 3, aiTabId: 1 }]);
  assert.equal(calls.sent[0].text, "https://jobs.example/last");
  assert.equal(calls.sent[0].tabId, 1);
  assert.equal(calls.sent[0].options.aiProviderId, "chatgpt");
  assert.equal(calls.sent[0].options.submitOnlyWhenIdle, true);
  assert.deepEqual(calls.focused, [1, 1]);
  assert.equal(calls.remembered[0].tabId, 3);
  assert.equal(calls.queries[0].windowId, 9);
});

test("each Play picks the next rightmost ungrouped tab and stops when none remain", async () => {
  const { context, calls } = fixture();
  await context.playRightmostPostingToAi("one", { ownerTabId: 1 });
  await context.playRightmostPostingToAi("two", { ownerTabId: 1 });
  await assert.rejects(context.playRightmostPostingToAi("three", { ownerTabId: 1 }), /No other ungrouped, unpinned tab/);
  assert.deepEqual(calls.sent.map((call) => call.text), [
    "https://jobs.example/last", "https://jobs.example/first"
  ]);
  assert.deepEqual(calls.numbered, []);
});

test("repeated Play clicks place jobs after the rightmost tab, including unrelated group members", async () => {
  const base = fixture();
  base.tabs.push({ id: 7, windowId: 9, index: 4, groupId: 44, url: "https://example.com/unrelated" });
  const { context, groupOrder } = withRealTabOrdering(base);
  await context.playRightmostPostingToAi("one", { ownerTabId: 1 });
  assert.deepEqual(groupOrder(), [1, 7, 3]);
  await context.playRightmostPostingToAi("two", { ownerTabId: 1 });
  assert.deepEqual(groupOrder(), [1, 7, 3, 2]);
});

test("Play creates a group for an ungrouped chat and appends the next job", async () => {
  const base = fixture();
  base.tabs[0].groupId = -1;
  const { context, tabs, groupOrder } = withRealTabOrdering(base);
  await context.playRightmostPostingToAi("one", { ownerTabId: 1 });
  assert.equal(tabs[0].groupId, 77);
  assert.deepEqual(groupOrder(), [1, 3]);
  await context.playRightmostPostingToAi("two", { ownerTabId: 1 });
  assert.deepEqual(groupOrder(), [1, 3, 2]);
});

test("Play still uses the group's rightmost tab when the previous job was closed or moved out", async () => {
  for (const action of ["closed", "moved"]) {
    const base = fixture();
    base.tabs.push({ id: 7, windowId: 9, index: 4, groupId: 44, url: "https://example.com/unrelated" });
    const { context, tabs, groupOrder } = withRealTabOrdering(base);
    await context.playRightmostPostingToAi("one", { ownerTabId: 1 });
    if (action === "closed") tabs.splice(tabs.findIndex((tab) => tab.id === 3), 1);
    else tabs.find((tab) => tab.id === 3).groupId = 55;
    await context.playRightmostPostingToAi("two", { ownerTabId: 1 });
    assert.deepEqual(groupOrder(), [1, 7, 2], action);
  }
});

test("Play excludes the initiating chat even when it is ungrouped and rightmost", async () => {
  const { context, tabs, calls } = fixture();
  tabs[0].groupId = -1;
  tabs[0].index = 20;
  await context.playRightmostPostingToAi("play", { ownerTabId: 1 });
  assert.equal(calls.sent[0].text, "https://jobs.example/last");
});

test("Play uses the current supported provider without opening another chat", async () => {
  for (const [provider, aiUrl] of [
    ["chatgpt", "https://chat.openai.com/c/current"],
    ["copilot", "https://copilot.microsoft.com/chats/current"],
    ["perplexity", "https://www.perplexity.ai/search/current"],
    ["deepseek", "https://chat.deepseek.com/a/chat/s/current"]
  ]) {
    const { context, calls } = fixture({ aiUrl });
    await context.playRightmostPostingToAi("play", { ownerTabId: 1 });
    assert.equal(calls.sent[0].options.aiProviderId, provider);
    assert.equal(calls.sent[0].tabId, 1);
  }
});

test("Play rejects a job page, a pinned chat, and a closed initiating tab", async () => {
  for (const state of ["job", "pinned", "closed"]) {
    const { context, tabs, calls } = fixture();
    if (state === "job") tabs[0].url = "https://jobs.example/42";
    if (state === "pinned") tabs[0].pinned = true;
    if (state === "closed") tabs.shift();
    await assert.rejects(context.playRightmostPostingToAi("play", { ownerTabId: 1 }), /unpinned AI chat|no longer open/);
    assert.equal(calls.grouped.length, 0);
    assert.equal(calls.sent.length, 0);
  }
});

test("Play rechecks a source that becomes grouped, pinned, or closed after selection", async () => {
  for (const state of ["grouped", "pinned", "closed"]) {
    const { context, calls } = fixture({ afterQuery: (tabs) => {
      const job = tabs.find((tab) => tab.id === 3);
      if (state === "grouped") job.groupId = 55;
      if (state === "pinned") job.pinned = true;
      if (state === "closed") tabs.splice(tabs.indexOf(job), 1);
    } });
    await assert.rejects(context.playRightmostPostingToAi("play", { ownerTabId: 1 }));
    assert.equal(calls.grouped.length, 0);
    assert.equal(calls.sent.length, 0);
  }
});

test("Play reports a busy chat's fill-only result", async () => {
  const { context, calls } = fixture();
  context.sendFillAndSendToTab = async () => ({ submitted: false, reason: "chat-running" });
  const result = await context.playRightmostPostingToAi("play", { ownerTabId: 1 });
  assert.equal(result.submitted, false);
  assert.equal(result.submissionNumber, null);
  assert.equal(calls.numbered.length, 0);
});

test("a failed submission does not number the job tab", async () => {
  const { context, calls } = fixture();
  context.sendFillAndSendToTab = async () => { throw new Error("Send failed"); };
  await assert.rejects(context.playRightmostPostingToAi("play", { ownerTabId: 1 }), /Send failed/);
  assert.equal(calls.numbered.length, 0);
});

test("the panel sends without permission prompts, enables Play for supported chats, and blocks repeated clicks", async () => {
  const button = { disabled: false, setAttribute() {}, querySelector: () => null };
  let finish;
  const calls = [];
  const context = vm.createContext({
    URL, console, playButton: button, activeTabId: 1,
    areActionButtonsDisabled: false, isCheckPostingRunning: false, isMakeOrOpenAiTabRunning: false,
    isCurrentTabPlayAiChat: true, isTabGroupCleanupRunning: false,
    playPostingBatchState: null,
    beginRunForTab: (ownerTabId) => ({ ownerTabId, runId: "play" }),
    updateCheckPostingButtonDisabledState: () => context.updatePlayButtonDisabledState(),
    addLog() {}, showStatus() {},
    chrome: { permissions: {
      request: () => assert.fail("Play must not request site access.")
    }, runtime: { sendMessage: (message) => {
      calls.push(message);
      return new Promise((resolve) => { finish = resolve; });
    } } }
  });
  load(panel, ["isPlayAiChatUrl", "updatePlayButtonDisabledState", "playRightmostPosting"], context);
  const { context: workerContext } = fixture();
  for (const url of [
    "https://chatgpt.com/", "https://chat.openai.com/c/current",
    "https://chat.deepseek.com/", "https://www.perplexity.ai/search/current",
    "https://copilot.microsoft.com/chats/current", "https://jobs.example/42",
    "https://copilot.microsoft.com/", "http://chatgpt.com/", "invalid"
  ]) {
    assert.equal(context.isPlayAiChatUrl(url), Boolean(workerContext.getPostingAiProviderId(url)), url);
  }
  const running = context.playRightmostPosting();
  context.activeTabId = 99;
  await context.playRightmostPosting();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "PLAY_RIGHTMOST_POSTING_TO_AI");
  assert.equal(calls[0].ownerTabId, 1);
  assert.equal(button.disabled, true);
  finish({ ok: true });
  await running;
  assert.equal(button.disabled, false);
  context.isCurrentTabPlayAiChat = false;
  context.updatePlayButtonDisabledState();
  assert.equal(button.disabled, false);
  assert.match(button.title, /Open the selected AI chat/);
  context.isCurrentTabPlayAiChat = true;
  context.areActionButtonsDisabled = true;
  context.updatePlayButtonDisabledState();
  assert.equal(button.disabled, true);
});

function outsideAiPanelFixture({ batch = null, sendMessage } = {}) {
  const attributes = {};
  const calls = [];
  const errors = [];
  const button = { disabled: true, setAttribute: (key, value) => { attributes[key] = value; }, querySelector: () => null };
  const context = vm.createContext({
    console: { error() {} }, playButton: button,
    activeTabId: 1, areActionButtonsDisabled: false,
    isCheckPostingRunning: false, isMakeOrOpenAiTabRunning: false,
    isCurrentTabPlayAiChat: false, playPostingBatchState: batch, isTabGroupCleanupRunning: false,
    beginRunForTab: (ownerTabId) => ({ ownerTabId, runId: "open-ai" }),
    updateCheckPostingButtonDisabledState: () => context.updatePlayButtonDisabledState(),
    addLog() {}, showStatus: (type, message) => errors.push({ type, message }),
    chrome: { runtime: { sendMessage: async (message) => {
      calls.push(message);
      return sendMessage ? sendMessage(message) : { ok: true };
    } } }
  });
  load(panel, ["updatePlayButtonDisabledState",
    "makeOrOpenSelectedAiTab", "playRightmostPosting"], context);
  context.updatePlayButtonDisabledState();
  return { context, button, attributes, calls, errors };
}

test("Play outside an AI URL uses the open-selected-chat action and prevents duplicate opens", async () => {
  for (const batch of [null, { ownerTabId: 9, completedCount: 1, tabCount: 2 }]) {
    let finish;
    const { context, button, attributes, calls } = outsideAiPanelFixture({
      batch, sendMessage: () => new Promise((resolve) => { finish = resolve; })
    });
    assert.equal(button.disabled, false);
    assert.equal(attributes["aria-label"], "Open selected AI chat");
    assert.match(button.title, /Open the selected AI chat, or create it if it is not open/);
    const running = context.playRightmostPosting();
    assert.equal(button.disabled, true);
    assert.equal(context.isMakeOrOpenAiTabRunning, true);
    context.activeTabId = 99;
    await context.playRightmostPosting();
    await context.makeOrOpenSelectedAiTab();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, "MAKE_OR_OPEN_CHECK_POSTING_AI_TAB");
    assert.equal(calls[0].ownerTabId, 1);
    finish({ ok: true });
    await running;
    assert.equal(context.isMakeOrOpenAiTabRunning, false);
    assert.equal(button.disabled, false);
  }
});

test("Play outside an AI URL preserves the shared open error and action locks", async () => {
  const { context, button, calls, errors } = outsideAiPanelFixture({
    sendMessage: async () => ({ ok: false, error: "Could not open the selected chat." })
  });
  await context.playRightmostPosting();
  assert.equal(calls.length, 1);
  assert.equal(errors[0].type, "error");
  assert.equal(errors[0].message, "Could not open the selected chat.");
  assert.equal(button.disabled, false);
  context.areActionButtonsDisabled = true;
  context.updatePlayButtonDisabledState();
  assert.equal(button.disabled, true);
  await context.playRightmostPosting();
  assert.equal(calls.length, 1);
});

test("ChatGPT submits an idle prompt and leaves a responding chat's URL unsent", async () => {
  for (const state of ["idle", "running", "starts-running"]) {
    let running = state === "running";
    let clicked = 0;
    let filled = "";
    const context = vm.createContext({
      findChatGptInput: () => ({}),
      fillChatGptInput: (_input, text) => { filled = text; },
      findSendButton: () => ({ disabled: false, click: () => { clicked += 1; } }),
      randomDelayMs: () => 0, CHATGPT_BEFORE_SEND_MS: { min: 0, max: 0 },
      sleep: async () => { running = state === "starts-running"; },
      document: { querySelector: () => running ? {} : null }
    });
    load(chatgpt, ["isAiChatRunning", "fillAndSend"], context);
    const result = await context.fillAndSend("https://jobs.example/42", { submitOnlyWhenIdle: true });
    assert.equal(filled, "https://jobs.example/42");
    assert.equal(result.submitted, state === "idle");
    assert.equal(clicked, state === "idle" ? 1 : 0);
  }
});

function batchFixture(tabCount = 1) {
  const base = fixture();
  const { context, calls } = base;
  let now = 1000000;
  let session = {};
  let local = { checkPostingConfig: { playTabCount: tabCount } };
  const alarms = new Map();
  let alarmListener;
  let alarmStep;
  calls.logs = [];
  calls.alarms = [];
  Object.assign(context, {
    PLAY_POSTING_BATCH_STORAGE_KEY: "playPostingBatch",
    PLAY_POSTING_ALARM_NAME: "play-posting-batch",
    CHECK_POSTING_CONFIG_STORAGE_KEY: "checkPostingConfig",
    CHECK_POSTING_COPILOT_URL: "https://copilot.microsoft.com/chats/default",
    playPostingBatchUpdateQueue: Promise.resolve(),
    playPostingBatchStarting: false,
    playPostingBatchStepRunning: false,
    Date: { now: () => now },
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    registerRunOwnerTab() {}, releaseRunOwnerTab() {},
    sendLog: async (_run, level, message) => calls.logs.push({ level, message })
  });
  context.chrome.storage = {
    session: {
      get: async () => structuredClone(session),
      set: async (values) => { Object.assign(session, structuredClone(values)); }
    },
    local: {
      get: async () => structuredClone(local),
      set: async (values) => { Object.assign(local, structuredClone(values)); }
    }
  };
  context.chrome.alarms = {
    onAlarm: { addListener: (listener) => { alarmListener = listener; } },
    clear: async (name) => alarms.delete(name),
    create: async (name, options) => {
      alarms.set(name, options);
      calls.alarms.push(options);
    }
  };
  load(worker, [
    "checkPostingAiDefaults", "checkPostingAiLabel", "normalizeCheckPostingProviderId", "normalizeCheckPostingAiUrl",
    "validatePlayPostingDelayRange", "getCheckPostingConfig", "saveCheckPostingConfig", "randomDelayMs",
    "getPlayPostingBatchState", "updatePlayPostingBatchState", "finishPlayPostingBatch",
    "cancelPlayPostingBatch", "startPlayPostingBatch", "runPlayPostingBatchStep",
    "restorePlayPostingBatch"
  ], context);
  const runStep = context.runPlayPostingBatchStep;
  context.runPlayPostingBatchStep = (...args) => {
    alarmStep = runStep(...args);
    return alarmStep;
  };
  vm.runInContext(worker.match(/^chrome\.alarms\.onAlarm\.addListener\([\s\S]*?^\}\);/m)[0], context);
  return { ...base, alarms,
    state: () => session.playPostingBatch,
    advance: () => { now = session.playPostingBatch.nextRunAt; },
    fireAlarm: async (fireAt = alarms.get("play-posting-batch")?.when) => {
      const alarm = alarms.get("play-posting-batch");
      assert.ok(alarm, "Play must have a scheduled alarm");
      now = fireAt;
      // Chrome consumes one-shot alarms when they fire, before dispatching the event.
      if (alarm.periodInMinutes) {
        alarms.set("play-posting-batch", { ...alarm, when: now + alarm.periodInMinutes * 60000 });
      } else {
        alarms.delete("play-posting-batch");
      }
      alarmListener({ name: "play-posting-batch", scheduledTime: alarm.when });
      await alarmStep;
    },
    setSession: (state) => { session.playPostingBatch = structuredClone(state); },
    setConfig: (config) => { local.checkPostingConfig = config; }
  };
}

test("the main Check posting action appends exactly one tab to the entire group", async () => {
  const base = batchFixture(5);
  base.tabs.push({ id: 7, windowId: 9, index: 4, groupId: 44, url: "https://example.com/unrelated" });
  const { context, calls, state, alarms, groupOrder } = withRealTabOrdering(base);
  await context.checkPostingOnce("main-one", { ownerTabId: 1 });
  assert.deepEqual(groupOrder(), [1, 7, 3]);
  assert.equal(calls.sent.length, 1);
  assert.equal(state(), undefined);
  assert.equal(alarms.size, 0);
  assert.deepEqual(calls.numbered, []);
  await context.checkPostingOnce("main-two", { ownerTabId: 1 });
  assert.deepEqual(groupOrder(), [1, 7, 3, 2]);
  assert.equal(calls.sent.length, 2);
  assert.equal(alarms.size, 0);
});

test("the main Check posting action creates a group for an ungrouped AI chat", async () => {
  const base = batchFixture(3);
  base.tabs[0].groupId = -1;
  const { context, groupOrder, state, calls } = withRealTabOrdering(base);
  await context.checkPostingOnce("main", { ownerTabId: 1 });
  assert.deepEqual(groupOrder(), [1, 3]);
  assert.equal(calls.sent.length, 1);
  assert.equal(state(), undefined);
});

test("the main Check posting action opens the selected chat outside AI without sending", async () => {
  const { context, calls, state, alarms } = batchFixture(4);
  const opened = [];
  context.makeOrOpenCheckPostingAiTab = async (runId, options) => opened.push({ runId, ...options });
  await context.checkPostingOnce("main-open", { ownerTabId: 2 });
  assert.deepEqual(opened, [{ runId: "main-open", ownerTabId: 2 }]);
  assert.equal(calls.sent.length, 0);
  assert.equal(state(), undefined);
  assert.equal(alarms.size, 0);
});

test("a busy chat's single main-button check does not schedule a retry", async () => {
  const { context, calls, state, alarms, groupOrder } = withRealTabOrdering(batchFixture(4));
  context.sendFillAndSendToTab = async (tabId, text) => {
    calls.sent.push({ tabId, text });
    return { submitted: false };
  };
  const result = await context.checkPostingOnce("main", { ownerTabId: 1 });
  assert.equal(result.submitted, false);
  assert.deepEqual(groupOrder(), [1, 3]);
  assert.equal(calls.sent.length, 1);
  assert.equal(state(), undefined);
  assert.equal(alarms.size, 0);
});

test("main-button checks cannot overlap each other or a Play batch", async () => {
  const { context, calls, state } = batchFixture(2);
  let complete;
  context.sendFillAndSendToTab = () => new Promise(resolve => { complete = resolve; });
  const running = context.checkPostingOnce("main", { ownerTabId: 1 });
  while (!complete) await new Promise(setImmediate);
  await assert.rejects(context.checkPostingOnce("another", { ownerTabId: 1 }), /already being processed/);
  await assert.rejects(context.startPlayPostingBatch("batch", { ownerTabId: 1 }), /already processing/);
  complete({ submitted: true });
  await running;
  assert.equal(context.playPostingBatchStepRunning, false);
  context.sendFillAndSendToTab = async (tabId, text) => {
    calls.sent.push({ tabId, text });
    return { submitted: true };
  };
  await context.startPlayPostingBatch("batch", { ownerTabId: 1 });
  const sentCount = calls.sent.length;
  await assert.rejects(context.checkPostingOnce("main-during-batch", { ownerTabId: 1 }), /Play is already running/);
  assert.equal(state().completedCount, 1);
  assert.equal(calls.sent.length, sentCount);
  assert.equal(context.playPostingBatchStepRunning, false);
});

function mainButtonPanelFixture({ ai = true, sendMessage } = {}) {
  const calls = [];
  const errors = [];
  const button = { disabled: false, setAttribute() {} };
  const playButton = { disabled: false, setAttribute() {}, querySelector: () => null };
  const context = vm.createContext({
    console: { error() {} }, checkPostingButton: button, playButton,
    activeTabId: 1, areActionButtonsDisabled: false, isCheckPostingRunning: false,
    isMakeOrOpenAiTabRunning: false, isCurrentTabPlayAiChat: ai, playPostingBatchState: null,
    isTabGroupCleanupRunning: false, updateTabGroupCleanupButtons() {},
    beginRunForTab: ownerTabId => ({ ownerTabId, runId: "main" }),
    addLog() {}, showStatus: (type, message) => errors.push({ type, message }),
    chrome: { runtime: { sendMessage: async message => {
      calls.push({ ...message });
      return sendMessage ? sendMessage(message) : { ok: true };
    } } }
  });
  load(panel, ["updatePlayButtonDisabledState", "updateCheckPostingButtonDisabledState",
    "makeOrOpenSelectedAiTab", "checkCurrentPosting", "playRightmostPosting"], context);
  context.updateCheckPostingButtonDisabledState();
  return { context, button, playButton, calls, errors };
}

test("the main button opens AI from other pages and shares Play's open lock", async () => {
  let complete;
  const { context, button, playButton, calls } = mainButtonPanelFixture({
    ai: false, sendMessage: () => new Promise(resolve => { complete = resolve; })
  });
  context.isCurrentTabGoogleSheet = true;
  context.isCurrentTabJobright = true;
  context.updateCheckPostingButtonDisabledState();
  assert.equal(button.disabled, false);
  assert.match(button.title, /Open the selected AI chat/);
  const running = context.checkCurrentPosting();
  assert.equal(button.disabled, true);
  assert.equal(playButton.disabled, true);
  context.activeTabId = 99;
  await context.checkCurrentPosting();
  await context.playRightmostPosting();
  assert.deepEqual(calls, [{ type: "MAKE_OR_OPEN_CHECK_POSTING_AI_TAB", runId: "main", ownerTabId: 1 }]);
  complete({ ok: true });
  await running;
  assert.equal(button.disabled, false);
  assert.equal(playButton.disabled, false);
});

test("the main button sends one check from AI and restores controls after failure", async () => {
  let complete;
  const { context, button, calls, errors } = mainButtonPanelFixture({
    sendMessage: () => new Promise(resolve => { complete = resolve; })
  });
  assert.match(button.title, /Send one rightmost/);
  const running = context.checkCurrentPosting();
  context.activeTabId = 99;
  await context.checkCurrentPosting();
  await context.playRightmostPosting();
  assert.deepEqual(calls, [{ type: "CHECK_POSTING_TO_COPILOT", runId: "main", ownerTabId: 1 }]);
  complete({ ok: false, error: "No eligible tab." });
  await running;
  assert.equal(button.disabled, false);
  assert.equal(errors[0].message, "No eligible tab.");
  context.playPostingBatchState = { ownerTabId: 99 };
  context.updateCheckPostingButtonDisabledState();
  assert.equal(button.disabled, true);
  await context.checkCurrentPosting();
  assert.equal(calls.length, 1);
});

test("Play count defaults to 1, persists a whole-number selection, and rejects invalid counts", async () => {
  const { context, setConfig } = batchFixture();
  for (const count of [undefined, 0, -1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1]) {
    setConfig({ playTabCount: count });
    assert.equal((await context.getCheckPostingConfig()).playTabCount, 1);
  }
  await context.saveCheckPostingConfig("copilot", {}, false, 3);
  assert.equal((await context.getCheckPostingConfig()).playTabCount, 3);
  for (const count of [0, -1, 1.5, "3", NaN]) {
    await assert.rejects(context.saveCheckPostingConfig("copilot", {}, false, count), /whole number/);
  }
  assert.equal((await context.getCheckPostingConfig()).playTabCount, 3);
});

test("Play wait settings preserve defaults, save valid ranges, and reject invalid ranges without overwriting", async () => {
  const { context, setConfig } = batchFixture();
  const readRange = async () => {
    const config = await context.getCheckPostingConfig();
    return [config.playDelayMinSeconds, config.playDelayMaxSeconds];
  };
  assert.deepEqual(await readRange(), [60, 90]);
  for (const range of [[0, 90], [1.5, 90], ["60", 90], [60, null], [100, 90], [60, 86401]]) {
    setConfig({ playDelayMinSeconds: range[0], playDelayMaxSeconds: range[1] });
    assert.deepEqual(await readRange(), [60, 90]);
  }
  await context.saveCheckPostingConfig("copilot", {}, false, 3, 45, 75);
  assert.deepEqual(await readRange(), [45, 75]);
  for (const range of [[0, 90], [-1, 90], [1.5, 90], ["60", 90], [60, NaN], [60, 86401]]) {
    await assert.rejects(context.saveCheckPostingConfig("copilot", {}, false, 3, ...range), /whole numbers/);
  }
  await assert.rejects(context.saveCheckPostingConfig("copilot", {}, false, 3, 75, 45), /at least the minimum/);
  assert.deepEqual(await readRange(), [45, 75]);
  await context.saveCheckPostingConfig("copilot", {}, false, 3, 25, 25);
  assert.deepEqual(await readRange(), [25, 25]);
});

test("Play schedules configured random bounds or a fixed interval after an immediate first send", async () => {
  for (const [minimum, maximum, random, expectedSeconds] of [
    [45, 75, 0, 45], [45, 75, 0.999999, 75], [25, 25, 0.5, 25]
  ]) {
    const { context, calls, state, alarms } = batchFixture(2);
    await context.saveCheckPostingConfig("copilot", {}, false, 2, minimum, maximum);
    context.Math.random = () => random;
    await context.startPlayPostingBatch("custom-wait", { ownerTabId: 1 });
    assert.equal(calls.sent.length, 1);
    assert.equal(state().nextRunAt, 1000000 + expectedSeconds * 1000);
    assert.equal(alarms.get("play-posting-batch").when, state().nextRunAt);
    assert.match(calls.logs.at(-1).message, new RegExp(`Next URL in ${expectedSeconds} seconds`));
  }
});

test("Play retains its saved interval through worker restoration, settings changes, and busy-chat retries", async () => {
  const { context, calls, state, setConfig, alarms, advance, tabs } = batchFixture(3);
  tabs.push({ id: 7, windowId: 9, index: 10, groupId: -1, url: "https://jobs.example/newest" });
  await context.saveCheckPostingConfig("copilot", {}, false, 3, 17, 17);
  let busy = false;
  context.sendFillAndSendToTab = async (tabId, text) => {
    calls.sent.push({ tabId, text });
    return { submitted: !busy };
  };
  await context.startPlayPostingBatch("saved-wait", { ownerTabId: 1 });
  assert.equal(state().nextRunAt, 1017000);
  assert.equal(state().playDelayMinSeconds, 17);
  assert.equal(state().playDelayMaxSeconds, 17);
  setConfig({ playTabCount: 3, playDelayMinSeconds: 200, playDelayMaxSeconds: 250 });
  alarms.clear();
  await context.restorePlayPostingBatch();
  assert.equal(alarms.get("play-posting-batch").when, 1017000);
  advance();
  busy = true;
  await context.runPlayPostingBatchStep();
  assert.equal(state().nextRunAt, 1034000);
  assert.equal(state().completedCount, 1);
  assert.match(calls.logs.at(-1).message, /retry this same URL in 17 seconds/);
  advance();
  busy = false;
  await context.runPlayPostingBatchStep();
  assert.equal(calls.sent[2].text, calls.sent[1].text);
  assert.equal(state().nextRunAt, 1051000);
  advance();
  await context.runPlayPostingBatchStep();
  assert.equal(state(), null);
  assert.equal(calls.sent.length, 4);
  assert.equal((await context.getCheckPostingConfig()).playDelayMinSeconds, 200);
});

test("a restored batch created before wait settings uses the original 60–90 second range", async () => {
  const { context, state, setSession, setConfig } = batchFixture(2);
  setConfig({ playTabCount: 2, playDelayMinSeconds: 10, playDelayMaxSeconds: 10 });
  setSession({
    runId: "legacy", ownerTabId: 1, providerId: "chatgpt", aiUrl: "https://chatgpt.com/c/current",
    allowNewConversation: false, tabCount: 2, completedCount: 0, pendingJob: null,
    phase: "ready", nextRunAt: null
  });
  await context.restorePlayPostingBatch();
  assert.equal(state().nextRunAt, 1060000);
});

test("a default single-tab Play sends immediately without numbering or an alarm", async () => {
  const { context, calls, state, alarms } = batchFixture();
  const result = await context.startPlayPostingBatch("batch", { ownerTabId: 1 });
  assert.equal(result.submitted, true);
  assert.equal(result.completedCount, 1);
  assert.equal(result.active, false);
  assert.equal(calls.sent.length, 1);
  assert.equal(result.submissionNumber, null);
  assert.deepEqual(calls.numbered, []);
  assert.equal(state(), null);
  assert.equal(alarms.size, 0);
});

test("a batch sends rightmost jobs one by one, with random 60–90 second alarms", async () => {
  const { context, calls, state, advance, alarms } = batchFixture(2);
  await context.startPlayPostingBatch("batch", { ownerTabId: 1 });
  assert.equal(calls.sent.length, 1);
  assert.deepEqual(calls.numbered, [{ tabId: 3, jobUrl: "https://jobs.example/last" }]);
  assert.equal(state().completedCount, 1);
  assert.equal(state().nextRunAt, 1060000);
  await context.runPlayPostingBatchStep(); // An early alarm cannot submit the next URL.
  assert.equal(calls.sent.length, 1);
  await assert.rejects(context.startPlayPostingBatch("another", { ownerTabId: 1 }), /already running/);
  advance();
  await context.runPlayPostingBatchStep();
  assert.deepEqual(calls.sent.map((call) => call.text), [
    "https://jobs.example/last", "https://jobs.example/first"
  ]);
  assert.deepEqual(calls.numbered.map((call) => call.tabId), [3, 2]);
  assert.equal(state(), null);
  assert.equal(alarms.size, 0);

  const maximum = batchFixture(2);
  maximum.context.Math.random = () => 0.999999;
  await maximum.context.startPlayPostingBatch("batch", { ownerTabId: 1 });
  assert.equal(maximum.state().nextRunAt, 1090000);
});

test("a Play batch follows the group's changing right edge and a busy-chat retry keeps its position", async () => {
  const base = batchFixture(3);
  base.tabs.push({ id: 7, windowId: 9, index: 2, groupId: -1, url: "https://jobs.example/middle" });
  base.tabs.push({ id: 8, windowId: 9, index: 4, groupId: 44, url: "https://example.com/unrelated" });
  const { context, calls, state, advance, groupOrder, tabs } = withRealTabOrdering(base);
  let busy = false;
  context.sendFillAndSendToTab = async (tabId, text) => {
    calls.sent.push({ tabId, text });
    return { submitted: !busy };
  };
  await context.startPlayPostingBatch("batch", { ownerTabId: 1 });
  assert.deepEqual(groupOrder(), [1, 8, 3]);
  tabs.push({ id: 9, windowId: 9, index: 20, groupId: -1, url: "https://example.com/added-during-wait" });
  await context.chrome.tabs.group({ tabIds: 9, groupId: 44 });
  await context.restorePlayPostingBatch();
  busy = true;
  advance();
  await context.runPlayPostingBatchStep();
  assert.deepEqual(groupOrder(), [1, 8, 3, 9, 7]);
  assert.equal(state().completedCount, 1);
  tabs.push({ id: 10, windowId: 9, index: 20, groupId: -1, url: "https://example.com/added-before-retry" });
  await context.chrome.tabs.group({ tabIds: 10, groupId: 44 });
  const moveCount = calls.moves.length;
  busy = false;
  advance();
  await context.runPlayPostingBatchStep();
  assert.deepEqual(groupOrder(), [1, 8, 3, 9, 7, 10]);
  assert.equal(calls.moves.length, moveCount);
  advance();
  await context.runPlayPostingBatchStep();
  assert.deepEqual(groupOrder(), [1, 8, 3, 9, 7, 10, 2]);
  assert.equal(state(), null);
});

test("a busy chat retries the same grouped job and counts only successful submissions", async () => {
  const { context, calls, state, advance } = batchFixture(2);
  let busy = true;
  context.sendFillAndSendToTab = async (tabId, text) => {
    calls.sent.push({ tabId, text });
    return { submitted: !busy };
  };
  await context.startPlayPostingBatch("batch", { ownerTabId: 1 });
  assert.equal(state().completedCount, 0);
  assert.equal(state().pendingJob.id, 3);
  assert.equal(calls.numbered.length, 0);
  advance();
  busy = false;
  await context.runPlayPostingBatchStep();
  assert.equal(calls.sent[1].text, calls.sent[0].text);
  assert.equal(state().completedCount, 1);
  assert.equal(state().pendingJob, null);
  advance();
  await context.runPlayPostingBatchStep();
  assert.equal(calls.sent[2].text, "https://jobs.example/first");
  assert.equal(calls.numbered.length, 2);
  assert.equal(state(), null);
});

test("an early alarm keeps a busy-chat retry scheduled until its saved deadline", async () => {
  const { context, calls, state, alarms, fireAlarm } = batchFixture();
  let busy = true;
  context.sendFillAndSendToTab = async (tabId, text) => {
    calls.sent.push({ tabId, text });
    return { submitted: !busy };
  };
  await context.startPlayPostingBatch("busy", { ownerTabId: 1 });
  const deadline = state().nextRunAt;
  busy = false;
  await fireAlarm(deadline - 1);
  assert.equal(calls.sent.length, 1, "Never send before the configured wait ends");
  assert.equal(state().nextRunAt, deadline);
  assert.ok(alarms.has("play-posting-batch"), "An early event must not strand Play");
  await fireAlarm();
  assert.equal(calls.sent.length, 2);
  assert.equal(calls.sent[1].text, calls.sent[0].text);
  assert.equal(state(), null);
  assert.equal(alarms.size, 0);
});

test("an alarm dispatched while a posting step is locked still has a later wake-up", async () => {
  const { context, state, calls, alarms, fireAlarm } = batchFixture(2);
  await context.startPlayPostingBatch("locked", { ownerTabId: 1 });
  context.playPostingBatchStepRunning = true;
  await fireAlarm();
  assert.equal(calls.sent.length, 1);
  assert.equal(state().phase, "waiting");
  assert.ok(alarms.has("play-posting-batch"), "The lock must not consume the only wake-up");
  context.playPostingBatchStepRunning = false;
  await fireAlarm();
  assert.equal(calls.sent.length, 2);
  assert.equal(state(), null);
  assert.equal(alarms.size, 0);
});

test("a worker waking after a missed busy-chat alarm runs the overdue retry immediately", async () => {
  const { context, state, calls, alarms, advance } = batchFixture();
  let busy = true;
  context.sendFillAndSendToTab = async (tabId, text) => {
    calls.sent.push({ tabId, text });
    return { submitted: !busy };
  };
  await context.startPlayPostingBatch("overdue", { ownerTabId: 1 });
  advance();
  alarms.clear();
  busy = false;
  await context.restorePlayPostingBatch();
  assert.equal(calls.sent.length, 2, "Restoration must execute an overdue retry");
  assert.equal(calls.sent[1].text, calls.sent[0].text);
  assert.equal(state(), null);
  assert.equal(alarms.size, 0);
});

test("Stop cancels pending alarms and only the owning AI tab may stop a batch", async () => {
  const { context, state, alarms, calls } = batchFixture(2);
  await context.startPlayPostingBatch("batch", { ownerTabId: 1 });
  await assert.rejects(context.cancelPlayPostingBatch("stop", { ownerTabId: 9 }), /tab that started it/);
  assert.equal(state().completedCount, 1);
  await context.cancelPlayPostingBatch("stop", { ownerTabId: 1 });
  assert.equal(state(), null);
  assert.equal(alarms.size, 0);
  await context.runPlayPostingBatchStep();
  assert.equal(calls.sent.length, 1);
});

test("stopping an in-flight submission cannot restart the remaining batch", async () => {
  const { context, state, alarms, calls } = batchFixture(2);
  let complete;
  context.sendFillAndSendToTab = () => new Promise((resolve) => { complete = resolve; });
  const running = context.startPlayPostingBatch("batch", { ownerTabId: 1 });
  while (!complete) await new Promise((resolve) => setImmediate(resolve));
  await context.cancelPlayPostingBatch("stop", { ownerTabId: 1 });
  complete({ submitted: true });
  await running;
  assert.equal(state(), null);
  assert.equal(alarms.size, 0);
  assert.equal(calls.numbered.length, 1);
});

test("a restored worker recreates a waiting alarm and stops an uncertain interrupted send", async () => {
  const { context, state, alarms, calls, setSession } = batchFixture(2);
  await context.startPlayPostingBatch("batch", { ownerTabId: 1 });
  alarms.clear();
  await context.restorePlayPostingBatch();
  assert.equal(alarms.get("play-posting-batch").when, state().nextRunAt);
  assert.equal(calls.sent.length, 1);
  setSession({ ...state(), phase: "sending" });
  await context.restorePlayPostingBatch();
  assert.equal(state(), null);
  assert.equal(alarms.size, 0);
  assert.equal(calls.sent.length, 1);
  assert.match(calls.logs.at(-1).message, /interrupted a submission/);
});

test("Play stops safely when the chat changes, a pending job changes, or sending fails", async () => {
  for (const scenario of ["chat", "job", "send"]) {
    const { context, state, alarms, tabs, advance, calls } = batchFixture(2);
    if (scenario === "job") context.sendFillAndSendToTab = async () => ({ submitted: false });
    await context.startPlayPostingBatch("batch", { ownerTabId: 1 });
    advance();
    if (scenario === "chat") tabs[0].url = "https://chatgpt.com/c/different";
    if (scenario === "job") tabs[2].url = "https://jobs.example/changed";
    if (scenario === "send") context.sendFillAndSendToTab = async () => { throw new Error("Send failed"); };
    await assert.rejects(context.runPlayPostingBatchStep());
    assert.equal(state(), null, scenario);
    assert.equal(alarms.size, 0, scenario);
    assert.match(calls.logs.at(-1).message, /Play stopped:/);
  }
});

test("Play adopts a new conversation created by its first submission and finishes when jobs run out", async () => {
  const { context, state, tabs, advance, calls } = batchFixture(3);
  tabs[0].url = "https://chatgpt.com/";
  await context.startPlayPostingBatch("batch", { ownerTabId: 1 });
  tabs[0].url = "https://chatgpt.com/c/created";
  advance();
  await context.runPlayPostingBatchStep();
  assert.equal(state().aiUrl, tabs[0].url);
  advance();
  const result = await context.runPlayPostingBatchStep();
  assert.equal(result.completedCount, 2);
  assert.equal(calls.sent.length, 2);
  assert.equal(state(), null);
  assert.match(calls.logs.at(-1).message, /no other ungrouped, unpinned tabs remain/);
});

test("the Play button becomes Stop on its owning chat and is disabled in another chat", async () => {
  const attributes = {};
  const button = { setAttribute: (key, value) => { attributes[key] = value; },
    querySelector: () => ({ setAttribute: (key, value) => { attributes[key] = value; } }) };
  const messages = [];
  const context = vm.createContext({
    console, playButton: button, activeTabId: 1, areActionButtonsDisabled: true,
    isCheckPostingRunning: false, isMakeOrOpenAiTabRunning: false, isCurrentTabPlayAiChat: true,
    isTabGroupCleanupRunning: false,
    playPostingBatchState: { ownerTabId: 1, completedCount: 2, tabCount: 5 },
    updateCheckPostingButtonDisabledState: () => context.updatePlayButtonDisabledState(),
    beginRunForTab: (ownerTabId) => ({ ownerTabId, runId: "stop" }),
    addLog() {}, showStatus() {},
    chrome: { runtime: { sendMessage: async (message) => { messages.push(message); return { ok: true }; } } }
  });
  load(panel, ["updatePlayButtonDisabledState", "playRightmostPosting"], context);
  context.updatePlayButtonDisabledState();
  assert.equal(button.disabled, false);
  assert.equal(attributes["aria-label"], "Stop Play");
  assert.match(button.title, /2\/5/);
  await context.playRightmostPosting();
  assert.equal(messages[0].type, "CANCEL_PLAY_POSTING_BATCH");
  context.activeTabId = 99;
  context.updatePlayButtonDisabledState();
  assert.equal(button.disabled, true);
});

test("the Play hotkey targets the shortcut's tab and ignores other panels", async () => {
  const messages = [];
  let command;
  const context = vm.createContext({
    console, Date,
    APP_ACTION_COMMANDS: { "play-posting": "play-posting", "check-posting": "check-posting" },
    getSidePanelStatus: async () => ({ open: true }),
    notifyExtensionPages: async (message) => messages.push(message),
    chrome: { commands: { onCommand: { addListener: (callback) => { command = callback; } } },
      tabs: { query: async () => [{ id: 11 }] } }
  });
  const listener = worker.match(/^chrome.commands.onCommand.addListener\([\s\S]*?^\}\);/m);
  vm.runInContext(listener[0], context);
  command("play-posting", { id: 7 });
  await new Promise(setImmediate);
  assert.equal(messages[0].ownerTabId, 7);
  command("play-posting");
  await new Promise(setImmediate);
  assert.equal(messages[1].ownerTabId, 11);
  command("check-posting", { id: 7 });
  await new Promise(setImmediate);
  assert.equal(messages[2].ownerTabId, 7);

  const block = panel.match(/  if \(message.type === "HOTKEY_ACTION"\) \{[\s\S]*?\n    return;\r?\n  \}/);
  let starts = 0;
  let checks = 0;
  context.activeTabId = 7;
  context.playRightmostPosting = () => { starts++; };
  context.checkCurrentPosting = () => { checks++; };
  vm.runInContext(`function handle(message) { ${block[0]} }`, context);
  context.handle({ type: "HOTKEY_ACTION", action: "play-posting", ownerTabId: 11 });
  assert.equal(starts, 0);
  context.handle({ type: "HOTKEY_ACTION", action: "play-posting", ownerTabId: 7 });
  assert.equal(starts, 1);
  context.handle({ type: "HOTKEY_ACTION", action: "check-posting", ownerTabId: 11 });
  assert.equal(checks, 0);
  context.handle({ type: "HOTKEY_ACTION", action: "check-posting", ownerTabId: 7 });
  assert.equal(checks, 1);
});
