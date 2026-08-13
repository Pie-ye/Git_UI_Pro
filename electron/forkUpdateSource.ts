import {
  Provider,
  type ResolvedUpdateFileInfo,
  type UpdateFileInfo,
  type UpdateInfo
} from "electron-updater";
import { normalizeReleaseNotes } from "./updateUtils";
import type { ReleaseHistoryItem } from "./releaseHistory";
import type { LatestStableRelease } from "./updateService";
import type { PortableUpdateTarget } from "./portableUpdate";

export const FORK_RELEASE_OWNER = "Pie-ye";
export const FORK_RELEASE_REPOSITORY = "Git_UI_Pro";
export const FORK_REPOSITORY_URL = `https://github.com/${FORK_RELEASE_OWNER}/${FORK_RELEASE_REPOSITORY}`;
export const FORK_RELEASE_HISTORY_URL = `https://api.github.com/repos/${FORK_RELEASE_OWNER}/${FORK_RELEASE_REPOSITORY}/releases?per_page=20`;
export const FORK_LATEST_RELEASE_URL = `https://api.github.com/repos/${FORK_RELEASE_OWNER}/${FORK_RELEASE_REPOSITORY}/releases/latest`;

const MAX_HISTORY_ENTRIES = 3;
const MAX_RELEASE_NOTES_LENGTH = 12_000;
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_DIGEST_PATTERN = /^sha256:([a-f\d]{64})$/i;

type StableVersion = Readonly<{
  value: string;
  parts: readonly [bigint, bigint, bigint];
}>;

type GithubReleaseAsset = Readonly<{
  name?: unknown;
  state?: unknown;
  digest?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}>;

type GithubRelease = Readonly<{
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  assets?: unknown;
}>;

type InstallerUpdateTarget = Readonly<{
  version: string;
  releaseName: string;
  releaseNotes: string;
  releaseDate: string;
  releaseUrl: string;
  downloadUrl: string;
  sha256: string;
}>;

type ForkUpdateTarget = InstallerUpdateTarget | PortableUpdateTarget;

type ParsedForkRelease = Readonly<{
  version: StableVersion;
  tagName: string;
  releaseName: string;
  releaseNotes: string;
  releaseDate: string;
  releaseUrl: string;
  installerTarget: InstallerUpdateTarget | null;
  portableTarget: PortableUpdateTarget | null;
  latestMetadataReady: boolean;
}>;

export class ForkReleaseCatalog {
  readonly entries: readonly ReleaseHistoryItem[];
  readonly #targets: ReadonlyMap<string, ForkUpdateTarget>;

  constructor(entries: readonly ReleaseHistoryItem[], targets: ReadonlyMap<string, ForkUpdateTarget>) {
    this.entries = Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
    this.#targets = new Map(targets);
  }

  resolveTarget(version: string): ForkUpdateTarget | null {
    const normalized = stripVersionPrefix(version);
    const target = this.#targets.get(normalized);
    return target ? Object.freeze({ ...target }) : null;
  }
}

export function forkReleaseUrl(version: string): string {
  return `${FORK_REPOSITORY_URL}/releases/tag/v${stripVersionPrefix(version)}`;
}

export function parseForkLatestRelease(
  rawRelease: unknown,
  portable: boolean,
  currentVersion: string
): LatestStableRelease {
  const parsed = parseForkRelease(rawRelease);
  if (!parsed) {
    throw new Error("GitHub latest 不是可用的正式版本。");
  }

  if (portable) {
    if (!parsed.portableTarget) {
      if (compareVersionValues(parsed.version.value, currentVersion) <= 0) {
        return Object.freeze({ version: parsed.version.value, tagName: parsed.tagName, target: null });
      }
      throw new Error(`GitHub v${parsed.version.value} 的 Windows Portable 正式版资产尚未就绪。`);
    }
    return Object.freeze({
      version: parsed.version.value,
      tagName: parsed.tagName,
      target: parsed.portableTarget
    });
  }

  if (!parsed.latestMetadataReady || !parsed.installerTarget) {
    throw new Error(`GitHub v${parsed.version.value} 的 Windows 正式版更新资产尚未就绪。`);
  }
  return Object.freeze({
    version: parsed.version.value,
    tagName: parsed.tagName,
    target: parsed.installerTarget
  });
}

