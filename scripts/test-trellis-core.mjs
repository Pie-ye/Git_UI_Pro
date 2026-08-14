import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseChecklist } = require("../dist-electron/trellis/checklist.js");
const { computeReadiness } = require("../dist-electron/trellis/readiness.js");
const { summarizeProgress } = require("../dist-electron/trellis/progress.js");
const {
  TrellisReaderError,
  buildSpecTree,
  detectTrellisProject,
  getTaskDetail,
  listActiveTasks,
  readSpecFile
} = require("../dist-electron/trellis/reader.js");
const { buildReviewFromSummary, reviewTask } = require("../dist-electron/trellis/review.js");

async function withTempDir(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-ui-pro-trellis-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedProject(root) {
  const tasks = path.join(root, ".trellis", "tasks");
  await mkdir(path.join(tasks, "archive", "old"), { recursive: true });
  await writeFile(path.join(tasks, "archive", "old", "task.json"), "{}", "utf8");

  const demo = path.join(tasks, "01-01-demo");
  await mkdir(demo, { recursive: true });
  await writeFile(path.join(demo, "task.json"), JSON.stringify({ id: "demo", title: "Demo Task", status: "planning", priority: "P2", assignee: "Pie-ye" }), "utf8");
  await writeFile(path.join(demo, "prd.md"), "# PRD\n\nHello", "utf8");

  const broken = path.join(tasks, "01-02-broken");
  await mkdir(broken, { recursive: true });
  await writeFile(path.join(broken, "task.json"), "{not-json", "utf8");

  const spec = path.join(root, ".trellis", "spec", "guides");
  await mkdir(spec, { recursive: true });
  await writeFile(path.join(spec, "index.md"), "# Guide\n\nbody", "utf8");
}

function artifacts(input = {}) {
  return { prd: false, design: false, implement: false, implementJsonl: false, checkJsonl: false, ...input };
}

function taskSummary(dirName, status, taskArtifacts) {
  return {
    dirName,
    title: dirName,
    status,
    children: [],
    artifacts: taskArtifacts,
    readiness: { level: "ok", flags: [] }
  };
}

test("checklist parser ignores fenced code blocks", () => {
  const result = parseChecklist("- [x] done\n```\n- [ ] fake\n```\n- [ ] real\n");
  assert.equal(result.total, 2);
  assert.equal(result.checked, 1);
  assert.deepEqual(result.uncheckedSamples, ["real"]);
});

test("readiness preserves trellis-window semantics", () => {
  assert.deepEqual(computeReadiness({ hasTaskJson: false, artifacts: artifacts() }), {
    level: "missing_required",
    flags: ["missing_task_json"]
  });
  assert.deepEqual(computeReadiness({ hasTaskJson: true, artifacts: artifacts({ prd: true }) }), {
    level: "ok",
    flags: ["no_design", "no_implement"]
  });
});

test("reader lists active tasks, details and specs", async () => withTempDir(async (root) => {
  await seedProject(root);
  assert.equal(await detectTrellisProject(root), true);
  const tasks = await listActiveTasks(root);
  assert.deepEqual(new Set(tasks.map((item) => item.dirName)), new Set(["01-01-demo", "01-02-broken"]));
  assert.equal(tasks.some((item) => item.dirName === "archive"), false);

  const demo = tasks.find((item) => item.dirName === "01-01-demo");
  assert.equal(demo.title, "Demo Task");
  assert.equal(demo.artifacts.prd, true);
  assert.equal(demo.artifacts.design, false);
  assert.equal(demo.readiness.level, "ok");
  assert.equal(demo.readiness.flags.includes("no_design"), true);

  const broken = tasks.find((item) => item.dirName === "01-02-broken");
  assert.ok(broken.error);
  assert.equal(broken.readiness.level, "partial");

  const detail = await getTaskDetail(root, "01-01-demo");
  assert.equal(detail.documents.prd.missing, false);
  assert.match(detail.documents.prd.content, /Hello/u);
  assert.equal(detail.documents.design.missing, true);

  const tree = await buildSpecTree(root);
  assert.equal(tree.type, "dir");
  const doc = await readSpecFile(root, "guides/index.md");
  assert.match(doc.content, /Guide/u);
}));

test("spec reader rejects path traversal", async () => withTempDir(async (root) => {
  await seedProject(root);
  await assert.rejects(() => readSpecFile(root, "../tasks/01-01-demo/prd.md"), TrellisReaderError);
  await assert.rejects(() => readSpecFile(root, "../../etc/passwd"), TrellisReaderError);
}));

test("progress aggregation matches trellis-window", () => {
  const tasks = [
    taskSummary("a", "in_progress", artifacts({ prd: true, design: true })),
    taskSummary("b", "planning", artifacts({ prd: true })),
    taskSummary("c", "completed", artifacts({ prd: true, design: true, implement: true }))
  ];
  const result = summarizeProgress(tasks);
  assert.equal(result.total, 3);
  assert.equal(result.artifacts.prd, 3);
  assert.equal(result.percentInProgress, 33.3);
  assert.equal(result.percentPlanning, 33.3);
  assert.equal(result.percentCompleted, 33.3);
});

test("review marks completed implementation ready to archive", async () => withTempDir(async (root) => {
  const taskDir = path.join(root, "t1");
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(taskDir, "task.json"), JSON.stringify({ title: "T", status: "in_progress" }), "utf8");
  await writeFile(path.join(taskDir, "prd.md"), "# G\n\n- [x] a\n- [x] b\n", "utf8");
  await writeFile(path.join(taskDir, "design.md"), "# d", "utf8");
  await writeFile(path.join(taskDir, "implement.md"), "- [x] one\n- [x] two\n", "utf8");
  const review = await buildReviewFromSummary(taskSummary("t1", "in_progress", artifacts({ prd: true, design: true, implement: true })), { taskDir, hasTaskJson: true });
  assert.equal(review.judgment, "ready_to_archive");
  assert.ok(review.score >= 0.75);
  assert.match(review.archiveCommand, /archive/u);
}));

