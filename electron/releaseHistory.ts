import {
  Provider,
  type ResolvedUpdateFileInfo,
  type UpdateFileInfo,
  type UpdateInfo
} from "electron-updater";

const RELEASE_OWNER = "zjx150504-lgtm";
const RELEASE_REPOSITORY = "Git_UI_Pro";
const MAX_HISTORY_ENTRIES = 3;
const MAX_RELEASE_NOTES_LENGTH = 12_000;
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_DIGEST_PATTERN = /^sha256:([a-f\d]{64})$/i;

type StableVersion = {
  value: string;
  parts: readonly [bigint, bigint, bigint];
};

type GithubReleaseAsset = {
  name?: unknown;
  state?: unknown;
  digest?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
};

type GithubRelease = {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  assets?: unknown;
};

export type ReleaseHistoryItem = Readonly<{
  version: string;
  tagName: string;
  releaseName: string;
  releaseNotes: string;
  publishedAt: string;
  releaseUrl: string;
  installerSize: number;
}>;

export type RollbackTarget = Readonly<{
  version: string;
  releaseName: string;
  releaseNotes: string;
  releaseDate: string;
  downloadUrl: string;
  sha256: string;
}>;

type RollbackProviderConfiguration = {
  readonly rollbackTarget?: unknown;
  readonly [key: string]: unknown;
};

export type RollbackUpdaterOptions = Readonly<{
  provider: "custom";
  updateProvider: typeof RollbackProvider;
  rollbackTarget: RollbackTarget;
}>;

type ParsedRelease = {
  version: StableVersion;
  item: ReleaseHistoryItem;
  target: RollbackTarget;
};

export class ReleaseHistoryCatalog {
  readonly entries: readonly ReleaseHistoryItem[];
  readonly #targets: ReadonlyMap<string, RollbackTarget>;

  constructor(entries: readonly ReleaseHistoryItem[], targets: ReadonlyMap<string, RollbackTarget>) {
    this.entries = Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
    this.#targets = new Map(targets);
  }

  resolveTarget(version: string): RollbackTarget | null {
    const normalizedVersion = version.startsWith("v") ? version.slice(1) : version;
    const target = this.#targets.get(normalizedVersion);
    return target ? Object.freeze({ ...target }) : null;
  }
}

export function buildReleaseHistoryCatalog(rawReleases: unknown, currentVersion: string): ReleaseHistoryCatalog {
  const current = parseStableVersion(currentVersion.startsWith("v") ? currentVersion.slice(1) : currentVersion);
  if (!current) {
    throw new Error(`当前版本不是稳定语义版本: ${currentVersion}`);
  }

  if (!Array.isArray(rawReleases)) {
    throw new Error("GitHub Releases 响应格式无效：预期发布记录数组。");
  }

  const releasesByVersion = new Map<string, ParsedRelease>();
  for (const rawRelease of rawReleases) {
    const release = parseGithubRelease(rawRelease, current);
    if (release && !releasesByVersion.has(release.version.value)) {
      releasesByVersion.set(release.version.value, release);
    }
  }

  const releases = [...releasesByVersion.values()]
    .sort((left, right) => compareStableVersions(right.version, left.version))
    .slice(0, MAX_HISTORY_ENTRIES);
  const targets = new Map(releases.map((release) => [release.version.value, release.target]));

  return new ReleaseHistoryCatalog(
    releases.map((release) => release.item),
    targets
  );
}

export function createRollbackUpdaterOptions(target: RollbackTarget): RollbackUpdaterOptions {
  const rollbackTarget = validateRollbackTarget(target);
  return Object.freeze({
    provider: "custom",
    updateProvider: RollbackProvider,
    rollbackTarget
  });
}

export class RollbackProvider extends Provider<UpdateInfo> {
  readonly #target: RollbackTarget;

