import { net } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ReleaseHistoryItem } from "./releaseHistory";
import {
  PORTABLE_UPDATE_DIRECTORY_NAME,
  PORTABLE_UPDATE_HEALTH_MARKER_ENV,
  PORTABLE_UPDATE_HEALTH_TOKEN_ENV,
  type PortableRuntime
} from "./portableRuntime";
import { githubReleaseUrl, normalizeReleaseNotes } from "./updateUtils";

const GITHUB_RELEASE_OWNER = "zjx150504-lgtm";
const GITHUB_RELEASE_REPOSITORY = "Git_UI_Pro";
const GITEE_RELEASE_OWNER = "zjx_master";
const GITEE_RELEASE_REPOSITORY = "git-ui-pro";
const UPDATE_MANIFEST_NAME = "update-manifest.json";
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_DIGEST_PATTERN = /^sha256:([a-f\d]{64})$/i;
const MAX_RELEASE_NOTES_LENGTH = 12_000;
const MAX_HISTORY_ENTRIES = 3;

type StableVersion = Readonly<{
  value: string;
  parts: readonly [bigint, bigint, bigint];
}>;

export type PortableUpdateTarget = Readonly<{
  version: string;
  tagName: string;
  releaseName: string;
  releaseNotes: string;
  releaseDate: string;
  releaseUrl: string;
  artifactName: string;
  downloadUrl: string;
  size: number;
  sha256: string;
}>;

export type PortableLatestStableRelease = Readonly<{
  version: string;
  tagName: string;
  target: PortableUpdateTarget;
}>;

export type PortableGiteeReleaseSummary = Readonly<{
  version: string;
  tagName: string;
  releaseName: string;
  releaseNotes: string;
  releaseDate: string;
  releaseUrl: string;
  artifactName: string;
  artifactUrl: string;
  manifestUrl: string;
}>;

export type PortableDownloadProgress = Readonly<{
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}>;

export class PortableReleaseCatalog {
  readonly entries: readonly ReleaseHistoryItem[];
  readonly #targets: ReadonlyMap<string, PortableUpdateTarget>;

  constructor(entries: readonly ReleaseHistoryItem[], targets: ReadonlyMap<string, PortableUpdateTarget>) {
    this.entries = Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
    this.#targets = new Map(targets);
  }

  resolveTarget(version: string): PortableUpdateTarget | null {
    const normalized = stripVersionPrefix(version);
    const target = this.#targets.get(normalized);
    return target ? Object.freeze({ ...target }) : null;
  }
}

export function portableArtifactName(version: string): string {
  const parsed = parseStableVersion(stripVersionPrefix(version));
  if (!parsed) {
    throw new Error(`Portable 版本号无效：${version}`);
  }
  return `Git-UI-Pro-Portable-${parsed.value}-x64.exe`;
}

export function parseLatestPortableGithubRelease(value: unknown): PortableLatestStableRelease {
  const target = parsePortableGithubRelease(value);
  if (!target) {
    throw new Error("GitHub latest 不是可用的 Portable 正式版本，或便携版资产尚未就绪。");
  }
  return Object.freeze({ version: target.version, tagName: target.tagName, target });
}

export function buildPortableGithubReleaseHistoryCatalog(
  rawReleases: unknown,
  currentVersion: string
): PortableReleaseCatalog {
  const current = requireStableVersion(currentVersion, "当前版本");
  if (!Array.isArray(rawReleases)) {
    throw new Error("GitHub Releases 响应格式无效：预期发布记录数组。");
  }
  const targets = new Map<string, PortableUpdateTarget>();
  for (const release of rawReleases) {
    const target = parsePortableGithubRelease(release);
    const version = target ? parseStableVersion(target.version) : null;
    if (!target || !version || compareStableVersions(version, current) >= 0 || targets.has(target.version)) {
      continue;
    }
    targets.set(target.version, target);
  }
  return portableCatalogFromTargets([...targets.values()]);
}

