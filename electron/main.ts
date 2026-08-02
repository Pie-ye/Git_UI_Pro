import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, type WebContents } from "electron";
import path from "node:path";
import { existsSync } from "node:fs";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import { ConfigStore, type RemoteProjectInput, type UiPreferences } from "./configStore";
import { buildSshArgs, GitService, normalizeRepositoryTarget, shellQuote, sshDestination, type ChangedFile, type GitPullStrategy, type RepositoryLocation } from "./gitService";
import { UpdateService, type UpdateState } from "./updateService";

let mainWindow: BrowserWindow | null = null;
let configStore: ConfigStore;
let updateService: UpdateService;
const gitService = new GitService();
const terminalSessions = new Map<string, TerminalSession>();
let terminalSessionSeed = 0;
let verifiedRemoteProject: { fingerprint: string; repositoryRoot: string; expiresAt: number } | null = null;

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
type AppThemeSource = "system" | "light" | "dark";
type WindowState = {
  isMaximized: boolean;
  isFullScreen: boolean;
};
type TerminalSession = {
  process: pty.IPty;
  webContents: WebContents;
};

// Avoid packaged Windows installs exiting when Chromium's GPU sandbox cannot start.
app.commandLine.appendSwitch("disable-gpu-sandbox");

const hasSingleInstanceLock = app.requestSingleInstanceLock();

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 860,
    minHeight: 640,
    frame: false,
    backgroundColor: "#101317",
    title: "Git UI Pro",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Some Windows custom install paths fail to start Electron's renderer sandbox.
      sandbox: false
    }
  });
  registerWindowStateEvents(mainWindow);

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle("app:command", (_event, command: string) => {
    runAppCommand(command);
    return true;
  });

  ipcMain.handle("app:openExternal", async (_event, url: string) => {
    const target = new URL(url);
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      return false;
    }

    await shell.openExternal(target.toString());
    return true;
  });

  ipcMain.handle("theme:setNative", (_event, themeSource: AppThemeSource) => {
    applyNativeTheme(themeSource);
    return true;
  });

  ipcMain.handle("window:getState", () => getWindowState());
  ipcMain.handle("update:getState", () => updateService.getState());
  ipcMain.handle("update:listReleases", (_event, force: boolean | undefined) => updateService.getReleaseHistory(Boolean(force)));
  ipcMain.handle("update:check", () => updateService.checkForUpdates());
  ipcMain.handle("update:prepareRollback", (_event, version: string) => updateService.prepareRollback(version));
  ipcMain.handle("update:cancelRollback", () => updateService.cancelRollback());
  ipcMain.handle("update:download", () => updateService.downloadUpdate());
  ipcMain.handle("update:install", () => updateService.installUpdate());
  ipcMain.handle("terminal:start", (event, repositoryPath: RepositoryLocation) => startTerminalSession(event.sender, repositoryPath));
  ipcMain.handle("terminal:write", (_event, sessionId: string, data: string) => writeTerminalSession(sessionId, data));
  ipcMain.handle("terminal:resize", (_event, sessionId: string, cols: number, rows: number) => resizeTerminalSession(sessionId, cols, rows));
  ipcMain.handle("terminal:dispose", (_event, sessionId: string) => disposeTerminalSession(sessionId));

  ipcMain.handle("git:getVersion", () => gitService.getVersion());

  ipcMain.handle("dialog:chooseDirectory", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory"],
      title: "选择 Git 项目目录"
    });

    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("dialog:chooseIdentityFile", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openFile"],
      title: "选择 SSH 私钥"
    });

    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("projects:list", () => configStore.listProjects());
  ipcMain.handle("projects:getLibrary", () => configStore.getProjectLibrary());
  ipcMain.handle("projects:createGroup", (_event, name: string) => configStore.createProjectGroup(name));
  ipcMain.handle("projects:renameGroup", (_event, groupId: string, name: string) => configStore.renameProjectGroup(groupId, name));
  ipcMain.handle("projects:deleteGroup", async (_event, groupId: string) => {
    await configStore.deleteProjectGroup(groupId);
    return true;
  });
  ipcMain.handle("projects:setGroup", (_event, projectId: string, groupId?: string) => configStore.setProjectGroup(projectId, groupId));
  ipcMain.handle("projects:markOpened", (_event, projectId: string) => configStore.markProjectOpened(projectId));
  ipcMain.handle("projects:removeRecent", async (_event, projectId: string) => {
    await configStore.removeRecentProject(projectId);
    return true;
  });
  ipcMain.handle("preferences:get", () => configStore.getUiPreferences());
  ipcMain.handle("preferences:update", (_event, input: Partial<UiPreferences>) => configStore.updateUiPreferences(input));

  ipcMain.handle("projects:add", async (_event, directoryPath: string) => {
    const repositoryRoot = await gitService.getRepositoryRoot(directoryPath);
    return configStore.addProject(repositoryRoot);
  });

  ipcMain.handle("projects:initializeRepository", async (_event, directoryPath: string, initialBranch: string, createGitignore: boolean) => {
    const result = await gitService.initializeRepository(directoryPath, initialBranch);
    if (!result.ok) {
      return { result };
    }
    if (createGitignore) {
      await gitService.createGitIgnoreIfMissing(directoryPath);
    }
    return { result, project: await configStore.addProject(await gitService.getRepositoryRoot(directoryPath)) };
  });

  ipcMain.handle("projects:cloneRepository", async (_event, sourceUrl: string, destinationPath: string, options) => {
    const result = await gitService.cloneRepository(sourceUrl, destinationPath, options);
    if (!result.ok) {
      return { result };
    }
    return { result, project: await configStore.addProject(await gitService.getRepositoryRoot(destinationPath)) };
  });

  ipcMain.handle("projects:testRemote", async (_event, input: RemoteProjectInput) => {
    const result = await gitService.testRemoteRepository(input);
    verifiedRemoteProject = result.ok && result.repositoryRoot
      ? {
          fingerprint: remoteProjectFingerprint(input),
          repositoryRoot: result.repositoryRoot,
          expiresAt: Date.now() + 60_000
        }
      : null;
    return result;
  });

  ipcMain.handle("projects:addRemote", async (_event, input: RemoteProjectInput) => {
    const fingerprint = remoteProjectFingerprint(input);
    const verified = verifiedRemoteProject?.fingerprint === fingerprint && verifiedRemoteProject.expiresAt > Date.now()
      ? verifiedRemoteProject
      : null;
    const result = verified ? null : await gitService.testRemoteRepository(input);
    const repositoryRoot = verified?.repositoryRoot ?? result?.repositoryRoot;
    if (!repositoryRoot || (result && !result.ok)) {
      throw new Error([result?.messageZh ?? "无法连接远程 Git 仓库。", result?.stderr.trim()].filter(Boolean).join("\n"));
    }
    verifiedRemoteProject = null;
    return configStore.addRemoteProject(input, repositoryRoot);
  });

  ipcMain.handle("projects:scan", async (_event, rootPath: string) => {
    const repositories = await gitService.scanRepositories(rootPath);
    const projects = [];

    for (const repositoryPath of repositories) {
      projects.push(await configStore.addProject(repositoryPath));
    }

    return projects;
  });

  ipcMain.handle("projects:reorder", async (_event, projectIds: string[]) => {
    await configStore.reorderProjects(projectIds);
    return true;
  });

  ipcMain.handle("projects:setFavorite", (_event, projectId: string, favorite: boolean) => configStore.setProjectFavorite(projectId, favorite));

  ipcMain.handle("projects:remove", async (_event, projectId: string) => {
    await configStore.removeProject(projectId);
    return true;
  });

  ipcMain.handle("git:getStatus", (_event, repositoryPath: RepositoryLocation) => gitService.getStatus(repositoryPath));
  ipcMain.handle("git:getHistory", (_event, repositoryPath: RepositoryLocation, filter) => gitService.getHistory(repositoryPath, filter));
  ipcMain.handle("git:getHistoryPage", (_event, repositoryPath: RepositoryLocation, query) => gitService.getHistoryPage(repositoryPath, query));
  ipcMain.handle("git:getBlame", (_event, repositoryPath: RepositoryLocation, filePath: string, revision?: string) =>
    gitService.getBlame(repositoryPath, filePath, revision)
  );
  ipcMain.handle("git:getHistoryRefs", (_event, repositoryPath: RepositoryLocation) => gitService.getHistoryRefs(repositoryPath));
  ipcMain.handle("git:getCommitDetails", (_event, repositoryPath: RepositoryLocation, hash: string) => gitService.getCommitDetails(repositoryPath, hash));
  ipcMain.handle("git:getCommitDiff", (_event, repositoryPath: RepositoryLocation, hash: string, filePath?: string) => gitService.getCommitDiff(repositoryPath, hash, filePath));
  ipcMain.handle("git:getCommitFilePreview", (_event, repositoryPath: RepositoryLocation, hash: string, file) => gitService.getCommitFilePreview(repositoryPath, hash, file));
  ipcMain.handle("git:getWorktree", (_event, repositoryPath: RepositoryLocation) => gitService.getWorktree(repositoryPath));
  ipcMain.handle("git:getWorktreeDiff", (_event, repositoryPath: RepositoryLocation, filePath: string, staged: boolean) =>
    gitService.getWorktreeDiff(repositoryPath, filePath, staged)
  );
  ipcMain.handle("git:getWorktreeFilePreview", (_event, repositoryPath: RepositoryLocation, file) => gitService.getWorktreeFilePreview(repositoryPath, file));
  ipcMain.handle("git:getConflictFileDetails", (_event, repositoryPath: RepositoryLocation, filePath: string) =>
    gitService.getConflictFileDetails(repositoryPath, filePath)
  );
  ipcMain.handle("git:resolveConflictFile", (_event, repositoryPath: RepositoryLocation, filePath: string, input) =>
    gitService.resolveConflictFile(repositoryPath, filePath, input)
  );
  ipcMain.handle("git:stageFile", (_event, repositoryPath: RepositoryLocation, file: ChangedFile) => gitService.stageFile(repositoryPath, file));
  ipcMain.handle("git:stageAll", (_event, repositoryPath: RepositoryLocation) => gitService.stageAll(repositoryPath));
  ipcMain.handle("git:unstageFile", (_event, repositoryPath: RepositoryLocation, file: ChangedFile) => gitService.unstageFile(repositoryPath, file));
  ipcMain.handle("git:unstageAll", (_event, repositoryPath: RepositoryLocation) => gitService.unstageAll(repositoryPath));
  ipcMain.handle("git:discardFile", (_event, repositoryPath: RepositoryLocation, file) => gitService.discardFile(repositoryPath, file));
  ipcMain.handle("git:getStashes", (_event, repositoryPath: RepositoryLocation) => gitService.getStashes(repositoryPath));
  ipcMain.handle("git:createStash", (_event, repositoryPath: RepositoryLocation, options) => gitService.createStash(repositoryPath, options));
  ipcMain.handle("git:applyStash", (_event, repositoryPath: RepositoryLocation, selector: string, restoreIndex: boolean) =>
    gitService.applyStash(repositoryPath, selector, restoreIndex)
  );
  ipcMain.handle("git:popStash", (_event, repositoryPath: RepositoryLocation, selector: string, restoreIndex: boolean) =>
    gitService.popStash(repositoryPath, selector, restoreIndex)
  );
  ipcMain.handle("git:dropStash", (_event, repositoryPath: RepositoryLocation, selector: string) => gitService.dropStash(repositoryPath, selector));
  ipcMain.handle("git:commit", (_event, repositoryPath: RepositoryLocation, input: { subject: string; body?: string; amend?: boolean; pushAfterCommit?: boolean }) =>
    gitService.commit(repositoryPath, input)
  );
  ipcMain.handle("git:fetch", (_event, repositoryPath: RepositoryLocation) => gitService.fetch(repositoryPath));
  ipcMain.handle("git:fetchRemote", (_event, repositoryPath: RepositoryLocation, remoteName: string, prune: boolean) =>
    gitService.fetchRemote(repositoryPath, remoteName, prune)
  );
  ipcMain.handle("git:pull", (_event, repositoryPath: RepositoryLocation, strategy: GitPullStrategy) => gitService.pull(repositoryPath, strategy));
  ipcMain.handle("git:mergeRemote", (_event, repositoryPath: RepositoryLocation) => gitService.mergeRemote(repositoryPath));
  ipcMain.handle("git:push", (_event, repositoryPath: RepositoryLocation) => gitService.push(repositoryPath));
  ipcMain.handle("git:getRemotes", (_event, repositoryPath: RepositoryLocation) => gitService.getRemotes(repositoryPath));
  ipcMain.handle("git:addRemote", (_event, repositoryPath: RepositoryLocation, name: string, fetchUrl: string, pushUrl?: string) =>
    gitService.addRemote(repositoryPath, name, fetchUrl, pushUrl)
  );
  ipcMain.handle("git:updateRemote", (_event, repositoryPath: RepositoryLocation, currentName: string, input) =>
    gitService.updateRemote(repositoryPath, currentName, input)
  );
  ipcMain.handle("git:removeRemote", (_event, repositoryPath: RepositoryLocation, name: string) => gitService.removeRemote(repositoryPath, name));
  ipcMain.handle("git:setBranchUpstream", (_event, repositoryPath: RepositoryLocation, branchName: string, upstream: string) =>
    gitService.setBranchUpstream(repositoryPath, branchName, upstream)
  );
  ipcMain.handle("git:unsetBranchUpstream", (_event, repositoryPath: RepositoryLocation, branchName: string) =>
    gitService.unsetBranchUpstream(repositoryPath, branchName)
  );
  ipcMain.handle("git:setDefaultRemote", (_event, repositoryPath: RepositoryLocation, remoteName: string, role: "fetch" | "push", branchName?: string) =>
    gitService.setDefaultRemote(repositoryPath, remoteName, role, branchName)
  );
  ipcMain.handle("git:getBranches", (_event, repositoryPath: RepositoryLocation) => gitService.getBranches(repositoryPath));
  ipcMain.handle("git:createBranch", (_event, repositoryPath: RepositoryLocation, branchName: string, checkout: boolean, startPoint?: string) =>
    gitService.createBranch(repositoryPath, branchName, checkout, startPoint)
  );
  ipcMain.handle("git:switchBranch", (_event, repositoryPath: RepositoryLocation, branch) => gitService.switchBranch(repositoryPath, branch));
  ipcMain.handle("git:getMergePreview", (_event, repositoryPath: RepositoryLocation, targetBranch: string) =>
    gitService.getMergePreview(repositoryPath, targetBranch)
  );
  ipcMain.handle("git:mergeCurrentBranch", (_event, repositoryPath: RepositoryLocation, targetBranch: string, strategy: "ff" | "no-ff") =>
    gitService.mergeCurrentBranch(repositoryPath, targetBranch, strategy)
  );
  ipcMain.handle("git:continueMerge", (_event, repositoryPath: RepositoryLocation) => gitService.continueMerge(repositoryPath));
  ipcMain.handle("git:abortMerge", (_event, repositoryPath: RepositoryLocation) => gitService.abortMerge(repositoryPath));
  ipcMain.handle("git:startRebase", (_event, repositoryPath: RepositoryLocation, upstream: string, onto?: string) =>
    gitService.startRebase(repositoryPath, upstream, onto)
  );
  ipcMain.handle("git:getRebasePlan", (_event, repositoryPath: RepositoryLocation, upstream: string) => gitService.getRebasePlan(repositoryPath, upstream));
  ipcMain.handle("git:startInteractiveRebase", (_event, repositoryPath: RepositoryLocation, upstream: string, plan, onto?: string) =>
    gitService.startInteractiveRebase(repositoryPath, upstream, plan, onto)
  );
  ipcMain.handle("git:continueRebase", (_event, repositoryPath: RepositoryLocation) => gitService.continueRebase(repositoryPath));
  ipcMain.handle("git:skipRebase", (_event, repositoryPath: RepositoryLocation) => gitService.skipRebase(repositoryPath));
  ipcMain.handle("git:abortRebase", (_event, repositoryPath: RepositoryLocation) => gitService.abortRebase(repositoryPath));
  ipcMain.handle("git:continueCherryPick", (_event, repositoryPath: RepositoryLocation) => gitService.continueCherryPick(repositoryPath));
  ipcMain.handle("git:skipCherryPick", (_event, repositoryPath: RepositoryLocation) => gitService.skipCherryPick(repositoryPath));
  ipcMain.handle("git:abortCherryPick", (_event, repositoryPath: RepositoryLocation) => gitService.abortCherryPick(repositoryPath));
  ipcMain.handle("git:continueRevert", (_event, repositoryPath: RepositoryLocation) => gitService.continueRevert(repositoryPath));
  ipcMain.handle("git:skipRevert", (_event, repositoryPath: RepositoryLocation) => gitService.skipRevert(repositoryPath));
  ipcMain.handle("git:abortRevert", (_event, repositoryPath: RepositoryLocation) => gitService.abortRevert(repositoryPath));
  ipcMain.handle("git:startBisect", (_event, repositoryPath: RepositoryLocation, badRef?: string, goodRef?: string) =>
    gitService.startBisect(repositoryPath, badRef, goodRef)
  );
  ipcMain.handle("git:markBisectGood", (_event, repositoryPath: RepositoryLocation, ref?: string) => gitService.markBisectGood(repositoryPath, ref));
  ipcMain.handle("git:markBisectBad", (_event, repositoryPath: RepositoryLocation, ref?: string) => gitService.markBisectBad(repositoryPath, ref));
  ipcMain.handle("git:skipBisect", (_event, repositoryPath: RepositoryLocation, refs?: string[]) => gitService.skipBisect(repositoryPath, refs));
  ipcMain.handle("git:resetBisect", (_event, repositoryPath: RepositoryLocation) => gitService.resetBisect(repositoryPath));
  ipcMain.handle("git:showCommitSignature", (_event, repositoryPath: RepositoryLocation, revision: string) =>
    gitService.showCommitSignature(repositoryPath, revision)
  );
  ipcMain.handle("git:verifyCommitSignature", (_event, repositoryPath: RepositoryLocation, revision: string) =>
    gitService.verifyCommitSignature(repositoryPath, revision)
  );
  ipcMain.handle("git:renameBranch", (_event, repositoryPath: RepositoryLocation, branchName: string, nextName: string, force: boolean) =>
    gitService.renameBranch(repositoryPath, branchName, nextName, force)
  );
  ipcMain.handle("git:deleteBranch", (_event, repositoryPath: RepositoryLocation, branchName: string, force = false) =>
    gitService.deleteBranch(repositoryPath, branchName, force)
  );
  ipcMain.handle("git:deleteRemoteBranch", (_event, repositoryPath: RepositoryLocation, remoteName: string, branchName: string) =>
    gitService.deleteRemoteBranch(repositoryPath, remoteName, branchName)
  );
  ipcMain.handle("git:getTags", (_event, repositoryPath: RepositoryLocation) => gitService.getTags(repositoryPath));
  ipcMain.handle("git:createTag", (_event, repositoryPath: RepositoryLocation, name: string, target: string, message?: string) =>
    gitService.createTag(repositoryPath, name, target, message)
  );
  ipcMain.handle("git:deleteTag", (_event, repositoryPath: RepositoryLocation, name: string) => gitService.deleteTag(repositoryPath, name));
  ipcMain.handle("git:pushTag", (_event, repositoryPath: RepositoryLocation, remoteName: string, name: string) =>
    gitService.pushTag(repositoryPath, remoteName, name)
  );
  ipcMain.handle("git:deleteRemoteTag", (_event, repositoryPath: RepositoryLocation, remoteName: string, name: string) =>
    gitService.deleteRemoteTag(repositoryPath, remoteName, name)
  );
  ipcMain.handle("git:getReflog", (_event, repositoryPath: RepositoryLocation, maxCount?: number) => gitService.getReflog(repositoryPath, maxCount));
  ipcMain.handle("git:resetToReflogEntry", (_event, repositoryPath: RepositoryLocation, selector: string, mode: "mixed" | "hard") =>
    gitService.resetToReflogEntry(repositoryPath, selector, mode)
  );
  ipcMain.handle("git:getLinkedWorktrees", (_event, repositoryPath: RepositoryLocation) => gitService.getLinkedWorktrees(repositoryPath));
  ipcMain.handle("git:addLinkedWorktree", (_event, repositoryPath: RepositoryLocation, options) => gitService.addLinkedWorktree(repositoryPath, options));
  ipcMain.handle("git:removeLinkedWorktree", (_event, repositoryPath: RepositoryLocation, worktreePath: string, force: boolean) =>
    gitService.removeLinkedWorktree(repositoryPath, worktreePath, force)
  );
  ipcMain.handle("git:pruneLinkedWorktrees", (_event, repositoryPath: RepositoryLocation) => gitService.pruneLinkedWorktrees(repositoryPath));
  ipcMain.handle("git:getSubmodules", (_event, repositoryPath: RepositoryLocation) => gitService.getSubmodules(repositoryPath));
  ipcMain.handle("git:initializeSubmodules", (_event, repositoryPath: RepositoryLocation) => gitService.initializeSubmodules(repositoryPath));
  ipcMain.handle("git:updateSubmodules", (_event, repositoryPath: RepositoryLocation, options) => gitService.updateSubmodules(repositoryPath, options));
  ipcMain.handle("git:syncSubmodules", (_event, repositoryPath: RepositoryLocation, recursive: boolean) =>
    gitService.syncSubmodules(repositoryPath, recursive)
  );
  ipcMain.handle("git:getLfsStatus", (_event, repositoryPath: RepositoryLocation) => gitService.getLfsStatus(repositoryPath));
  ipcMain.handle("git:installLfs", (_event, repositoryPath: RepositoryLocation, scope: "local" | "global") =>
    gitService.installLfs(repositoryPath, scope)
  );
  ipcMain.handle("git:pullLfs", (_event, repositoryPath: RepositoryLocation, remoteName?: string, refs?: string[]) =>
    gitService.pullLfs(repositoryPath, remoteName, refs)
  );
  ipcMain.handle("git:pruneLfs", (_event, repositoryPath: RepositoryLocation) => gitService.pruneLfs(repositoryPath));
  ipcMain.handle("git:readGitIgnore", (_event, repositoryPath: RepositoryLocation) => gitService.readGitIgnore(repositoryPath));
  ipcMain.handle("git:writeGitIgnore", async (_event, repositoryPath: RepositoryLocation, content: string, expectedRevision: string) => {
    await gitService.writeGitIgnore(repositoryPath, content, expectedRevision);
    return true;
  });
  ipcMain.handle("git:getSigningConfig", (_event, repositoryPath: RepositoryLocation) => gitService.getSigningConfig(repositoryPath));
  ipcMain.handle("git:setSigningConfig", (_event, repositoryPath: RepositoryLocation, input) => gitService.setSigningConfig(repositoryPath, input));
  ipcMain.handle("git:getHostingLinks", (_event, repositoryPath: RepositoryLocation, remoteName: string, commitHash?: string, branchName?: string) =>
    gitService.getHostingLinks(repositoryPath, commitHash, branchName, remoteName)
  );
  ipcMain.handle("git:amendLastCommitMessage", (_event, repositoryPath: RepositoryLocation, input: { subject: string; body?: string }) =>
    gitService.amendLastCommitMessage(repositoryPath, input)
  );
  ipcMain.handle("git:resetLastCommit", (_event, repositoryPath: RepositoryLocation, mode: "soft" | "mixed") => gitService.resetLastCommit(repositoryPath, mode));
  ipcMain.handle("git:resetToCommit", (_event, repositoryPath: RepositoryLocation, hash: string, mode: "soft" | "mixed" | "hard") =>
    gitService.resetToCommit(repositoryPath, hash, mode)
  );
  ipcMain.handle("git:revertCommit", (_event, repositoryPath: RepositoryLocation, hash: string) => gitService.revertCommit(repositoryPath, hash));
  ipcMain.handle("git:cherryPickCommit", (_event, repositoryPath: RepositoryLocation, hash: string) => gitService.cherryPickCommit(repositoryPath, hash));
}

