const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const panel = fs.readFileSync(path.join(__dirname, "../sidepanel/sidepanel.js"), "utf8");
const code = "GOOGLE_OAUTH_CLIENT_CONFIGURATION_REQUIRED";
const message = "Process stopped. Google rejected the extension's OAuth client ID. Fix the Item ID and retry.";

function fixture() {
  const events = [];
  const requests = [];
  const context = vm.createContext({
    console: { error() {} },
    GOOGLE_OAUTH_CLIENT_CONFIGURATION_REQUIRED_CODE: code,
    SAVE_PROCESS_BUSY_CODE: "SAVE_PROCESS_BUSY",
    activeTabId: 7,
    activeRunId: "run",
    isSaveActionRunning: false,
    areActionButtonsDisabled: true,
    isSavePostProcessRequestPending: true,
    savePostProcessState: { runId: "run", ownerTabId: 7, involvedTabIds: [7, 8] },
    tabStateById: new Map([[8, {
      runId: "run", savePostProcessState: { runId: "run" },
      areActionButtonsDisabled: true, isSavePostProcessRequestPending: true
    }]]),
    runTabIdsByRunId: new Map([["run", new Set([7, 8])]]),
    saveWorkspacesByTabId: new Map([[8, { runId: "run" }]]),
    profileSelectionState: { selectedProfileIds: ["profile"] },
    isActiveTab: (tabId) => tabId === 7,
    getTabState: (tabId) => context.tabStateById.get(tabId),
    setSaveButtonsDisabled: (disabled) => { context.areActionButtonsDisabled = disabled; },
    renderSavePostProcessControls: () => events.push("process-state-updated"),
    schedulePersistTabSession() {},
    clearStatus() {}, clearDeletedRows() {}, clearLogsForTab() {},
    validateSaveCurrentTabInputs: () => ({ ok: true }),
    validateActiveBrowserTabForAppAction: async () => ({ ok: true, tabId: 7 }),
    beginRunForTab: () => ({ runId: "run", ownerTabId: 7 }),
    getSelectedAiProviderId: () => "none",
    showStatus() {}, addLog() {},
    showStatusForTab: (_tabId, type, text) => events.push({ type, text }),
    addLogForTab() {},
    showSaveCompletionToast: (ok) => events.push(ok ? "success-toast" : "error-toast"),
    chrome: { runtime: {
      sendMessage: async (request) => {
        requests.push(request);
        return { ok: false, code, error: message };
      },
      onMessage: { addListener: (listener) => { context.onMessage = listener; } }
    } }
  });
  for (const name of [
    "resolveRunTabIds", "resolveSavePostProcessTargetTabIds",
    "setSavePostProcessStateForTab", "setSavePostProcessRequestPendingForTab",
    "setSaveButtonsDisabledForTab", "beginButtonProcessForTab", "finishButtonProcessForTab",
    "endSaveProcessAfterOAuthError", "runCurrentAppAction", "runCurrentAppActionOnce"
  ]) {
    const match = panel.match(new RegExp("^(?:async )?function " + name + "\\b[\\s\\S]*?^}\\r?$", "m"));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
  return { context, events, requests };
}

function assertStopped(context, events) {
  assert.equal(context.savePostProcessState, null);
  assert.equal(context.isSavePostProcessRequestPending, false);
  assert.equal(context.areActionButtonsDisabled, false);
  const relatedTab = context.tabStateById.get(8);
  assert.equal(relatedTab.savePostProcessState, null);
  assert.equal(relatedTab.isSavePostProcessRequestPending, false);
  assert.equal(relatedTab.areActionButtonsDisabled, false);
  assert.ok(events.some((event) => event.type === "error" && event.text === message));
  assert.ok(events.indexOf("error-toast") < events.indexOf("process-state-updated"));
  assert.ok(!events.includes("success-toast"));
}

test("a clicked save reports the OAuth error then releases all process controls without retrying", async () => {
  const { context, events, requests } = fixture();
  await context.runCurrentAppAction();
  assertStopped(context, events);
  assert.equal(context.isSaveActionRunning, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, "SAVE_CURRENT_TAB_URL_TO_SHEET");
});

test("a hotkey save reports the OAuth error then releases all process controls", () => {
  const { context, events } = fixture();
  const start = panel.indexOf("chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {");
  const end = panel.indexOf("function showBuildResumeContextStatus", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(panel.slice(start, end), context);
  context.onMessage({ type: "HOTKEY_SAVE_FINISHED", runId: "run", ownerTabId: 7, ok: false, code, error: message });
  assertStopped(context, events);
});

test("stopping an OAuth failure preserves a newer process on a previously involved tab", () => {
  const { context } = fixture();
  const newerState = {
    runId: "new-run", savePostProcessState: { runId: "new-run" },
    areActionButtonsDisabled: true, isSavePostProcessRequestPending: true
  };
  context.tabStateById.set(9, newerState);
  context.runTabIdsByRunId.get("run").add(9);
  context.endSaveProcessAfterOAuthError("run", 7);
  assert.equal(context.tabStateById.get(9).savePostProcessState.runId, "new-run");
  assert.equal(context.tabStateById.get(9).areActionButtonsDisabled, true);
  assert.equal(context.tabStateById.get(9).isSavePostProcessRequestPending, true);
});
