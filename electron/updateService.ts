import { app, net } from "electron";
import { NsisUpdater, type ProgressInfo, type UpdateCheckResult, type UpdateInfo } from "electron-updater";
import type { CancellationToken } from "builder-util-runtime";
import {
  buildReleaseHistoryCatalog,
  createRollbackUpdaterOptions,
  ReleaseHistoryCatalog,
  type ReleaseHistoryItem,
  type RollbackTarget
} from "./releaseHistory";
import { githubReleaseUrl, normalizeReleaseNotes, updateErrorMessage } from "./updateUtils";

const INITIAL_CHECK_DELAY_MS = 8_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const RELEASE_HISTORY_CACHE_MS = 15 * 60 * 1_000;
const RELEASE_HISTORY_URL = "https://api.github.com/repos/zjx150504-lgtm/Git_UI_Pro/releases?per_page=20";
const LATEST_RELEASE_URL = "https://api.github.com/repos/zjx150504-lgtm/Git_UI_Pro/releases/latest";
const MAX_RELEASE_HISTORY_RESPONSE_LENGTH = 5_000_000;
const RELEASE_HISTORY_REQUEST_TIMEOUT_MS = 20_000;
const SHA256_DIGEST_PATTERN = /^sha256:([a-f\d]{64})$/i;

export type UpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export type UpdateOperation = "upgrade" | "rollback";

export type UpdateProgress = {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
};

export type UpdateState = {
  revision: number;
  phase: UpdatePhase;
  operation: UpdateOperation;
  currentVersion: string;
  availableVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseDate?: string;
  releaseUrl?: string;
  progress?: UpdateProgress;
  error?: string;
};

type UpdateStateInput = Omit<UpdateState, "revision"> & { revision?: number };

type UpgradeDownloadUpdater = {
  checkForUpdates: () => Promise<UpdateCheckResult | null>;
  downloadUpdate: (cancellationToken?: CancellationToken) => Promise<string[]>;
};

export type LatestStableRelease = {
  version: string;
  tagName: string;
  target: RollbackTarget;
};

export type FreshUpgradeDownload = {
  info: UpdateInfo;
  downloadPromise: Promise<string[]> | null;
  cancellationToken: CancellationToken | null;
};

export async function resolveFreshUpgradeCheck(
  updater: Pick<UpgradeDownloadUpdater, "checkForUpdates">,
  loadLatestRelease: () => Promise<LatestStableRelease>
): Promise<UpdateCheckResult> {
  const latestRelease = await loadLatestRelease();
  const result = await updater.checkForUpdates();
  if (!result) {
    throw new Error("更新检查未返回结果，操作已停止。");
  }

  const updaterVersion = normalizeStableVersion(result.updateInfo.version);
  if (updaterVersion !== latestRelease.version) {
    throw new Error(
      `GitHub 最新正式版为 v${latestRelease.version}，但更新元数据仍为 v${updaterVersion ?? result.updateInfo.version}，操作已停止。`
    );
  }
  return result;
}

export async function startFreshUpgradeDownload(
  updater: UpgradeDownloadUpdater,
  loadLatestRelease: () => Promise<LatestStableRelease>,
  onCandidate: (info: UpdateInfo) => void
): Promise<FreshUpgradeDownload> {
  const result = await resolveFreshUpgradeCheck(updater, loadLatestRelease);
  if (!result.isUpdateAvailable) {
    return { info: result.updateInfo, downloadPromise: null, cancellationToken: null };
  }

  onCandidate(result.updateInfo);
  return {
    info: result.updateInfo,
    downloadPromise: updater.downloadUpdate(result.cancellationToken),
    cancellationToken: result.cancellationToken ?? null
  };
}

