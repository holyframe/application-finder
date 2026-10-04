const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../service-worker.js"), "utf8");
const storageKey = "postingSubmissionNumbers";

function fixture(storage = {}) {
  const links = [];
  const scripts = [];
  const logs = [];
  let onMutation;
  const document = {
    title: "Engineer - Example",
    head: { appendChild(link) {
      if (!links.includes(link)) links.push(link);
      link.isConnected = true;
    } },
    createElement() {
      const attributes = new Map();
      return {
        isConnected: false,
        getAttribute: (name) => attributes.get(name) ?? null,
        setAttribute: (name, value) => attributes.set(name, value),
        remove: function () { this.isConnected = false; }
      };
    },
    querySelectorAll() {
      return links.filter((link) => link.isConnected && /(?:^|\s)icon(?:\s|$)/i.test(link.getAttribute("rel")));
    }
  };
  const urls = new Map([[2, "https://jobs.example/first"], [3, "https://jobs.example/last"]]);
  const context = vm.createContext({
    console, document, window: {},
    MutationObserver: class {
      constructor(callback) { onMutation = callback; }
      observe() {}
      disconnect() { onMutation = null; }
    },
    POSTING_SUBMISSION_NUMBERS_STORAGE_KEY: storageKey,
    postingNumberUpdateQueue: Promise.resolve(),
    saveTitleStatusByTabId: new Map(),
    getUrlComparisonKey: (url) => String(url || "").replace(/\/$/, ""),
    sendLog: (_runId, level, message) => logs.push({ level, message }),
    chrome: {
      tabs: { get: async (id) => ({ id, url: urls.get(id) }) },
      storage: { session: {
        get: async () => structuredClone(storage),
        set: async (values) => Object.assign(storage, structuredClone(values))
      } },
      scripting: { executeScript: async (details) => {
        scripts.push(details);
        return [{ result: details.func(...details.args) }];
      } }
    }
  });
  for (const name of ["updatePostingNumberState", "markPostingSubmission", "forgetPostingSubmission"]) {
    const match = source.match(new RegExp("^(?:async )?function " + name + "\\b[\\s\\S]*?^}\\r?$", "m"));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
  return { context, storage, scripts, document, urls, logs, links,
    mutate: () => onMutation?.(),
    addIcon(rel, href) {
      const link = document.createElement("link");
      link.setAttribute("rel", rel);
      link.setAttribute("href", href);
      document.head.appendChild(link);
      return link;
    }
  };
}

test("concurrent successful submissions receive unique log numbers without changing tab icons", async () => {
  const { context, storage, scripts } = fixture();
  const numbers = await Promise.all([
    context.markPostingSubmission(3, "https://jobs.example/last", "one"),
    context.markPostingSubmission(2, "https://jobs.example/first", "two")
  ]);
  assert.deepEqual(numbers, [1, 2]);
  assert.equal(storage[storageKey].byTabId[3].number, 1);
  assert.equal(storage[storageKey].byTabId[2].number, 2);
  assert.deepEqual(scripts, []);
});

test("worker restarts preserve log numbers and closed tabs drop their tracking", async () => {
  const first = fixture();
  await first.context.markPostingSubmission(3, "https://jobs.example/last", "one");
  const restarted = fixture(first.storage);
  assert.equal(first.storage[storageKey].lastNumber, 1);
  assert.equal(await restarted.context.markPostingSubmission(2, "https://jobs.example/first", "two"), 2);
  await restarted.context.forgetPostingSubmission(3);
  assert.equal(first.storage[storageKey].byTabId[3], undefined);
  assert.equal(first.storage[storageKey].lastNumber, 2);
  assert.deepEqual(restarted.scripts, []);
});

test("submission tracking leaves site favicons, page titles, and touch icons intact", async () => {
  const fixtureState = fixture();
  const { context, document, links } = fixtureState;
  const site = fixtureState.addIcon("shortcut icon", "/site.ico");
  const touch = fixtureState.addIcon("apple-touch-icon", "/touch.png");
  await context.markPostingSubmission(3, "https://jobs.example/last", "one");
  const url = site.getAttribute("href");
  assert.equal(url, "/site.ico");
  assert.equal(document.title, "Engineer - Example");
  assert.equal(touch.getAttribute("href"), "/touch.png");
  site.setAttribute("href", "/new-site.ico");
  fixtureState.mutate();
  assert.equal(site.getAttribute("href"), "/new-site.ico");
  await context.markPostingSubmission(3, "https://jobs.example/last", "two");
  assert.equal(site.getAttribute("href"), "/new-site.ico");
  assert.equal(links.length, 2);
  assert.deepEqual(fixtureState.scripts, []);
});

test("tab reloads do not restore old numbered icons from stored submissions", async () => {
  const { context, storage, scripts } = fixture({
    [storageKey]: { lastNumber: 7, byTabId: { 3: { number: 7, jobUrl: "https://jobs.example/last" } } }
  });
  let onUpdated;
  context.syncSidePanelForTab = () => {};
  context.chrome.tabs.onUpdated = { addListener: (listener) => { onUpdated = listener; } };
  const listener = source.match(/^chrome.tabs.onUpdated.addListener\([\s\S]*?^\}\);/m);
  assert.ok(listener);
  vm.runInContext(listener[0], context);
  onUpdated(3, { status: "complete" }, { id: 3 });
  await new Promise(setImmediate);
  assert.deepEqual(scripts, []);
  assert.equal(storage[storageKey].lastNumber, 7);
});

test("submission logging does not require site access or report an icon failure", async () => {
  const { context, storage, logs, scripts } = fixture();
  context.chrome.scripting.executeScript = async () => { throw new Error("Site access denied"); };
  assert.equal(await context.markPostingSubmission(3, "https://jobs.example/last", "one"), 1);
  assert.equal(storage[storageKey].byTabId[3].number, 1);
  assert.equal(logs[0].message, "URL submitted as number 1.");
  assert.equal(logs[0].level, "info");
  assert.deepEqual(scripts, []);
});
