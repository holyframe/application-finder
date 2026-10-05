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

test("restored tabs drop removed view preferences and retain a chat URL saved by legacy Exchange", async () => {
  const chatUrl = "https://chat.deepseek.com/a/chat/s/legacy123";
  const context = fixture({
    workspaces: {
      1: { sessionType: "save-workspace", chatGptUrl: "https://jobs.example/42", storedExchangeUrl: chatUrl }
    },
    tabStates: {
      1: { saveWorkspaceSidePanelView: "home", defaultSidePanelView: "workspace", manualSelectedProfileIds: ["alice"] }
    }
  });
  await context.restoreTabSession();
  const workspace = context.saveWorkspacesByTabId.get(1);
  assert.equal(workspace.chatGptUrl, chatUrl);
  assert.equal(Object.hasOwn(workspace, "storedExchangeUrl"), false);
  const state = context.tabStateById.get(1);
  assert.equal(Object.hasOwn(state, "saveWorkspaceSidePanelView"), false);
  assert.equal(Object.hasOwn(state, "defaultSidePanelView"), false);
  assert.deepEqual(Array.from(state.manualSelectedProfileIds), ["alice"]);
});

test("tabs display their saved workspace automatically and return Home when that workspace is removed", () => {
  const element = () => ({
    classes: new Set(), attributes: {}, focused: false,
    classList: {
      add(name) { this.owner.classes.add(name); },
      toggle(name, present) { if (present) this.owner.classes.add(name); else this.owner.classes.delete(name); }
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    focus() { this.focused = true; }
  });
  const nodes = Object.fromEntries(["appRoot", "splitWindowsModal", "buildResumeContextModal", "applicationWorkspaceUrlInput", "saveButton"]
    .map(name => {
      const node = element();
      node.classList.owner = node;
      return [name, node];
    }));
  const selectedTabs = [];
  const context = vm.createContext({
    ...nodes, currentSaveWorkspace: null, isBuildResumeContextModalOpen: false,
    renderSavePostProcessControls() {}, setSaveWorkspaceTab: tab => selectedTabs.push(tab)
  });
  for (const name of ["hasActiveSaveWorkspaceForCurrentTab", "getCurrentSidePanelView", "renderSaveWorkspaceSidePanelView"]) {
    const match = source.match(new RegExp("^(?:async )?function " + name + "\\b[\\s\\S]*?^}\\r?$", "m"));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
  context.renderSaveWorkspaceSidePanelView();
  assert.equal(context.getCurrentSidePanelView(), "home");
  assert.equal(nodes.appRoot.classes.has("is-workspace-hidden"), false);
  assert.equal(nodes.splitWindowsModal.attributes["aria-hidden"], "true");
  context.currentSaveWorkspace = { activeTab: "resume" };
  context.isBuildResumeContextModalOpen = true;
  context.renderSaveWorkspaceSidePanelView({ focus: true });
  assert.equal(context.getCurrentSidePanelView(), "workspace");
  assert.equal(nodes.appRoot.classes.has("is-workspace-hidden"), true);
  assert.equal(nodes.splitWindowsModal.attributes["aria-hidden"], "false");
  assert.equal(nodes.applicationWorkspaceUrlInput.focused, true);
  assert.deepEqual(selectedTabs, ["resume"]);
  assert.equal(nodes.buildResumeContextModal.attributes["aria-hidden"], "false");
  context.currentSaveWorkspace = null;
  context.renderSaveWorkspaceSidePanelView({ focus: true });
  assert.equal(nodes.appRoot.classes.has("is-workspace-hidden"), false);
  assert.equal(nodes.splitWindowsModal.attributes["aria-hidden"], "true");
  assert.equal(nodes.buildResumeContextModal.attributes["aria-hidden"], "true");
  assert.equal(nodes.saveButton.focused, true);
});
