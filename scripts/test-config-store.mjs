import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import configStoreModule from "../dist-electron/configStore.js";

const { ConfigStore } = configStoreModule;

async function withTemporaryStore(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "git-ui-pro-config-"));
  try {
    await run(new ConfigStore(directory), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("配置读改写串行执行且保留并发项目操作", async () => {
  await withTemporaryStore(async (store, directory) => {
    const [localA, localB, remoteUpper, remoteLower] = await Promise.all([
      store.addProject(path.join(directory, "repo-a")),
      store.addProject(path.join(directory, "repo-b")),
      store.addRemoteProject({ host: "example.com", username: "Deploy", repositoryPath: "/srv/repo" }, "/srv/repo"),
      store.addRemoteProject({ host: "example.com", username: "deploy", repositoryPath: "/srv/repo" }, "/srv/repo")
    ]);

    await Promise.all([
      store.setProjectFavorite(localA.id, true),
      store.removeProject(localB.id),
      store.reorderProjects([remoteLower.id, remoteUpper.id, localA.id])
    ]);

    const projects = await store.listProjects();
    assert.deepEqual(new Set(projects.map((project) => project.id)), new Set([localA.id, remoteUpper.id, remoteLower.id]));
    assert.equal(projects.find((project) => project.id === localA.id)?.favorite, true);
    assert.deepEqual(
      projects.filter((project) => project.remote).map((project) => project.remote.username).sort(),
      ["Deploy", "deploy"]
    );
  });
});

test("主配置损坏时保留原文件并从有效备份恢复", async () => {
  await withTemporaryStore(async (store, directory) => {
    const first = await store.addProject(path.join(directory, "repo-a"));
    await store.addProject(path.join(directory, "repo-b"));
    await writeFile(path.join(directory, "config.json"), "{ broken json", "utf8");

    const restored = await new ConfigStore(directory).read();
    assert.deepEqual(restored.projects.map((project) => project.id), [first.id]);
    const restoredRaw = await readFile(path.join(directory, "config.json"), "utf8");
    assert.doesNotThrow(() => JSON.parse(restoredRaw));

    const corruptFiles = (await readdir(directory)).filter((name) => name.startsWith("config.corrupt.") && name.endsWith(".json"));
    assert.equal(corruptFiles.length, 1);
    assert.equal(await readFile(path.join(directory, corruptFiles[0]), "utf8"), "{ broken json");
  });
});
