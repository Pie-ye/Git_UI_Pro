import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCommitMessage,
  collectArtifacts,
  compareVersions,
  detectProvider,
  expectedWindowsUpdateArtifacts,
  isTransientGitNetworkFailure,
  mergeReleaseNotes,
  parseStatusPorcelain,
  parseVersion,
  recommendVersions,
  resolveNpmInvocation,
  runGitWithNetworkRetry,
  runProcess,
  startReleaseConsole,
  validateWindowsUpdateArtifacts
} from "./release-console.mjs";

test("解析并推荐稳定版本号", () => {
  assert.deepEqual(parseVersion("0.1.5"), { major: 0, minor: 1, patch: 5, text: "0.1.5" });
  assert.equal(parseVersion("v0.1.5"), null);
  assert.equal(parseVersion("01.1.5"), null);
  assert.deepEqual(recommendVersions("0.1.5"), {
    patch: "0.1.6",
    minor: "0.2.0",
    major: "1.0.0"
  });
  assert.ok(compareVersions("0.2.0", "0.1.9") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
});

test("解析包含暂存、未暂存、未跟踪和重命名的工作区状态", () => {
  const files = parseStatusPorcelain("M  src/a.ts\0 M src/b.ts\0?? docs/new.md\0R  src/new.ts\0src/old.ts\0");
  assert.deepEqual(files, [
    { code: "M ", path: "src/a.ts", staged: true, untracked: false },
    { code: " M", path: "src/b.ts", staged: false, untracked: false },
    { code: "??", path: "docs/new.md", staged: false, untracked: true },
    { code: "R ", path: "src/new.ts", previousPath: "src/old.ts", staged: true, untracked: false }
  ]);
});

test("生成符合仓库规则的中文分段提交信息", () => {
  assert.equal(
    buildCommitMessage({
      title: "chore(release): 发布 v0.1.6",
      notes: ["更新版本号", "生成 Windows 安装包"],
      files: ["package.json", "package-lock.json"]
    }),
    "chore(release): 发布 v0.1.6\n\n1. 更新版本号\n2. 生成 Windows 安装包\n\n涉及文件:\n1. package.json\n2. package-lock.json\n"
  );
});

test("自动版本说明不能被提交请求删除", () => {
  assert.deepEqual(
    mergeReleaseNotes(["自动记录一", "自动记录二"], ["自动记录二", "补充说明"]),
    ["自动记录一", "自动记录二", "补充说明"]
  );
  assert.deepEqual(mergeReleaseNotes(["自动记录一"], []), ["自动记录一"]);
});

test("识别 GitHub 与 Gitee 远端", () => {
  assert.equal(detectProvider("https://github.com/example/repo.git"), "github");
  assert.equal(detectProvider("git@gitee.com:example/repo.git"), "gitee");
  assert.equal(detectProvider("https://git.example.com/repo.git"), "other");
});

test("只将临时 Git 网络故障识别为可重试错误", () => {
  assert.equal(
    isTransientGitNetworkFailure("fatal: unable to access 'https://github.com/example/repo.git/': schannel: failed to receive handshake, SSL/TLS connection failed"),
    true
  );
  assert.equal(isTransientGitNetworkFailure("fatal: unable to access repository: Failed to connect to github.com"), true);
  assert.equal(isTransientGitNetworkFailure("GnuTLS recv error (-110): The TLS connection was non-properly terminated."), true);
  assert.equal(isTransientGitNetworkFailure("fatal: unable to access repository: Connection refused"), true);
  assert.equal(isTransientGitNetworkFailure("remote: Repository not found.\nfatal: Authentication failed"), false);
  assert.equal(isTransientGitNetworkFailure("error: RPC failed; HTTP 401 curl 22"), false);
  assert.equal(isTransientGitNetworkFailure("error: RPC failed; HTTP 403 curl 22"), false);
  assert.equal(isTransientGitNetworkFailure("SSL certificate problem: certificate has expired"), false);
  assert.equal(isTransientGitNetworkFailure("fatal: couldn't find remote ref refs/heads/master"), false);
});

test("临时网络故障恢复后停止重试", async () => {
  const results = [
    { code: 1, stdout: "", stderr: "Connection was reset", timedOut: false },
    { code: 1, stdout: "", stderr: "", timedOut: true },
    { code: 0, stdout: "ok", stderr: "", timedOut: false }
  ];
  const waits = [];
  const job = { logs: [] };
  let calls = 0;
  const result = await runGitWithNetworkRetry(["ls-remote", "github"], {
    job,
    retryLabel: "github ",
    retryDelays: [0, 0],
    runCommand: async () => results[calls++],
    wait: async (delayMs) => waits.push(delayMs)
  });

  assert.equal(result.stdout, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [0, 0]);
  assert.deepEqual(
    job.logs.map((entry) => entry.message),
    ["github 连接暂时中断，0 秒后自动重试（2/3）", "github 连接暂时中断，0 秒后自动重试（3/3）"]
  );
});

test("非网络错误不会重试，连续网络错误最多尝试三次", async () => {
  let calls = 0;
  await assert.rejects(
    runGitWithNetworkRetry(["ls-remote", "github"], {
      retryDelays: [0, 0],
      runCommand: async () => {
        calls += 1;
        return { code: 1, stdout: "", stderr: "Authentication failed", timedOut: false };
      },
      wait: async () => {}
    }),
    /Authentication failed/
  );
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(
    runGitWithNetworkRetry(["ls-remote", "github"], {
      retryDelays: [0, 0],
      runCommand: async () => {
        calls += 1;
        return { code: 1, stdout: "", stderr: "Connection timed out", timedOut: false };
      },
      wait: async () => {}
    }),
    /已自动尝试 3 次/
  );
  assert.equal(calls, 3);
});

test("命令超时会终止包含子进程的进程树", { timeout: 10_000 }, async () => {
  const childScript = [
    'const { spawn } = require("node:child_process");',
    'spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });',
    "setInterval(() => {}, 1000);"
  ].join("");
  const startedAt = Date.now();
  const result = await runProcess(process.execPath, ["-e", childScript], {
    allowFailure: true,
    timeoutMs: 500
  });

  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 5_000, "进程树应在超时后及时退出");
});

