import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { TrellisService } = require("../dist-electron/trellis/service.js");

async function withTempDir(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-ui-pro-trellis-service-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("service reports non-Trellis local repositories without throwing", async () => withTempDir(async (root) => {
  const service = new TrellisService();
  assert.deepEqual(await service.detect({ path: root }), {
    supported: true,
    detected: false,
    reason: "not_trellis"
  });
  const overview = await service.getOverview({ path: root });
  assert.equal(overview.tasks.length, 0);
  assert.equal(overview.progress.total, 0);
}));

test("service rejects remote Trellis reads but reports capability cleanly", async () => {
  const service = new TrellisService();
  const remote = { path: "/srv/project", remote: { type: "ssh", host: "example.test" } };
  assert.deepEqual(await service.detect(remote), {
    supported: false,
    detected: false,
    reason: "remote_not_supported"
  });
  await assert.rejects(() => service.listTasks(remote), /遠端 Trellis 檢視尚未支援/u);
});

test("service overview includes tasks, progress and review summaries", async () => withTempDir(async (root) => {
  const taskDir = path.join(root, ".trellis", "tasks", "01-01-demo");
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(taskDir, "task.json"), JSON.stringify({ id: "demo", title: "Demo", status: "in_progress", priority: "P1" }), "utf8");
  await writeFile(path.join(taskDir, "prd.md"), "- [x] accepted\n", "utf8");
  await writeFile(path.join(taskDir, "implement.md"), "- [x] done\n", "utf8");

  const service = new TrellisService();
  const overview = await service.getOverview({ path: root });
  assert.equal(overview.availability.detected, true);
  assert.equal(overview.tasks.length, 1);
  assert.equal(overview.progress.total, 1);
  assert.equal(overview.tasks[0].review.judgment, "ready_to_archive");
}));
