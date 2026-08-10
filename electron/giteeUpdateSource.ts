import {
  ReleaseHistoryCatalog,
  type ReleaseHistoryItem,
  type RollbackTarget
} from "./releaseHistory";

const GITEE_RELEASE_OWNER = "zjx_master";
const GITEE_RELEASE_REPOSITORY = "git-ui-pro";
const UPDATE_MANIFEST_NAME = "update-manifest.json";
const MAX_RELEASE_NOTES_LENGTH = 12_000;
const MAX_HISTORY_ENTRIES = 3;
const HISTORY_CANDIDATE_LIMIT = 8;
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type StableVersion = {
  value: string;
  parts: readonly [bigint, bigint, bigint];
};

type GiteeReleaseAsset = {
  name?: unknown;
  browser_download_url?: unknown;
};

type GiteeRelease = {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  prerelease?: unknown;
  created_at?: unknown;
  assets?: unknown;
};

export type GiteeReleaseSummary = Readonly<{
  version: string;
  tagName: string;
  releaseName: string;
  releaseNotes: string;
  releaseDate: string;
  releaseUrl: string;
  installerName: string;
  installerUrl: string;
  manifestUrl: string;
}>;

export type VerifiedGiteeRelease = Readonly<{
  version: string;
  tagName: string;
  releaseUrl: string;
  installerSize: number;
  target: RollbackTarget;
}>;

export function parseLatestStableGiteeRelease(
  rawRelease: unknown,
  rawManifest: unknown
): VerifiedGiteeRelease {
  const summary = parseGiteeReleaseSummary(rawRelease);
  if (!summary) {
    throw new Error("Gitee latest 不是可用的正式版本，或更新资产尚未同步完成。");
  }
  return verifyGiteeRelease(summary, rawManifest);
}

export function selectGiteeHistoryCandidates(
  rawReleases: unknown,
  currentVersion: string
): GiteeReleaseSummary[] {
  const current = parseStableVersion(stripVersionPrefix(currentVersion));
  if (!current) {
    throw new Error(`当前版本不是稳定语义版本: ${currentVersion}`);
  }
  if (!Array.isArray(rawReleases)) {
    throw new Error("Gitee Releases 响应格式无效：预期发布记录数组。");
  }

  const candidates = new Map<string, { version: StableVersion; summary: GiteeReleaseSummary }>();
  for (const rawRelease of rawReleases) {
    const summary = parseGiteeReleaseSummary(rawRelease);
    const version = summary ? parseStableVersion(summary.version) : null;
    if (!summary || !version || compareStableVersions(version, current) >= 0 || candidates.has(version.value)) {
      continue;
    }
    candidates.set(version.value, { version, summary });
  }

  return [...candidates.values()]
    .sort((left, right) => compareStableVersions(right.version, left.version))
    .slice(0, HISTORY_CANDIDATE_LIMIT)
    .map((candidate) => candidate.summary);
}

export function verifyGiteeRelease(
  summary: GiteeReleaseSummary,
  rawManifest: unknown
): VerifiedGiteeRelease {
  if (!isRecord(rawManifest)) {
    throw new Error(`Gitee v${summary.version} 的更新清单格式无效。`);
  }

  const installer = isRecord(rawManifest.installer) ? rawManifest.installer : null;
  const size = installer?.size;
  const sha256 = installer?.sha256;
  if (
    rawManifest.schemaVersion !== 1 ||
    rawManifest.version !== summary.version ||
    rawManifest.tagName !== summary.tagName ||
    !installer ||
    installer.name !== summary.installerName ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    typeof sha256 !== "string" ||
    !/^[a-f\d]{64}$/i.test(sha256)
  ) {
    throw new Error(`Gitee v${summary.version} 的更新清单与发行版不匹配。`);
  }

  return Object.freeze({
    version: summary.version,
    tagName: summary.tagName,
    releaseUrl: summary.releaseUrl,
    installerSize: size,
    target: Object.freeze({
      version: summary.version,
      releaseName: summary.releaseName,
      releaseNotes: summary.releaseNotes,
      releaseDate: summary.releaseDate,
      releaseUrl: summary.releaseUrl,
      downloadUrl: summary.installerUrl,
      sha256: sha256.toLowerCase()
    })
  });
}