test("review handles unmaintained and incomplete AC", async () => withTempDir(async (root) => {
  const unmaintained = path.join(root, "t2");
  await mkdir(unmaintained, { recursive: true });
  await writeFile(path.join(unmaintained, "prd.md"), "# Goal only\nno checkboxes", "utf8");
  await writeFile(path.join(unmaintained, "implement.md"), "- [x] a\n- [x] b\n", "utf8");
  const ready = await buildReviewFromSummary(taskSummary("t2", "in_progress", artifacts({ prd: true, implement: true })), { taskDir: unmaintained, hasTaskJson: true });
  assert.equal(ready.flags.includes("ac_unmaintained"), true);
  assert.equal(ready.judgment, "ready_to_archive");

  const incomplete = path.join(root, "t3");
  await mkdir(incomplete, { recursive: true });
  await writeFile(path.join(incomplete, "prd.md"), "- [x] a\n- [ ] b\n- [ ] c\n", "utf8");
  await writeFile(path.join(incomplete, "implement.md"), "- [x] done\n", "utf8");
  const verify = await buildReviewFromSummary(taskSummary("t3", "in_progress", artifacts({ prd: true, design: true, implement: true })), { taskDir: incomplete, hasTaskJson: true });
  assert.equal(verify.judgment, "needs_verification");
}));

test("review task reads a real .trellis task path", async () => withTempDir(async (root) => {
  const taskDir = path.join(root, ".trellis", "tasks", "01-01-x");
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(taskDir, "task.json"), JSON.stringify({ id: "x", title: "X", status: "in_progress" }), "utf8");
  await writeFile(path.join(taskDir, "prd.md"), "- [x] ok\n", "utf8");
  await writeFile(path.join(taskDir, "implement.md"), "- [x] ok\n", "utf8");
  const review = await reviewTask(root, "01-01-x");
  assert.equal(review.dirName, "01-01-x");
  assert.equal(review.rulesVersion, "review-1");
}));