export function parsePortableGiteeReleaseSummary(value: unknown): PortableGiteeReleaseSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const tagName = typeof value.tag_name === "string" ? value.tag_name : "";
  const tagMatch = /^v(.+)$/.exec(tagName);
  const version = tagMatch ? parseStableVersion(tagMatch[1]) : null;
  const releaseDate = normalizeDate(value.created_at);
  if (!version || value.prerelease !== false || !releaseDate || !Array.isArray(value.assets)) {
    return null;
  }

  const artifactName = portableArtifactName(version.value);
  const artifactPath = giteeDownloadPath(tagName, artifactName);
  const manifestPath = giteeDownloadPath(tagName, UPDATE_MANIFEST_NAME);
  let artifactUrl: string | null = null;
  let manifestUrl: string | null = null;
  for (const item of value.assets) {
    if (!isRecord(item) || typeof item.browser_download_url !== "string") {
      continue;
    }
    if (item.name === artifactName) {
      artifactUrl = parseExactDownloadUrl(item.browser_download_url, "gitee.com", artifactPath);
    }
    if (item.name === UPDATE_MANIFEST_NAME) {
      manifestUrl = parseExactDownloadUrl(item.browser_download_url, "gitee.com", manifestPath);
    }
  }
  if (!artifactUrl || !manifestUrl) {
    return null;
  }

  return Object.freeze({
    version: version.value,
    tagName,
    releaseName: normalizeText(value.name) || `Git UI Pro v${version.value}`,
    releaseNotes: normalizeText(value.body).slice(0, MAX_RELEASE_NOTES_LENGTH),
    releaseDate,
    releaseUrl: `https://gitee.com/${GITEE_RELEASE_OWNER}/${GITEE_RELEASE_REPOSITORY}/releases/tag/${tagName}`,
    artifactName,
    artifactUrl,
    manifestUrl
  });
}

export function verifyPortableGiteeRelease(
  summary: PortableGiteeReleaseSummary,
  rawManifest: unknown
): PortableUpdateTarget {
  if (!isRecord(rawManifest) || !isRecord(rawManifest.portable)) {
    throw new Error(`Gitee v${summary.version} 的 Portable 更新清单格式无效。`);
  }
  const portable = rawManifest.portable;
  if (
    rawManifest.schemaVersion !== 1 ||
    rawManifest.version !== summary.version ||
    rawManifest.tagName !== summary.tagName ||
    portable.name !== summary.artifactName ||
    typeof portable.size !== "number" ||
    !Number.isSafeInteger(portable.size) ||
    portable.size <= 0 ||
    typeof portable.sha256 !== "string" ||
    !/^[a-f\d]{64}$/i.test(portable.sha256)
  ) {
    throw new Error(`Gitee v${summary.version} 的 Portable 更新清单与发行版不匹配。`);
  }
  return Object.freeze({
    version: summary.version,
    tagName: summary.tagName,
    releaseName: summary.releaseName,
    releaseNotes: summary.releaseNotes,
    releaseDate: summary.releaseDate,
    releaseUrl: summary.releaseUrl,
    artifactName: summary.artifactName,
    downloadUrl: summary.artifactUrl,
    size: portable.size,
    sha256: portable.sha256.toLowerCase()
  });
}

export function parseLatestPortableGiteeRelease(
  rawRelease: unknown,
  rawManifest: unknown
): PortableLatestStableRelease {
  const summary = parsePortableGiteeReleaseSummary(rawRelease);
  if (!summary) {
    throw new Error("Gitee latest 不是可用的 Portable 正式版本，或便携版资产尚未同步完成。");
  }
  const target = verifyPortableGiteeRelease(summary, rawManifest);
  return Object.freeze({ version: target.version, tagName: target.tagName, target });
}

