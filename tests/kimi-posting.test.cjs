const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const root = path.resolve(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
const panel = fs.readFileSync(path.join(root, "sidepanel/sidepanel.js"), "utf8");
const content = fs.readFileSync(path.join(root, "content/ai-provider.js"), "utf8");

function load(source, names, context) {
  for (const name of names) {
    const match = source.match(new RegExp("^(?:async )?function " + name + "\\b[\\s\\S]*?^}\\r?$", "m"));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
}
function workerFixture() {
  let local = { checkPostingConfig: { providerId: "deepseek", urls: {
    copilot: "https://copilot.microsoft.com/chats/existing",
    deepseek: "https://chat.deepseek.com/a/chat/existing",
    perplexity: "https://www.perplexity.ai/search/existing"
  } } };
  const updates = [];
  const context = vm.createContext({ URL, CHECK_POSTING_COPILOT_URL: "https://copilot.microsoft.com/chats/default",
    CHECK_POSTING_CONFIG_STORAGE_KEY: "checkPostingConfig", DEFAULT_AI_PROVIDER_ID: "chatgpt",
    chrome: { storage: { local: { get: async () => structuredClone(local),
      set: async values => Object.assign(local, structuredClone(values)) } },
    tabs: { update: async (id, options) => updates.push({ id, ...options }),
      create: () => assert.fail("Open URL must keep the current tab.") } }
  });
  vm.runInContext(worker.match(/^const AI_PROVIDERS = Object\.freeze\([\s\S]*?^\}\);/m)[0], context);
  load(worker, ["isCopilotChatUrl", "isCheckPostingAiUrl", "getPostingAiProviderId", "isCheckPostingProviderUrl",
    "checkPostingAiDefaults", "normalizeCheckPostingProviderId", "checkPostingAiLabel", "normalizeCheckPostingAiUrl",
    "validatePlayPostingDelayRange", "getCheckPostingConfig", "saveCheckPostingConfig", "openCheckPostingAiUrl",
    "getAiProviderConfig", "normalizeAiProviderId"], context);
  return { context, updates };
}

test("Kimi chat URLs are recognized by settings, worker, and panel without enabling Kimi for Save App", () => {
  const { context } = workerFixture();
  const panelContext = vm.createContext({ URL });
  load(panel, ["isPlayAiChatUrl"], panelContext);
  for (const hostname of ["kimi.com", "www.kimi.com", "kimi.ai", "www.kimi.ai"]) {
    const url = `https://${hostname}/chat/existing`;
    assert.equal(context.normalizeCheckPostingAiUrl("kimi", url + "/"), url);
    assert.equal(context.getPostingAiProviderId(url), "kimi");
    assert.equal(context.isCheckPostingAiUrl(url), true);
    assert.equal(context.isCheckPostingProviderUrl(url, "kimi"), true);
    assert.equal(panelContext.isPlayAiChatUrl(url), true);
  }
  for (const url of ["javascript:alert(1)", "http://www.kimi.com/chat/1", "https://www.kimi.com.evil.example/", "https://chat.deepseek.com/"]) {
    assert.throws(() => context.normalizeCheckPostingAiUrl("kimi", url), /Kimi URL/);
    assert.notEqual(context.getPostingAiProviderId(url), "kimi");
  }
  assert.equal(context.normalizeCheckPostingAiUrl("kimi", ""), "https://www.kimi.com");
  assert.equal(context.getAiProviderConfig("kimi").contentScript, "content/ai-provider.js");
  assert.equal(context.getAiProviderConfig("kimi").checkPostingOnly, true);
  assert.equal(context.normalizeAiProviderId("kimi"), "chatgpt");
});

test("adding Kimi preserves existing AI URLs and persists its selected chat and Play settings", async () => {
  const { context } = workerFixture();
  const original = await context.getCheckPostingConfig();
  assert.equal(original.providerId, "deepseek");
  assert.equal(original.urls.kimi, "https://www.kimi.com");
  await context.saveCheckPostingConfig("kimi", { ...original.urls, kimi: "https://www.kimi.ai/chat/saved" }, false, 4, 12, 15);
  const saved = await context.getCheckPostingConfig();
  assert.equal(saved.providerId, "kimi");
  assert.equal(saved.url, "https://www.kimi.ai/chat/saved");
  for (const id of ["copilot", "perplexity", "deepseek"]) assert.equal(saved.urls[id], original.urls[id]);
  assert.equal(saved.playTabCount, 4);
  assert.equal(saved.playDelayMinSeconds, 12);
  assert.equal(saved.playDelayMaxSeconds, 15);
});

test("each AI URL opens in the requested current tab and invalid URLs never navigate", async () => {
  const { context, updates } = workerFixture();
  for (const [id, url] of Object.entries(context.checkPostingAiDefaults())) {
    const opened = await context.openCheckPostingAiUrl(id, url, 17);
    assert.equal(opened.tabId, 17);
    assert.deepEqual(updates.at(-1), { id: 17, url: url.replace(/\/+$/, ""), active: true });
  }
  const count = updates.length;
  await assert.rejects(context.openCheckPostingAiUrl("kimi", "https://other.example/", 17), /Kimi URL/);
  await assert.rejects(context.openCheckPostingAiUrl("kimi", "https://www.kimi.com", null), /current browser tab/);
  assert.equal(updates.length, count);
});

test("the URL button uses the row's unsaved URL and captures the current tab before navigation", async () => {
  let complete;
  const requests = [];
  const input = { value: " https://www.kimi.com/chat/unsaved ", reportValidity: () => true };
  const button = { disabled: false };
  const context = vm.createContext({ activeTabId: 17,
    document: { querySelector: selector => selector.startsWith("#checkPostingUrl-") ? input : button },
    showStatus() {}, addLog() {}, chrome: { runtime: { sendMessage: message => {
      requests.push({ ...message });
      return new Promise(resolve => { complete = resolve; });
    } } }
  });
  load(panel, ["openCheckPostingAiUrl"], context);
  const opening = context.openCheckPostingAiUrl("kimi");
  context.activeTabId = 99;
  await context.openCheckPostingAiUrl("kimi");
  assert.deepEqual(requests, [{ type: "OPEN_CHECK_POSTING_AI_URL", providerId: "kimi", ownerTabId: 17,
    url: "https://www.kimi.com/chat/unsaved" }]);
  complete({ ok: true, url: "https://www.kimi.com/chat/unsaved" });
  await opening;
  assert.equal(button.disabled, false);
});

test("Kimi's shared send/stop control is treated as busy and its disabled state is respected", () => {
  const context = vm.createContext({ location: { hostname: "www.kimi.com" },
    chrome: { runtime: { onMessage: { addListener() {} } } } });
  vm.runInContext(content, context);
  context.findFirst = selectors => selectors.includes('.send-button-container [name^="Stop" i]') ? {} : null;
  assert.equal(context.isAiChatRunning(), true);
  const button = { classList: { contains: value => value === "disabled" }, getAttribute: () => null };
  assert.equal(context.isSendButtonReady(button), false);
  button.classList.contains = () => false;
  assert.equal(context.isSendButtonReady(button), true);
});
