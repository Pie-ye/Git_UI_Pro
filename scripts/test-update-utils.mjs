import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import giteeUpdateSource from "../dist-electron/giteeUpdateSource.js";
import releaseHistory from "../dist-electron/releaseHistory.js";
import updateService from "../dist-electron/updateService.js";
import updateUtils from "../dist-electron/updateUtils.js";
import portableRuntime from "../dist-electron/portableRuntime.js";
import portableUpdate from "../dist-electron/portableUpdate.js";

const { buildReleaseHistoryCatalog, createRollbackUpdaterOptions } = releaseHistory;
const {
  buildGiteeReleaseHistoryCatalog,
  parseLatestStableGiteeRelease,
  selectGiteeHistoryCandidates,
  verifyGiteeRelease
} = giteeUpdateSource;
const {
  UPDATE_CHECK_INITIAL_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UpdateCheckGate,
  parseLatestStableGithubRelease,
  resolveFreshUpgradeCheck,
  startFreshUpgradeDownload
} = updateService;
const { githubReleaseUrl, normalizeReleaseNotes, updateErrorMessage } = updateUtils;
const {
  completePortableUpdateHealthCheck,
  resolvePortableDataPath,
  resolvePortableExecutablePath
} = portableRuntime;
const {
  buildPortableGiteeReleaseHistoryCatalog,
  buildPortableGithubReleaseHistoryCatalog,
  buildPortableUpdatePowerShellScript,
  comparePortableVersions,
  parseLatestPortableGiteeRelease,
  parseLatestPortableGithubRelease,
  parsePortableGiteeReleaseSummary,
  portableArtifactName,
  selectPortableGiteeHistoryCandidates,
  verifyPortableGiteeRelease
} = portableUpdate;

const SHA256 = "a".repeat(64);

test("正式版后台更新检查使用短周期调度", () => {
  assert.equal(UPDATE_CHECK_INITIAL_DELAY_MS, 8_000);
  assert.equal(UPDATE_CHECK_INTERVAL_MS, 5 * 60 * 1_000);
});

test("后台检查与手动刷新共享同一个进行中请求", async () => {
  const gate = new UpdateCheckGate();
  let resolveCheck;
  let checkCalls = 0;
  const check = () => {
    checkCalls += 1;
    return new Promise((resolve) => {
      resolveCheck = resolve;
    });
  };

  const backgroundRequest = gate.run(check);
  const manualRequest = gate.run(check);
  assert.equal(manualRequest, backgroundRequest);
  assert.equal(checkCalls, 0);

  await Promise.resolve();
  assert.equal(checkCalls, 1);
  resolveCheck({ phase: "available", availableVersion: "0.1.20" });
  assert.deepEqual(await manualRequest, { phase: "available", availableVersion: "0.1.20" });
  assert.equal(gate.getActiveRequest(), null);

  const nextRequest = gate.run(async () => {
    checkCalls += 1;
    return { phase: "up-to-date" };
  });
  assert.notEqual(nextRequest, backgroundRequest);
  assert.deepEqual(await nextRequest, { phase: "up-to-date" });
  assert.equal(checkCalls, 2);
});

test("失败的更新检查完成后允许下一次定时检查", async () => {
  const gate = new UpdateCheckGate();
  const failedRequest = gate.run(async () => {
    throw new Error("network unavailable");
  });
  await assert.rejects(failedRequest, /network unavailable/);
  assert.equal(gate.getActiveRequest(), null);
  assert.equal(await gate.run(async () => "recovered"), "recovered");
});