export function buildGiteeReleaseHistoryCatalog(
  releases: readonly VerifiedGiteeRelease[],
  currentVersion: string
): ReleaseHistoryCatalog {
  const current = parseStableVersion(stripVersionPrefix(currentVersion));
  if (!current) {
    throw new Error(`当前版本不是稳定语义版本: ${currentVersion}`);
  }

  const releasesByVersion = new Map<string, { version: StableVersion; release: VerifiedGiteeRelease }>();
  for (const release of releases) {
    const version = parseStableVersion(release.version);
    if (!version || compareStableVersions(version, current) >= 0 || releasesByVersion.has(version.value)) {
      continue;
    }
    releasesByVersion.set(version.value, { version, release });
  }

  const selected = [...releasesByVersion.values()]
    .sort((left, right) => compareStableVersions(right.version, left.version))
    .slice(0, MAX_HISTORY_ENTRIES)
    .map(({ release }) => release);
  const entries: ReleaseHistoryItem[] = selected.map((release) => ({
    version: release.version,
    tagName: release.tagName,
    releaseName: release.target.releaseName,
    releaseNotes: release.target.releaseNotes,
    publishedAt: release.target.releaseDate,
    releaseUrl: release.releaseUrl,
    installerSize: release.installerSize
  }));
  const targets = new Map(selected.map((release) => [release.version, release.target]));
  return new ReleaseHistoryCatalog(entries, targets);
}

export function parseGiteeReleaseSummary(value: unknown): GiteeReleaseSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  const release = value as GiteeRelease;
  if (release.prerelease !== false || typeof release.tag_name !== "string") {
    return null;
  }
  const tagMatch = /^v(.+)$/.exec(release.tag_name);
  const version = tagMatch ? parseStableVersion(tagMatch[1]) : null;
  const releaseDate = normalizeDate(release.created_at);
  if (!version || !releaseDate || !Array.isArray(release.assets)) {
    return null;
  }

  const installerName = `Git-UI-Pro-Setup-${version.value}-x64.exe`;
  const installerPath = expectedDownloadPath(release.tag_name, installerName);
  const manifestPath = expectedDownloadPath(release.tag_name, UPDATE_MANIFEST_NAME);
  let installerUrl: string | null = null;
  let manifestUrl: string | null = null;
  for (const value of release.assets) {
    if (!isRecord(value)) {
      continue;
    }
    const asset = value as GiteeReleaseAsset;
    if (asset.name === installerName && typeof asset.browser_download_url === "string") {
      installerUrl = parseExactGiteeUrl(asset.browser_download_url, installerPath);
    }
    if (asset.name === UPDATE_MANIFEST_NAME && typeof asset.browser_download_url === "string") {
      manifestUrl = parseExactGiteeUrl(asset.browser_download_url, manifestPath);
    }
  }
  if (!installerUrl || !manifestUrl) {
    return null;
  }

  const releaseUrl = `https://gitee.com/${GITEE_RELEASE_OWNER}/${GITEE_RELEASE_REPOSITORY}/releases/tag/${release.tag_name}`;
  return Object.freeze({
    version: version.value,
    tagName: release.tag_name,
    releaseName: normalizeText(release.name) || `Git UI Pro v${version.value}`,
    releaseNotes: normalizeText(release.body).slice(0, MAX_RELEASE_NOTES_LENGTH),
    releaseDate,
    releaseUrl,
    installerName,
    installerUrl,
    manifestUrl
  });
}

function expectedDownloadPath(tagName: string, filename: string): string {
  return `/${GITEE_RELEASE_OWNER}/${GITEE_RELEASE_REPOSITORY}/releases/download/${tagName}/${filename}`;
}

function parseExactGiteeUrl(value: string, expectedPath: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "gitee.com" &&
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

function stripVersionPrefix(value: string): string {
  return value.startsWith("v") ? value.slice(1) : value;
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