test("Windows 通过 Node 执行 npm CLI，避免直接 spawn npm.cmd", () => {
  const invocation = resolveNpmInvocation({
    platform: "win32",
    execPath: "C:\\node\\node.exe",
    npmExecPath: "C:\\node\\node_modules\\npm\\bin\\npm-cli.js",
    fileExists: (candidate) => candidate.endsWith("npm-cli.js")
  });
  assert.deepEqual(invocation, {
    command: "C:\\node\\node.exe",
    prefixArgs: ["C:\\node\\node_modules\\npm\\bin\\npm-cli.js"]
  });
});

test("当前环境解析出的 npm 调用可以正常启动", () => {
  const invocation = resolveNpmInvocation();
  const result = spawnSync(invocation.command, [...invocation.prefixArgs, "--version"], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("收集 Windows 正式版自动更新所需的三项产物", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "git-ui-pro-release-"));
  const version = "0.1.13";
  const expected = expectedWindowsUpdateArtifacts(version);
  try {
    await Promise.all([
      writeFile(path.join(directory, expected.installer), "installer"),
      writeFile(path.join(directory, expected.blockmap), "blockmap"),
      writeFile(path.join(directory, expected.metadata), "version: 0.1.13"),
      writeFile(path.join(directory, "Git-UI-Pro-Portable-0.1.13-x64.exe"), "portable"),
      writeFile(path.join(directory, "Git-UI-Pro-Setup-0.1.12-x64.exe"), "stale")
    ]);

    const artifacts = await collectArtifacts(version, directory);
    assert.deepEqual(
      artifacts.map((artifact) => artifact.name).sort(),
      Object.values(expected).sort()
    );
    assert.equal(validateWindowsUpdateArtifacts(version, artifacts).valid, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("缺少 blockmap 或 latest.yml 时拒绝发布 Windows 正式版", () => {
  const version = "0.1.13";
  const expected = expectedWindowsUpdateArtifacts(version);
  const validation = validateWindowsUpdateArtifacts(version, [
    { name: expected.installer, size: 1 }
  ]);

  assert.equal(validation.valid, false);
  assert.deepEqual(validation.missing, [expected.blockmap, expected.metadata]);
});

test("发布控制台仅凭令牌返回仓库状态", async () => {
  const { server, url, token } = await startReleaseConsole({ port: 0, openBrowser: false });
  try {
    const forbidden = await fetch(`${url}/api/status`);
    assert.equal(forbidden.status, 403);

    const forbiddenMutation = await fetch(`${url}/api/releases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-release-token": token
      },
      body: "{}"
    });
    assert.equal(forbiddenMutation.status, 403);

    const response = await fetch(`${url}/api/status`, {
      headers: { "x-release-token": token }
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.repository, "git-ui-pro");
    assert.ok(parseVersion(status.packageVersion));
    assert.ok(compareVersions(status.recommendations.patch, status.baselineVersion) > 0);
    assert.equal(status.remotes.gitee.provider, "gitee");
    assert.ok(Array.isArray(status.history));
    assert.ok(Array.isArray(status.files));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