function githubRelease(version, overrides = {}) {
  const tagName = overrides.tag_name ?? `v${version}`;
  const installerVersion = overrides.installerVersion ?? version;
  const assetName = `Git-UI-Pro-Setup-${installerVersion}-x64.exe`;
  const asset = {
    name: assetName,
    state: "uploaded",
    digest: `sha256:${SHA256}`,
    browser_download_url: `https://github.com/zjx150504-lgtm/Git_UI_Pro/releases/download/${tagName}/${assetName}`,
    size: 82_000_000,
    ...overrides.asset
  };

  return {
    tag_name: tagName,
    name: `Git UI Pro v${version}`,
    body: `版本 ${version} 说明`,
    draft: false,
    prerelease: false,
    published_at: "2026-07-23T08:05:52Z",
    ...overrides,
    assets: overrides.assets ?? [asset]
  };
}

function latestGithubRelease(version, overrides = {}) {
  const release = githubRelease(version, overrides);
  return {
    ...release,
    assets: overrides.assets ?? [
      ...release.assets,
      {
        name: "latest.yml",
        state: "uploaded",
        size: 1024,
        browser_download_url: `https://github.com/zjx150504-lgtm/Git_UI_Pro/releases/download/v${version}/latest.yml`
      }
    ]
  };
}

function giteeRelease(version, overrides = {}) {
  const tagName = overrides.tag_name ?? `v${version}`;
  const installerName = `Git-UI-Pro-Setup-${version}-x64.exe`;
  return {
    tag_name: tagName,
    name: `Git UI Pro v${version}`,
    body: `版本 ${version} 说明`,
    prerelease: false,
    created_at: "2026-07-23T08:05:52Z",
    ...overrides,
    assets: overrides.assets ?? [
      {
        name: installerName,
        browser_download_url: `https://gitee.com/zjx_master/git-ui-pro/releases/download/${tagName}/${installerName}`
      },
      {
        name: "update-manifest.json",
        browser_download_url: `https://gitee.com/zjx_master/git-ui-pro/releases/download/${tagName}/update-manifest.json`
      }
    ]
  };
}

function giteeManifest(version, overrides = {}) {
  const { installer: installerOverrides = {}, ...manifestOverrides } = overrides;
  return {
    schemaVersion: 1,
    version,
    tagName: `v${version}`,
    ...manifestOverrides,
    installer: {
      name: `Git-UI-Pro-Setup-${version}-x64.exe`,
      size: 82_000_000,
      sha256: SHA256,
      ...installerOverrides
    }
  };
}

function portableGithubRelease(version, overrides = {}) {
  const tagName = overrides.tag_name ?? `v${version}`;
  const artifactName = `Git-UI-Pro-Portable-${version}-x64.exe`;
  return {
    tag_name: tagName,
    name: `Git UI Pro v${version}`,
    body: `Portable ${version} 说明`,
    draft: false,
    prerelease: false,
    published_at: "2026-07-23T08:05:52Z",
    ...overrides,
    assets: overrides.assets ?? [{
      name: artifactName,
      state: "uploaded",
      digest: `sha256:${SHA256}`,
      size: 80_000_000,
      browser_download_url: `https://github.com/zjx150504-lgtm/Git_UI_Pro/releases/download/${tagName}/${artifactName}`
    }]
  };
}

function portableGiteeRelease(version, overrides = {}) {
  const tagName = overrides.tag_name ?? `v${version}`;
  const artifactName = `Git-UI-Pro-Portable-${version}-x64.exe`;
  return {
    tag_name: tagName,
    name: `Git UI Pro v${version}`,
    body: `Portable ${version} 说明`,
    prerelease: false,
    created_at: "2026-07-23T08:05:52Z",
    ...overrides,
    assets: overrides.assets ?? [
      {
        name: artifactName,
        browser_download_url: `https://gitee.com/zjx_master/git-ui-pro/releases/download/${tagName}/${artifactName}`
      },
      {
        name: "update-manifest.json",
        browser_download_url: `https://gitee.com/zjx_master/git-ui-pro/releases/download/${tagName}/update-manifest.json`
      }
    ]
  };
}

