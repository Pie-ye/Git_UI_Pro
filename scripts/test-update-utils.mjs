import assert from "node:assert/strict";
import test from "node:test";
import releaseHistory from "../dist-electron/releaseHistory.js";
import updateUtils from "../dist-electron/updateUtils.js";

const { buildReleaseHistoryCatalog, createRollbackUpdaterOptions } = releaseHistory;
const { githubReleaseUrl, normalizeReleaseNotes, updateErrorMessage } = updateUtils;

const SHA256 = "a".repeat(64);

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

test("更新错误信息有可读兜底且限制长度", () => {
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
