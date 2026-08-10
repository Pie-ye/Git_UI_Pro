import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_GITEE_OWNER = "zjx_master";
const DEFAULT_GITEE_REPOSITORY = "git-ui-pro";
const UPDATE_MANIFEST_NAME = "update-manifest.json";
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const STABLE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function createGiteeUpdateManifest(tagName, installer) {
  const version = stableVersionFromTag(tagName);
  const expectedName = `Git-UI-Pro-Setup-${version}-x64.exe`;
  if (
    installer?.name !== expectedName ||
    !Number.isSafeInteger(installer.size) ||
    installer.size <= 0 ||
    typeof installer.sha256 !== "string" ||
    !/^[a-f\d]{64}$/i.test(installer.sha256)
  ) {
    throw new Error("Windows 安装包信息无效，无法生成 Gitee 更新清单。");
  }
  return Object.freeze({
    schemaVersion: 1,
    version,
    tagName,
    installer: Object.freeze({
      name: expectedName,
      size: installer.size,
      sha256: installer.sha256.toLowerCase()
    })
  });
}

export async function collectWindowsUpdateFiles(rootDirectory, tagName) {
  const version = stableVersionFromTag(tagName);
  const expectedNames = [
    `Git-UI-Pro-Setup-${version}-x64.exe`,
    `Git-UI-Pro-Setup-${version}-x64.exe.blockmap`,
    "latest.yml"
  ];
  const files = await listFilesRecursively(path.resolve(rootDirectory));
  const selected = new Map();
  for (const filename of expectedNames) {
    const matches = files.filter((file) => path.basename(file) === filename);
    if (matches.length !== 1) {
      throw new Error(`Gitee 镜像要求 ${filename} 恰好存在一份，实际找到 ${matches.length} 份。`);
    }
    selected.set(filename, matches[0]);
  }
  return selected;
}