function portableManifest(version, overrides = {}) {
  const { portable: portableOverrides = {}, ...manifestOverrides } = overrides;
  return {
    schemaVersion: 1,
    version,
    tagName: `v${version}`,
    ...manifestOverrides,
    portable: {
      name: `Git-UI-Pro-Portable-${version}-x64.exe`,
      size: 80_000_000,
      sha256: SHA256,
      ...portableOverrides
    }
  };
}

function updateCheckResult(version, isUpdateAvailable = true) {
  const updateInfo = { version, files: [] };
  return {
    isUpdateAvailable,
    updateInfo,
    versionInfo: updateInfo,
    cancellationToken: { version }
  };
}

test("统一字符串与多版本发布说明格式", () => {
  assert.equal(normalizeReleaseNotes("  第一项\r\n第二项  "), "第一项\n第二项");
  assert.equal(
    normalizeReleaseNotes([
      { version: "0.1.13", note: "修复更新流程" },
      { version: "v0.1.12", note: "完善发布控制台" }
    ]),
    "v0.1.13\n修复更新流程\n\nv0.1.12\n完善发布控制台"
  );
});

test("更新错误信息使用明确默认说明并限制长度", () => {
  assert.equal(updateErrorMessage(new Error("网络不可用")), "网络不可用");
  assert.equal(updateErrorMessage(""), "检查更新失败");
  assert.equal(updateErrorMessage("x".repeat(800)).length, 600);
});

test("生成公开 GitHub Release 地址", () => {
  assert.equal(
    githubReleaseUrl("v0.1.13"),
    "https://github.com/zjx150504-lgtm/Git_UI_Pro/releases/tag/v0.1.13"
  );
});

test("回退版本严格按语义版本倒序并最多返回三条", () => {
  const catalog = buildReleaseHistoryCatalog(
    [githubRelease("0.1.9"), githubRelease("0.1.12"), githubRelease("0.1.10"), githubRelease("0.1.11")],
    "0.1.13"
  );

  assert.deepEqual(
    catalog.entries.map((entry) => entry.version),
    ["0.1.12", "0.1.11", "0.1.10"]
  );
  assert.equal(catalog.entries[0].publishedAt, "2026-07-23T08:05:52.000Z");
});

test("发布历史响应不是数组时明确拒绝", () => {
  assert.throws(
    () => buildReleaseHistoryCatalog({ message: "rate limited" }, "0.1.13"),
    /GitHub Releases 响应格式无效/
  );
});

test("渲染层记录不暴露安装包地址和校验值，内部目标仍可解析", () => {
  const catalog = buildReleaseHistoryCatalog([githubRelease("0.1.12")], "v0.1.13");
  const item = catalog.entries[0];
  const target = catalog.resolveTarget("v0.1.12");

  assert.equal(Object.hasOwn(item, "downloadUrl"), false);
  assert.equal(Object.hasOwn(item, "sha256"), false);
  assert.doesNotMatch(JSON.stringify(catalog.entries), /releases\/download|sha256/i);
  assert.equal(
    target?.downloadUrl,
    "https://github.com/zjx150504-lgtm/Git_UI_Pro/releases/download/v0.1.12/Git-UI-Pro-Setup-0.1.12-x64.exe"
  );
  assert.equal(target?.sha256, SHA256);
  assert.equal(target?.releaseUrl, "https://github.com/zjx150504-lgtm/Git_UI_Pro/releases/tag/v0.1.12");
  assert.equal(catalog.resolveTarget("0.1.9"), null);
});

test("过滤非稳定版、当前及更高版本、草稿与预发布", () => {
  const catalog = buildReleaseHistoryCatalog(
    [
      githubRelease("0.1.13"),
      githubRelease("0.1.14"),
      githubRelease("0.1.12", { draft: true }),
      githubRelease("0.1.11", { prerelease: true }),
      githubRelease("0.1.10-beta.1"),
      githubRelease("01.1.9"),
      githubRelease("0.1.8", { tag_name: "release-0.1.8" }),
      githubRelease("0.1.7", { tag_name: "v0.1.7+build.1" })
    ],
    "0.1.13"
  );

  assert.deepEqual(catalog.entries, []);
  assert.throws(() => buildReleaseHistoryCatalog([], "0.1.13-beta.1"), /当前版本不是稳定语义版本/);
});

