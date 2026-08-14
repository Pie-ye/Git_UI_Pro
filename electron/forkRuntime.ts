import { app, ipcMain, net, session } from "electron";
import path from "node:path";
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
import { registerTrellisIpc } from "./trellis/ipc";

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
  [key: string]: any;
};

recordSmokeStep("entry");
installSmokeDiagnostics();
recordSmokeStep("diagnostics-installed");
installForkModuleOverrides();
recordSmokeStep("fork-overrides-installed");
installTrellisRuntime();
recordSmokeStep("trellis-runtime-installed");
recordSmokeStep("before-update-service-require");
const updateServiceModule = require("./updateService") as { UpdateService: { prototype: UpdateServicePrototype } };
recordSmokeStep("after-update-service-require");
installAutomaticUpdatePolicy(updateServiceModule.UpdateService.prototype);
recordSmokeStep("update-policy-installed");
recordSmokeStep("before-main-require");
require("./main");
recordSmokeStep("after-main-require");

function recordSmokeStep(step: string): void {
  if (process.env.GIT_UI_PRO_ELECTRON_SMOKE !== "1") {
    return;
  }
  const globalRecord = globalThis as typeof globalThis & { __GIT_UI_PRO_SMOKE_STEPS?: string[] };
  const steps = globalRecord.__GIT_UI_PRO_SMOKE_STEPS ?? [];
  steps.push(step);
  globalRecord.__GIT_UI_PRO_SMOKE_STEPS = steps;
  console.log(`[smoke startup] step=${step}`);
}

function installSmokeDiagnostics(): void {
  if (process.env.GIT_UI_PRO_ELECTRON_SMOKE !== "1") {
    return;
  }

  const errorText = (value: unknown) => value instanceof Error ? value.stack ?? value.message : String(value);
  const originalWhenReady = app.whenReady.bind(app);
  const originalRequestSingleInstanceLock = app.requestSingleInstanceLock.bind(app);
  const originalIpcHandle = ipcMain.handle.bind(ipcMain);
  let whenReadyCalls = 0;
  let ipcRegistrations = 0;

  (app as typeof app & { whenReady: typeof app.whenReady }).whenReady = () => {
    whenReadyCalls += 1;
    console.log(`[smoke startup] whenReady requested #${whenReadyCalls}`);
    return originalWhenReady();
  };
  (app as typeof app & { requestSingleInstanceLock: typeof app.requestSingleInstanceLock }).requestSingleInstanceLock = (...args: Parameters<typeof app.requestSingleInstanceLock>) => {
    const result = originalRequestSingleInstanceLock(...args);
    console.log(`[smoke startup] requestSingleInstanceLock=${result}`);
    return result;
  };
  ipcMain.handle = ((channel: string, listener: Parameters<typeof ipcMain.handle>[1]) => {
    ipcRegistrations += 1;
    if (ipcRegistrations <= 12 || channel.startsWith("app:") || channel.startsWith("projects:")) {
      console.log(`[smoke startup] ipc handle #${ipcRegistrations} ${channel}`);
    }
    return originalIpcHandle(channel, listener);
  }) as typeof ipcMain.handle;

  process.on("unhandledRejection", (reason) => {
    console.error(`[smoke startup] unhandledRejection: ${errorText(reason)}`);
  });
  process.on("uncaughtException", (error) => {
    console.error(`[smoke startup] uncaughtException: ${errorText(error)}`);
  });
  app.on("browser-window-created", (_event, window) => {
    console.log(`[smoke startup] browser-window-created id=${window.id}`);
  });
  app.on("will-quit", () => {
    console.log("[smoke startup] will-quit");
  });
  void app.whenReady().then(() => {
    console.log(`[smoke startup] ready userData=${app.getPath("userData")} whenReadyCalls=${whenReadyCalls} ipcRegistrations=${ipcRegistrations}`);
    setTimeout(() => {
      console.log(`[smoke startup] ready+1000ms whenReadyCalls=${whenReadyCalls} ipcRegistrations=${ipcRegistrations}`);
    }, 1_000);
  });
}

function installForkModuleOverrides(): void {
  const releaseHistory = require("./releaseHistory") as Record<string, unknown>;
  releaseHistory.createRollbackUpdaterOptions = createForkRollbackUpdaterOptions;

  const updateUtils = require("./updateUtils") as Record<string, unknown>;
  updateUtils.githubReleaseUrl = forkReleaseUrl;
}

function installTrellisRuntime(): void {
  registerTrellisIpc();
  void app.whenReady().then(() => {
    const trellisPreloadPath = path.join(__dirname, "trellis", "preload.js");
    const currentPreloads = session.defaultSession.getPreloads();
    if (!currentPreloads.includes(trellisPreloadPath)) {
      session.defaultSession.setPreloads([...currentPreloads, trellisPreloadPath]);
    }
  });
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