export function selectPortableGiteeHistoryCandidates(
  rawReleases: unknown,
  currentVersion: string,
  limit = 8
): PortableGiteeReleaseSummary[] {
  const current = requireStableVersion(currentVersion, "当前版本");
  if (!Array.isArray(rawReleases)) {
    throw new Error("Gitee Releases 响应格式无效：预期发布记录数组。");
  }
  const candidates = new Map<string, { version: StableVersion; summary: PortableGiteeReleaseSummary }>();
  for (const release of rawReleases) {
    const summary = parsePortableGiteeReleaseSummary(release);
    const version = summary ? parseStableVersion(summary.version) : null;
    if (!summary || !version || compareStableVersions(version, current) >= 0 || candidates.has(version.value)) {
      continue;
    }
    candidates.set(version.value, { version, summary });
  }
  return [...candidates.values()]
    .sort((left, right) => compareStableVersions(right.version, left.version))
    .slice(0, limit)
    .map(({ summary }) => summary);
}

export function buildPortableGiteeReleaseHistoryCatalog(
  targets: readonly PortableUpdateTarget[],
  currentVersion: string
): PortableReleaseCatalog {
  const current = requireStableVersion(currentVersion, "当前版本");
  return portableCatalogFromTargets(targets.filter((target) => {
    const version = parseStableVersion(target.version);
    return version && compareStableVersions(version, current) < 0;
  }));
}

export function comparePortableVersions(leftValue: string, rightValue: string): number {
  return compareStableVersions(
    requireStableVersion(leftValue, "版本号"),
    requireStableVersion(rightValue, "版本号")
  );
}