test("只接受版本一致的正式 Setup x64 uploaded 资产和 sha256 digest", () => {
  const wrongPortable = githubRelease("0.1.12", {
    asset: { name: "Git-UI-Pro-Portable-0.1.12-x64.exe" }
  });
  const tagAssetMismatch = githubRelease("0.1.6", { installerVersion: "0.1.5" });
  const pendingAsset = githubRelease("0.1.11", { asset: { state: "new" } });
  const missingDigest = githubRelease("0.1.10", { asset: { digest: null } });
  const malformedDigest = githubRelease("0.1.9", { asset: { digest: "sha256:1234" } });
  const foreignDownload = githubRelease("0.1.8", {
    asset: { browser_download_url: "https://example.com/Git-UI-Pro-Setup-0.1.8-x64.exe" }
  });
  const emptyAsset = githubRelease("0.1.6", { asset: { size: 0 } });
  const valid = githubRelease("0.1.7", {
    asset: { digest: `sha256:${"B".repeat(64)}` }
  });

  const catalog = buildReleaseHistoryCatalog(
    [wrongPortable, tagAssetMismatch, pendingAsset, missingDigest, malformedDigest, foreignDownload, emptyAsset, valid],
    "0.1.13"
  );

  assert.deepEqual(catalog.entries.map((entry) => entry.version), ["0.1.7"]);
  assert.equal(catalog.resolveTarget("0.1.7")?.sha256, "b".repeat(64));
});

test("RollbackProvider 提供固定版本与 SHA-256 下载信息", async () => {
  const catalog = buildReleaseHistoryCatalog([githubRelease("0.1.12")], "0.1.13");
  const target = catalog.resolveTarget("0.1.12");
  assert.ok(target);

  const options = createRollbackUpdaterOptions(target);
  const provider = new options.updateProvider(options, {}, {
    executor: null,
    isUseMultipleRangeRequest: false,
    platform: "win32"
  });
  const updateInfo = await provider.getLatestVersion();
  const files = provider.resolveFiles(updateInfo);

  assert.equal(options.provider, "custom");
  assert.equal(updateInfo.version, "0.1.12");
  assert.equal(updateInfo.files[0].sha2, SHA256);
  assert.equal(files[0].url.href, target.downloadUrl);
  assert.equal(files[0].info.sha2, SHA256);
  assert.equal(files[0].info.sha512, undefined);
  assert.throws(
    () => createRollbackUpdaterOptions({ ...target, downloadUrl: "https://example.com/installer.exe" }),
    /回退目标无效/
  );
});

test("GitHub latest 只接受资产就绪的稳定正式版", () => {
  const latest = parseLatestStableGithubRelease(latestGithubRelease("0.1.16"));
  assert.equal(latest.version, "0.1.16");
  assert.equal(latest.tagName, "v0.1.16");
  assert.equal(latest.target.version, "0.1.16");
  assert.equal(latest.target.sha256, SHA256);
  assert.equal(
    latest.target.downloadUrl,
    "https://github.com/zjx150504-lgtm/Git_UI_Pro/releases/download/v0.1.16/Git-UI-Pro-Setup-0.1.16-x64.exe"
  );
  assert.throws(
    () => parseLatestStableGithubRelease(latestGithubRelease("0.1.16", { prerelease: true })),
    /不是可用的正式版本/
  );
  assert.throws(
    () => parseLatestStableGithubRelease(latestGithubRelease("0.1.16-beta.1")),
    /不是标准正式版本号/
  );
  assert.throws(
    () =>
      parseLatestStableGithubRelease(
        latestGithubRelease("0.1.16", {
          assets: [
            {
              name: "Git-UI-Pro-Setup-0.1.16-x64.exe",
              state: "uploaded",
              size: 82_000_000
            }
          ]
        })
      ),
    /Windows 正式版资产尚未就绪/
  );
});

