const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../sidepanel/sidepanel.js"), "utf8");

function fixture(session) {
  const context = vm.createContext({
    console,
    TAB_SESSION_STORAGE_KEY: "tabSessionById",
    saveWorkspacesByTabId: new Map(),
    tabStateById: new Map(),
    runTabIdsByRunId: new Map(),
    registerRunTab: () => {},
    schedulePersistTabSession: () => {},
    chrome: {
      storage: { session: { get: async () => ({ tabSessionById: session }) } },
      tabs: { query: async () => [{ id: 1 }, { id: 2 }] }
    }
  });
  for (const name of ["createTabState", "cloneTabStateForPersistence", "restoreTabSession"]) {
    const match = source.match(new RegExp("^(?:async )?function " + name + "\\b[\\s\\S]*?^}\\r?$", "m"));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
  return context;
}

test("Save App restores open-tab workspaces and profile selections after a panel reload", async () => {
  const context = fixture({
    workspaces: {
      1: { sessionType: "save-workspace", profileName: "Alice", resumeUrl: "https://docs.google.com/document/d/resume/edit", isReady: true },
      3: { sessionType: "save-workspace", profileName: "Closed tab" }
    },
    tabStates: {
      1: { manualSelectedProfileIds: ["alice"], buildResumeContextDraft: "Resume draft", saveWorkspaceSidePanelView: "workspace" }
    }
  });
  await context.restoreTabSession();
  assert.equal(context.saveWorkspacesByTabId.size, 1);
  assert.equal(context.saveWorkspacesByTabId.get(1).profileName, "Alice");
  assert.equal(context.saveWorkspacesByTabId.get(1).chatGptTabId, 1);
  assert.equal(context.saveWorkspacesByTabId.get(1).isReady, true);
  assert.deepEqual(Array.from(context.tabStateById.get(1).manualSelectedProfileIds), ["alice"]);
  assert.equal(context.tabStateById.get(1).buildResumeContextDraft, "Resume draft");
});

test("removed Sheet-import workspaces and dialog state cannot return after a panel reload", async () => {
  const context = fixture({
    workspaces: { 2: { sessionType: "make-resume", profileName: "Old imported profile" } },
    tabStates: {
      2: {
        isSplitWindowsDialogOpen: true,
        isMakeResumeOpening: true,
        splitWindowSessionType: "make-resume",
        splitWindowPairs: [{ tabId: 2 }],
        splitWindowsDraft: "Old Sheet rows",
        manualSelectedProfileIds: ["bob"]
      }
    }
  });
  await context.restoreTabSession();
  assert.equal(context.saveWorkspacesByTabId.size, 0);
  const state = context.tabStateById.get(2);
  assert.deepEqual(Array.from(state.manualSelectedProfileIds), ["bob"]);
  for (const key of ["isSplitWindowsDialogOpen", "isMakeResumeOpening", "splitWindowSessionType", "splitWindowPairs", "splitWindowsDraft"]) {
    assert.equal(Object.hasOwn(state, key), false, key);
  }
});
