import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = path.join(repoRoot, "test-results");
const screenshotPath = path.join(resultsDir, "gitkraken-context-actions-electron-smoke.png");
const reportPath = path.join(resultsDir, "gitkraken-context-actions-electron-smoke.json");
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "git-ui-pro-context-smoke-"));
const runtimeErrors = [];
const checks = [];
let electronApp;
let page;

function check(name, detail = "ok") {
  checks.push({ name, detail });
  console.log(`SMOKE ✓ ${name}: ${detail}`);
}

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: fixtureRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedFixture() {
  git(["init"]);
  git(["branch", "-M", "master"]);
  git(["config", "user.name", "Context Smoke Runner"]);
  git(["config", "user.email", "context-smoke@example.invalid"]);

  await writeFile(path.join(fixtureRoot, "README.md"), "# context smoke\n", "utf8");
  git(["add", "README.md"]);
  git(["commit", "-m", "base context commit"]);

  git(["switch", "-c", "feature/rebase"]);
  await writeFile(path.join(fixtureRoot, "feature.txt"), "FEATURE_REBASE\n", "utf8");
  git(["add", "feature.txt"]);
  git(["commit", "-m", "feature rebase work"]);

  git(["switch", "master"]);
  await writeFile(path.join(fixtureRoot, "master.txt"), "MASTER_WORK\n", "utf8");
  git(["add", "master.txt"]);
  git(["commit", "-m", "master work"]);
  git(["tag", "existing-context-tag", "HEAD~1"]);

  git(["switch", "-c", "temp/rename"]);
  await writeFile(path.join(fixtureRoot, "temp.txt"), "TEMP_RENAME\n", "utf8");
  git(["add", "temp.txt"]);
  git(["commit", "-m", "temp rename work"]);
  git(["switch", "master"]);
}

async function waitForWindow(app, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const windows = app.windows();
    if (windows.length > 0) return windows[0];
    try {
      return await app.firstWindow({ timeout: 500 });
    } catch {
      await delay(250);
    }
  }
  throw new Error("Electron did not create a BrowserWindow");
}

async function showAllRefs() {
  await page.locator(".graph-ref-filter-button").click();
  const allRefs = page.locator(".graph-ref-mode-item", { hasText: "全部" });
  await allRefs.waitFor({ state: "visible", timeout: 5_000 });
  await allRefs.click();
}

