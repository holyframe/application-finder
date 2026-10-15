// Optional integration check. Uses a fresh profile and synthetic pages only.
// NODE_PATH must expose Playwright. Usage: node tests/kimi-posting-browser-check.cjs [msedge|chromium]
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");

async function waitForBatch(page, matches) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(async () =>
      (await chrome.storage.session.get("playPostingBatch")).playPostingBatch);
    if (matches(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the posting batch.");
}

(async () => {
  const context = await chromium.launchPersistentContext("", {
    headless: true, channel: process.argv[2] || "msedge", viewport: { width: 400, height: 960 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  context.setDefaultTimeout(15000);
  try {
    await context.route(/^https?:/, route => route.fulfill({ contentType: "text/html", body:
      `<!doctype html><title>Kimi posting test</title>
       <div data-testid="chat-editor"><div class="chat-input-editor" contenteditable="true" role="textbox" style="min-height:50px"></div>
       <div class="send-button-container disabled" style="height:40px;width:40px"><svg name="Send"></svg></div></div>
       <script>
         window.submissions = [];
         const input = document.querySelector('.chat-input-editor');
         const send = document.querySelector('.send-button-container');
         input.addEventListener('input', () => send.classList.remove('disabled'));
         send.addEventListener('click', () => {
           if (send.querySelector('[name="Stop"]')) throw new Error('Clicked Kimi Stop while busy');
           if (send.classList.contains('disabled')) throw new Error('Clicked disabled Kimi Send');
           window.submissions.push(input.innerText.trim()); input.innerHTML = '';
         });
       </script>`
    }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    const errors = [];
    panel.on("pageerror", error => errors.push(error.message));
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
    await panel.evaluate(async () => {
      await chrome.storage.local.set({ sheetConfig: { aiProviderId: 'none' } });
      setJobDescriptionFormModalOpen(false);
    });
    const target = await context.newPage();
    await target.goto("https://target.invalid/original");
    target.on("pageerror", error => errors.push(error.message));
    const tabId = await panel.evaluate(async () =>
      (await chrome.tabs.query({})).find(tab => tab.url === 'https://target.invalid/original').id);
    const tabCount = await panel.evaluate(async () => (await chrome.tabs.query({})).length);
    await panel.evaluate(() => setActionSettingsModalOpen('checkPosting', true));
    await panel.waitForFunction(() => document.querySelector('#checkPostingUrl-kimi').value.includes('kimi.com'));
    for (const [providerId, url] of Object.entries({
      copilot: 'https://copilot.microsoft.com/chats/open-test',
      perplexity: 'https://www.perplexity.ai/search/open-test',
      deepseek: 'https://chat.deepseek.com/a/chat/open-test',
      kimi: 'https://www.kimi.com/chat/open-test'
    })) {
      await panel.locator(`#checkPostingUrl-${providerId}`).fill(url);
      await panel.evaluate(async tabId => {
        await chrome.tabs.update(tabId, { active: true });
        await syncActiveTabFromBrowser();
      }, tabId);
      // A real side panel preserves the active browser tab. This test hosts
      // the panel in an extension tab, so dispatch its click without activating it.
      await panel.locator(`[data-open-check-posting-url="${providerId}"]`).dispatchEvent('click');
      await target.waitForURL(url);
      assert.equal(await panel.evaluate(async () => (await chrome.tabs.query({})).length), tabCount);
    }
    console.log('All four open-link buttons navigate the same tab without creating tabs.');
    const layout = await panel.locator('.check-posting-ai-url-row').evaluateAll(rows => rows.every(row => {
      const bounds = row.getBoundingClientRect();
      return [...row.children].every(child => {
        const rect = child.getBoundingClientRect();
        return rect.left >= bounds.left && rect.right <= bounds.right + 1;
      });
    }));
    assert.equal(layout, true);
    await panel.screenshot({ path: path.join(os.tmpdir(), 'application-finder-kimi-settings.png'), fullPage: true });
    await panel.evaluate(async () => {
      document.querySelector('#checkPostingProvider-kimi').checked = true;
      playPostingTabCountInput.value = '1';
      playPostingDelayMinInput.value = '71'; playPostingDelayMaxInput.value = '71';
      const saved = await saveCheckPostingSettings();
      if (!saved) throw new Error('Could not save Kimi settings');
      setActionSettingsModalOpen('checkPosting', false);
    });
    await panel.reload();
    await panel.evaluate(() => setActionSettingsModalOpen('checkPosting', true));
    await panel.waitForFunction(() => document.querySelector('#checkPostingProvider-kimi').checked);
    assert.equal(await panel.locator('#checkPostingUrl-kimi').inputValue(), 'https://www.kimi.com/chat/open-test');
    await panel.evaluate(() => setActionSettingsModalOpen('checkPosting', false));
    const job = await context.newPage();
    await job.goto('https://posting.invalid/kimi-job');
    await target.evaluate(() => document.querySelector('.send-button-container svg').setAttribute('name', 'Stop'));
    await panel.evaluate(async tabId => {
      await chrome.tabs.update(tabId, { active: true }); await syncActiveTabFromBrowser();
      await refreshCurrentTabActionAvailability();
      setJobDescriptionFormModalOpen(false);
    }, tabId);
    await panel.locator('#playButton').dispatchEvent('click');
    await waitForBatch(panel, state => state?.phase === 'waiting' && state.completedCount === 0);
    assert.deepEqual(await target.evaluate(() => window.submissions), []);
    assert.equal(await target.locator('.chat-input-editor').innerText(), 'https://posting.invalid/kimi-job');
    await target.evaluate(() => document.querySelector('.send-button-container svg').setAttribute('name', 'Send'));
    await worker.evaluate(async () => {
      const { playPostingBatch } = await chrome.storage.session.get('playPostingBatch');
      await chrome.storage.session.set({ playPostingBatch: { ...playPostingBatch, nextRunAt: Date.now() - 1 } });
      await runPlayPostingBatchStep();
    });
    await waitForBatch(panel, state => !state);
    assert.deepEqual(await target.evaluate(() => window.submissions), ['https://posting.invalid/kimi-job']);
    assert.deepEqual(errors, []);
    console.log('Kimi settings persist, its busy chat keeps the draft, and Play retries the same posting once idle.');
  } finally {
    await context.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
