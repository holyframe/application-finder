// Optional visual QA: NODE_PATH must expose Playwright. Pass a screenshot folder.
// Uses synthetic data and an isolated browser; never calls Chrome extension or Google APIs.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(root, "sidepanel/sidepanel.css"), "utf8");
const source = fs.readFileSync(path.join(root, "sidepanel/sidepanel.js"), "utf8");
const renderer = ["isGoogleSheetsDocumentUrl", "createNoModelProfileProgress", "renderProfileList"].map((name) =>
  source.match(new RegExp("^function " + name + "\\b[\\s\\S]*?^}\\r?$", "m"))[0]
).join("\n");
const outputDir = process.argv[2];
if (!outputDir) throw new Error("Pass a screenshot output directory.");

(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.argv[3] || undefined
  });
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.route("**/*", (route) => route.abort());
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent(`<!doctype html>
      <html><head><style>${css}</style></head><body><main class="app">
        <section class="card profile-picker-card">
          <div class="card-title-row"><h2>Profiles</h2></div>
          <p id="profileJobTitle" class="profile-job-title is-hidden"></p>
          <ul id="profileList" class="profile-list" aria-label="Profiles"></ul>
        </section>
      </main></body></html>`);
    await page.addScriptTag({ content: `
      ${renderer}
      const areActionButtonsDisabled = false;
      let savePostProcessState = null;
      let isSavePostProcessRequestPending = false;
      function isSavePostProcessActive(state = savePostProcessState) {
        return Boolean(state?.runId);
      }
      async function cancelSavePostProcess() {}
      function requestDeleteNoModelProfileApplication() {}
      const profileList = document.getElementById("profileList");
      const profileJobTitle = document.getElementById("profileJobTitle");
      const activeTabId = 7;
      let noModelProgressByTabId = {};
      let profileSelectionState;
      function isNoModelSaveMode() { return true; }
      function renderProfileResumeSettings() {}
      function previewStatus(preview) {
        const status = preview === "cancelling" ? "running" :
          ["deleting", "deleted"].includes(preview) ? "completed" : preview;
        isSavePostProcessRequestPending = preview === "cancelling";
        const report = {
          runId: status === "running" ? "visual-run" : "",
          jobTitle: "Senior software engineer - Platform",
          status,
          jobUrl: "https://jobs.example/42",
          error: ["failed", "cancelled"].includes(status)
            ? "Save stopped. Completed records are kept; check the sheet before retrying."
            : "",
          profiles: [
            { id: "frontend", name: "Frontend",
              status: status === "idle" ? "idle" : "saved",
              stage: status === "idle" ? "idle" : "done",
              resumeUrl: status === "idle" ? "" : "https://docs.google.com/document/d/one/edit",
              sheetUrl: status === "idle" ? "" : "https://docs.google.com/spreadsheets/d/test/edit#gid=1" },
            { id: "backend", name: "Backend / Platform engineering",
              status: status === "idle" ? "idle" : status === "completed" ? "saved" : status === "running" ? "running" : status,
              stage: status === "idle" ? "idle" : status === "completed" ? "done" : "sheet",
              resumeUrl: status === "idle" ? "" : "https://docs.google.com/document/d/two/edit",
              sheetUrl: status === "completed"
                ? "https://docs.google.com/spreadsheets/d/test/edit#gid=2"
                : "" },
            { id: "data", name: "Data and analytics",
              status: status === "idle" ? "idle" : status === "completed" ? "saved" : status === "running" ? "queued" :
                status === "cancelled" ? "cancelled" : "skipped",
              stage: status === "completed" ? "done" : "resume",
              resumeUrl: status === "completed"
                ? "https://docs.google.com/document/d/three/edit"
                : "",
              sheetUrl: status === "completed"
                ? "https://docs.google.com/spreadsheets/d/test/edit#gid=3"
                : "" }
          ]
        };
        savePostProcessState = status === "running"
          ? { runId: report.runId }
          : null;
        if (preview === "deleting") report.profiles[0].deleting = true;
        if (preview === "deleted") report.profiles[0].deleted = true;
        noModelProgressByTabId = status === "idle" ? {} : { [activeTabId]: report };
        profileSelectionState = {
          selectedProfileIds: report.profiles.map((profile) => profile.id),
          profiles: report.profiles.map((profile) => ({
            id: profile.id,
            name: profile.name,
            selectedPromptResumeId: "resume",
            promptResumes: [{ id: "resume", label: "Default", autoSelect: false }]
          }))
        };
        renderProfileList();
      }
    ` });
    fs.mkdirSync(outputDir, { recursive: true });
    for (const width of [320, 360, 440, 680]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const status of ["idle", "running", "cancelling", "completed", "deleting", "deleted", "failed", "cancelled"]) {
        await page.evaluate((value) => previewStatus(value), status);
        const dimensions = await page.evaluate(() => ({
          bodyWidth: document.documentElement.clientWidth,
          contentWidth: document.documentElement.scrollWidth,
          profileCount: document.querySelectorAll(".profile-item").length,
          embeddedProgressCount:
            document.querySelectorAll(".profile-item > .no-model-profile-progress").length,
          standalonePanelCount: document.querySelectorAll("#noModelProgressPanel").length,
          errorCount: document.querySelectorAll(".no-model-profile-error").length,
          openSheetCount:
            document.querySelectorAll(".no-model-profile-open-sheet").length,
          deleteCount: document.querySelectorAll(".no-model-profile-delete").length,
          cancelCount: document.querySelectorAll(".no-model-profile-cancel").length,
          disabledProgressCount:
            document.querySelectorAll(".no-model-profile-progress.is-disabled").length,
          activeConnectorCount:
            document.querySelectorAll('[data-connector-state="active"]').length,
          profileHeights: [...document.querySelectorAll(".profile-item")].map(
            (item) => Math.round(item.getBoundingClientRect().height)
          ),
          headerHeights: [...document.querySelectorAll(".profile-item-header")].map(
            (header) => Math.round(header.getBoundingClientRect().height)
          ),
          clippedControls: [...document.querySelectorAll(
            ".profile-item-header > input, .profile-actions > button, .no-model-profile-action"
          )].filter((control) => {
            const card = control.closest(".profile-item").getBoundingClientRect();
            const bounds = control.getBoundingClientRect();
            return bounds.left < card.left || bounds.right > card.right;
          }).length,
          overflowingSteps: [...document.querySelectorAll(".no-model-profile-steps li")]
            .filter((step) => step.lastElementChild.getBoundingClientRect().right >
              step.getBoundingClientRect().right + 1).length
        }));
        assert.equal(dimensions.profileCount, 3);
        assert.equal(dimensions.embeddedProgressCount, 3);
        assert.equal(dimensions.standalonePanelCount, 0);
        assert.equal(
          dimensions.errorCount,
          status === "failed" ? 1 : status === "cancelled" ? 2 : 0
        );
        const isRunning = ["running", "cancelling"].includes(status);
        const completedCount = status === "idle" ? 0 :
          ["completed", "deleting", "deleted"].includes(status) ? 3 : 1;
        assert.equal(dimensions.openSheetCount, completedCount);
        assert.equal(dimensions.deleteCount, completedCount - (status === "deleted" ? 1 : 0));
        assert.equal(dimensions.cancelCount, isRunning ? 3 : 0);
        assert.equal(dimensions.disabledProgressCount, status === "idle" ? 3 : 0);
        assert.equal(dimensions.activeConnectorCount, isRunning ? 1 : 0);
        assert.equal(dimensions.clippedControls, 0, JSON.stringify({ width, status, ...dimensions }));
        assert.equal(dimensions.overflowingSteps, 0, JSON.stringify({ width, status, ...dimensions }));
        assert.ok(dimensions.headerHeights.every((height) => height <= 40),
          JSON.stringify({ width, status, ...dimensions }));
        assert.ok(
          dimensions.contentWidth <= dimensions.bodyWidth,
          JSON.stringify(dimensions)
        );
        await page.screenshot({
          path: path.join(outputDir, `no-model-embedded-${status}-${width}.png`),
          fullPage: true
        });
        console.log(JSON.stringify({ width, status, heights: dimensions.profileHeights }));
      }
    }
    assert.equal(await page.evaluate(() => {
      const card = document.createElement("section");
      card.className = "card job-description-card is-hidden";
      document.body.append(card);
      const hidden = getComputedStyle(card).display === "none";
      card.remove();
      return hidden;
    }), true);
    assert.deepEqual(errors, []);
    console.log(
      "Visual QA passed: compact profiles at 320px, 360px, 440px, and 680px, all states, no overflow."
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
