import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = path.join(repoRoot, "test-results");
const screenshotPath = path.join(resultsDir, "gitkraken-workflows-electron-smoke.png");
const reportPath = path.join(resultsDir, "gitkraken-workflows-electron-smoke.json");
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "git-ui-pro-gitkraken-smoke-"));
const runtimeErrors = [];
const checks = [];
const mainStates = [];
let electronApp;
let page;

function check(name, detail = "ok") {
  checks.push({ name, detail });
  console.log(`SMOKE ✓ ${name}: ${detail}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: fixtureRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

async function seedFixture() {
  git(["init"]);
  git(["branch", "-M", "master"]);
  git(["config", "user.name", "GitKraken Smoke Runner"]);
  git(["config", "user.email", "gitkraken-smoke@example.invalid"]);

  await writeFile(path.join(fixtureRoot, "README.md"), "# GitKraken workflow smoke\n", "utf8");
  git(["add", "README.md"]);
  git(["commit", "-m", "base commit"]);

  git(["switch", "-c", "feature/drag-merge"]);
  await writeFile(path.join(fixtureRoot, "feature.txt"), "SMOKE_DRAG_MERGE\n", "utf8");
  git(["add", "feature.txt"]);
  git(["commit", "-m", "feature work"]);
  git(["switch", "master"]);
}

async function waitForWindow(app, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await app.evaluate(({ app: electronRuntime, BrowserWindow }) => ({
      ready: electronRuntime.isReady(),
      windows: BrowserWindow.getAllWindows().length,
      appPath: electronRuntime.getAppPath(),
      userData: electronRuntime.getPath("userData"),
      argv: process.argv,
      startupSteps: globalThis.__GIT_UI_PRO_SMOKE_STEPS ?? []
    }));
    mainStates.push(state);
    console.log(`SMOKE main state: ready=${state.ready} windows=${state.windows} steps=${state.startupSteps.join(",")}`);
    if (state.windows > 0) {
      const windows = app.windows();
      if (windows.length > 0) return windows[0];
      try {
        return await app.firstWindow({ timeout: 1_000 });
      } catch {
        // BrowserWindow exists; let Playwright observe it on the next poll.
      }
    }
    await delay(500);
  }
  throw new Error(`Electron did not create a BrowserWindow. Last main state: ${JSON.stringify(mainStates.at(-1))}`);
}

async function currentBranch() {
  return page.evaluate(async (fixturePath) => {
    if (!window.gitUI) throw new Error("gitUI bridge unavailable");
    return (await window.gitUI.getProjectStatus({ path: fixturePath })).currentBranch;
  }, fixtureRoot);
}

try {
  await mkdir(resultsDir, { recursive: true });
  await seedFixture();

  electronApp = await electron.launch({
    args: ["--disable-gpu", repoRoot],
    cwd: repoRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      ELECTRON_ENABLE_LOGGING: "1",
      GIT_UI_PRO_ELECTRON_SMOKE: "1"
    },
    timeout: 30_000
  });

  electronApp.on("console", (message) => {
    const text = `[electron main ${message.type()}] ${message.text()}`;
    console.log(text);
    if (message.type() === "error") runtimeErrors.push(text);
  });

  const child = electronApp.process();
  child.stdout?.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) console.log(`[electron stdout] ${text}`);
  });
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error(`[electron stderr] ${text}`);
  });
  child.on("exit", (code, signal) => console.log(`SMOKE electron exit: code=${code} signal=${signal}`));

  page = await waitForWindow(electronApp);
  page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(`console.error: ${message.text()}`);
  });

  await page.waitForSelector(".app-shell", { timeout: 20_000 });
  check("Electron main window rendered");

  const addedProject = await page.evaluate(async (fixturePath) => {
    if (!window.gitUI) throw new Error("gitUI bridge unavailable");
    await window.gitUI.updateUiPreferences({ bottomConsoleVisible: false });
    return window.gitUI.addProject(fixturePath);
  }, fixtureRoot);
  assert.equal(addedProject.path, fixtureRoot);
  check("Fixture repository added", addedProject.name);

  await page.reload({ waitUntil: "domcontentloaded" });
  const activeProject = page.locator(".project-rail-item.active", { hasText: addedProject.name });
  await activeProject.waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".gitkraken-branch-switcher").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".gitkraken-tag-button").waitFor({ state: "visible", timeout: 15_000 });
  check("GitKraken-style graph controls mounted");

  // Branch switch through the graph toolbar.
  await page.locator(".gitkraken-branch-switcher").click();
  const featureBranchItem = page.locator(".gitkraken-branch-item", { hasText: "feature/drag-merge" });
  await featureBranchItem.waitFor({ state: "visible", timeout: 5_000 });
  await featureBranchItem.click();
  await page.waitForFunction(async (fixturePath) => {
    if (!window.gitUI) return false;
    return (await window.gitUI.getProjectStatus({ path: fixturePath })).currentBranch === "feature/drag-merge";
  }, fixtureRoot, { timeout: 10_000 });
  assert.equal(await currentBranch(), "feature/drag-merge");
  check("Branch switch works", "master → feature/drag-merge");

  await page.locator(".gitkraken-branch-switcher").click();
  const masterBranchItem = page.locator(".gitkraken-branch-item", { hasText: "master" });
  await masterBranchItem.waitFor({ state: "visible", timeout: 5_000 });
  await masterBranchItem.click();
  await page.waitForFunction(async (fixturePath) => {
    if (!window.gitUI) return false;
    return (await window.gitUI.getProjectStatus({ path: fixturePath })).currentBranch === "master";
  }, fixtureRoot, { timeout: 10_000 });
  check("Branch switch restores target", "feature/drag-merge → master");

  // Show all graph refs so both local branch chips are available as drag source/target.
  await page.locator(".graph-ref-filter-button").click();
  const allRefsButton = page.locator(".graph-ref-mode-item", { hasText: "全部" });
  await allRefsButton.waitFor({ state: "visible", timeout: 5_000 });
  await allRefsButton.click();

  const featureChip = page.locator(".ref-chip.localBranch.gitkraken-branch-chip", { hasText: "feature/drag-merge" }).first();
  const masterChip = page.locator(".ref-chip.localBranch.gitkraken-branch-chip", { hasText: "master" }).first();
  await featureChip.waitFor({ state: "visible", timeout: 10_000 });
  await masterChip.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await featureChip.evaluate((element) => element.draggable), true);
  assert.equal(await masterChip.evaluate((element) => element.draggable), true);
  check("Local branch chips are draggable");

  await featureChip.dragTo(masterChip);
  const dropMenu = page.locator(".gitkraken-context-menu", { hasText: "選擇拖放操作" }).first();
  await dropMenu.waitFor({ state: "visible", timeout: 8_000 });
  await dropMenu.getByRole("menuitem", { name: "Merge feature/drag-merge into master" }).click();
  await page.waitForFunction(async (fixturePath) => {
    if (!window.gitUI) return false;
    const status = await window.gitUI.getProjectStatus({ path: fixturePath });
    return status.currentBranch === "master" && !status.operationState && !status.hasConflicts;
  }, fixtureRoot, { timeout: 15_000 });

  assert.equal(git(["merge-base", "--is-ancestor", "feature/drag-merge", "master"], { stdio: ["ignore", "pipe", "pipe"] }), "");
  assert.equal(git(["branch", "--show-current"]), "master");
  assert.match(git(["log", "master", "--format=%s", "-n", "5"]), /feature work/);
  check("Drag action chooser merge works", "feature/drag-merge → master");

  // Create a tag through the graph toolbar manager.
  await page.locator(".gitkraken-tag-button").click();
  const tagDialog = page.locator(".gitkraken-tag-dialog");
  await tagDialog.waitFor({ state: "visible", timeout: 5_000 });
  const tagInputs = tagDialog.locator(".gitkraken-tag-create input");
  await tagInputs.nth(0).fill("smoke-tag-v038");
  await tagInputs.nth(1).fill("HEAD");
  await tagDialog.locator(".gitkraken-create-tag").click();
  await tagDialog.locator(".gitkraken-tag-row", { hasText: "smoke-tag-v038" }).waitFor({ state: "visible", timeout: 8_000 });
  assert.match(git(["tag", "--list", "smoke-tag-v038"]), /^smoke-tag-v038$/);
  assert.equal(git(["rev-parse", "smoke-tag-v038"]), git(["rev-parse", "HEAD"]));
  check("Tag creation works", "smoke-tag-v038 @ HEAD");

  await page.screenshot({ path: screenshotPath, fullPage: true });
  check("Screenshot captured", path.basename(screenshotPath));

  assert.deepEqual(runtimeErrors, [], `Runtime errors detected:\n${runtimeErrors.join("\n")}`);
  check("No Electron/renderer console errors detected");

  await writeFile(reportPath, JSON.stringify({ ok: true, checks, runtimeErrors, mainStates }, null, 2), "utf8");
  console.log("SMOKE RESULT: PASS");
} catch (error) {
  if (page) {
    try {
      await mkdir(resultsDir, { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch {
      // Preserve the original smoke failure.
    }
  }
  await writeFile(reportPath, JSON.stringify({
    ok: false,
    checks,
    runtimeErrors,
    mainStates,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
  }, null, 2), "utf8");
  console.error("SMOKE RESULT: FAIL", error);
  process.exitCode = 1;
} finally {
  if (electronApp) {
    try {
      await electronApp.close();
    } catch {
      // The process may already have exited after a startup failure.
    }
  }
  await rm(fixtureRoot, { recursive: true, force: true });
}
