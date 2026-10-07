// Optional integration check: NODE_PATH must expose Playwright.
// Uses a fresh browser profile and synthetic pages, never the user's chats or tabs.
// Usage: node tests/play-posting-browser-check.cjs [msedge|chromium]
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");

(async () => {
  const context = await chromium.launchPersistentContext("", {
    headless: true,
    channel: process.argv[2] || "msedge",
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    await context.route(/^https?:/, route => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Play retry test</title>
        <textarea id="prompt-textarea"></textarea>
        <button data-testid="stop-button">Stop</button>
        <button data-testid="send-button">Send</button>
        <script>
          window.submissions = [];
          document.querySelector('[data-testid="send-button"]').onclick = () => {
            window.submissions.push(document.querySelector('textarea').value);
          };
        </script>`
    }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
    const ai = await context.newPage();
    await ai.goto("https://chatgpt.com/c/play-retry-test");
    const job = await context.newPage();
    await job.goto("https://play-test.invalid/job");
    const ownerTabId = await panel.evaluate(async () => {
      await chrome.storage.local.set({
        checkPostingConfig: { playTabCount: 1, playDelayMinSeconds: 71, playDelayMaxSeconds: 71 }
      });
      return (await chrome.tabs.query({})).find(tab => tab.url === "https://chatgpt.com/c/play-retry-test").id;
    });
    const response = await panel.evaluate(ownerTabId => chrome.runtime.sendMessage({
      type: "PLAY_RIGHTMOST_POSTING_TO_AI", runId: "browser-retry", ownerTabId
    }), ownerTabId);
    assert.equal(response.ok, true);
    assert.equal(response.submitted, false);
    const state = await panel.evaluate(async () => (await chrome.storage.session.get("playPostingBatch")).playPostingBatch);
    assert.equal(state.phase, "waiting");
    assert.equal(state.completedCount, 0);
    assert.equal(state.pendingJob.url, "https://play-test.invalid/job");
    const alarm = await worker.evaluate(() => chrome.alarms.get("play-posting-batch"));
    assert.equal(alarm.scheduledTime, state.nextRunAt);
    assert.equal(alarm.periodInMinutes, 0.5);
    console.log("Busy chat schedules its same-URL retry in 71 seconds with a backstop.");

    await ai.evaluate(() => document.querySelector('[data-testid="stop-button"]').remove());
    // Stop the real extension worker during the wait. The Chrome alarm must wake it.
    const cdp = await context.newCDPSession(panel);
    let versionId;
    cdp.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
      versionId ||= versions.find(version => version.scriptURL === worker.url())?.versionId;
    });
    await cdp.send("ServiceWorker.enable");
    for (let i = 0; !versionId && i < 50; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(versionId, "Find the extension worker's version to simulate suspension");
    await cdp.send("ServiceWorker.stopWorker", { versionId });
    await cdp.detach();
    console.log("Worker stopped during the wait; waiting for Chrome to wake it.");
    await ai.waitForFunction(() => window.submissions.length === 1, null, { timeout: 105000 });
    assert.deepEqual(await ai.evaluate(() => window.submissions), ["https://play-test.invalid/job"]);
    await panel.waitForFunction(async () => !(await chrome.storage.session.get("playPostingBatch")).playPostingBatch);
    const resumed = context.serviceWorkers().find(entry => entry.url() === worker.url())
      || await context.waitForEvent("serviceworker");
    assert.equal(await resumed.evaluate(() => chrome.alarms.get("play-posting-batch")), undefined);
    console.log("Chrome resumed Play, sent the pending URL once, and cleared the batch and alarm.");
  } finally {
    await context.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
