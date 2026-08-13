import { net } from "electron";
import { NsisUpdater } from "electron-updater";
import {
  buildForkReleaseHistoryCatalog,
  createForkRollbackUpdaterOptions,
  FORK_LATEST_RELEASE_URL,
  FORK_RELEASE_HISTORY_URL,
  FORK_RELEASE_OWNER,
  FORK_RELEASE_REPOSITORY,
  forkReleaseUrl,
  parseForkLatestRelease
} from "./forkUpdateSource";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RELEASE_RESPONSE_LENGTH = 5_000_000;

type RuntimeUpdateState = {
  phase: string;
  operation: string;
  currentVersion: string;
};

type RuntimeUpdateService = {
  getState(): RuntimeUpdateState;
  downloadUpdate(): Promise<RuntimeUpdateState>;
  [key: string]: any;
};

type UpdateServicePrototype = {
  checkForUpdates(this: RuntimeUpdateService): Promise<RuntimeUpdateState>;
  stop(this: RuntimeUpdateService): void;
  [key: string]: any;
};

installForkModuleOverrides();
const updateServiceModule = require("./updateService") as { UpdateService: { prototype: UpdateServicePrototype } };
installAutomaticUpdatePolicy(updateServiceModule.UpdateService.prototype);
require("./main");

function installForkModuleOverrides(): void {
  const releaseHistory = require("./releaseHistory") as Record<string, unknown>;
  releaseHistory.createRollbackUpdaterOptions = createForkRollbackUpdaterOptions;

  const updateUtils = require("./updateUtils") as Record<string, unknown>;
  updateUtils.githubReleaseUrl = forkReleaseUrl;
}

function installAutomaticUpdatePolicy(prototype: UpdateServicePrototype): void {
  prototype.fetchLatestStableRelease = async function (this: RuntimeUpdateService) {
    const rawRelease = await fetchGithubJson(FORK_LATEST_RELEASE_URL, "GitHub 最新正式版");
    const state = this.getState();
    return parseForkLatestRelease(rawRelease, Boolean(this.portable), state.currentVersion);
  };

  prototype.fetchReleaseHistory = async function (this: RuntimeUpdateService) {
    const rawReleases = await fetchGithubJson(FORK_RELEASE_HISTORY_URL, "GitHub 历史版本");
    const state = this.getState();
    const catalog = buildForkReleaseHistoryCatalog(rawReleases, state.currentVersion, Boolean(this.portable));
    return typeof this.cacheReleaseHistory === "function" ? this.cacheReleaseHistory(catalog) : catalog;
  };

  prototype.createUpgradeUpdater = function () {
    const updater = new NsisUpdater({
      provider: "github",
      owner: FORK_RELEASE_OWNER,
      repo: FORK_RELEASE_REPOSITORY,
      releaseType: "release"
    } as any);
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.fullChangelog = false;
    updater.disableWebInstaller = true;
    updater.disableDifferentialDownload = false;
    updater.logger = console;
    return updater;
  };

  const originalCheckForUpdates = prototype.checkForUpdates;
  prototype.checkForUpdates = function (this: RuntimeUpdateService): Promise<RuntimeUpdateState> {
    return originalCheckForUpdates.call(this).then(async (state) => {
      if (state.operation === "upgrade" && state.phase === "available") {
        return this.downloadUpdate();
      }
      return state;
    });
  };

  const originalStop = prototype.stop;
  prototype.stop = function (this: RuntimeUpdateService): void {
    const state = this.getState();
    const shouldKeepDownloadedInstaller = !this.portable &&
      state.operation === "upgrade" &&
      state.phase === "downloaded" &&
      Boolean(this.upgradeUpdater);

    if (!shouldKeepDownloadedInstaller) {
      originalStop.call(this);
      return;
    }

    const retainedUpdater = this.upgradeUpdater;
    const retainedCancellationToken = this.upgradeCancellationToken;
    this.upgradeUpdater = null;
    this.upgradeCancellationToken = null;
    try {
      originalStop.call(this);
    } finally {
      this.upgradeUpdater = retainedUpdater;
      this.upgradeCancellationToken = retainedCancellationToken;
    }
  };
}

async function fetchGithubJson(url: string, sourceLabel: string): Promise<unknown> {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set("update-check", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await net.fetch(requestUrl.toString(), {
      headers: {
        Accept: "application/vnd.github+json",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
        "User-Agent": "Git-UI-Pro-Fork",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`读取${sourceLabel}超时，请检查网络后重试。`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      throw new Error(`${sourceLabel}查询受限，请稍后重试。`);
    }
    throw new Error(`无法读取${sourceLabel}（HTTP ${response.status}）。`);
  }

  const rawText = await response.text();
  if (rawText.length > MAX_RELEASE_RESPONSE_LENGTH) {
    throw new Error(`${sourceLabel}返回的数据异常，已停止处理。`);
  }
  try {
    return JSON.parse(rawText);
  } catch {
    throw new Error(`${sourceLabel}返回的数据无法解析。`);
  }
}