export function parseLatestStableGithubRelease(value: unknown): LatestStableRelease {
  if (!value || typeof value !== "object") {
    throw new Error("GitHub 最新正式版数据格式无效。");
  }

  const release = value as {
    tag_name?: unknown;
    name?: unknown;
    body?: unknown;
    published_at?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    assets?: unknown;
  };
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string") {
    throw new Error("GitHub latest 不是可用的正式版本。");
  }

  const version = normalizeStableVersion(release.tag_name);
  if (!version || release.tag_name !== `v${version}`) {
    throw new Error("GitHub latest 标签不是标准正式版本号。");
  }
  if (!Array.isArray(release.assets)) {
    throw new Error(`GitHub v${version} 缺少正式版安装资产。`);
  }

  const installerName = `Git-UI-Pro-Setup-${version}-x64.exe`;
  const expectedInstallerPath = `/zjx150504-lgtm/Git_UI_Pro/releases/download/${release.tag_name}/${installerName}`;
  let latestMetadataReady = false;
  let installerTarget: { downloadUrl: string; sha256: string } | null = null;
  for (const value of release.assets) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const asset = value as {
      name?: unknown;
      state?: unknown;
      size?: unknown;
      digest?: unknown;
      browser_download_url?: unknown;
    };
    const uploaded = asset.state === "uploaded" &&
      typeof asset.size === "number" &&
      Number.isSafeInteger(asset.size) &&
      asset.size > 0;
    if (!uploaded) {
      continue;
    }
    if (asset.name === "latest.yml") {
      latestMetadataReady = true;
      continue;
    }
    if (asset.name !== installerName || typeof asset.digest !== "string" || typeof asset.browser_download_url !== "string") {
      continue;
    }
    const digestMatch = SHA256_DIGEST_PATTERN.exec(asset.digest);
    const downloadUrl = parseExactGithubDownloadUrl(asset.browser_download_url, expectedInstallerPath);
    if (digestMatch && downloadUrl) {
      installerTarget = { downloadUrl, sha256: digestMatch[1].toLowerCase() };
    }
  }
  if (!latestMetadataReady || !installerTarget) {
    throw new Error(`GitHub v${version} 的 Windows 正式版资产尚未就绪。`);
  }

  if (typeof release.published_at !== "string") {
    throw new Error(`GitHub v${version} 缺少有效发布时间。`);
  }
  const publishedAt = new Date(release.published_at);
  if (Number.isNaN(publishedAt.getTime())) {
    throw new Error(`GitHub v${version} 的发布时间无效。`);
  }
  const releaseName = typeof release.name === "string" && release.name.trim()
    ? release.name.trim()
    : `Git UI Pro v${version}`;
  const releaseNotes = normalizeReleaseNotes(typeof release.body === "string" ? release.body : "");
  return {
    version,
    tagName: release.tag_name,
    target: {
      version,
      releaseName,
      releaseNotes,
      releaseDate: publishedAt.toISOString(),
      downloadUrl: installerTarget.downloadUrl,
      sha256: installerTarget.sha256
    }
  };
}

