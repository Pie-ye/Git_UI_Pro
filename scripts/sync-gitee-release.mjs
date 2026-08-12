import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_GITEE_OWNER = "zjx_master";
const DEFAULT_GITEE_REPOSITORY = "git-ui-pro";
const UPDATE_MANIFEST_NAME = "update-manifest.json";
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120 * 60_000;
const UPLOAD_IDLE_TIMEOUT_MS = 10 * 60_000;
const UPLOAD_MAX_ATTEMPTS = 2;
const UPLOAD_RETRY_DELAY_MS = 15_000;
const STABLE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function createGiteeUpdateManifest(tagName, installer, portable) {
  const version = stableVersionFromTag(tagName);
  const expectedName = `Git-UI-Pro-Setup-${version}-x64.exe`;
  const expectedPortableName = `Git-UI-Pro-Portable-${version}-x64.exe`;
  if (
    installer?.name !== expectedName ||
    !Number.isSafeInteger(installer.size) ||
    installer.size <= 0 ||
    typeof installer.sha256 !== "string" ||
    !/^[a-f\d]{64}$/i.test(installer.sha256)
  ) {
    throw new Error("Windows 安装包信息无效，无法生成 Gitee 更新清单。");
  }
  if (
    portable?.name !== expectedPortableName ||
    !Number.isSafeInteger(portable.size) ||
    portable.size <= 0 ||
    typeof portable.sha256 !== "string" ||
    !/^[a-f\d]{64}$/i.test(portable.sha256)
  ) {
    throw new Error("Windows Portable 信息无效，无法生成 Gitee 更新清单。");
  }
  return Object.freeze({
    schemaVersion: 1,
    version,
    tagName,
    installer: Object.freeze({
      name: expectedName,
      size: installer.size,
      sha256: installer.sha256.toLowerCase()
    }),
    portable: Object.freeze({
      name: expectedPortableName,
      size: portable.size,
      sha256: portable.sha256.toLowerCase()
    })
  });
}

export async function collectWindowsUpdateFiles(rootDirectory, tagName) {
  const version = stableVersionFromTag(tagName);
  const expectedNames = [
    `Git-UI-Pro-Setup-${version}-x64.exe`,
    `Git-UI-Pro-Setup-${version}-x64.exe.blockmap`,
    `Git-UI-Pro-Portable-${version}-x64.exe`,
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
  const portableName = `Git-UI-Pro-Portable-${version}-x64.exe`;
  const installerPath = files.get(installerName);
  const portablePath = files.get(portableName);
  const [installerStat, portableStat, installerSha256, portableSha256] = await Promise.all([
    stat(installerPath),
    stat(portablePath),
    sha256File(installerPath),
    sha256File(portablePath)
  ]);
  const manifest = createGiteeUpdateManifest(tagName, {
    name: installerName,
    size: installerStat.size,
    sha256: installerSha256
  }, {
    name: portableName,
    size: portableStat.size,
    sha256: portableSha256
  });
  const githubRelease = await fetchGithubRelease(githubRepository, tagName, githubToken, options.fetchImpl);
  const gitee = createGiteeClient({
    owner,
    repository,
    token,
    fetchImpl: options.fetchImpl,
    uploadImpl: options.uploadImpl
  });
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
  const uploadEntries = [
    installerName,
    `${installerName}.blockmap`,
    portableName,
    "latest.yml"
  ].map((name) => [name, files.get(name)]);
  const expectedAssets = new Map();
  for (const [name, filename] of uploadEntries) {
    console.log(`正在上传 Gitee Release 附件：${name}`);
    const size = await gitee.ensureAsset(release.id, name, { filePath: filename });
    expectedAssets.set(name, size);
  }
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`正在上传 Gitee Release 附件：${UPDATE_MANIFEST_NAME}`);
  const manifestSize = await gitee.ensureAsset(release.id, UPDATE_MANIFEST_NAME, { data: manifestBuffer });
  expectedAssets.set(UPDATE_MANIFEST_NAME, manifestSize);
  await gitee.verifyNamedAssets(release.id, expectedAssets);

  return Object.freeze({
    tagName,
    version,
    releaseUrl: `https://gitee.com/${owner}/${repository}/releases/tag/${tagName}`,
    assets: Object.freeze(uploadNames)
  });
}

