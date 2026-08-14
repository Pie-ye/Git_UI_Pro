import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = path.join(repoRoot, "test-results");
const screenshotPath = path.join(resultsDir, "trellis-electron-smoke.png");
const reportPath = path.join(resultsDir, "trellis-electron-smoke.json");
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "git-ui-pro-trellis-smoke-"));
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

async function seedFixture(root) {
  execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Trellis Smoke Runner"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "trellis-smoke@example.invalid"], { cwd: root, stdio: "pipe" });

  const taskDir = path.join(root, ".trellis", "tasks", "01-01-smoke");
  const specDir = path.join(root, ".trellis", "spec", "guide");
  await mkdir(taskDir, { recursive: true });
  await mkdir(specDir, { recursive: true });
  await writeFile(path.join(root, "README.md"), "# Trellis Smoke Fixture\n", "utf8");
  await writeFile(path.join(taskDir, "task.json"), JSON.stringify({
    id: "smoke",
    title: "Trellis Smoke Task",
    status: "in_progress",
    priority: "P1",
    assignee: "Smoke Runner",
    scope: "electron-ui"
  }, null, 2), "utf8");
  await writeFile(path.join(taskDir, "prd.md"), "# Smoke PRD\n\n- [x] SMOKE_ACCEPTANCE\n", "utf8");
  await writeFile(path.join(taskDir, "design.md"), "# Smoke Design\n\nSMOKE_DESIGN\n", "utf8");
  await writeFile(path.join(taskDir, "implement.md"), "# Smoke Implement\n\n- [x] SMOKE_IMPLEMENT\n", "utf8");
  await writeFile(path.join(specDir, "smoke.md"), "# Smoke Spec\n\nSMOKE_SPEC\n", "utf8");

  execFileSync("git", ["add", "."], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "seed Trellis smoke fixture"], { cwd: root, stdio: "pipe" });
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
        // BrowserWindow exists; give Playwright one more polling turn to observe it.
      }
    }
    await delay(500);
  }
  throw new Error(`Electron did not create a BrowserWindow. Last main state: ${JSON.stringify(mainStates.at(-1))}`);
}

try {
  await mkdir(resultsDir, { recursive: true });
  await seedFixture(fixtureRoot);

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

  const bridgeState = await page.evaluate(() => ({
    gitUI: Boolean(window.gitUI),
    trellisUI: Boolean(window.trellisUI)
  }));
  assert.equal(bridgeState.gitUI, true, "window.gitUI bridge is missing");
  assert.equal(bridgeState.trellisUI, true, "window.trellisUI bridge is missing");
  check("Desktop preload bridges available", JSON.stringify(bridgeState));

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
  await page.locator(".trellis-workspace").waitFor({ state: "visible", timeout: 15_000 });
  check("Trellis mounted in empty editor canvas");

  const themeContext = await page.evaluate(() => {
    const workspace = document.querySelector(".trellis-workspace");
    const editor = document.querySelector(".editor-detail-panel");
    const shell = document.querySelector(".app-shell");
    if (!(workspace instanceof HTMLElement) || !(editor instanceof HTMLElement) || !(shell instanceof HTMLElement)) return null;
    const workspaceStyle = getComputedStyle(workspace);
    const editorStyle = getComputedStyle(editor);
    return {
      shellClass: shell.className,
      workspacePanel: workspaceStyle.getPropertyValue("--panel").trim(),
      editorPanel: editorStyle.getPropertyValue("--panel").trim(),
      workspaceText: workspaceStyle.getPropertyValue("--text").trim(),
      editorText: editorStyle.getPropertyValue("--text").trim(),
      workspaceAccent: workspaceStyle.getPropertyValue("--accent").trim(),
      editorAccent: editorStyle.getPropertyValue("--accent").trim()
    };
  });
  assert.ok(themeContext, "Trellis/editor theme context is missing");
  assert.match(themeContext.shellClass, /theme-(light|dark)/, "App theme class is missing");
  assert.ok(themeContext.workspacePanel, "--panel theme token is missing");
  assert.equal(themeContext.workspacePanel, themeContext.editorPanel, "Trellis does not inherit the editor --panel token");
  assert.equal(themeContext.workspaceText, themeContext.editorText, "Trellis does not inherit the editor --text token");
  assert.equal(themeContext.workspaceAccent, themeContext.editorAccent, "Trellis does not inherit the editor --accent token");
  check("Trellis inherits Git UI theme tokens", `${themeContext.workspacePanel} / ${themeContext.workspaceAccent}`);

  await page.locator(".trellis-task-control", { hasText: "Trellis Smoke Task" }).waitFor({ state: "visible", timeout: 10_000 });
  await page.locator(".trellis-title-block", { hasText: "Trellis Smoke Task" }).waitFor({ state: "visible", timeout: 10_000 });
  const activeTaskCount = await page.locator(".trellis-workspace-count").textContent();
  assert.equal(activeTaskCount?.trim(), "1");
  check("Active task overview rendered", "1 task");

  await page.getByRole("button", { name: "PRD", exact: true }).click();
  await page.locator(".trellis-document pre", { hasText: "SMOKE_ACCEPTANCE" }).waitFor({ state: "visible", timeout: 5_000 });
  check("PRD document rendered");

  await page.getByRole("button", { name: "Design", exact: true }).click();
  await page.locator(".trellis-document pre", { hasText: "SMOKE_DESIGN" }).waitFor({ state: "visible", timeout: 5_000 });
  check("Design document rendered");

  await page.getByRole("button", { name: "Implement", exact: true }).click();
  await page.locator(".trellis-document pre", { hasText: "SMOKE_IMPLEMENT" }).waitFor({ state: "visible", timeout: 5_000 });
  check("Implement document rendered");

  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.locator(".trellis-review", { hasText: "ready_to_archive" }).waitFor({ state: "visible", timeout: 5_000 });
  const score = await page.locator(".trellis-review-score strong").textContent();
  assert.equal(score?.trim(), "96%");
  check("Review rendered", "ready_to_archive / 96%");

  await page.getByRole("button", { name: "Specs", exact: true }).click();
  const specButton = page.locator(".trellis-spec-node", { hasText: "smoke.md" });
  await specButton.waitFor({ state: "visible", timeout: 5_000 });
  await specButton.click();
  await page.locator(".trellis-spec-document pre", { hasText: "SMOKE_SPEC" }).waitFor({ state: "visible", timeout: 5_000 });
  check("Spec tree and file rendered");

  await writeFile(path.join(fixtureRoot, "README.md"), "# Trellis Smoke Fixture\n\nSMOKE_FILE_CHANGE\n", "utf8");
  await activeProject.click();
  const changedFile = page.locator(".scm-file-row", { hasText: "README.md" });
  await changedFile.waitFor({ state: "visible", timeout: 10_000 });
  await changedFile.click();
  await page.locator(".editor-detail-panel:not(.empty)").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator(".trellis-workspace").waitFor({ state: "detached", timeout: 10_000 });
  await page.locator(".editor-diff-panel", { hasText: "SMOKE_FILE_CHANGE" }).waitFor({ state: "visible", timeout: 10_000 });
  check("Selected file replaces Trellis canvas with diff preview");

  await page.locator(".editor-tab-close").click();
  await page.locator(".editor-detail-panel.empty").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator(".trellis-workspace").waitFor({ state: "visible", timeout: 10_000 });
  check("Closing file restores Trellis canvas");

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
