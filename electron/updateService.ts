import { app } from "electron";
import { autoUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";
import { githubReleaseUrl, normalizeReleaseNotes, updateErrorMessage } from "./updateUtils";

const INITIAL_CHECK_DELAY_MS = 8_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

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

export type UpdateProgress = {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
};

export type UpdateState = {
  phase: UpdatePhase;
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
  private readonly supported = process.platform === "win32" && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;

  constructor(private readonly onStateChange: (state: UpdateState) => void) {
    this.state = {
      phase: this.supported ? "idle" : "unsupported",
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
  }

  getState(): UpdateState {
    return cloneState(this.state);
  }

  async checkForUpdates(): Promise<UpdateState> {
    if (
      !this.supported ||
      this.state.phase === "checking" ||
      this.state.phase === "downloading" ||
      this.state.phase === "downloaded" ||
      this.state.phase === "installing"
    ) {
      return this.getState();
    }

    this.setState({ ...this.state, phase: "checking", error: undefined });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.setError(error);
    }
    return this.getState();
  }

  async downloadUpdate(): Promise<UpdateState> {
    if (!this.supported || !this.state.availableVersion || !["available", "error"].includes(this.state.phase)) {
      return this.getState();
    }

    this.setState({
      ...this.state,
      phase: "downloading",
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
      error: undefined
    });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.setError(error);
    }
    return this.getState();
  }

  installUpdate(): boolean {
    if (!this.supported || this.state.phase !== "downloaded") {
      return false;
    }

    this.setState({ ...this.state, phase: "installing", error: undefined });
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
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
      this.setState({ ...this.state, phase: "checking", error: undefined });
    });
    autoUpdater.on("update-available", (info) => {
      this.setState(this.stateFromInfo("available", info));
    });
    autoUpdater.on("update-not-available", (info) => {
      this.setState({
        phase: "up-to-date",
        currentVersion: this.state.currentVersion,
        availableVersion: info.version,
        releaseDate: info.releaseDate
      });
    });
    autoUpdater.on("download-progress", (progress) => {
      this.setState({ ...this.state, phase: "downloading", progress: normalizeProgress(progress), error: undefined });
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.setState({ ...this.stateFromInfo("downloaded", info), progress: this.state.progress });
    });
    autoUpdater.on("update-cancelled", () => {
      this.setError(new Error("更新下载已取消"));
    });
    autoUpdater.on("error", (error) => this.setError(error));
  }

  private stateFromInfo(phase: "available" | "downloaded", info: UpdateInfo): UpdateState {
    return {
      phase,
      currentVersion: this.state.currentVersion,
      availableVersion: info.version,
      releaseName: info.releaseName?.trim() || `Git UI Pro v${info.version}`,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      releaseDate: info.releaseDate,
      releaseUrl: githubReleaseUrl(info.version)
    };
  }

  private setError(error: unknown): void {
    this.setState({ ...this.state, phase: "error", error: updateErrorMessage(error) });
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
