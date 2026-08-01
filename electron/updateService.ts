import { app, net } from "electron";
import { autoUpdater, NsisUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";
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
const MAX_RELEASE_HISTORY_RESPONSE_LENGTH = 5_000_000;
const RELEASE_HISTORY_REQUEST_TIMEOUT_MS = 20_000;

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

export class UpdateService {
  private state: UpdateState;
  private started = false;
  private initialCheckTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private rollbackUpdater: NsisUpdater | null = null;
  private rollbackCancellationToken: CancellationToken | null = null;
  private rollbackGeneration = 0;
  private releaseHistoryCatalog: ReleaseHistoryCatalog | null = null;
  private releaseHistoryFetchedAt = 0;
  private releaseHistoryRequest: Promise<ReleaseHistoryCatalog> | null = null;
  private readonly supported = process.platform === "win32" && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;

  constructor(private readonly onStateChange: (state: UpdateState) => void) {
    this.state = {
      phase: this.supported ? "idle" : "unsupported",
      operation: "upgrade",
      currentVersion: app.getVersion()
    };

    if (this.supported) {
      this.configureUpdater();
    }
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
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.setError(error, "upgrade");
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
    if (!this.supported || !this.state.availableVersion || !["available", "error"].includes(this.state.phase)) {
      return this.getState();
    }

    const updater = this.state.operation === "rollback" ? this.rollbackUpdater : autoUpdater;
    if (!updater) {
      this.setError(new Error("回退版本尚未通过校验，请重新选择该版本。"), "rollback");
      return this.getState();
    }
    const operation = this.state.operation;
    const cancellationToken = operation === "rollback" ? this.rollbackCancellationToken ?? undefined : undefined;

    this.setState({
      ...this.state,
      phase: "downloading",
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
      error: undefined
    });
    void updater.downloadUpdate(cancellationToken).catch((error) => {
      if (operation === "rollback" && this.rollbackUpdater !== updater) {
        return;
      }
      this.setError(error, operation);
    });
    return this.getState();
  }

  installUpdate(): boolean {
    if (!this.supported || this.state.phase !== "downloaded") {
      return false;
    }

    const updater = this.state.operation === "rollback" ? this.rollbackUpdater : autoUpdater;
    if (!updater) {
      this.setError(new Error("回退安装包已失效，请重新下载。"), "rollback");
      return false;
    }

    this.setState({ ...this.state, phase: "installing", error: undefined });
    setImmediate(() => updater.quitAndInstall(false, true));
    return true;
  }

  private configureUpdater(): void {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.fullChangelog = false;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.logger = console;

    autoUpdater.on("checking-for-update", () => {
      if (!this.rollbackUpdater) {
        this.setState({ phase: "checking", operation: "upgrade", currentVersion: this.state.currentVersion });
      }
    });
    autoUpdater.on("update-available", (info) => {
      if (!this.rollbackUpdater) {
        this.setState(this.stateFromInfo("available", info, "upgrade"));
      }
    });
    autoUpdater.on("update-not-available", (info) => {
      if (!this.rollbackUpdater) {
        this.setState({
          phase: "up-to-date",
          operation: "upgrade",
          currentVersion: this.state.currentVersion,
          availableVersion: info.version,
          releaseDate: info.releaseDate,
          releaseUrl: githubReleaseUrl(info.version)
        });
      }
    });
    autoUpdater.on("download-progress", (progress) => {
      if (!this.rollbackUpdater) {
        this.setState({ ...this.state, phase: "downloading", progress: normalizeProgress(progress), error: undefined });
      }
    });
    autoUpdater.on("update-downloaded", (info) => {
      if (!this.rollbackUpdater) {
        this.setState({ ...this.stateFromInfo("downloaded", info, "upgrade"), progress: this.state.progress });
      }
    });
    autoUpdater.on("update-cancelled", () => {
      if (!this.rollbackUpdater) {
        this.setError(new Error("更新下载已取消"), "upgrade");
      }
    });
    autoUpdater.on("error", (error) => {
      if (!this.rollbackUpdater) {
        this.setError(error, "upgrade");
      }
    });
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

  private stateFromInfo(phase: "available" | "downloaded", info: UpdateInfo, operation: UpdateOperation): UpdateState {
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

  private setState(state: UpdateState): void {
    this.state = state;
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