test("Gitee 国内更新源只接受路径、版本与 SHA-256 全部匹配的镜像", () => {
  const release = giteeRelease("0.1.26");
  const latest = parseLatestStableGiteeRelease(release, giteeManifest("0.1.26", {
    installer: { sha256: "B".repeat(64) }
  }));

  assert.equal(latest.version, "0.1.26");
  assert.equal(latest.target.sha256, "b".repeat(64));
  assert.equal(
    latest.target.downloadUrl,
    "https://gitee.com/zjx_master/git-ui-pro/releases/download/v0.1.26/Git-UI-Pro-Setup-0.1.26-x64.exe"
  );
  assert.equal(
    latest.target.releaseUrl,
    "https://gitee.com/zjx_master/git-ui-pro/releases/tag/v0.1.26"
  );
  assert.doesNotThrow(() => createRollbackUpdaterOptions(latest.target));

  assert.throws(
    () => parseLatestStableGiteeRelease(release, giteeManifest("0.1.25")),
    /更新清单与发行版不匹配/
  );
  assert.throws(
    () => parseLatestStableGiteeRelease(
      giteeRelease("0.1.26", {
        assets: [
          {
            name: "Git-UI-Pro-Setup-0.1.26-x64.exe",
            browser_download_url: "https://example.com/Git-UI-Pro-Setup-0.1.26-x64.exe"
          },
          {
            name: "update-manifest.json",
            browser_download_url: "https://gitee.com/zjx_master/git-ui-pro/releases/download/v0.1.26/update-manifest.json"
          }
        ]
      }),
      giteeManifest("0.1.26")
    ),
    /更新资产尚未同步完成/
  );
});