function createGiteeClient({ owner, repository, token, fetchImpl = fetch, uploadImpl = uploadMultipartAsset }) {
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

  async function listAssets(releaseId) {
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
    return assets;
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

    async ensureAsset(releaseId, filename, source) {
      const expectedSize = await assetSourceSize(filename, source);
      const assets = await listAssets(releaseId);
      const namedAssets = assets.filter((asset) => asset?.name === filename);
      const reusableAsset = namedAssets.find((asset) => Number(asset?.size) === expectedSize);
      if (reusableAsset) {
        console.log(`Gitee Release 附件已存在且大小一致，跳过重传：${filename}`);
        return expectedSize;
      }

      for (const asset of namedAssets) {
        if (Number.isSafeInteger(asset?.id)) {
          await request(`/releases/${releaseId}/attach_files/${asset.id}`, {
            method: "DELETE",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ access_token: token })
          });
        }
      }

      for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt += 1) {
        try {
          await uploadImpl({
            url: `${baseUrl}/releases/${releaseId}/attach_files`,
            token,
            filename,
            source,
            timeoutMs: UPLOAD_TIMEOUT_MS,
            idleTimeoutMs: UPLOAD_IDLE_TIMEOUT_MS
          });
          console.log(`Gitee Release 附件上传完成：${filename}`);
          return expectedSize;
        } catch (error) {
          const completedAfterError = await listAssets(releaseId)
            .then((assets) => assets.some((asset) => asset?.name === filename && Number(asset?.size) === expectedSize))
            .catch(() => false);
          if (completedAfterError) {
            console.log(`Gitee Release 已在连接中断后确认附件完整：${filename}`);
            return expectedSize;
          }
          if (attempt >= UPLOAD_MAX_ATTEMPTS || !isRetryableUploadError(error)) {
            throw error;
          }
          console.warn(`Gitee Release 附件上传中断，${Math.round(UPLOAD_RETRY_DELAY_MS / 1_000)} 秒后重试（${attempt + 1}/${UPLOAD_MAX_ATTEMPTS}）：${filename}`);
          await delay(UPLOAD_RETRY_DELAY_MS);
        }
      }
      throw new Error(`Gitee Release 附件 ${filename} 未能完成上传。`);
    },

    async verifyNamedAssets(releaseId, expectedAssets) {
      const assets = await listAssets(releaseId);
      const invalid = [...expectedAssets].filter(([name, size]) => !assets.some((asset) => asset?.name === name && Number(asset?.size) === size));
      if (invalid.length > 0) {
        throw new Error(`Gitee Release 附件上传后校验失败，缺少或大小不一致：${invalid.map(([name]) => name).join("、")}。`);
      }
    }
  };
}

async function assetSourceSize(filename, source) {
  const size = source.filePath ? (await stat(source.filePath)).size : source.data?.length;
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`待上传附件 ${filename} 为空或大小无效。`);
  }
  return size;
}

function isRetryableUploadError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const status = /HTTP\s+(\d{3})/i.exec(message);
  if (!status) {
    return true;
  }
  const statusCode = Number(status[1]);
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function uploadMultipartAsset({ url, token, filename, source, timeoutMs, idleTimeoutMs }) {
  const boundary = `----git-ui-pro-${randomUUID()}`;
  const safeFilename = filename.replace(/["\r\n]/g, "_");
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeFilename}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
    "utf8"
  );
  const suffix = Buffer.from(
    `\r\n--${boundary}\r\n` +
      "Content-Disposition: form-data; name=\"access_token\"\r\n\r\n" +
      `${token}\r\n--${boundary}--\r\n`,
    "utf8"
  );
  const fileSize = await assetSourceSize(filename, source);

  await new Promise((resolve, reject) => {
    let fileStream;
    let uploadedBytes = 0;
    let nextProgressPercent = 10;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };
    const request = httpsRequest(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": prefix.length + fileSize + suffix.length,
        "User-Agent": "Git-UI-Pro-Gitee-Mirror"
      }
    }, (response) => {
      const chunks = [];
      let responseSize = 0;
      response.on("data", (chunk) => {
        responseSize += chunk.length;
        if (responseSize <= 16_384) {
          chunks.push(chunk);
        }
      });
      response.on("end", () => {
        const detail = Buffer.concat(chunks).toString("utf8").slice(0, 500).replace(/\s+/g, " ").trim();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          finish(resolve);
          return;
        }
        finish(
          reject,
          new Error(
            `上传 Gitee Release 附件 ${filename} 返回 HTTP ${response.statusCode ?? "未知"}` +
              `${detail ? `：${detail}` : ""}`
          )
        );
      });
    });
    const timeoutId = setTimeout(() => {
      request.destroy(
        new Error(
          `上传 Gitee Release 附件 ${filename} 超过 ${Math.round(timeoutMs / 60_000)} 分钟` +
            `（已传输 ${formatMegabytes(uploadedBytes)} / ${formatMegabytes(fileSize)}）。`
        )
      );
    }, timeoutMs);
    request.setTimeout(idleTimeoutMs, () => {
      request.destroy(
        new Error(
          `上传 Gitee Release 附件 ${filename} 连续 ${Math.round(idleTimeoutMs / 60_000)} 分钟无网络进度` +
            `（已传输 ${formatMegabytes(uploadedBytes)} / ${formatMegabytes(fileSize)}）。`
        )
      );
    });
    request.on("error", (error) => {
      fileStream?.destroy();
      finish(reject, new Error(`上传 Gitee Release 附件 ${filename} 失败：${error.message}`));
    });
    request.write(prefix);
    if (source.filePath) {
      fileStream = createReadStream(source.filePath);
      fileStream.on("error", (error) => request.destroy(error));
      fileStream.on("data", (chunk) => {
        uploadedBytes += chunk.length;
        const progressPercent = Math.floor((uploadedBytes / fileSize) * 100);
        if (progressPercent >= nextProgressPercent) {
          console.log(
            `Gitee Release 附件传输进度：${filename} ${progressPercent}%` +
              `（${formatMegabytes(uploadedBytes)} / ${formatMegabytes(fileSize)}）`
          );
          nextProgressPercent = Math.min(100, progressPercent + 10);
        }
      });
      fileStream.on("end", () => request.end(suffix));
      fileStream.pipe(request, { end: false });
      return;
    }
    uploadedBytes = source.data.length;
    request.end(Buffer.concat([source.data, suffix]));
  });
}

function formatMegabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
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