  constructor(options: RollbackProviderConfiguration, _updater: unknown, runtimeOptions: any) {
    super(runtimeOptions);
    this.#target = validateRollbackTarget(options.rollbackTarget);
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    return createUpdateInfo(this.#target);
  }

  resolveFiles(_updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    return [
      {
        url: new URL(this.#target.downloadUrl),
        info: createSha256FileInfo(this.#target)
      }
    ];
  }
}

function parseGithubRelease(value: unknown, currentVersion: StableVersion): ParsedRelease | null {
  if (!isRecord(value)) {
    return null;
  }

  const release = value as GithubRelease;
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string") {
    return null;
  }

  const tagMatch = /^v(.+)$/.exec(release.tag_name);
  const version = tagMatch ? parseStableVersion(tagMatch[1]) : null;
  if (!version || compareStableVersions(version, currentVersion) >= 0) {
    return null;
  }

  const publishedAt = normalizePublishedAt(release.published_at);
  const asset = findInstallerAsset(release.assets, version.value, release.tag_name);
  if (!publishedAt || !asset) {
    return null;
  }

  const releaseName = normalizeText(release.name) || `Git UI Pro v${version.value}`;
  const releaseNotes = normalizeText(release.body).slice(0, MAX_RELEASE_NOTES_LENGTH);
  const releaseUrl = `https://github.com/${RELEASE_OWNER}/${RELEASE_REPOSITORY}/releases/tag/${release.tag_name}`;
  const item = Object.freeze({
    version: version.value,
    tagName: release.tag_name,
    releaseName,
    releaseNotes,
    publishedAt,
    releaseUrl,
    installerSize: asset.size
  });
  const target = Object.freeze({
    version: version.value,
    releaseName,
    releaseNotes,
    releaseDate: publishedAt,
    downloadUrl: asset.downloadUrl,
    sha256: asset.sha256
  });

  return { version, item, target };
}

function findInstallerAsset(
  assets: unknown,
  version: string,
  tagName: string
): { downloadUrl: string; sha256: string; size: number } | null {
  if (!Array.isArray(assets)) {
    return null;
  }

  const expectedName = `Git-UI-Pro-Setup-${version}-x64.exe`;
  const expectedPath = `/${RELEASE_OWNER}/${RELEASE_REPOSITORY}/releases/download/${tagName}/${expectedName}`;
  for (const value of assets) {
    if (!isRecord(value)) {
      continue;
    }

    const asset = value as GithubReleaseAsset;
    if (
      asset.name !== expectedName ||
      asset.state !== "uploaded" ||
      typeof asset.digest !== "string" ||
      typeof asset.browser_download_url !== "string"
    ) {
      continue;
    }

    const digestMatch = SHA256_DIGEST_PATTERN.exec(asset.digest);
    const downloadUrl = parseExpectedDownloadUrl(asset.browser_download_url, expectedPath);
    if (!digestMatch || !downloadUrl) {
      continue;
    }

    if (typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
      continue;
    }

    const size = asset.size;
    return { downloadUrl, sha256: digestMatch[1].toLowerCase(), size };
  }

  return null;
}

function parseExpectedDownloadUrl(value: string, expectedPath: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === expectedPath
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function parseStableVersion(value: string): StableVersion | null {
  const match = STABLE_VERSION_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  return {
    value,
    parts: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])]
  };
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

function normalizePublishedAt(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\r\n/g, "\n") : "";
}

function createUpdateInfo(target: RollbackTarget): UpdateInfo {
  return {
    version: target.version,
    files: [createSha256FileInfo(target)],
    releaseName: target.releaseName,
    releaseNotes: target.releaseNotes,
    releaseDate: target.releaseDate
  } as unknown as UpdateInfo;
}

function validateRollbackTarget(value: unknown): RollbackTarget {
  if (!isRecord(value)) {
    throw new Error("回退目标无效");
  }

  const version = typeof value.version === "string" ? parseStableVersion(value.version) : null;
  const expectedName = version ? `Git-UI-Pro-Setup-${version.value}-x64.exe` : "";
  const expectedPath = version
    ? `/${RELEASE_OWNER}/${RELEASE_REPOSITORY}/releases/download/v${version.value}/${expectedName}`
    : "";
  const downloadUrl = typeof value.downloadUrl === "string" ? parseExpectedDownloadUrl(value.downloadUrl, expectedPath) : null;
  const releaseDate = normalizePublishedAt(value.releaseDate);
  if (
    !version ||
    !downloadUrl ||
    typeof value.sha256 !== "string" ||
    !/^[a-f\d]{64}$/i.test(value.sha256) ||
    typeof value.releaseName !== "string" ||
    typeof value.releaseNotes !== "string" ||
    !releaseDate
  ) {
    throw new Error("回退目标无效");
  }

  return Object.freeze({
    version: version.value,
    releaseName: value.releaseName,
    releaseNotes: value.releaseNotes.slice(0, MAX_RELEASE_NOTES_LENGTH),
    releaseDate,
    downloadUrl,
    sha256: value.sha256.toLowerCase()
  });
}

function createSha256FileInfo(target: RollbackTarget): UpdateFileInfo {
  // GitHub exposes SHA-256 while electron-updater 6.8.9 still validates its legacy sha2 field at runtime.
  return {
    url: target.downloadUrl,
    sha2: target.sha256
  } as unknown as UpdateFileInfo;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