export function buildForkReleaseHistoryCatalog(
  rawReleases: unknown,
  currentVersion: string,
  portable: boolean
): ForkReleaseCatalog {
  const current = requireStableVersion(currentVersion, "当前版本");
  if (!Array.isArray(rawReleases)) {
    throw new Error("GitHub Releases 响应格式无效：预期发布记录数组。");
  }

  const releases = new Map<string, { parsed: ParsedForkRelease; target: ForkUpdateTarget }>();
  for (const rawRelease of rawReleases) {
    const parsed = parseForkRelease(rawRelease);
    const target = portable ? parsed?.portableTarget : parsed?.installerTarget;
    if (!parsed || !target || compareStableVersions(parsed.version, current) >= 0 || releases.has(parsed.version.value)) {
      continue;
    }
    releases.set(parsed.version.value, { parsed, target });
  }

  const selected = [...releases.values()]
    .sort((left, right) => compareStableVersions(right.parsed.version, left.parsed.version))
    .slice(0, MAX_HISTORY_ENTRIES);
  const targets = new Map(selected.map(({ parsed, target }) => [parsed.version.value, target]));
  const entries = selected.map(({ parsed, target }) => Object.freeze({
    version: parsed.version.value,
    tagName: parsed.tagName,
    releaseName: parsed.releaseName,
    releaseNotes: parsed.releaseNotes,
    publishedAt: parsed.releaseDate,
    releaseUrl: parsed.releaseUrl,
    installerSize: "size" in target ? target.size : findAssetSize(rawReleases, parsed.tagName, installerName(parsed.version.value))
  }));
  return new ForkReleaseCatalog(entries, targets);
}

export function createForkRollbackUpdaterOptions(target: unknown): Readonly<{
  provider: "custom";
  updateProvider: typeof ForkRollbackProvider;
  rollbackTarget: InstallerUpdateTarget;
}> {
  const rollbackTarget = validateInstallerTarget(target);
  return Object.freeze({
    provider: "custom",
    updateProvider: ForkRollbackProvider,
    rollbackTarget
  });
}

export class ForkRollbackProvider extends Provider<UpdateInfo> {
  readonly #target: InstallerUpdateTarget;

