const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
const panel = fs.readFileSync(path.join(root, "sidepanel/sidepanel.js"), "utf8");

function load(source, names, context) {
  for (const name of names) {
    const match = source.match(new RegExp("^(?:async )?function " + name + "\\b[\\s\\S]*?^}\\r?$", "m"));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
}

function fixture() {
  const aiUrl = "https://chat.deepseek.com/a/chat/s/current";
  const tabs = [
    { id: 1, windowId: 9, index: 1, groupId: 11, url: aiUrl },
    { id: 2, windowId: 9, index: 2, groupId: 11, url: "https://jobs.example/check-first" },
    { id: 3, windowId: 9, index: 3, groupId: 11, url: "https://jobs.example/check-last" },
    { id: 4, windowId: 9, index: 4, groupId: 20, url: "https://jobs.example/save-first" },
    { id: 5, windowId: 9, index: 5, groupId: 20, url: "https://jobs.example/save-middle" },
    { id: 6, windowId: 9, index: 6, groupId: 20, url: "https://jobs.example/save-last" },
    { id: 7, windowId: 9, index: 7, groupId: 30, url: "https://example.com/other-group" },
    { id: 8, windowId: 9, index: 8, groupId: -1, url: "https://jobright.ai/jobs/recommend" },
    { id: 9, windowId: 10, index: 0, groupId: 42, url: aiUrl },
    { id: 10, windowId: 10, index: 1, groupId: 42, url: "https://jobs.example/other-check" },
    { id: 11, windowId: 10, index: 2, groupId: 43, url: "https://jobs.example/other-save-first" },
    { id: 12, windowId: 10, index: 3, groupId: 43, url: "https://jobs.example/other-save-last" }
  ];
  const groups = [
    { id: 11, windowId: 9, title: "Check with AI" },
    { id: 20, windowId: 9, title: "Saving to Docs" },
    { id: 30, windowId: 9, title: "Unrelated" },
    { id: 42, windowId: 10, title: "Check with AI" },
    { id: 43, windowId: 10, title: "Saving to Docs" }
  ];
  const calls = { removed: [], focused: [], logs: [], owners: [] };
  const context = vm.createContext({
    URL, console,
    CHECK_POSTING_TAB_GROUP_TITLE: "Check with AI",
    SAVING_TO_DOCS_TAB_GROUP_TITLE: "Saving to Docs",
    playPostingBatchStarting: false, playPostingBatchStepRunning: false,
    activeSaveRunId: "", activeSaveProcessControllers: new Map(),
    getPlayPostingBatchState: async () => null,
    getCheckPostingConfig: async () => ({ url: aiUrl }),
    getRunOwnerTabId: () => 8,
    registerRunOwnerTab: (runId, tabId) => calls.owners.push({ runId, tabId }),
    focusBrowserTab: async tabId => calls.focused.push(tabId),
    sendLog: (runId, level, message) => calls.logs.push({ runId, level, message }),
    chrome: {
      tabs: {
        get: async id => {
          context.beforeGet?.(id);
          const tab = tabs.find(tab => tab.id === id);
          if (!tab) throw new Error("Tab closed.");
          return { ...tab };
        },
        query: async ({ groupId }) => tabs.filter(tab => tab.groupId === groupId).map(tab => ({ ...tab })),
        remove: async id => {
          calls.removed.push(id);
          tabs.splice(tabs.findIndex(tab => tab.id === id), 1);
          context.afterRemove?.(id);
        }
      },
      tabGroups: {
        // Return all groups to also verify the explicit scope checks.
        query: async () => groups.map(group => ({ ...group })),
        get: async id => {
          context.beforeGroupGet?.(id);
          const group = groups.find(group => group.id === id);
          if (!group) throw new Error("Group closed.");
          return { ...group };
        }
      }
    }
  });
  load(worker, ["isCopilotChatUrl", "getPostingAiProviderId", "getUrlComparisonKey",
    "selectCheckPostingAiTab", "getTabGroupCleanupTarget", "cleanupActionTabGroup"], context);
  return { context, tabs, groups, calls };
}

test("Check posting delete keeps the AI and closes only its other group tabs", async () => {
  const { context, tabs, calls } = fixture();
  const result = await context.cleanupActionTabGroup("delete", { ownerTabId: 1, groupType: "check-posting" });
  assert.deepEqual(calls.removed, [2, 3]);
  assert.equal(result.keptTabId, 1);
  assert.equal(result.closedCount, 2);
  assert.deepEqual(tabs.map(tab => tab.id), [1, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("delete outside AI chooses the selected chat group in the source window", async () => {
  const { context, calls } = fixture();
  await context.cleanupActionTabGroup("delete", { ownerTabId: 8, groupType: "check-posting" });
  assert.deepEqual(calls.removed, [2, 3]);
  assert.deepEqual(calls.focused, []);
});

test("the current Check with AI group takes priority over another selected chat", async () => {
  const { context, groups, tabs, calls } = fixture();
  groups.push({ id: 31, windowId: 9, title: "Check with AI" });
  tabs.push({ id: 13, windowId: 9, index: 9, groupId: 31, url: "https://chatgpt.com/c/other" },
    { id: 14, windowId: 9, index: 10, groupId: 31, url: "https://jobs.example/another" });
  const result = await context.cleanupActionTabGroup("delete", { ownerTabId: 13, groupType: "check-posting" });
  assert.deepEqual(calls.removed, [14]);
  assert.equal(result.keptTabId, 13);
});

test("Jobright delete keeps the rightmost Saving to Docs tab and focuses it if the source closes", async () => {
  const { context, tabs, calls } = fixture();
  // A saved job may have navigated to AI; its tab position still determines the keeper.
  tabs.find(tab => tab.id === 6).url = "https://chat.deepseek.com/a/chat/s/saved-job";
  const result = await context.cleanupActionTabGroup("delete", { ownerTabId: 4, groupType: "saving-to-docs" });
  assert.deepEqual(calls.removed, [4, 5]);
  assert.equal(result.keptTabId, 6);
  assert.deepEqual(calls.focused, [6]);
  assert.deepEqual(calls.owners, [{ runId: "delete", tabId: 6 }]);
  assert.ok(tabs.some(tab => tab.id === 1));
  assert.ok(tabs.some(tab => tab.id === 11));
});

test("missing local groups and Check with AI groups without an AI close nothing", async () => {
  for (const scenario of ["missing", "no-ai"]) {
    const { context, groups, tabs, calls } = fixture();
    if (scenario === "missing") groups.splice(groups.findIndex(group => group.id === 11), 1);
    else tabs.find(tab => tab.id === 1).url = "https://jobs.example/no-ai";
    const result = await context.cleanupActionTabGroup("delete", { ownerTabId: 8, groupType: "check-posting" });
    assert.equal(result.closedCount, 0);
    assert.deepEqual(calls.removed, []);
  }
});

test("groups that contain only the keeper remain intact", async () => {
  const { context, tabs, calls } = fixture();
  for (const id of [2, 3, 4, 5]) tabs.splice(tabs.findIndex(tab => tab.id === id), 1);
  const check = await context.cleanupActionTabGroup("delete", { ownerTabId: 8, groupType: "check-posting" });
  const saving = await context.cleanupActionTabGroup("delete", { ownerTabId: 8, groupType: "saving-to-docs" });
  assert.equal(check.keptTabId, 1);
  assert.equal(saving.keptTabId, 6);
  assert.deepEqual(calls.removed, []);
});

test("cleanup waits for active saves, submissions, and Play batches", async () => {
  for (const busy of ["save", "post-process", "submission", "batch"]) {
    const { context, calls } = fixture();
    if (busy === "save") context.activeSaveRunId = "save";
    if (busy === "post-process") context.activeSaveProcessControllers.set("save", {});
    if (busy === "submission") context.playPostingBatchStepRunning = true;
    if (busy === "batch") context.getPlayPostingBatchState = async () => ({ ownerTabId: 1 });
    await assert.rejects(context.cleanupActionTabGroup("delete", { ownerTabId: 8, groupType: "check-posting" }), /finish|Stop Play/);
    assert.deepEqual(calls.removed, []);
  }
});

test("cleanup skips a candidate that moves out of the target group", async () => {
  const { context, tabs, calls } = fixture();
  context.beforeGet = id => {
    if (id === 2) tabs.find(tab => tab.id === 2).groupId = 20;
  };
  await context.cleanupActionTabGroup("delete", { ownerTabId: 8, groupType: "check-posting" });
  assert.deepEqual(calls.removed, [3]);
  assert.ok(tabs.some(tab => tab.id === 2));
});

test("cleanup stops if its keeper or named group changes", async () => {
  for (const scenario of ["keeper", "title"]) {
    const { context, tabs, groups, calls } = fixture();
    if (scenario === "keeper") context.beforeGet = id => {
      if (id === 1) tabs.find(tab => tab.id === 1).groupId = 30;
    };
    else context.beforeGroupGet = id => { groups.find(group => group.id === id).title = "Renamed"; };
    await assert.rejects(context.cleanupActionTabGroup("delete", { ownerTabId: 8, groupType: "check-posting" }), /changed/);
    assert.deepEqual(calls.removed, []);
    assert.equal(context.playPostingBatchStepRunning, false);
  }
});

test("cleanup stops after a keeper moves during closure and releases its lock", async () => {
  const { context, tabs, calls } = fixture();
  context.afterRemove = () => { tabs.find(tab => tab.id === 1).groupId = 30; };
  await assert.rejects(context.cleanupActionTabGroup("delete", { ownerTabId: 8, groupType: "check-posting" }), /changed/);
  assert.deepEqual(calls.removed, [2]);
  assert.ok(tabs.some(tab => tab.id === 3));
  assert.equal(context.playPostingBatchStepRunning, false);
});

test("cleanup rejects unknown group types", async () => {
  const { context, calls } = fixture();
  await assert.rejects(context.cleanupActionTabGroup("delete", { ownerTabId: 8, groupType: "other" }), /Unknown/);
  assert.deepEqual(calls.removed, []);
});

function panelFixture(sendMessage = async () => ({ ok: true })) {
  const button = () => ({ disabled: false, setAttribute() {}, querySelector: () => null });
  const calls = [];
  const errors = [];
  const context = vm.createContext({
    console: { error() {} }, activeTabId: 8,
    areActionButtonsDisabled: false, isSaveActionRunning: false, isCheckPostingRunning: false,
    isMakeOrOpenAiTabRunning: false, isJobrightOpening: false, jobrightOpenRun: null, isTabGroupCleanupRunning: false,
    playPostingBatchState: null, isCurrentTabGoogleSheet: false, isCurrentTabJobright: true,
    isCurrentTabPlayAiChat: false,
    saveButton: button(), checkPostingButton: button(), playButton: button(),
    openJobrightJobsButton: button(), jobrightPlayButton: button(),
    checkPostingDeleteButton: button(), jobrightDeleteButton: button(),
    beginRunForTab: ownerTabId => ({ ownerTabId, runId: "delete" }),
    addLog() {}, showStatus: (type, message) => errors.push({ type, message }),
    chrome: { runtime: { sendMessage: async message => {
      calls.push({ ...message });
      return sendMessage(message);
    } } }
  });
  load(panel, ["updateSaveButtonDisabledState", "updateTabGroupCleanupButtons",
    "updateCheckPostingButtonDisabledState", "updatePlayButtonDisabledState",
    "updateJobrightOpenControlsDisabledState", "closeActionGroupTabs"], context);
  return { context, calls, errors };
}

test("delete clicks capture their source tab, lock both rows, and restore controls on errors", async () => {
  let complete;
  const { context, calls, errors } = panelFixture(() => new Promise(resolve => { complete = resolve; }));
  const running = context.closeActionGroupTabs("saving-to-docs");
  for (const name of ["checkPostingDeleteButton", "jobrightDeleteButton", "checkPostingButton", "playButton", "openJobrightJobsButton", "jobrightPlayButton"]) {
    assert.equal(context[name].disabled, true, name);
  }
  context.activeTabId = 99;
  await context.closeActionGroupTabs("check-posting");
  assert.deepEqual(calls, [{ type: "CLEANUP_ACTION_TAB_GROUP", runId: "delete", ownerTabId: 8, groupType: "saving-to-docs" }]);
  complete({ ok: false, error: "The group changed." });
  await running;
  assert.equal(context.checkPostingDeleteButton.disabled, false);
  assert.equal(context.jobrightDeleteButton.disabled, false);
  assert.equal(context.openJobrightJobsButton.disabled, false);
  assert.equal(errors[0].message, "The group changed.");
});

test("delete controls wait for other running actions without sending a cleanup request", async () => {
  for (const flag of ["areActionButtonsDisabled", "isSaveActionRunning", "isCheckPostingRunning", "isMakeOrOpenAiTabRunning", "isJobrightOpening", "playPostingBatchState"]) {
    const { context, calls } = panelFixture();
    context[flag] = true;
    context.updateTabGroupCleanupButtons();
    assert.equal(context.checkPostingDeleteButton.disabled, true, flag);
    assert.equal(context.jobrightDeleteButton.disabled, true, flag);
    await context.closeActionGroupTabs("check-posting");
    assert.deepEqual(calls, [], flag);
  }
});