function applyNativeTheme(themeSource: AppThemeSource): void {
  nativeTheme.themeSource = themeSource;
  mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#101317" : "#f5f7fa");
}

function getWindowState(): WindowState {
  return {
    isMaximized: mainWindow?.isMaximized() ?? false,
    isFullScreen: mainWindow?.isFullScreen() ?? false
  };
}

function emitWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("window:state", getWindowState());
}

function emitUpdateState(state: UpdateState): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("update:state", state);
}

function registerWindowStateEvents(window: BrowserWindow): void {
  const emit = () => emitWindowState();
  window.on("maximize", emit);
  window.on("unmaximize", emit);
  window.on("enter-full-screen", emit);
  window.on("leave-full-screen", emit);
  window.on("restore", emit);
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  mainWindow.focus();
}

function runAppCommand(command: string): void {
  if (command === "app:quit") {
    app.quit();
    return;
  }

  if (!mainWindow) {
    return;
  }

  const webContents = mainWindow.webContents;
  switch (command) {
    case "edit:undo":
      webContents.undo();
      break;
    case "edit:redo":
      webContents.redo();
      break;
    case "edit:cut":
      webContents.cut();
      break;
    case "edit:copy":
      webContents.copy();
      break;
    case "edit:paste":
      webContents.paste();
      break;
    case "edit:selectAll":
      webContents.selectAll();
      break;
    case "view:reload":
      webContents.reload();
      break;
    case "view:forceReload":
      webContents.reloadIgnoringCache();
      break;
    case "view:toggleDevTools":
      webContents.toggleDevTools();
      break;
    case "view:resetZoom":
      webContents.setZoomLevel(0);
      break;
    case "view:zoomIn":
      webContents.setZoomLevel(webContents.getZoomLevel() + 1);
      break;
    case "view:zoomOut":
      webContents.setZoomLevel(webContents.getZoomLevel() - 1);
      break;
    case "view:toggleFullscreen":
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      break;
    case "window:minimize":
      mainWindow.minimize();
      break;
    case "window:toggleMaximize":
      if (mainWindow.isFullScreen()) {
        mainWindow.setFullScreen(false);
      } else if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
      emitWindowState();
      break;
    case "window:close":
      mainWindow.close();
      break;
    case "help:about":
      showAboutDialog();
      break;
  }
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusMainWindow();
  });

  app.whenReady().then(async () => {
    configStore = new ConfigStore(app.getPath("userData"));
    updateService = new UpdateService(emitUpdateState);
    configureApplicationMenu();
    registerIpc();
    await createWindow();
    updateService.start();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      } else {
        focusMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    disposeAllTerminalSessions();
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    updateService?.stop();
  });
}