function branchChip(name) {
  return page.locator(".ref-chip.localBranch.gitkraken-branch-chip", { hasText: name }).first();
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
    if (message.type() === "error") runtimeErrors.push(`[electron main] ${message.text()}`);
  });

  page = await waitForWindow(electronApp);
  page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(`console.error: ${message.text()}`);
  });

  await page.waitForSelector(".app-shell", { timeout: 20_000 });
  const addedProject = await page.evaluate(async (fixturePath) => {
    if (!window.gitUI) throw new Error("gitUI bridge unavailable");
    await window.gitUI.updateUiPreferences({ bottomConsoleVisible: false });
    return window.gitUI.addProject(fixturePath);
  }, fixtureRoot);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".project-rail-item.active", { hasText: addedProject.name }).waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".gitkraken-branch-switcher").waitFor({ state: "visible", timeout: 15_000 });
  await showAllRefs();
  check("Context action layer mounted");

  // Branch context menu exposes GitKraken-style actions.
  const feature = branchChip("feature/rebase");
  await feature.waitFor({ state: "visible", timeout: 10_000 });
  await feature.click({ button: "right" });
  const featureMenu = page.locator(".gitkraken-context-menu", { hasText: "feature/rebase" }).first();
  await featureMenu.waitFor({ state: "visible", timeout: 5_000 });
  await featureMenu.getByRole("menuitem", { name: "切換到 feature/rebase" }).waitFor({ state: "visible" });
  await featureMenu.getByRole("menuitem", { name: /Merge 到 master/ }).waitFor({ state: "visible" });
  await featureMenu.getByRole("menuitem", { name: "在此建立 Tag" }).waitFor({ state: "visible" });
  check("Branch right-click actions rendered");
  await page.keyboard.press("Escape");

  // Rename from the branch chip itself.
  const temp = branchChip("temp/rename");
  await temp.waitFor({ state: "visible", timeout: 10_000 });
  await temp.click({ button: "right" });
  const tempMenu = page.locator(".gitkraken-context-menu", { hasText: "temp/rename" }).first();
  await tempMenu.getByRole("menuitem", { name: "重新命名分支…" }).click();
  const renameDialog = page.locator(".gitkraken-action-dialog", { hasText: "重新命名 temp/rename" });
  await renameDialog.waitFor({ state: "visible", timeout: 5_000 });
  await renameDialog.locator("input").fill("temp/renamed");
  await renameDialog.getByRole("button", { name: "確認" }).click();
  await page.waitForFunction(async (fixturePath) => {
    if (!window.gitUI) return false;
    const branches = await window.gitUI.getBranches({ path: fixturePath });
    return branches.some((branch) => branch.name === "temp/renamed") && !branches.some((branch) => branch.name === "temp/rename");
  }, fixtureRoot, { timeout: 10_000 });
  assert.match(git(["branch", "--list", "temp/renamed"]), /temp\/renamed/);
  check("Branch rename works from context menu");

  // Preserve the native commit menu while extending it with React-rendered Tag actions.
  const masterCommit = page.locator(".graph-commit-row", { hasText: "master work" }).first();
  await masterCommit.click({ button: "right" });
  const commitMenu = page.locator(".graph-commit-menu");
  await commitMenu.waitFor({ state: "visible", timeout: 5_000 });
  await commitMenu.getByRole("menuitem", { name: "Cherry-pick 此提交" }).waitFor({ state: "visible" });
  const commitExtension = page.locator(".gitkraken-commit-extension-menu");
  await commitExtension.waitFor({ state: "visible", timeout: 5_000 });
  const createTagHere = commitExtension.getByRole("menuitem", { name: "建立 Tag", exact: true });
  await createTagHere.click();
  const tagDialog = page.locator(".gitkraken-action-dialog", { hasText: "建立 Tag" });
  await tagDialog.waitFor({ state: "visible", timeout: 8_000 });
  await tagDialog.locator("input").fill("context-smoke-tag");
  await tagDialog.getByRole("button", { name: "建立" }).click();
  await page.waitForFunction(async (fixturePath) => {
    if (!window.gitUI) return false;
    const tags = await window.gitUI.getTags({ path: fixturePath });
    return tags.some((tag) => tag.name === "context-smoke-tag");
  }, fixtureRoot, { timeout: 10_000 });
  assert.equal(git(["rev-parse", "context-smoke-tag"]), git(["rev-parse", "master"]));
  check("Commit context extension creates tag");

  // Tag context menu creates and checks out a branch at the tagged commit.
  await showAllRefs();
  const existingTag = page.locator(".ref-chip.tag", { hasText: "existing-context-tag" }).first();
  await existingTag.waitFor({ state: "visible", timeout: 10_000 });
  await existingTag.click({ button: "right" });
  const tagMenu = page.locator(".gitkraken-context-menu", { hasText: "existing-context-tag" }).first();
  await tagMenu.getByRole("menuitem", { name: "從此 Tag 建立分支…" }).click();
  const branchDialog = page.locator(".gitkraken-action-dialog", { hasText: "從 Tag existing-context-tag 建立分支" });
  await branchDialog.waitFor({ state: "visible", timeout: 5_000 });
  await branchDialog.locator("input").fill("from/context-tag");
  await branchDialog.getByRole("button", { name: "確認" }).click();
  await page.waitForFunction(async (fixturePath) => {
    if (!window.gitUI) return false;
    return (await window.gitUI.getProjectStatus({ path: fixturePath })).currentBranch === "from/context-tag";
  }, fixtureRoot, { timeout: 10_000 });
  assert.equal(git(["rev-parse", "from/context-tag"]), git(["rev-parse", "existing-context-tag"]));
  check("Tag context menu creates branch");

  // Return to master using branch context action, then drag feature onto master and choose Rebase.
  await showAllRefs();
  const master = branchChip("master");
  await master.click({ button: "right" });
  await page.locator(".gitkraken-context-menu", { hasText: "master" }).first().getByRole("menuitem", { name: "切換到 master" }).click();
  await page.waitForFunction(async (fixturePath) => {
    if (!window.gitUI) return false;
    return (await window.gitUI.getProjectStatus({ path: fixturePath })).currentBranch === "master";
  }, fixtureRoot, { timeout: 10_000 });
  check("Branch checkout works from context menu");

  await showAllRefs();
  const featureForRebase = branchChip("feature/rebase");
  const masterTarget = branchChip("master");
  await featureForRebase.dragTo(masterTarget);
  const dropMenu = page.locator(".gitkraken-context-menu", { hasText: "選擇拖放操作" }).first();
  await dropMenu.waitFor({ state: "visible", timeout: 8_000 });
  await dropMenu.getByRole("menuitem", { name: "Rebase feature/rebase onto master" }).click();
  const rebaseConfirm = page.locator(".gitkraken-action-dialog", { hasText: "Rebase feature/rebase onto master" });
  await rebaseConfirm.waitFor({ state: "visible", timeout: 5_000 });
  await rebaseConfirm.getByRole("button", { name: "開始 Rebase" }).click();
  await page.waitForFunction(async (fixturePath) => {
    if (!window.gitUI) return false;
    const status = await window.gitUI.getProjectStatus({ path: fixturePath });
    return status.currentBranch === "feature/rebase" && !status.operationState && !status.hasConflicts;
  }, fixtureRoot, { timeout: 15_000 });
  assert.equal(git(["rev-parse", "feature/rebase^"]), git(["rev-parse", "master"]));
  check("Drag action chooser rebase works", "feature/rebase onto master");

  await page.screenshot({ path: screenshotPath, fullPage: true });
  assert.deepEqual(runtimeErrors, [], `Runtime errors detected:\n${runtimeErrors.join("\n")}`);
  check("No Electron/renderer console errors detected");

  await writeFile(reportPath, JSON.stringify({ ok: true, checks, runtimeErrors }, null, 2), "utf8");
  console.log("SMOKE RESULT: PASS");
} catch (error) {
  if (page) {
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch {
      // Preserve original error.
    }
  }
  await writeFile(reportPath, JSON.stringify({
    ok: false,
    checks,
    runtimeErrors,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
  }, null, 2), "utf8");
  console.error("SMOKE RESULT: FAIL", error);
  process.exitCode = 1;
} finally {
  if (electronApp) {
    try {
      await electronApp.close();
    } catch {
      // Electron may already be closed.
    }
  }
  await rm(fixtureRoot, { recursive: true, force: true });
}
