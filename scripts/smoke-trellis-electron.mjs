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
let electronApp;
let page;

function check(name, detail = "ok") {
  checks.push({ name, detail });
  console.log(`SMOKE ✓ ${name}: ${detail}`);
}

async function seedFixture(root) {
  execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
  const taskDir = path.join(root, ".trellis", "tasks", "01-01-smoke");
  const specDir = path.join(root, ".trellis", "spec", "guide");
  await mkdir(taskDir, { recursive: true });
  await mkdir(specDir, { recursive: true });
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
}

try {
  await mkdir(resultsDir, { recursive: true });
  await seedFixture(fixtureRoot);

  electronApp = await electron.launch({
    args: [repoRoot],
    cwd: repoRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1"
    },
    timeout: 30_000
  });

  const child = electronApp.process();
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error(`[electron stderr] ${text}`);
  });

  page = await electronApp.firstWindow({ timeout: 20_000 });
  page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(`console.error: ${message.text()}`);
  });

  await page.waitForSelector(".trellis-launcher", { timeout: 20_000 });
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
    return window.gitUI.addProject(fixturePath);
  }, fixtureRoot);
  assert.equal(addedProject.path, fixtureRoot);
  check("Fixture repository added", addedProject.name);

  await page.locator(".trellis-launcher").click();
  await page.locator(".trellis-drawer").waitFor({ state: "visible", timeout: 10_000 });
  check("Trellis Drawer opened");

  await page.locator(".trellis-task-row", { hasText: "Trellis Smoke Task" }).waitFor({ state: "visible", timeout: 10_000 });
  await page.locator(".trellis-title-block", { hasText: "Trellis Smoke Task" }).waitFor({ state: "visible", timeout: 10_000 });
  const activeTaskCount = await page.locator(".trellis-progress-card strong").first().textContent();
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

  await page.screenshot({ path: screenshotPath, fullPage: true });
  check("Screenshot captured", path.basename(screenshotPath));

  assert.deepEqual(runtimeErrors, [], `Renderer errors detected:\n${runtimeErrors.join("\n")}`);
  check("No renderer pageerror/console.error detected");

  await writeFile(reportPath, JSON.stringify({ ok: true, checks, runtimeErrors }, null, 2), "utf8");
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