function parseExactGithubDownloadUrl(value: string, expectedPath: string): string | null {
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

export class UpdateService {
  private state: UpdateState;
  private started = false;
  private initialCheckTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private upgradeUpdater: NsisUpdater | null = null;
  private upgradeCancellationToken: CancellationToken | null = null;
  private upgradeGeneration = 0;
  private rollbackUpdater: NsisUpdater | null = null;
  private rollbackCancellationToken: CancellationToken | null = null;
  private rollbackGeneration = 0;
  private releaseHistoryCatalog: ReleaseHistoryCatalog | null = null;
  private releaseHistoryFetchedAt = 0;
  private releaseHistoryRequest: Promise<ReleaseHistoryCatalog> | null = null;
  private latestReleaseRequestSeed = 0;
  private readonly supported = process.platform === "win32" && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;

  constructor(private readonly onStateChange: (state: UpdateState) => void) {
    this.state = {
      revision: 0,
      phase: this.supported ? "idle" : "unsupported",
      operation: "upgrade",
      currentVersion: app.getVersion()
    };
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.emit();
    if (!this.supported) {
      return;
    }

    this.initialCheckTimer = setTimeout(() => void this.checkForUpdates(), INITIAL_CHECK_DELAY_MS);
    this.initialCheckTimer.unref();
    this.intervalTimer = setInterval(() => void this.checkForUpdates(), CHECK_INTERVAL_MS);
    this.intervalTimer.unref();
  }

  stop(): void {
    if (this.initialCheckTimer) {
      clearTimeout(this.initialCheckTimer);
      this.initialCheckTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.disposeUpgradeUpdater();
    this.rollbackCancellationToken?.cancel();
    this.rollbackCancellationToken = null;
  }

  getState(): UpdateState {
    return cloneState(this.state);
  }

  async getReleaseHistory(force = false): Promise<ReleaseHistoryItem[]> {
    if (!this.supported) {
      return [];
    }

    const catalog = await this.loadReleaseHistory(force);
    return catalog.entries.map((entry) => ({ ...entry }));
  }

  async checkForUpdates(): Promise<UpdateState> {
    if (
      !this.supported ||
      this.state.operation === "rollback" ||
      this.state.phase === "checking" ||
      this.state.phase === "downloading" ||
      this.state.phase === "downloaded" ||
      this.state.phase === "installing"
    ) {
      return this.getState();
    }

    this.setState({
      phase: "checking",
      operation: "upgrade",
      currentVersion: this.state.currentVersion
    });
    let checkUpdater: NsisUpdater | null = null;
    try {
      const latestRelease = await this.fetchLatestStableRelease();
      checkUpdater = this.createUpgradeUpdater(latestRelease.target);
      const result = await resolveFreshUpgradeCheck(checkUpdater, async () => latestRelease);
      if (result.isUpdateAvailable) {
        this.setState(this.stateFromInfo("available", result.updateInfo, "upgrade"));
      } else {
        this.setState({
          phase: "up-to-date",
          operation: "upgrade",
          currentVersion: this.state.currentVersion,
          availableVersion: result.updateInfo.version,
          releaseDate: result.updateInfo.releaseDate,
          releaseUrl: githubReleaseUrl(result.updateInfo.version)
        });
      }
    } catch (error) {
      this.setError(error, "upgrade");
    } finally {
      checkUpdater?.removeAllListeners();
    }
    return this.getState();
  }

  async prepareRollback(version: string): Promise<UpdateState> {
    if (!this.supported) {
      return this.getState();
    }
    if (["checking", "downloading", "downloaded", "installing"].includes(this.state.phase)) {
      throw new Error("当前更新操作尚未结束，请稍后再选择回退版本。");
    }

    const catalog = await this.loadReleaseHistory(false);
    const target = catalog.resolveTarget(version);
    if (!target) {
      throw new Error("所选版本不再可用，请刷新历史版本后重试。");
    }

    this.disposeRollbackUpdater();
    const updater = this.createRollbackUpdater(target);
    const generation = ++this.rollbackGeneration;
    this.rollbackUpdater = updater;
    this.bindRollbackUpdater(updater, generation);
    this.setState({
      phase: "checking",
      operation: "rollback",
      currentVersion: this.state.currentVersion,
      availableVersion: target.version,
      releaseName: target.releaseName,
      releaseNotes: target.releaseNotes,
      releaseDate: target.releaseDate,
      releaseUrl: githubReleaseUrl(target.version)
    });

    try {
      const result = await updater.checkForUpdates();
      if (this.rollbackUpdater !== updater || generation !== this.rollbackGeneration) {
        return this.getState();
      }
      if (!result?.isUpdateAvailable || result.updateInfo.version !== target.version) {
        throw new Error("无法确认所选回退版本，操作已停止。");
      }
      this.rollbackCancellationToken = result.cancellationToken ?? null;
    } catch (error) {
      if (this.rollbackUpdater === updater && generation === this.rollbackGeneration) {
        this.disposeRollbackUpdater();
        this.setState({
          phase: "error",
          operation: "rollback",
          currentVersion: this.state.currentVersion,
          availableVersion: target.version,
          releaseName: target.releaseName,
          releaseNotes: target.releaseNotes,
          releaseDate: target.releaseDate,
          releaseUrl: githubReleaseUrl(target.version),
          error: updateErrorMessage(error)
        });
      }
    }

    return this.getState();
  }

  cancelRollback(): UpdateState {
    if (this.state.operation !== "rollback" || this.state.phase === "installing") {
      return this.getState();
    }

    this.disposeRollbackUpdater();
    this.setState({
      phase: this.supported ? "idle" : "unsupported",
      operation: "upgrade",
      currentVersion: this.state.currentVersion
    });
    return this.getState();
  }

  async downloadUpdate(): Promise<UpdateState> {
    if (!this.supported || !["available", "error"].includes(this.state.phase)) {
      return this.getState();
    }

    if (this.state.operation === "upgrade") {
      return this.downloadLatestUpgrade();
    }

    if (!this.state.availableVersion || !this.rollbackUpdater) {
      this.setError(new Error("回退版本尚未通过校验，请重新选择该版本。"), "rollback");
      return this.getState();
    }

    this.setState({
      ...this.state,
      phase: "downloading",
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
      error: undefined
    });
    const updater = this.rollbackUpdater;
    void updater.downloadUpdate(this.rollbackCancellationToken ?? undefined).catch((error) => {
      if (this.rollbackUpdater !== updater) {
        return;
      }
      this.setError(error, "rollback");
    });
    return this.getState();
  }

  installUpdate(): boolean {
    if (!this.supported || this.state.phase !== "downloaded") {
      return false;
    }

    const updater = this.state.operation === "rollback" ? this.rollbackUpdater : this.upgradeUpdater;
    if (!updater) {
      const operation = this.state.operation;
      const packageName = operation === "rollback" ? "回退安装包" : "更新安装包";
      this.setError(new Error(`${packageName}已失效，请重新下载。`), operation);
      return false;
    }

    this.setState({ ...this.state, phase: "installing", error: undefined });
    setImmediate(() => updater.quitAndInstall(false, true));
    return true;
  }

  private createUpgradeUpdater(target: RollbackTarget): NsisUpdater {
    const updater = new NsisUpdater(createRollbackUpdaterOptions(target) as any);
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.fullChangelog = false;
    updater.disableWebInstaller = true;
    updater.disableDifferentialDownload = true;
    updater.logger = console;
    return updater;
  }

  private bindUpgradeUpdater(updater: NsisUpdater, generation: number): void {
    const isActive = () => this.upgradeUpdater === updater && this.upgradeGeneration === generation;
    updater.on("download-progress", (progress) => {
      if (isActive()) {
        this.setState({ ...this.state, phase: "downloading", progress: normalizeProgress(progress), error: undefined });
      }
    });
    updater.on("update-downloaded", (info) => {
      if (isActive()) {
        this.setState({ ...this.stateFromInfo("downloaded", info, "upgrade"), progress: this.state.progress });
      }
    });
    updater.on("update-cancelled", () => {
      if (isActive()) {
        this.setError(new Error("更新下载已取消"), "upgrade");
      }
    });
    updater.on("error", (error) => {
      if (isActive()) {
        this.setError(error, "upgrade");
      }
    });
  }

  private async downloadLatestUpgrade(): Promise<UpdateState> {
    this.setState({
      phase: "checking",
      operation: "upgrade",
      currentVersion: this.state.currentVersion
    });

    try {
      this.disposeUpgradeUpdater();
      const latestRelease = await this.fetchLatestStableRelease();
      const updater = this.createUpgradeUpdater(latestRelease.target);
      const generation = ++this.upgradeGeneration;
      this.upgradeUpdater = updater;
      this.bindUpgradeUpdater(updater, generation);
      const freshDownload = await startFreshUpgradeDownload(
        updater,
        async () => latestRelease,
        (info) => {
          this.setState({
            ...this.stateFromInfo("available", info, "upgrade"),
            phase: "downloading",
            progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
            error: undefined
          });
        }
      );
      this.upgradeCancellationToken = freshDownload.cancellationToken;
      if (!freshDownload.downloadPromise) {
        this.disposeUpgradeUpdater();
        this.setState({
          phase: "up-to-date",
          operation: "upgrade",
          currentVersion: this.state.currentVersion,
          availableVersion: freshDownload.info.version,
          releaseDate: freshDownload.info.releaseDate,
          releaseUrl: githubReleaseUrl(freshDownload.info.version)
        });
        return this.getState();
      }

      void freshDownload.downloadPromise.catch((error) => {
        if (this.upgradeUpdater === updater && this.upgradeGeneration === generation) {
          this.setError(error, "upgrade");
        }
      });
    } catch (error) {
      this.disposeUpgradeUpdater();
      this.setError(error, "upgrade");
    }
    return this.getState();
  }

  private createRollbackUpdater(target: RollbackTarget): NsisUpdater {
    const updater = new NsisUpdater(createRollbackUpdaterOptions(target) as any);
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = true;
    updater.fullChangelog = false;
    updater.disableWebInstaller = true;
    updater.disableDifferentialDownload = true;
    updater.logger = console;
    return updater;
  }

  private bindRollbackUpdater(updater: NsisUpdater, generation: number): void {
    const isActive = () => this.rollbackUpdater === updater && this.rollbackGeneration === generation;
    updater.on("checking-for-update", () => {
      if (isActive()) {
        this.setState({ ...this.state, phase: "checking", operation: "rollback", error: undefined });
      }
    });
    updater.on("update-available", (info) => {
      if (isActive()) {
        this.setState(this.stateFromInfo("available", info, "rollback"));
      }
    });
    updater.on("update-not-available", () => {
      if (isActive()) {
        this.setError(new Error("所选版本无法用于回退。"), "rollback");
      }
    });
    updater.on("download-progress", (progress) => {
      if (isActive()) {
        this.setState({ ...this.state, phase: "downloading", operation: "rollback", progress: normalizeProgress(progress), error: undefined });
      }
    });
    updater.on("update-downloaded", (info) => {
      if (isActive()) {
        this.setState({ ...this.stateFromInfo("downloaded", info, "rollback"), progress: this.state.progress });
      }
    });
    updater.on("update-cancelled", () => {
      if (isActive()) {
        this.setError(new Error("回退安装包下载已取消。"), "rollback");
      }
    });
    updater.on("error", (error) => {
      if (isActive()) {
        this.setError(error, "rollback");
      }
    });
  }

  private disposeUpgradeUpdater(): void {
    this.upgradeGeneration += 1;
    this.upgradeCancellationToken?.cancel();
    this.upgradeCancellationToken = null;
    this.upgradeUpdater?.removeAllListeners();
    this.upgradeUpdater = null;
  }

  private disposeRollbackUpdater(): void {
    this.rollbackGeneration += 1;
    this.rollbackCancellationToken?.cancel();
    this.rollbackCancellationToken = null;
    this.rollbackUpdater?.removeAllListeners();
    this.rollbackUpdater = null;
  }

  private async loadReleaseHistory(force: boolean): Promise<ReleaseHistoryCatalog> {
    if (!force && this.releaseHistoryCatalog && Date.now() - this.releaseHistoryFetchedAt < RELEASE_HISTORY_CACHE_MS) {
      return this.releaseHistoryCatalog;
    }
    if (this.releaseHistoryRequest) {
      return this.releaseHistoryRequest;
    }

    const request = this.fetchReleaseHistory().finally(() => {
      if (this.releaseHistoryRequest === request) {
        this.releaseHistoryRequest = null;
      }
    });
    this.releaseHistoryRequest = request;
    return request;
  }

  private async fetchLatestStableRelease(): Promise<LatestStableRelease> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RELEASE_HISTORY_REQUEST_TIMEOUT_MS);
    const requestUrl = new URL(LATEST_RELEASE_URL);
    requestUrl.searchParams.set("update-check", `${Date.now()}-${++this.latestReleaseRequestSeed}`);

    let response: Response;
    try {
      response = await net.fetch(requestUrl.toString(), {
        headers: {
          Accept: "application/vnd.github+json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
          "User-Agent": `Git-UI-Pro/${this.state.currentVersion}`,
          "X-GitHub-Api-Version": "2022-11-28"
        },
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("读取 GitHub 最新正式版超时，请检查网络后重试。");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        throw new Error("GitHub 最新正式版查询受限，请稍后重试。");
      }
      throw new Error(`无法读取 GitHub 最新正式版（HTTP ${response.status}）。`);
    }

    const rawText = await response.text();
    if (rawText.length > MAX_RELEASE_HISTORY_RESPONSE_LENGTH) {
      throw new Error("GitHub 返回的最新正式版数据异常，已停止处理。");
    }

    let rawRelease: unknown;
    try {
      rawRelease = JSON.parse(rawText);
    } catch {
      throw new Error("GitHub 返回的最新正式版数据无法解析。");
    }
    return parseLatestStableGithubRelease(rawRelease);
  }

  private async fetchReleaseHistory(): Promise<ReleaseHistoryCatalog> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RELEASE_HISTORY_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await net.fetch(RELEASE_HISTORY_URL, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `Git-UI-Pro/${this.state.currentVersion}`,
          "X-GitHub-Api-Version": "2022-11-28"
        },
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("读取 GitHub 历史版本超时，请检查网络后重试。");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        throw new Error("GitHub 查询过于频繁，请稍后再刷新历史版本。");
      }
      throw new Error(`无法读取 GitHub 历史版本（HTTP ${response.status}）。`);
    }

    const rawText = await response.text();
    if (rawText.length > MAX_RELEASE_HISTORY_RESPONSE_LENGTH) {
      throw new Error("GitHub 返回的历史版本数据异常，已停止处理。");
    }

    let rawReleases: unknown;
    try {
      rawReleases = JSON.parse(rawText);
    } catch {
      throw new Error("GitHub 返回的历史版本数据无法解析。");
    }

    const catalog = buildReleaseHistoryCatalog(rawReleases, this.state.currentVersion);
    this.releaseHistoryCatalog = catalog;
    this.releaseHistoryFetchedAt = Date.now();
    return catalog;
  }

  private stateFromInfo(phase: "available" | "downloaded", info: UpdateInfo, operation: UpdateOperation): UpdateStateInput {
    return {
      phase,
      operation,
      currentVersion: this.state.currentVersion,
      availableVersion: info.version,
      releaseName: info.releaseName?.trim() || `Git UI Pro v${info.version}`,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      releaseDate: info.releaseDate,
      releaseUrl: githubReleaseUrl(info.version)
    };
  }

  private setError(error: unknown, operation: UpdateOperation): void {
    this.setState({ ...this.state, operation, phase: "error", error: updateErrorMessage(error) });
  }

  private setState(state: UpdateStateInput): void {
    this.state = { ...state, revision: this.state.revision + 1 };
    this.emit();
  }

  private emit(): void {
    this.onStateChange(this.getState());
  }
}

function normalizeProgress(progress: ProgressInfo): UpdateProgress {
  return {
    percent: Math.max(0, Math.min(100, progress.percent)),
    transferred: Math.max(0, progress.transferred),
    total: Math.max(0, progress.total),
    bytesPerSecond: Math.max(0, progress.bytesPerSecond)
  };
}

function cloneState(state: UpdateState): UpdateState {
  return {
    ...state,
    progress: state.progress ? { ...state.progress } : undefined
  };
}

function normalizeStableVersion(value: string): string | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value.trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}
