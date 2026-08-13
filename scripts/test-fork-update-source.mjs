import assert from "node:assert/strict";
import test from "node:test";
import forkUpdateSource from "../dist-electron/forkUpdateSource.js";

const {
  buildForkReleaseHistoryCatalog,
  FORK_LATEST_RELEASE_URL,
  FORK_RELEASE_HISTORY_URL,
  FORK_REPOSITORY_URL,
  forkReleaseUrl,
  parseForkLatestRelease
} = forkUpdateSource;

const SHA256 = "a".repeat(64);

function release(version, overrides = {}) {
  const tagName = `v${version}`;
  const setupName = `Git-UI-Pro-Setup-${version}-x64.exe`;
  const portableName = `Git-UI-Pro-Portable-${version}-x64.exe`;
  return {
    tag_name: tagName,
    name: `Git UI Pro v${version}`,
    body: `版本 ${version}`,
    draft: false,
    prerelease: false,
    published_at: "2026-08-13T00:00:00Z",
    assets: [
      {
        name: setupName,
        state: "uploaded",
        size: 82_000_000,
        digest: `sha256:${SHA256}`,
        browser_download_url: `${FORK_REPOSITORY_URL}/releases/download/${tagName}/${setupName}`
      },
      {
        name: `${setupName}.blockmap`,
        state: "uploaded",
        size: 100_000,
        digest: `sha256:${SHA256}`,
        browser_download_url: `${FORK_REPOSITORY_URL}/releases/download/${tagName}/${setupName}.blockmap`
      },
      {
        name: portableName,
        state: "uploaded",
        size: 80_000_000,
        digest: `sha256:${SHA256}`,
        browser_download_url: `${FORK_REPOSITORY_URL}/releases/download/${tagName}/${portableName}`
      },
      {
        name: "latest.yml",
        state: "uploaded",
        size: 1024,
        digest: `sha256:${SHA256}`,
        browser_download_url: `${FORK_REPOSITORY_URL}/releases/download/${tagName}/latest.yml`
      }
    ],
    ...overrides
  };
}

test("fork 更新來源固定指向 Pie-ye/Git_UI_Pro", () => {
  assert.equal(FORK_REPOSITORY_URL, "https://github.com/Pie-ye/Git_UI_Pro");
  assert.equal(FORK_LATEST_RELEASE_URL, "https://api.github.com/repos/Pie-ye/Git_UI_Pro/releases/latest");
  assert.equal(FORK_RELEASE_HISTORY_URL, "https://api.github.com/repos/Pie-ye/Git_UI_Pro/releases?per_page=20");
  assert.equal(forkReleaseUrl("v0.1.35"), "https://github.com/Pie-ye/Git_UI_Pro/releases/tag/v0.1.35");
});

test("安装版 latest 只接受 fork 的正式 Release 资产", () => {
  const latest = parseForkLatestRelease(release("0.1.35"), false, "0.1.34");
  assert.equal(latest.version, "0.1.35");
  assert.equal(
    latest.target?.downloadUrl,
    "https://github.com/Pie-ye/Git_UI_Pro/releases/download/v0.1.35/Git-UI-Pro-Setup-0.1.35-x64.exe"
  );
  assert.equal(latest.target?.releaseUrl, "https://github.com/Pie-ye/Git_UI_Pro/releases/tag/v0.1.35");
});

test("拒绝原作者仓库的伪装安装资产", () => {
  const value = release("0.1.35");
  value.assets[0].browser_download_url =
    "https://github.com/zjx150504-lgtm/Git_UI_Pro/releases/download/v0.1.35/Git-UI-Pro-Setup-0.1.35-x64.exe";
  assert.throws(
    () => parseForkLatestRelease(value, false, "0.1.34"),
    /Windows 正式版更新资产尚未就绪/
  );
});

test("Portable latest 同样只从 fork 解析", () => {
  const latest = parseForkLatestRelease(release("0.1.35"), true, "0.1.34");
  assert.equal(latest.version, "0.1.35");
  assert.equal(latest.target?.artifactName, "Git-UI-Pro-Portable-0.1.35-x64.exe");
  assert.equal(
    latest.target?.downloadUrl,
    "https://github.com/Pie-ye/Git_UI_Pro/releases/download/v0.1.35/Git-UI-Pro-Portable-0.1.35-x64.exe"
  );
});

test("历史版本按语义版本倒序并最多保留三个", () => {
  const catalog = buildForkReleaseHistoryCatalog(
    [release("0.1.30"), release("0.1.33"), release("0.1.31"), release("0.1.32"), release("0.1.35")],
    "0.1.34",
    false
  );
  assert.deepEqual(catalog.entries.map((item) => item.version), ["0.1.33", "0.1.32", "0.1.31"]);
  assert.equal(catalog.resolveTarget("v0.1.33")?.releaseUrl, "https://github.com/Pie-ye/Git_UI_Pro/releases/tag/v0.1.33");
});