function startTerminalSession(webContents: WebContents, repositoryPath: RepositoryLocation): { sessionId: string; shell: string; cwd: string; trustedPromptMarkers: boolean } {
  const target = normalizeRepositoryTarget(repositoryPath);
  const localShell = terminalShell();
  const cwd = target.remote ? process.cwd() : path.resolve(target.path);
  const sshArgs = target.remote ? buildSshArgs(target.remote) : [];
  const sshHost = target.remote ? sshArgs.pop()! : "";
  const command = target.remote ? "ssh" : localShell.command;
  const args = target.remote
    ? [...sshArgs, "-t", sshHost, `cd ${shellQuote(target.path)} && exec \"\${SHELL:-/bin/sh}\" -l`]
    : localShell.args;
  const shellLabel = target.remote ? `SSH ${sshDestination(target.remote)}` : localShell.label;
  const sessionId = `terminal-${Date.now()}-${++terminalSessionSeed}`;
  const terminal = pty.spawn(command, args, {
    cols: 80,
    rows: 24,
    cwd,
    env: process.env,
    name: process.platform === "win32" ? "xterm-256color" : "xterm-color"
  });

  terminalSessions.set(sessionId, { process: terminal, webContents });
  terminal.onData((data) => sendTerminalData(sessionId, data));
  terminal.onExit(({ exitCode, signal }) => {
    terminalSessions.delete(sessionId);
    if (!webContents.isDestroyed()) {
      webContents.send("terminal:exit", { sessionId, exitCode, signal });
    }
  });

  return {
    sessionId,
    shell: shellLabel,
    cwd: target.remote ? `${sshDestination(target.remote)}:${target.path}` : cwd,
    trustedPromptMarkers: !target.remote && localShell.trustedPromptMarkers
  };
}

