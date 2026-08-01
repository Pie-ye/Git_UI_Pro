import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { GitService, parseHostedRemoteUrl } = require("../dist-electron/gitService.js");
const testRoot = await mkdtemp(path.join(os.tmpdir(), "git-ui-pro-capabilities-"));

function git(repositoryPath, ...args) {
  return execFileSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function createRepository(name) {
  const repositoryPath = path.join(testRoot, name);
  const service = new GitService();
  const initResult = await service.initializeRepository(repositoryPath, "main");
  assert.equal(initResult.ok, true, initResult.messageZh ?? initResult.stderr);
  git(repositoryPath, "config", "user.name", "Capability Test");
  git(repositoryPath, "config", "user.email", "capability-test@example.com");
  git(repositoryPath, "config", "core.autocrlf", "false");
  await writeFile(path.join(repositoryPath, "tracked.txt"), "base\n", "utf8");
  git(repositoryPath, "add", "tracked.txt");
  git(repositoryPath, "commit", "-m", "base");
  return repositoryPath;
}

function assertSuccess(result) {
  assert.equal(result.ok, true, result.messageZh ?? result.stderr);
}

test("stash operations preserve explicit apply, pop, and drop behavior", async () => {
  const repositoryPath = await createRepository("stash");
  const service = new GitService();

  await writeFile(path.join(repositoryPath, "tracked.txt"), "stashed\n", "utf8");
  await writeFile(path.join(repositoryPath, "untracked.txt"), "untracked\n", "utf8");
  assertSuccess(await service.createStash(repositoryPath, { message: "saved state", includeUntracked: true }));
  const [entry] = await service.getStashes(repositoryPath);
  assert.equal(entry.selector, "stash@{0}");
  assert.match(entry.subject, /saved state/);

  await writeFile(path.join(repositoryPath, "tracked.txt"), "newer stash\n", "utf8");
  assertSuccess(await service.createStash(repositoryPath, { message: "newer state" }));
  const [newerEntry] = await service.getStashes(repositoryPath);
  assertSuccess(await service.applyStash(repositoryPath, entry.hash));
  assert.equal(await readFile(path.join(repositoryPath, "tracked.txt"), "utf8"), "stashed\n");
  git(repositoryPath, "reset", "--hard");
  git(repositoryPath, "clean", "-fd");
  assertSuccess(await service.dropStash(repositoryPath, entry.hash));
  assertSuccess(await service.popStash(repositoryPath, newerEntry.hash));
  assert.equal(await readFile(path.join(repositoryPath, "tracked.txt"), "utf8"), "newer stash\n");
  assert.equal((await service.getStashes(repositoryPath)).length, 0);
});

test("repository, remote, branch, tag, reflog, and hosting capabilities use real Git state", async () => {
  const repositoryPath = await createRepository("repository");
  const service = new GitService();
  const barePath = path.join(testRoot, "repository-remote.git");
  await mkdir(barePath);
  git(barePath, "init", "--bare", "--initial-branch=main");

  assertSuccess(await service.addRemote(repositoryPath, "origin", barePath));
  git(repositoryPath, "push", "--set-upstream", "origin", "main");
  const remotes = await service.getRemotes(repositoryPath);
  assert.deepEqual(remotes.map((remote) => remote.name), ["origin"]);
  assert.equal(remotes[0].fetchUrls[0].replace(/\\/g, "/"), barePath.replace(/\\/g, "/"));

  const mirrorPath = path.join(testRoot, "mirror.git");
  await mkdir(mirrorPath);
  git(mirrorPath, "init", "--bare", "--initial-branch=main");
  assertSuccess(await service.updateRemote(repositoryPath, "origin", { name: "upstream", pushUrl: mirrorPath }));
  assertSuccess(await service.setBranchUpstream(repositoryPath, "main", "upstream/main"));
  assertSuccess(await service.updateRemote(repositoryPath, "upstream", { pushUrl: null }));

  assertSuccess(await service.createBranch(repositoryPath, "feature/rename", false));
  assertSuccess(await service.renameBranch(repositoryPath, "feature/rename", "feature/renamed"));
  assertSuccess(await service.deleteBranch(repositoryPath, "feature/renamed", true));

  git(repositoryPath, "switch", "-c", "remote/delete-me");
  await writeFile(path.join(repositoryPath, "remote.txt"), "remote\n", "utf8");
  git(repositoryPath, "add", "remote.txt");
  git(repositoryPath, "commit", "-m", "remote branch");
  git(repositoryPath, "push", "upstream", "remote/delete-me");
  git(repositoryPath, "switch", "main");
  assertSuccess(await service.deleteRemoteBranch(repositoryPath, "upstream", "remote/delete-me"));

  assertSuccess(await service.createTag(repositoryPath, "v-test", "HEAD", "annotated test"));
  const tag = (await service.getTags(repositoryPath)).find((item) => item.name === "v-test");
  assert.equal(tag?.annotated, true);
  assert.equal(tag?.subject, "annotated test");
  assertSuccess(await service.pushTag(repositoryPath, "upstream", "v-test"));
  assertSuccess(await service.deleteRemoteTag(repositoryPath, "upstream", "v-test"));
  assertSuccess(await service.deleteTag(repositoryPath, "v-test"));

  await writeFile(path.join(repositoryPath, "second.txt"), "second\n", "utf8");
  git(repositoryPath, "add", "second.txt");
  git(repositoryPath, "commit", "-m", "second");
  const reflog = await service.getReflog(repositoryPath, 10);
  assert.match(reflog[0].selector, /@\{0\}$/);
  assert.equal(reflog[0].action, "commit");
  assertSuccess(await service.resetToReflogEntry(repositoryPath, reflog[1].hash, "mixed"));

  assertSuccess(await service.addRemote(repositoryPath, "github", "git@github.com:sample-org/sample-repo.git"));
  const links = await service.getHostingLinks(repositoryPath, "abc123", "feature/test", "github");
  assert.equal(links.repositoryUrl, "https://github.com/sample-org/sample-repo");
  assert.equal(links.commitUrl, "https://github.com/sample-org/sample-repo/commit/abc123");
  assert.equal(links.branchUrl, "https://github.com/sample-org/sample-repo/tree/feature/test");

  const gitlab = parseHostedRemoteUrl("https://gitlab.com/group/subgroup/repo.git", "deadbeef", "main");
  assert.equal(gitlab?.commitUrl, "https://gitlab.com/group/subgroup/repo/-/commit/deadbeef");
  assert.equal(gitlab?.branchUrl, "https://gitlab.com/group/subgroup/repo/-/tree/main");
  assert.equal(parseHostedRemoteUrl("ssh://internal.example.com/team/repo.git"), null);

  assertSuccess(await service.removeRemote(repositoryPath, "github"));
});

test("remote updates restore the exact original name and URLs after a later command fails", async () => {
  const repositoryPath = await createRepository("remote-transaction");
  const service = new GitService();
  const fetchPath = path.join(testRoot, "remote-transaction-fetch.git");
  const pushPath = path.join(testRoot, "remote-transaction-push.git");
  const nextFetchPath = path.join(testRoot, "remote-transaction-next-fetch.git");
  const nextPushPath = path.join(testRoot, "remote-transaction-next-push.git");
  for (const targetPath of [fetchPath, pushPath, nextFetchPath, nextPushPath]) {
    await mkdir(targetPath);
    git(targetPath, "init", "--bare", "--initial-branch=main");
  }
  assertSuccess(await service.addRemote(repositoryPath, "origin", fetchPath));
  git(repositoryPath, "remote", "set-url", "--push", "origin", pushPath);

  const originalRun = service.run.bind(service);
  let injectedFailure = false;
  service.run = async (cwd, args, options) => {
    if (!injectedFailure && args[0] === "remote" && args[1] === "set-url" && args[2] === "--push") {
      injectedFailure = true;
      return {
        ok: false,
        command: `git ${args.join(" ")}`,
        stdout: "",
        stderr: "injected push-url failure",
        exitCode: 73,
        messageZh: "注入的推送地址更新失败"
      };
    }
    return originalRun(cwd, args, options);
  };

  const result = await service.updateRemote(repositoryPath, "origin", {
    name: "upstream",
    fetchUrl: nextFetchPath,
    pushUrl: nextPushPath
  });
  assert.equal(result.ok, false);
  assert.match(result.messageZh ?? "", /已恢复原配置/);
  assert.equal(git(repositoryPath, "remote"), "origin");
  assert.equal(git(repositoryPath, "config", "--local", "--get-all", "remote.origin.url").replace(/\\/g, "/"), fetchPath.replace(/\\/g, "/"));
  assert.equal(git(repositoryPath, "config", "--local", "--get-all", "remote.origin.pushurl").replace(/\\/g, "/"), pushPath.replace(/\\/g, "/"));

  let primaryFailureInjected = false;
  let rollbackFailureInjected = false;
  service.run = async (cwd, args, options) => {
    if (!primaryFailureInjected && args[0] === "remote" && args[1] === "set-url" && args[2] === "--push") {
      primaryFailureInjected = true;
      return {
        ok: false,
        command: `git ${args.join(" ")}`,
        stdout: "",
        stderr: "injected push-url failure",
        exitCode: 73,
        messageZh: "注入的推送地址更新失败"
      };
    }
    if (primaryFailureInjected && !rollbackFailureInjected && args[0] === "config" && args.includes("--unset-all") && args.at(-1) === "remote.upstream.pushurl") {
      rollbackFailureInjected = true;
      return {
        ok: false,
        command: `git ${args.join(" ")}`,
        stdout: "",
        stderr: "injected rollback failure",
        exitCode: 75,
        messageZh: "注入的恢复失败"
      };
    }
    return originalRun(cwd, args, options);
  };
  const rollbackFailureResult = await service.updateRemote(repositoryPath, "origin", {
    name: "upstream",
    fetchUrl: nextFetchPath,
    pushUrl: nextPushPath
  });
  assert.equal(rollbackFailureResult.ok, false);
  assert.match(rollbackFailureResult.messageZh ?? "", /恢复原配置失败/);
});

test("remote creation removes the new remote when its custom push URL cannot be configured", async () => {
  const repositoryPath = await createRepository("remote-add-transaction");
  const service = new GitService();
  const originalRun = service.run.bind(service);
  let injectedFailure = false;
  service.run = async (cwd, args, options) => {
    if (!injectedFailure && args[0] === "remote" && args[1] === "set-url" && args[2] === "--push") {
      injectedFailure = true;
      return {
        ok: false,
        command: `git ${args.join(" ")}`,
        stdout: "",
        stderr: "injected push-url failure",
        exitCode: 73,
        messageZh: "注入的推送地址配置失败"
      };
    }
    return originalRun(cwd, args, options);
  };

  const result = await service.addRemote(
    repositoryPath,
    "origin",
    "https://example.com/fetch.git",
    "https://example.com/push.git"
  );
  assert.equal(result.ok, false);
  assert.match(result.messageZh ?? "", /已恢复原配置/);
  assert.equal(git(repositoryPath, "remote"), "");
});

test("signing updates restore every exact prior local value after a later key fails", async () => {
  const repositoryPath = await createRepository("signing-transaction");
  const service = new GitService();
  git(repositoryPath, "config", "--local", "--add", "commit.gpgSign", "true");
  git(repositoryPath, "config", "--local", "--add", "commit.gpgSign", "false");
  git(repositoryPath, "config", "--local", "gpg.format", "openpgp");

  const originalRun = service.run.bind(service);
  let injectedFailure = false;
  service.run = async (cwd, args, options) => {
    if (!injectedFailure && args[0] === "config" && args.at(-2) === "gpg.format") {
      injectedFailure = true;
      return {
        ok: false,
        command: `git ${args.join(" ")}`,
        stdout: "",
        stderr: "injected signing-format failure",
        exitCode: 74,
        messageZh: "注入的签名格式更新失败"
      };
    }
    return originalRun(cwd, args, options);
  };

  const result = await service.setSigningConfig(repositoryPath, { commitGpgSign: true, format: "ssh" });
  assert.equal(result.ok, false);
  assert.match(result.messageZh ?? "", /已恢复原配置/);
  assert.deepEqual(git(repositoryPath, "config", "--local", "--get-all", "commit.gpgSign").split(/\r?\n/), ["true", "false"]);
  assert.equal(git(repositoryPath, "config", "--local", "--get", "gpg.format"), "openpgp");

  service.run = originalRun;
  assertSuccess(await service.setSigningConfig(repositoryPath, { tagGpgSign: null }));
});

test("branch divergence and conflict counts reflect each real ref and conflicted file", async () => {
  const repositoryPath = await createRepository("branch-divergence");
  const service = new GitService();
  const barePath = path.join(testRoot, "branch-divergence-remote.git");
  await mkdir(barePath);
  git(barePath, "init", "--bare", "--initial-branch=main");
  assertSuccess(await service.addRemote(repositoryPath, "origin", barePath));
  git(repositoryPath, "push", "--set-upstream", "origin", "main");

  const peerPath = path.join(testRoot, "branch-divergence-peer");
  execFileSync("git", ["clone", barePath, peerPath], { cwd: testRoot, stdio: ["ignore", "pipe", "pipe"] });
  git(peerPath, "config", "user.name", "Peer Test");
  git(peerPath, "config", "user.email", "peer@example.com");
  await writeFile(path.join(peerPath, "peer.txt"), "peer\n", "utf8");
  git(peerPath, "add", "peer.txt");
  git(peerPath, "commit", "-m", "peer commit");
  git(peerPath, "push", "origin", "main");

  await writeFile(path.join(repositoryPath, "local.txt"), "local\n", "utf8");
  git(repositoryPath, "add", "local.txt");
  git(repositoryPath, "commit", "-m", "local commit");
  git(repositoryPath, "fetch", "origin");
  git(repositoryPath, "branch", "without-upstream");
  const branches = await service.getBranches(repositoryPath);
  const main = branches.find((branch) => branch.name === "main" && branch.type === "local");
  assert.equal(main?.ahead, 1);
  assert.equal(main?.behind, 1);
  const withoutUpstream = branches.find((branch) => branch.name === "without-upstream" && branch.type === "local");
  assert.equal(withoutUpstream?.upstream, undefined);
  assert.equal(withoutUpstream?.ahead, undefined);
  assert.equal(withoutUpstream?.behind, undefined);

  const conflictPath = await createRepository("conflict-count");
  git(conflictPath, "switch", "-c", "conflict-side");
  await writeFile(path.join(conflictPath, "tracked.txt"), "side\n", "utf8");
  git(conflictPath, "add", "tracked.txt");
  git(conflictPath, "commit", "-m", "side change");
  git(conflictPath, "switch", "main");
  await writeFile(path.join(conflictPath, "tracked.txt"), "main\n", "utf8");
  git(conflictPath, "add", "tracked.txt");
  git(conflictPath, "commit", "-m", "main change");
  const mergeResult = await service.run(conflictPath, ["merge", "conflict-side"]);
  assert.equal(mergeResult.ok, false);
  const conflictStatus = await service.getStatus(conflictPath);
  assert.equal(conflictStatus.hasConflicts, true);
  assert.equal(conflictStatus.conflictedCount, 1);
  git(conflictPath, "merge", "--abort");
});

test("clone, linked worktree, gitignore, signing, LFS, and signature checks are executable", async () => {
  const repositoryPath = await createRepository("extended");
  const service = new GitService();
  const clonePath = path.join(testRoot, "extended-clone");
  assertSuccess(await service.cloneRepository(repositoryPath, clonePath, { branch: "main", depth: 1 }));
  assert.equal(git(clonePath, "branch", "--show-current"), "main");

  const linkedPath = path.join(testRoot, "extended-worktree");
  assertSuccess(await service.addLinkedWorktree(repositoryPath, { path: linkedPath, newBranch: "worktree/test" }));
  const linked = await service.getLinkedWorktrees(repositoryPath);
  assert.equal(linked.some((item) => item.branch === "worktree/test"), true);
  assertSuccess(await service.removeLinkedWorktree(repositoryPath, linkedPath));
  assertSuccess(await service.pruneLinkedWorktrees(repositoryPath, true));

  assert.deepEqual(await service.readGitIgnore(repositoryPath), { exists: false, content: "", revision: "missing" });
  assert.equal(await service.createGitIgnoreIfMissing(repositoryPath), true);
  const emptyGitIgnore = await service.readGitIgnore(repositoryPath);
  assert.equal(emptyGitIgnore.exists, true);
  assert.equal(emptyGitIgnore.content, "");
  assert.match(emptyGitIgnore.revision, /^git:[0-9a-f]{40,64}$/);
  await service.writeGitIgnore(repositoryPath, "node_modules/\n*.log\n", emptyGitIgnore.revision);
  assert.equal(await service.createGitIgnoreIfMissing(repositoryPath), false);
  const savedGitIgnore = await service.readGitIgnore(repositoryPath);
  assert.equal(savedGitIgnore.content, "node_modules/\n*.log\n");
  await writeFile(path.join(repositoryPath, ".gitignore"), "external-rule/\n", "utf8");
  await assert.rejects(
    service.writeGitIgnore(repositoryPath, "stale-editor-rule/\n", savedGitIgnore.revision),
    /外部发生变化/
  );
  assert.equal(await readFile(path.join(repositoryPath, ".gitignore"), "utf8"), "external-rule/\n");

  assertSuccess(
    await service.setSigningConfig(repositoryPath, {
      commitGpgSign: false,
      signingKey: "test-key",
      format: "ssh"
    })
  );
  assert.deepEqual(await service.getSigningConfig(repositoryPath), {
    commitGpgSign: false,
    signingKey: "test-key",
    format: "ssh"
  });
  assertSuccess(await service.setSigningConfig(repositoryPath, { signingKey: null, format: null }));

  const uninitializedLfsStatus = await service.getLfsStatus(repositoryPath);
  assert.equal(uninitializedLfsStatus.installed, true);
  assert.equal(uninitializedLfsStatus.initialized, false);
  assertSuccess(await service.installLfs(repositoryPath, "local"));
  const lfsStatus = await service.getLfsStatus(repositoryPath);
  assert.equal(lfsStatus.installed, true);
  assert.equal(lfsStatus.initialized, true);
  assert.match(lfsStatus.version, /^git-lfs\//);
  assert.deepEqual(lfsStatus.files, []);
  const hookPath = git(repositoryPath, "rev-parse", "--git-path", "hooks/pre-push");
  await rm(path.resolve(repositoryPath, hookPath));
  const missingHookStatus = await service.getLfsStatus(repositoryPath);
  assert.equal(missingHookStatus.installed, true);
  assert.equal(missingHookStatus.initialized, false);
  assertSuccess(await service.pullLfs(repositoryPath));
  git(repositoryPath, "lfs", "track", "*.bin");
  await writeFile(path.join(repositoryPath, "asset.bin"), "first\n", "utf8");
  git(repositoryPath, "add", ".gitattributes", "asset.bin");
  git(repositoryPath, "commit", "-m", "add lfs asset");
  await writeFile(path.join(repositoryPath, "asset.bin"), "second\n", "utf8");
  const changedLfsStatus = await service.getLfsStatus(repositoryPath);
  assert.equal(changedLfsStatus.files.some((file) => file.path === "asset.bin" && file.staged === false), true);
  assertSuccess(await service.pruneLfs(repositoryPath, true));

  assertSuccess(await service.showCommitSignature(repositoryPath, "HEAD"));
  const verification = await service.verifyCommitSignature(repositoryPath, "HEAD");
  assert.equal(verification.ok, false, "未签名提交不得被报告为签名验证成功");
});

test("submodule state and lifecycle commands are backed by Git", async () => {
  const grandchildPath = await createRepository("submodule-grandchild");
  const childPath = await createRepository("submodule-child");
  git(childPath, "-c", "protocol.file.allow=always", "submodule", "add", grandchildPath, "nested/grandchild");
  git(childPath, "commit", "-m", "add nested submodule");
  const repositoryPath = await createRepository("submodule-parent");
  const service = new GitService();
  git(repositoryPath, "-c", "protocol.file.allow=always", "submodule", "add", childPath, "modules/child");
  git(repositoryPath, "commit", "-m", "add submodule");

  let modules = await service.getSubmodules(repositoryPath);
  let [submodule] = modules;
  assert.equal(submodule.path, "modules/child");
  assert.equal(submodule.state, "initialized");
  const nestedSubmodule = modules.find((item) => item.path === "modules/child/nested/grandchild");
  assert.equal(nestedSubmodule?.url.replace(/\\/g, "/"), grandchildPath.replace(/\\/g, "/"));
  assertSuccess(await service.syncSubmodules(repositoryPath));

  git(repositoryPath, "submodule", "deinit", "--force", "modules/child");
  modules = await service.getSubmodules(repositoryPath);
  [submodule] = modules;
  assert.equal(submodule.state, "uninitialized");
  assertSuccess(await service.initializeSubmodules(repositoryPath, ["modules/child"]));
  const previousAllowedProtocols = process.env.GIT_ALLOW_PROTOCOL;
  process.env.GIT_ALLOW_PROTOCOL = "file";
  try {
    assertSuccess(await service.updateSubmodules(repositoryPath, { paths: ["modules/child"], initialize: true, recursive: true }));
  } finally {
    if (previousAllowedProtocols === undefined) {
      delete process.env.GIT_ALLOW_PROTOCOL;
    } else {
      process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocols;
    }
  }
});

test("history pagination, advanced filters, file history, and blame use complete Git data", async () => {
  const repositoryPath = await createRepository("history");
  const service = new GitService();

  await writeFile(path.join(repositoryPath, "history.txt"), "first\n", "utf8");
  git(repositoryPath, "add", "history.txt");
  git(repositoryPath, "-c", "user.name=Alice", "-c", "user.email=alice@example.com", "commit", "-m", "feat: alice history");
  await writeFile(path.join(repositoryPath, "history.txt"), "first\nsecond\n", "utf8");
  git(repositoryPath, "add", "history.txt");
  git(repositoryPath, "-c", "user.name=Bob", "-c", "user.email=bob@example.com", "commit", "-m", "fix: bob history");
  await writeFile(path.join(repositoryPath, "other.txt"), "other\n", "utf8");
  git(repositoryPath, "add", "other.txt");
  git(repositoryPath, "commit", "-m", "docs: unrelated file");

  const firstPage = await service.getHistoryPage(repositoryPath, { limit: 2 });
  assert.equal(firstPage.commits.length, 2);
  assert.equal(firstPage.hasMore, true);
  const secondPage = await service.getHistoryPage(repositoryPath, { limit: 2, skip: firstPage.nextSkip });
  assert.equal(secondPage.commits.some((commit) => firstPage.commits.some((known) => known.hash === commit.hash)), false);

  const authorPage = await service.getHistoryPage(repositoryPath, { author: "Alice", limit: 20 });
  assert.deepEqual(authorPage.commits.map((commit) => commit.authorName), ["Alice"]);
  const messagePage = await service.getHistoryPage(repositoryPath, { search: "bob history", limit: 20 });
  assert.equal(messagePage.commits.length, 1);
  assert.equal(messagePage.commits[0].authorName, "Bob");
  const filePage = await service.getHistoryPage(repositoryPath, { path: "history.txt", limit: 20 });
  assert.deepEqual(filePage.commits.map((commit) => commit.subject), ["fix: bob history", "feat: alice history"]);

  const blame = await service.getBlame(repositoryPath, "history.txt");
  assert.equal(blame.length, 2);
  assert.equal(blame[0].authorName, "Alice");
  assert.equal(blame[1].authorName, "Bob");
});

test("advanced history treats message text literally and includes the full end date", async () => {
  const service = new GitService();
  const calls = [];
  service.getStatus = async () => ({
    currentBranch: "main",
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    hasConflicts: false,
    conflictedCount: 0
  });
  service.run = async (_cwd, args) => {
    calls.push(args);
    return { ok: true, command: `git ${args.join(" ")}`, stdout: "", stderr: "", exitCode: 0 };
  };

  await service.getHistoryPage("repo", { search: "[literal]", after: "2026-08-01", before: "2026-08-02", limit: 20 });
  const [logArgs] = calls;
  assert.equal(logArgs.includes("--fixed-strings"), true);
  assert.equal(logArgs.includes("--grep=[literal]"), true);
  assert.equal(logArgs.includes("--since=2026-08-01 00:00:00.000"), true);
  assert.equal(logArgs.includes("--until=2026-08-02 23:59:59.999"), true);
  await assert.rejects(service.getHistoryPage("repo", { before: "2026-02-30" }), /不是有效日期/);
});

test("interactive rebase plan executes the submitted order and actions", async () => {
  const repositoryPath = await createRepository("interactive-rebase");
  const service = new GitService();
  const upstream = git(repositoryPath, "rev-parse", "HEAD");

  for (const [name, subject] of [["one.txt", "feat: one"], ["two.txt", "feat: two"], ["three.txt", "fix: three"]]) {
    await writeFile(path.join(repositoryPath, name), `${subject}\n`, "utf8");
    git(repositoryPath, "add", name);
    git(repositoryPath, "commit", "-m", subject);
  }

  const plan = await service.getRebasePlan(repositoryPath, upstream);
  assert.deepEqual(plan.map((item) => item.subject), ["feat: one", "feat: two", "fix: three"]);
  const reorderedPlan = [
    { ...plan[1], action: "pick" },
    { ...plan[0], action: "pick" },
    { ...plan[2], action: "fixup" }
  ];
  assertSuccess(await service.startInteractiveRebase(repositoryPath, upstream, reorderedPlan));

  const subjects = git(repositoryPath, "log", "--reverse", "--format=%s", `${upstream}..HEAD`).split(/\r?\n/);
  assert.deepEqual(subjects, ["feat: two", "feat: one"]);
  assert.equal(git(repositoryPath, "show", "HEAD:three.txt"), "fix: three");
});

test("operation methods issue one exact Git command and never substitute another command", async () => {
  const service = new GitService();
  const calls = [];
  service.run = async (_cwd, args) => {
    calls.push(args);
    return { ok: true, command: `git ${args.join(" ")}`, stdout: "", stderr: "", exitCode: 0 };
  };

  await service.unstageFile("repo", "tracked.txt");
  await service.unstageAll("repo");
  await service.createBranch("repo", "feature/exact", true, "main");
  await service.switchBranch("repo", { type: "local", name: "main" });
  await service.switchBranch("repo", { type: "remote", name: "origin/feature" });
  await service.startRebase("repo", "upstream", "onto");
  await service.continueRebase("repo");
  await service.skipRebase("repo");
  await service.abortRebase("repo");
  await service.continueCherryPick("repo");
  await service.skipCherryPick("repo");
  await service.abortCherryPick("repo");
  await service.continueRevert("repo");
  await service.skipRevert("repo");
  await service.abortRevert("repo");
  await service.startBisect("repo", "bad", "good");
  await service.markBisectGood("repo", "good");
  await service.markBisectBad("repo");
  await service.skipBisect("repo", ["one", "two"]);
  await service.resetBisect("repo");

  assert.deepEqual(calls, [
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    ["restore", "--staged", "--", "tracked.txt"],
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    ["restore", "--staged", "--", "."],
    ["check-ref-format", "--branch", "feature/exact"],
    ["switch", "-c", "feature/exact", "main"],
    ["switch", "main"],
    ["switch", "--track", "origin/feature"],
    ["rebase", "--onto", "onto", "upstream"],
    ["-c", "core.editor=true", "rebase", "--continue"],
    ["rebase", "--skip"],
    ["rebase", "--abort"],
    ["-c", "core.editor=true", "cherry-pick", "--continue"],
    ["cherry-pick", "--skip"],
    ["cherry-pick", "--abort"],
    ["-c", "core.editor=true", "revert", "--continue"],
    ["revert", "--skip"],
    ["revert", "--abort"],
    ["bisect", "start", "bad", "good"],
    ["bisect", "good", "good"],
    ["bisect", "bad"],
    ["bisect", "skip", "one", "two"],
    ["bisect", "reset"]
  ]);

  const unbornService = new GitService();
  const unbornCalls = [];
  unbornService.run = async (_cwd, args) => {
    unbornCalls.push(args);
    if (args[0] === "rev-parse") {
      return { ok: false, command: `git ${args.join(" ")}`, stdout: "", stderr: "", exitCode: 1 };
    }
    return { ok: true, command: `git ${args.join(" ")}`, stdout: "", stderr: "", exitCode: 0 };
  };
  await unbornService.unstageFile("repo", "first.txt");
  assert.deepEqual(unbornCalls, [
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    ["rm", "--cached", "-r", "--", "first.txt"]
  ]);
});

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});