  constructor(options: { rollbackTarget?: unknown }, _updater: unknown, runtimeOptions: any) {
    super(runtimeOptions);
    this.#target = validateInstallerTarget(options.rollbackTarget);
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    return createUpdateInfo(this.#target);
  }

  resolveFiles(_updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    return [{
      url: new URL(this.#target.downloadUrl),
      info: createSha256FileInfo(this.#target)
    }];
  }
}

function parseForkRelease(value: unknown): ParsedForkRelease | null {
  if (!isRecord(value)) {
    return null;
  }
  const release = value as GithubRelease;
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string") {
    return null;
  }

  const tagMatch = /^v(.+)$/.exec(release.tag_name);
  const version = tagMatch ? parseStableVersion(tagMatch[1]) : null;
  const releaseDate = normalizeDate(release.published_at);
  if (!version || !releaseDate || !Array.isArray(release.assets)) {
    return null;
  }

  const releaseName = normalizeText(release.name) || `Git UI Pro v${version.value}`;
  const releaseNotes = normalizeReleaseNotes(normalizeText(release.body)).slice(0, MAX_RELEASE_NOTES_LENGTH);
  const releaseUrl = forkReleaseUrl(version.value);
  const installerAsset = findAsset(release.assets, release.tag_name, installerName(version.value));
  const portableAsset = findAsset(release.assets, release.tag_name, portableName(version.value));
  const latestMetadataReady = release.assets.some((asset) => isUploadedAssetNamed(asset, "latest.yml"));

  return Object.freeze({
    version,
    tagName: release.tag_name,
    releaseName,
    releaseNotes,
    releaseDate,
    releaseUrl,
    latestMetadataReady,
    installerTarget: installerAsset ? Object.freeze({
      version: version.value,
      releaseName,
      releaseNotes,
      releaseDate,
      releaseUrl,
      downloadUrl: installerAsset.downloadUrl,
      sha256: installerAsset.sha256
    }) : null,
    portableTarget: portableAsset ? Object.freeze({
      version: version.value,
      tagName: release.tag_name,
      releaseName,
      releaseNotes,
      releaseDate,
      releaseUrl,
      artifactName: portableName(version.value),
      downloadUrl: portableAsset.downloadUrl,
      size: portableAsset.size,
      sha256: portableAsset.sha256
    }) : null
  });
}

function findAsset(
  assets: readonly unknown[],
  tagName: string,
  name: string
): { downloadUrl: string; sha256: string; size: number } | null {
  const expectedPath = `/${FORK_RELEASE_OWNER}/${FORK_RELEASE_REPOSITORY}/releases/download/${tagName}/${name}`;
  for (const value of assets) {
    if (!isRecord(value)) {
      continue;
    }
    const asset = value as GithubReleaseAsset;
    if (
      asset.name !== name ||
      asset.state !== "uploaded" ||
      typeof asset.digest !== "string" ||
      typeof asset.browser_download_url !== "string" ||
      typeof asset.size !== "number" ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0
    ) {
      continue;
    }
    const digestMatch = SHA256_DIGEST_PATTERN.exec(asset.digest);
    const downloadUrl = parseExpectedGithubUrl(asset.browser_download_url, expectedPath);
    if (digestMatch && downloadUrl) {
      return { downloadUrl, sha256: digestMatch[1].toLowerCase(), size: asset.size };
    }
  }
  return null;
}

function findAssetSize(rawReleases: unknown, tagName: string, name: string): number {
  if (!Array.isArray(rawReleases)) {
    return 0;
  }
  const release = rawReleases.find((value) => isRecord(value) && value.tag_name === tagName);
  if (!release || !Array.isArray(release.assets)) {
    return 0;
  }
  const asset = release.assets.find((value) => isRecord(value) && value.name === name);
  return asset && typeof asset.size === "number" && Number.isSafeInteger(asset.size) && asset.size > 0 ? asset.size : 0;
}

function isUploadedAssetNamed(value: unknown, name: string): boolean {
  return isRecord(value) &&
    value.name === name &&
    value.state === "uploaded" &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size > 0;
}

function validateInstallerTarget(value: unknown): InstallerUpdateTarget {
  if (!isRecord(value)) {
    throw new Error("更新目标无效");
  }
  const version = typeof value.version === "string" ? parseStableVersion(value.version) : null;
  const expectedName = version ? installerName(version.value) : "";
  const expectedPath = version
    ? `/${FORK_RELEASE_OWNER}/${FORK_RELEASE_REPOSITORY}/releases/download/v${version.value}/${expectedName}`
    : "";
  const downloadUrl = typeof value.downloadUrl === "string"
    ? parseExpectedGithubUrl(value.downloadUrl, expectedPath)
    : null;
  const releaseUrl = version && typeof value.releaseUrl === "string" && value.releaseUrl === forkReleaseUrl(version.value)
    ? value.releaseUrl
    : null;
  const releaseDate = normalizeDate(value.releaseDate);
  if (
    !version || !downloadUrl || !releaseUrl || !releaseDate ||
    typeof value.sha256 !== "string" || !/^[a-f\d]{64}$/i.test(value.sha256) ||
    typeof value.releaseName !== "string" || typeof value.releaseNotes !== "string"
  ) {
    throw new Error("更新目标无效");
  }
  return Object.freeze({
    version: version.value,
    releaseName: value.releaseName,
    releaseNotes: value.releaseNotes.slice(0, MAX_RELEASE_NOTES_LENGTH),
    releaseDate,
    releaseUrl,
    downloadUrl,
    sha256: value.sha256.toLowerCase()
  });
}

function createUpdateInfo(target: InstallerUpdateTarget): UpdateInfo {
  return {
    version: target.version,
    files: [createSha256FileInfo(target)],
    releaseName: target.releaseName,
    releaseNotes: target.releaseNotes,
    releaseDate: target.releaseDate
  } as unknown as UpdateInfo;
}

function createSha256FileInfo(target: InstallerUpdateTarget): UpdateFileInfo {
  return { url: target.downloadUrl, sha2: target.sha256 } as unknown as UpdateFileInfo;
}

function parseExpectedGithubUrl(value: string, expectedPath: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
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

function installerName(version: string): string {
  return `Git-UI-Pro-Setup-${version}-x64.exe`;
}

function portableName(version: string): string {
  return `Git-UI-Pro-Portable-${version}-x64.exe`;
}

function stripVersionPrefix(value: string): string {
  return value.trim().replace(/^v/i, "");
}

function requireStableVersion(value: string, label: string): StableVersion {
  const parsed = parseStableVersion(stripVersionPrefix(value));
  if (!parsed) {
    throw new Error(`${label}不是稳定语义版本: ${value}`);
  }
  return parsed;
}

function parseStableVersion(value: string): StableVersion | null {
  const match = STABLE_VERSION_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  return Object.freeze({
    value,
    parts: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])]
  });
}

function compareVersionValues(left: string, right: string): number {
  return compareStableVersions(requireStableVersion(left, "版本号"), requireStableVersion(right, "版本号"));
}

function compareStableVersions(left: StableVersion, right: StableVersion): number {
  for (let index = 0; index < left.parts.length; index += 1) {
    if (left.parts[index] > right.parts[index]) {
      return 1;
    }
    if (left.parts[index] < right.parts[index]) {
      return -1;
    }
  }
  return 0;
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

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