export async function syncGiteeRelease(options = {}) {
  const token = requiredValue(options.giteeToken ?? process.env.GITEE_TOKEN, "GITEE_TOKEN");
  const githubToken = requiredValue(options.githubToken ?? process.env.GITHUB_TOKEN, "GITHUB_TOKEN");
  const githubRepository = requiredValue(options.githubRepository ?? process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const tagName = requiredValue(options.tagName ?? process.env.RELEASE_TAG, "RELEASE_TAG");
  const artifactsDirectory = requiredValue(
    options.artifactsDirectory ?? process.env.RELEASE_ARTIFACTS_DIR,
    "RELEASE_ARTIFACTS_DIR"
  );
  const owner = options.giteeOwner ?? process.env.GITEE_OWNER ?? DEFAULT_GITEE_OWNER;
  const repository = options.giteeRepository ?? process.env.GITEE_REPOSITORY ?? DEFAULT_GITEE_REPOSITORY;
  const version = stableVersionFromTag(tagName);
  const files = await collectWindowsUpdateFiles(artifactsDirectory, tagName);
  const installerName = `Git-UI-Pro-Setup-${version}-x64.exe`;
  const installerPath = files.get(installerName);
  const installerStat = await stat(installerPath);
  const installerSha256 = createHash("sha256").update(await readFile(installerPath)).digest("hex");
  const manifest = createGiteeUpdateManifest(tagName, {
    name: installerName,
    size: installerStat.size,
    sha256: installerSha256
  });
  const githubRelease = await fetchGithubRelease(githubRepository, tagName, githubToken, options.fetchImpl);
  const gitee = createGiteeClient({ owner, repository, token, fetchImpl: options.fetchImpl });
  const release = await gitee.ensureRelease({
    tagName,
    name: normalizeText(githubRelease.name) || `Git UI Pro v${version}`,
    body: normalizeText(githubRelease.body),
    targetCommitish: tagName
  });
  if (!Number.isSafeInteger(release?.id) || release.id <= 0) {
    throw new Error("Gitee Release 创建结果缺少有效编号，已停止上传更新资产。");
  }

  const uploadNames = [...files.keys(), UPDATE_MANIFEST_NAME];
  await gitee.removeNamedAssets(release.id, new Set(uploadNames));
  for (const [name, filename] of files) {
    await gitee.uploadAsset(release.id, name, await readFile(filename));
  }
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await gitee.uploadAsset(release.id, UPDATE_MANIFEST_NAME, manifestBuffer);

  return Object.freeze({
    tagName,
    version,
    releaseUrl: `https://gitee.com/${owner}/${repository}/releases/tag/${tagName}`,
    assets: Object.freeze(uploadNames)
  });
}

function createGiteeClient({ owner, repository, token, fetchImpl = fetch }) {
  const baseUrl = `https://gitee.com/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;

  async function request(pathname, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${pathname}`, { ...init, signal: controller.signal });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500).replace(/\s+/g, " ").trim();
        throw new Error(`Gitee API ${pathname} 返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`);
      }
      if (response.status === 204) {
        return null;
      }
      const responseText = await response.text();
      return responseText ? JSON.parse(responseText) : null;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Gitee API ${pathname} 请求超时。`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function findRelease(tagName) {
    const url = new URL(`${baseUrl}/releases/tags/${encodeURIComponent(tagName)}`);
    url.searchParams.set("access_token", token);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Gitee API /releases/tags/${tagName} 返回 HTTP ${response.status}。`);
    }
    return response.json();
  }

  return {
    async ensureRelease({ tagName, name, body, targetCommitish }) {
      const existing = await findRelease(tagName);
      const payload = {
        access_token: token,
        tag_name: tagName,
        name,
        body,
        prerelease: false,
        target_commitish: targetCommitish
      };
      if (existing?.id) {
        return request(`/releases/${existing.id}`, {
          method: "PATCH",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      }
      return request("/releases", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    },

    async removeNamedAssets(releaseId, names) {
      const url = new URL(`${baseUrl}/releases/${releaseId}/attach_files`);
      url.searchParams.set("access_token", token);
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`读取 Gitee v5 Release 附件失败（HTTP ${response.status}）。`);
      }
      const assets = await response.json();
      if (!Array.isArray(assets)) {
        throw new Error("Gitee Release 附件列表格式无效。");
      }
      for (const asset of assets) {
        if (asset && Number.isSafeInteger(asset.id) && names.has(asset.name)) {
          await request(`/releases/${releaseId}/attach_files/${asset.id}`, {
            method: "DELETE",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ access_token: token })
          });
        }
      }
    },

    async uploadAsset(releaseId, filename, data) {
      const form = new FormData();
      form.append("file", new Blob([data]), filename);
      form.append("access_token", token);
      await request(`/releases/${releaseId}/attach_files`, {
        method: "POST",
        headers: { Accept: "application/json" },
        body: form
      }, UPLOAD_TIMEOUT_MS);
    }
  };
}

async function fetchGithubRelease(repository, tagName, token, fetchImpl = fetch) {
  const url = `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tagName)}`;
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "Git-UI-Pro-Gitee-Mirror",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`读取 GitHub ${tagName} Release 失败（HTTP ${response.status}）。`);
  }
  const release = await response.json();
  if (release?.tag_name !== tagName || release.draft === true || release.prerelease === true) {
    throw new Error(`GitHub ${tagName} 不是可镜像的正式发行版。`);
  }
  return release;
}

async function listFilesRecursively(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listFilesRecursively(candidate);
    }
    return entry.isFile() ? [candidate] : [];
  }));
  return nested.flat();
}

function stableVersionFromTag(tagName) {
  const match = STABLE_TAG_PATTERN.exec(tagName);
  if (!match) {
    throw new Error(`只允许同步稳定版本标签，收到：${tagName}`);
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim().replace(/\r\n/g, "\n") : "";
}

function requiredValue(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`缺少环境变量 ${name}。`);
  }
  return value.trim();
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  syncGiteeRelease().then(
    (result) => {
      console.log(`Gitee 国内更新源已同步：${result.releaseUrl}`);
      console.log(`已上传：${result.assets.join("、")}`);
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  );
}