test("Gitee 历史版本按版本筛选并生成可校验的回退目标", () => {
  const candidates = selectGiteeHistoryCandidates(
    [giteeRelease("0.1.24"), giteeRelease("0.1.23"), giteeRelease("0.1.26")],
    "0.1.25"
  );
  assert.deepEqual(candidates.map((candidate) => candidate.version), ["0.1.24", "0.1.23"]);

  const releases = candidates.map((candidate) => verifyGiteeRelease(candidate, giteeManifest(candidate.version)));
  const catalog = buildGiteeReleaseHistoryCatalog(releases, "0.1.25");
  assert.deepEqual(catalog.entries.map((entry) => entry.version), ["0.1.24", "0.1.23"]);
  assert.match(catalog.resolveTarget("0.1.24")?.downloadUrl ?? "", /^https:\/\/gitee\.com\//);
});

test("Portable GitHub 正式版严格匹配专属资产、版本、大小与 SHA-256", () => {
  const latest = parseLatestPortableGithubRelease(portableGithubRelease("0.1.32"));
  assert.equal(latest.version, "0.1.32");
  assert.equal(latest.target.artifactName, "Git-UI-Pro-Portable-0.1.32-x64.exe");
  assert.equal(latest.target.size, 80_000_000);
  assert.equal(latest.target.sha256, SHA256);
  assert.equal(
    latest.target.downloadUrl,
    "https://github.com/zjx150504-lgtm/Git_UI_Pro/releases/download/v0.1.32/Git-UI-Pro-Portable-0.1.32-x64.exe"
  );
  assert.throws(
    () => parseLatestPortableGithubRelease(portableGithubRelease("0.1.32", {
      assets: [{
        name: "Git-UI-Pro-Setup-0.1.32-x64.exe",
        state: "uploaded",
        digest: `sha256:${SHA256}`,
        size: 80_000_000,
        browser_download_url: "https://github.com/zjx150504-lgtm/Git_UI_Pro/releases/download/v0.1.32/Git-UI-Pro-Setup-0.1.32-x64.exe"
      }]
    })),
    /Portable 正式版本/
  );

  const catalog = buildPortableGithubReleaseHistoryCatalog([
    portableGithubRelease("0.1.30"),
    portableGithubRelease("0.1.29"),
    portableGithubRelease("0.1.28"),
    portableGithubRelease("0.1.27")
  ], "0.1.31");
  assert.deepEqual(catalog.entries.map((entry) => entry.version), ["0.1.30", "0.1.29", "0.1.28"]);
  assert.equal(catalog.resolveTarget("v0.1.30")?.artifactName, "Git-UI-Pro-Portable-0.1.30-x64.exe");
});

test("Portable Gitee 双源清单仅接受对应便携资产", () => {
  const release = portableGiteeRelease("0.1.32");
  const latest = parseLatestPortableGiteeRelease(release, portableManifest("0.1.32", {
    portable: { sha256: "B".repeat(64) }
  }));
  assert.equal(latest.target.sha256, "b".repeat(64));
  assert.equal(
    latest.target.downloadUrl,
    "https://gitee.com/zjx_master/git-ui-pro/releases/download/v0.1.32/Git-UI-Pro-Portable-0.1.32-x64.exe"
  );
  assert.throws(
    () => parseLatestPortableGiteeRelease(release, portableManifest("0.1.32", {
      portable: { name: "Git-UI-Pro-Setup-0.1.32-x64.exe" }
    })),
    /Portable 更新清单与发行版不匹配/
  );

  const candidates = selectPortableGiteeHistoryCandidates([
    portableGiteeRelease("0.1.30"),
    portableGiteeRelease("0.1.29"),
    portableGiteeRelease("0.1.32")
  ], "0.1.31");
  const targets = candidates.map((candidate) => verifyPortableGiteeRelease(candidate, portableManifest(candidate.version)));
  const catalog = buildPortableGiteeReleaseHistoryCatalog(targets, "0.1.31");
  assert.deepEqual(catalog.entries.map((entry) => entry.version), ["0.1.30", "0.1.29"]);
  assert.ok(parsePortableGiteeReleaseSummary(release));
});

test("Portable 运行时识别外层程序并使用独立数据目录", () => {
  const environment = {
    PORTABLE_EXECUTABLE_DIR: "E:\\Tools\\Git UI Pro",
    PORTABLE_EXECUTABLE_FILE: "E:\\Tools\\Git UI Pro\\Git-UI-Pro-Portable-0.1.32-x64.exe"
  };
  const executable = resolvePortableExecutablePath(environment, "win32");
  assert.equal(executable, environment.PORTABLE_EXECUTABLE_FILE);
  assert.equal(resolvePortableDataPath(executable), "E:\\Tools\\Git UI Pro\\Git-UI-Pro-Data");
  assert.equal(resolvePortableExecutablePath({ ...environment, PORTABLE_EXECUTABLE_DIR: "D:\\Other" }, "win32"), null);
  assert.equal(portableArtifactName("v0.1.32"), "Git-UI-Pro-Portable-0.1.32-x64.exe");
  assert.ok(comparePortableVersions("0.1.32", "0.1.31") > 0);
});

test("Portable 新版本只有在窗口成功加载后才写入健康标记", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "git-ui-pro-portable-health-"));
  const token = "a".repeat(32);
  const updateDirectory = path.join(directory, "updates");
  const markerPath = path.join(updateDirectory, `portable-health-${token}.ok`);
  try {
    await mkdir(updateDirectory, { recursive: true });
    assert.equal(completePortableUpdateHealthCheck(directory, {
      GIT_UI_PRO_PORTABLE_UPDATE_TOKEN: token,
      GIT_UI_PRO_PORTABLE_UPDATE_MARKER: markerPath
    }), true);
    assert.equal((await readFile(markerPath, "utf8")).trim(), token);
    assert.equal(completePortableUpdateHealthCheck(directory, {
      GIT_UI_PRO_PORTABLE_UPDATE_TOKEN: token,
      GIT_UI_PRO_PORTABLE_UPDATE_MARKER: path.join(directory, "outside.ok")
    }), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Portable 替换脚本包含退出等待、健康检查与失败回退", () => {
  const script = buildPortableUpdatePowerShellScript();
  assert.match(script, /Wait-ForExit \$ApplicationPid/);
  assert.match(script, /Wait-ForExit \$LauncherPid/);
  assert.match(script, /PORTABLE_UPDATE_TOKEN/);
  assert.match(script, /Move-Item -LiteralPath \$BackupPath -Destination \$CurrentPath/);
  assert.match(script, /新版本健康检查通过/);
});