function writeTerminalSession(sessionId: string, data: string): boolean {
  const session = terminalSessions.get(sessionId);
  if (!session) {
    return false;
  }

  session.process.write(data);
  return true;
}

function resizeTerminalSession(sessionId: string, cols: number, rows: number): boolean {
  const session = terminalSessions.get(sessionId);
  if (!session) {
    return false;
  }

  session.process.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows)));
  return true;
}

function disposeTerminalSession(sessionId: string): boolean {
  const session = terminalSessions.get(sessionId);
  if (!session) {
    return false;
  }

  terminalSessions.delete(sessionId);
  session.process.kill();
  return true;
}

function disposeAllTerminalSessions(): void {
  for (const sessionId of terminalSessions.keys()) {
    disposeTerminalSession(sessionId);
  }
}

function sendTerminalData(sessionId: string, data: string): void {
  const session = terminalSessions.get(sessionId);
  if (!session || session.webContents.isDestroyed()) {
    return;
  }

  session.webContents.send("terminal:data", { sessionId, stream: "stdout", data });
}

function terminalShell(): { command: string; args: string[]; label: string; trustedPromptMarkers: boolean } {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const windowsPowerShell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(windowsPowerShell)) {
      return {
        command: windowsPowerShell,
        args: [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-NoExit",
          "-Command",
          "$global:GitUiProOriginalPrompt=$function:prompt; function global:prompt { [Console]::Write(([char]27)+']633;A'+[char]7); & $global:GitUiProOriginalPrompt }"
        ],
        label: "PowerShell",
        trustedPromptMarkers: true
      };
    }

    return {
      command: process.env.ComSpec || path.join(systemRoot, "System32", "cmd.exe"),
      args: ["/K"],
      label: "Command Prompt",
      trustedPromptMarkers: false
    };
  }

  const shell = process.env.SHELL || "/bin/sh";
  return {
    command: shell,
    args: [],
    label: path.basename(shell),
    trustedPromptMarkers: false
  };
}

function remoteProjectFingerprint(input: RemoteProjectInput): string {
  return JSON.stringify([
    input.host.trim().toLowerCase(),
    input.username?.trim() ?? "",
    input.port ?? 22,
    input.repositoryPath.trim().replace(/\\/g, "/").replace(/\/$/, ""),
    input.identityFile?.trim() ?? ""
  ]);
}

function configureApplicationMenu(): void {
  Menu.setApplicationMenu(null);
}

function showAboutDialog(): void {
  const options = {
    type: "info",
    title: "关于 Git UI Pro",
    message: "Git UI Pro",
    detail: "中文桌面 Git Graph + 多项目管理器"
  } as const;

  if (mainWindow) {
    void dialog.showMessageBox(mainWindow, options);
    return;
  }

  void dialog.showMessageBox(options);
}
