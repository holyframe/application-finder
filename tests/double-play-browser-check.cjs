// Optional integration check using a fresh profile and synthetic pages only.
// NODE_PATH must expose Playwright. Usage: node tests/double-play-browser-check.cjs [msedge|chromium]
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");

async function waitForBatch(page, matches, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page.evaluate(async () =>
      (await chrome.storage.session.get('playPostingBatch')).playPostingBatch);
    if (matches(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the posting batch.");
}

(async () => {
  const context = await chromium.launchPersistentContext("", {
    headless: true, channel: process.argv[2] || "msedge", viewport: { width: 400, height: 900 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    context.setDefaultTimeout(15000);
    await context.route(/^https?:/, route => {
      const jobright = new URL(route.request().url()).hostname === "jobright.ai";
      return route.fulfill({ contentType: "text/html", body: jobright
        ? `<!doctype html><title>Jobright test</title><script>
            window.openedJobIds = [];
            window.__applicationHelperJobright = {
              startOpenRun: () => ({ok: true}), stopOpenRun: () => ({ok: true}),
              describe: () => ({ok: true, harvestedJobs: 20, harvestedWithUrl: 20}),
              claimNext: (processed) => ({found: true, jobId: 'job-' + processed.length,
                applyUrl: 'https://employer.invalid/application-' + processed.length}),
              markAlreadyApplied: (jobId) => { window.openedJobIds.push(jobId); return {ok: true}; }
            };
          </script>`
        : `<!doctype html><title>Posting test</title>
          <textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button>
          <script>
            window.submissions = [];
            document.querySelector('button').onclick = () => {
              window.submissions.push(document.querySelector('textarea').value);
              document.querySelector('textarea').value = '';
            };
          </script>` });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    let panel = await context.newPage();
    const errors = [];
    panel.on("pageerror", error => errors.push(error.message));
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
    const ai = await context.newPage();
    await ai.goto("https://chatgpt.com/c/double-play-test");
    const jobright = await context.newPage();
    await jobright.goto("https://jobright.ai/jobs/recommend");
    const first = await context.newPage();
    await first.goto("https://posting.invalid/first");
    const last = await context.newPage();
    await last.goto("https://posting.invalid/last");
    const tabIds = await panel.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      await chrome.storage.local.set({ checkPostingConfig: {
        playTabCount: 1, playDelayMinSeconds: 71, playDelayMaxSeconds: 71
      } });
      return { ai: tabs.find(tab => tab.url.includes('/c/double-play-test')).id,
        jobright: tabs.find(tab => tab.url === 'https://jobright.ai/jobs/recommend').id };
    });
    await panel.evaluate(async ({ ai }) => {
      await chrome.tabs.update(ai, { active: true });
      await syncActiveTabFromBrowser();
      await refreshCurrentTabActionAvailability();
      jobrightOpenCountInput.value = '5';
      await saveJobrightSettings();
      setJobDescriptionFormModalOpen(false);
    }, tabIds);
    console.log("Starting Double Play from the new button.");
    // A real side panel preserves Chrome's active tab. This test hosts it in a
    // regular extension tab, so dispatch the DOM click without activating it.
    await panel.locator("#doublePlayButton").dispatchEvent("click");
    await waitForBatch(panel, state => state?.phase === 'waiting' && state.completedCount === 1);
    assert.deepEqual(await ai.evaluate(() => window.submissions), ["https://posting.invalid/last"]);
    console.log("First posting submitted; closing the panel during the wait.");
    // Close the panel during a wait. Check completion leaves a durable handoff.
    await panel.close();
    await worker.evaluate(async () => {
      const { playPostingBatch } = await chrome.storage.session.get('playPostingBatch');
      await chrome.storage.session.set({ playPostingBatch: { ...playPostingBatch, nextRunAt: Date.now() - 1 } });
      await runPlayPostingBatchStep();
    });
    assert.deepEqual(await ai.evaluate(() => window.submissions), ["https://posting.invalid/last", "https://posting.invalid/first"]);
    const deferred = await worker.evaluate(async () =>
      (await chrome.storage.session.get('playPostingBatch')).playPostingBatch);
    assert.equal(deferred.phase, "jobright-ready");
    assert.equal(deferred.jobrightTabId, tabIds.jobright);
    console.log("All postings submitted; reopening the panel for the deferred handoff.");
    panel = await context.newPage();
    panel.on("pageerror", error => errors.push(error.message));
    panel.on("console", message => { if (message.type() === 'error') console.log('Panel error:', message.text()); });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
    await panel.evaluate(() => setJobDescriptionFormModalOpen(false));
    await panel.waitForFunction(() => isJobrightOpening);
    assert.equal(await panel.locator("#doublePlayButton").getAttribute("aria-label"), "Stop Double Play");
    await waitForBatch(panel, state => !state);
    const result = await panel.evaluate(async (jobrightTabId) => {
      const tabs = await chrome.tabs.query({});
      const [{ result: markedJobIds }] = await chrome.scripting.executeScript({
        target: { tabId: jobrightTabId }, world: "MAIN", func: () => window.openedJobIds
      });
      return { applications: tabs.filter(tab => (tab.pendingUrl || tab.url).startsWith('https://employer.invalid/application-')).length,
        activeJobright: tabs.some(tab => tab.active && tab.url === 'https://jobright.ai/jobs/recommend'),
        markedJobIds,
        count: jobrightOpenCountInput.value,
        alarm: await chrome.alarms.get('play-posting-batch') };
    }, tabIds.jobright);
    assert.equal(result.markedJobIds.length, 5);
    assert.equal(result.applications, 5);
    assert.equal(result.activeJobright, true);
    assert.equal(result.count, "5");
    assert.equal(result.alarm, undefined);
    assert.deepEqual(errors, []);
    await panel.screenshot({ path: path.join(os.tmpdir(), 'application-finder-double-play-panel.png'), fullPage: true });
    const layout = await panel.locator('.home-check-posting-actions').evaluate(row => {
      const bounds = row.getBoundingClientRect();
      return [...row.querySelectorAll(':scope > button, :scope > div')].every(element => {
        const rect = element.getBoundingClientRect();
        return rect.left >= bounds.left && rect.right <= bounds.right + 1;
      });
    });
    assert.equal(layout, true);
    console.log("Double Play sent all posting tabs, restored the deferred handoff, opened the saved 5 Jobright applications, and fits at 400px.");
  } finally {
    await context.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