test("权威 latest 与 updater 元数据不一致时拒绝旧候选", async () => {
  let downloadCalls = 0;
  const updater = {
    async checkForUpdates() {
      return updateCheckResult("0.1.15");
    },
    async downloadUpdate() {
      downloadCalls += 1;
      return [];
    }
  };

  await assert.rejects(
    () =>
      startFreshUpgradeDownload(
        updater,
        async () => ({ version: "0.1.16", tagName: "v0.1.16" }),
        () => assert.fail("不应接受旧候选")
      ),
    /更新源最新正式版为 v0\.1\.16.*下载元数据仍为 v0\.1\.15/
  );
  assert.equal(downloadCalls, 0);
});

test("连续发布时每次下载都重新读取 latest 并下载本次检查结果", async () => {
  const callOrder = [];
  const downloadedVersions = [];
  let remoteVersion = "0.1.15";
  let updaterCandidate = "0.1.14";
  const updater = {
    async checkForUpdates() {
      callOrder.push(`check:${remoteVersion}`);
      updaterCandidate = remoteVersion;
      return updateCheckResult(remoteVersion);
    },
    async downloadUpdate(cancellationToken) {
      callOrder.push(`download:${updaterCandidate}`);
      downloadedVersions.push({ candidate: updaterCandidate, token: cancellationToken.version });
      return [`Git-UI-Pro-Setup-${updaterCandidate}-x64.exe`];
    }
  };
  const loadLatestRelease = async () => {
    callOrder.push(`latest:${remoteVersion}`);
    return { version: remoteVersion, tagName: `v${remoteVersion}` };
  };

  const first = await startFreshUpgradeDownload(updater, loadLatestRelease, (info) => {
    callOrder.push(`candidate:${info.version}`);
  });
  await first.downloadPromise;

  remoteVersion = "0.1.16";
  const second = await startFreshUpgradeDownload(updater, loadLatestRelease, (info) => {
    callOrder.push(`candidate:${info.version}`);
  });
  await second.downloadPromise;

  assert.deepEqual(downloadedVersions, [
    { candidate: "0.1.15", token: "0.1.15" },
    { candidate: "0.1.16", token: "0.1.16" }
  ]);
  assert.deepEqual(callOrder, [
    "latest:0.1.15",
    "check:0.1.15",
    "candidate:0.1.15",
    "download:0.1.15",
    "latest:0.1.16",
    "check:0.1.16",
    "candidate:0.1.16",
    "download:0.1.16"
  ]);
});

test("没有新版本时保留本次 latest 结果且不触发下载", async () => {
  let downloadCalls = 0;
  const updater = {
    async checkForUpdates() {
      return updateCheckResult("0.1.16", false);
    },
    async downloadUpdate() {
      downloadCalls += 1;
      return [];
    }
  };

  const checked = await resolveFreshUpgradeCheck(updater, async () => ({ version: "0.1.16", tagName: "v0.1.16" }));
  const download = await startFreshUpgradeDownload(
    updater,
    async () => ({ version: "0.1.16", tagName: "v0.1.16" }),
    () => assert.fail("没有新版本时不应进入下载态")
  );

  assert.equal(checked.isUpdateAvailable, false);
  assert.equal(download.info.version, "0.1.16");
  assert.equal(download.downloadPromise, null);
  assert.equal(downloadCalls, 0);
});