export async function downloadPortableUpdate(
  target: PortableUpdateTarget,
  runtime: PortableRuntime,
  signal: AbortSignal,
  onProgress: (progress: PortableDownloadProgress) => void
): Promise<string> {
  const executablePath = requirePortableExecutable(runtime);
  const stagingDirectory = path.join(path.dirname(executablePath), ".git-ui-pro-updates");
  await ensureDirectoryWritable(stagingDirectory);
  const partialPath = path.join(stagingDirectory, `${target.artifactName}.partial`);
  const stagedPath = path.join(stagingDirectory, `${target.artifactName}.ready`);
  await Promise.all([rm(partialPath, { force: true }), rm(stagedPath, { force: true })]);

  const response = await net.fetch(target.downloadUrl, {
    method: "GET",
    redirect: "follow",
    headers: { Accept: "application/octet-stream, */*", "Cache-Control": "no-cache" },
    signal
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Portable 更新包下载失败（HTTP ${response.status}）。`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(contentLength) && contentLength > 0 && contentLength !== target.size) {
    await response.body.cancel().catch(() => undefined);
    throw new Error(`Portable 更新包大小与发行版清单不一致（预期 ${target.size}，实际 ${contentLength}）。`);
  }

  const handle = await open(partialPath, "wx", 0o600);
  const reader = response.body.getReader();
  const digest = createHash("sha256");
  const startedAt = Date.now();
  let transferred = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const bytes = Buffer.from(chunk.value);
      transferred += bytes.length;
      if (transferred > target.size) {
        throw new Error("Portable 更新包大小超过发行版清单，已停止下载。");
      }
      digest.update(bytes);
      await handle.write(bytes);
      const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1_000);
      onProgress(Object.freeze({
        percent: Math.max(0, Math.min(100, (transferred / target.size) * 100)),
        transferred,
        total: target.size,
        bytesPerSecond: transferred / elapsedSeconds
      }));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }

  const actualDigest = digest.digest("hex");
  if (transferred !== target.size) {
    await rm(partialPath, { force: true });
    throw new Error(`Portable 更新包下载不完整（预期 ${target.size} 字节，实际 ${transferred} 字节）。`);
  }
  if (actualDigest !== target.sha256) {
    await rm(partialPath, { force: true });
    throw new Error("Portable 更新包 SHA-256 校验失败，已删除下载文件。");
  }
  await rename(partialPath, stagedPath);
  return stagedPath;
}

export async function launchPortableUpdateHelper(input: {
  runtime: PortableRuntime;
  userDataPath: string;
  stagedPath: string;
  target: PortableUpdateTarget;
}): Promise<void> {
  const currentPath = requirePortableExecutable(input.runtime);
  const currentDirectory = path.dirname(currentPath);
  const expectedStagingDirectory = path.resolve(currentDirectory, ".git-ui-pro-updates");
  const stagedPath = path.resolve(input.stagedPath);
  if (
    path.dirname(stagedPath).toLocaleLowerCase() !== expectedStagingDirectory.toLocaleLowerCase() ||
    path.basename(stagedPath) !== `${input.target.artifactName}.ready`
  ) {
    throw new Error("Portable 更新包暂存路径无效，请重新下载。");
  }
  const stagedStat = await stat(stagedPath);
  if (!stagedStat.isFile() || stagedStat.size !== input.target.size) {
    throw new Error("Portable 更新包已失效，请重新下载。");
  }

  const updateDirectory = path.resolve(input.userDataPath, PORTABLE_UPDATE_DIRECTORY_NAME);
  await mkdir(updateDirectory, { recursive: true });
  const token = randomBytes(16).toString("hex");
  const markerPath = path.join(updateDirectory, `portable-health-${token}.ok`);
  const helperPath = path.join(updateDirectory, "apply-portable-update.ps1");
  const backupPath = path.join(currentDirectory, "Git-UI-Pro-Portable.previous.exe");
  const logPath = path.join(updateDirectory, "portable-update.log");
  await Promise.all([
    rm(markerPath, { force: true }),
    writeFile(helperPath, `${buildPortableUpdatePowerShellScript()}\n`, { encoding: "utf8", mode: 0o600 })
  ]);

  const child = spawn("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helperPath,
    "-ApplicationPid",
    String(process.pid),
    "-LauncherPid",
    String(process.ppid),
    "-CurrentPath",
    currentPath,
    "-StagedPath",
    stagedPath,
    "-BackupPath",
    backupPath,
    "-HealthPath",
    markerPath,
    "-HealthToken",
    token,
    "-LogPath",
    logPath
  ], {
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => reject(new Error(`Portable 更新辅助进程启动失败：${error.message}`)));
  });
  child.unref();
}

export function buildPortableUpdatePowerShellScript(): string {
  return [
    "param(",
    "  [Parameter(Mandatory=$true)][int]$ApplicationPid,",
    "  [Parameter(Mandatory=$true)][int]$LauncherPid,",
    "  [Parameter(Mandatory=$true)][string]$CurrentPath,",
    "  [Parameter(Mandatory=$true)][string]$StagedPath,",
    "  [Parameter(Mandatory=$true)][string]$BackupPath,",
    "  [Parameter(Mandatory=$true)][string]$HealthPath,",
    "  [Parameter(Mandatory=$true)][string]$HealthToken,",
    "  [Parameter(Mandatory=$true)][string]$LogPath",
    ")",
    "$ErrorActionPreference = 'Stop'",
    "function Write-UpdateLog([string]$Message) {",
    "  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'",
    "  Add-Content -LiteralPath $LogPath -Value \"[$timestamp] $Message\" -Encoding UTF8",
    "}",
    "function Wait-ForExit([int]$TargetPid, [int]$TimeoutSeconds) {",
    "  try { Wait-Process -Id $TargetPid -Timeout $TimeoutSeconds -ErrorAction SilentlyContinue } catch {}",
    "}",
    "function Start-Portable([bool]$HealthCheck) {",
    "  if ($HealthCheck) {",
    `    $env:${PORTABLE_UPDATE_HEALTH_TOKEN_ENV} = $HealthToken`,
    `    $env:${PORTABLE_UPDATE_HEALTH_MARKER_ENV} = $HealthPath`,
    "  } else {",
    `    Remove-Item Env:${PORTABLE_UPDATE_HEALTH_TOKEN_ENV} -ErrorAction SilentlyContinue`,
    `    Remove-Item Env:${PORTABLE_UPDATE_HEALTH_MARKER_ENV} -ErrorAction SilentlyContinue`,
    "  }",
    "  return Start-Process -FilePath $CurrentPath -PassThru",
    "}",
    "New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null",
    "Write-UpdateLog '等待 Git UI Pro 与 Portable 启动器退出。'",
    "Wait-ForExit $ApplicationPid 90",
    "Wait-ForExit $LauncherPid 90",
    "try {",
    "  Remove-Item -LiteralPath $HealthPath -Force -ErrorAction SilentlyContinue",
    "  Remove-Item -LiteralPath $BackupPath -Force -ErrorAction SilentlyContinue",
    "  Move-Item -LiteralPath $CurrentPath -Destination $BackupPath -Force",
    "  Move-Item -LiteralPath $StagedPath -Destination $CurrentPath -Force",
    "  Write-UpdateLog 'Portable 文件替换完成，启动新版本并等待健康检查。'",
    "  $newLauncher = Start-Portable $true",
    "  $deadline = (Get-Date).AddSeconds(90)",
    "  $healthy = $false",
    "  while ((Get-Date) -lt $deadline) {",
    "    if (Test-Path -LiteralPath $HealthPath) {",
    "      $marker = (Get-Content -LiteralPath $HealthPath -Raw -ErrorAction SilentlyContinue).Trim()",
    "      if ($marker -eq $HealthToken) { $healthy = $true; break }",
    "    }",
    "    if ($newLauncher.HasExited) { break }",
    "    Start-Sleep -Milliseconds 500",
    "  }",
    "  if (-not $healthy) {",
    "    Write-UpdateLog '新版本未通过健康检查，准备恢复上一版本。'",
    "    if (-not $newLauncher.HasExited) { & taskkill.exe /PID $newLauncher.Id /T /F | Out-Null }",
    "    Wait-ForExit $newLauncher.Id 30",
    "    Remove-Item -LiteralPath $CurrentPath -Force -ErrorAction SilentlyContinue",
    "    Move-Item -LiteralPath $BackupPath -Destination $CurrentPath -Force",
    "    Start-Portable $false | Out-Null",
    "    Write-UpdateLog '已恢复上一版本并重新启动。'",
    "    exit 2",
    "  }",
    "  Remove-Item -LiteralPath $BackupPath -Force -ErrorAction SilentlyContinue",
    "  Remove-Item -LiteralPath $HealthPath -Force -ErrorAction SilentlyContinue",
    "  Write-UpdateLog '新版本健康检查通过，更新完成。'",
    "  exit 0",
    "} catch {",
    "  Write-UpdateLog (\"Portable 更新失败：\" + $_.Exception.Message)",
    "  if (-not (Test-Path -LiteralPath $CurrentPath) -and (Test-Path -LiteralPath $BackupPath)) {",
    "    Move-Item -LiteralPath $BackupPath -Destination $CurrentPath -Force -ErrorAction SilentlyContinue",
    "  }",
    "  if (Test-Path -LiteralPath $CurrentPath) { Start-Portable $false | Out-Null }",
    "  exit 1",
    "}"
  ].join("\r\n");
}

async function ensureDirectoryWritable(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.write-test-${process.pid}-${Date.now()}`);
  const handle = await open(probe, "wx", 0o600);
  await handle.close();
  await rm(probe, { force: true });
}

function requirePortableExecutable(runtime: PortableRuntime): string {
  if (!runtime.isPortable || !runtime.executablePath || !path.isAbsolute(runtime.executablePath)) {
    throw new Error("当前不是可更新的 Windows Portable 正式版。");
  }
  if (!existsSync(runtime.executablePath)) {
    throw new Error("找不到当前 Portable 可执行文件，无法执行在线更新。");
  }
  return path.resolve(runtime.executablePath);
}

function parsePortableGithubRelease(value: unknown): PortableUpdateTarget | null {
  if (!isRecord(value) || value.draft !== false || value.prerelease !== false || typeof value.tag_name !== "string") {
    return null;
  }
  const tagMatch = /^v(.+)$/.exec(value.tag_name);
  const version = tagMatch ? parseStableVersion(tagMatch[1]) : null;
  const releaseDate = normalizeDate(value.published_at);
  if (!version || !releaseDate || !Array.isArray(value.assets)) {
    return null;
  }
  const artifactName = portableArtifactName(version.value);
  const expectedPath = `/${GITHUB_RELEASE_OWNER}/${GITHUB_RELEASE_REPOSITORY}/releases/download/${value.tag_name}/${artifactName}`;
  for (const item of value.assets) {
    if (!isRecord(item) || item.name !== artifactName || item.state !== "uploaded") {
      continue;
    }
    const digestMatch = typeof item.digest === "string" ? SHA256_DIGEST_PATTERN.exec(item.digest) : null;
    const downloadUrl = typeof item.browser_download_url === "string"
      ? parseExactDownloadUrl(item.browser_download_url, "github.com", expectedPath)
      : null;
    if (
      !digestMatch ||
      !downloadUrl ||
      typeof item.size !== "number" ||
      !Number.isSafeInteger(item.size) ||
      item.size <= 0
    ) {
      continue;
    }
    return Object.freeze({
      version: version.value,
      tagName: value.tag_name,
      releaseName: normalizeText(value.name) || `Git UI Pro v${version.value}`,
      releaseNotes: normalizeReleaseNotes(normalizeText(value.body)).slice(0, MAX_RELEASE_NOTES_LENGTH),
      releaseDate,
      releaseUrl: githubReleaseUrl(version.value),
      artifactName,
      downloadUrl,
      size: item.size,
      sha256: digestMatch[1].toLowerCase()
    });
  }
  return null;
}

function portableCatalogFromTargets(input: readonly PortableUpdateTarget[]): PortableReleaseCatalog {
  const unique = new Map<string, PortableUpdateTarget>();
  for (const target of input) {
    if (!unique.has(target.version)) {
      unique.set(target.version, target);
    }
  }
  const selected = [...unique.values()]
    .sort((left, right) => comparePortableVersions(right.version, left.version))
    .slice(0, MAX_HISTORY_ENTRIES);
  const entries: ReleaseHistoryItem[] = selected.map((target) => ({
    version: target.version,
    tagName: target.tagName,
    releaseName: target.releaseName,
    releaseNotes: target.releaseNotes,
    publishedAt: target.releaseDate,
    releaseUrl: target.releaseUrl,
    installerSize: target.size
  }));
  return new PortableReleaseCatalog(entries, new Map(selected.map((target) => [target.version, target])));
}

function parseExactDownloadUrl(value: string, hostname: string, expectedPath: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === hostname &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname === expectedPath
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function giteeDownloadPath(tagName: string, filename: string): string {
  return `/${GITEE_RELEASE_OWNER}/${GITEE_RELEASE_REPOSITORY}/releases/download/${tagName}/${filename}`;
}

function parseStableVersion(value: string): StableVersion | null {
  const match = STABLE_VERSION_PATTERN.exec(value.trim());
  return match
    ? Object.freeze({
      value: `${match[1]}.${match[2]}.${match[3]}`,
      parts: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])] as const
    })
    : null;
}

function requireStableVersion(value: string, label: string): StableVersion {
  const parsed = parseStableVersion(stripVersionPrefix(value));
  if (!parsed) {
    throw new Error(`${label}不是稳定语义版本：${value}`);
  }
  return parsed;
}

function compareStableVersions(left: StableVersion, right: StableVersion): number {
  for (let index = 0; index < left.parts.length; index += 1) {
    if (left.parts[index] > right.parts[index]) return 1;
    if (left.parts[index] < right.parts[index]) return -1;
  }
  return 0;
}

function stripVersionPrefix(value: string): string {
  return value.startsWith("v") ? value.slice(1) : value;
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\r\n/g, "\n") : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function sha256File(filename: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

export async function readPortableUpdateLog(userDataPath: string): Promise<string> {
  const filename = path.join(userDataPath, PORTABLE_UPDATE_DIRECTORY_NAME, "portable-update.log");
  return readFile(filename, "utf8").catch(() => "");
}
