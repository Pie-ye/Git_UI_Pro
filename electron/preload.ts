import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { GitPullStrategy, RepositoryTarget } from "./gitService";
import type { ReleaseHistoryItem } from "./releaseHistory";
import type { UpdateState } from "./updateService";

type WindowState = {
  isMaximized: boolean;
  isFullScreen: boolean;
};

contextBridge.exposeInMainWorld("gitUI", {
  runAppCommand: (command: string) => ipcRenderer.invoke("app:command", command),
  openExternal: (url: string) => ipcRenderer.invoke("app:openExternal", url),
  setNativeTheme: (themeSource: "system" | "light" | "dark") => ipcRenderer.invoke("theme:setNative", themeSource),
  getWindowState: () => ipcRenderer.invoke("window:getState"),
  onWindowStateChange: (callback: (state: WindowState) => void) => {
    const listener = (_event: IpcRendererEvent, state: WindowState) => callback(state);
    ipcRenderer.on("window:state", listener);
    return () => ipcRenderer.removeListener("window:state", listener);
  },
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke("update:getState"),
  listUpdateReleases: (force = false): Promise<ReleaseHistoryItem[]> => ipcRenderer.invoke("update:listReleases", force),
  checkForUpdates: (): Promise<UpdateState> => ipcRenderer.invoke("update:check"),
  prepareRollback: (version: string): Promise<UpdateState> => ipcRenderer.invoke("update:prepareRollback", version),
  cancelRollback: (): Promise<UpdateState> => ipcRenderer.invoke("update:cancelRollback"),
  downloadUpdate: (): Promise<UpdateState> => ipcRenderer.invoke("update:download"),
  installUpdate: (): Promise<boolean> => ipcRenderer.invoke("update:install"),
  onUpdateState: (callback: (state: UpdateState) => void) => {
    const listener = (_event: IpcRendererEvent, state: UpdateState) => callback(state);
    ipcRenderer.on("update:state", listener);
    return () => ipcRenderer.removeListener("update:state", listener);
  },
  getGitVersion: () => ipcRenderer.invoke("git:getVersion"),
  startTerminal: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("terminal:start", repositoryPath),
  writeTerminal: (sessionId: string, data: string) => ipcRenderer.invoke("terminal:write", sessionId, data),
  resizeTerminal: (sessionId: string, cols: number, rows: number) => ipcRenderer.invoke("terminal:resize", sessionId, cols, rows),
  disposeTerminal: (sessionId: string) => ipcRenderer.invoke("terminal:dispose", sessionId),
  onTerminalData: (callback: (event: { sessionId: string; stream: "stdout" | "stderr"; data: string }) => void) => {
    const listener = (_event: IpcRendererEvent, payload: { sessionId: string; stream: "stdout" | "stderr"; data: string }) => callback(payload);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.removeListener("terminal:data", listener);
  },
  onTerminalExit: (callback: (event: { sessionId: string; exitCode: number | null; signal: string | null }) => void) => {
    const listener = (_event: IpcRendererEvent, payload: { sessionId: string; exitCode: number | null; signal: string | null }) => callback(payload);
    ipcRenderer.on("terminal:exit", listener);
    return () => ipcRenderer.removeListener("terminal:exit", listener);
  },
  chooseDirectory: () => ipcRenderer.invoke("dialog:chooseDirectory"),
  chooseIdentityFile: () => ipcRenderer.invoke("dialog:chooseIdentityFile"),
  getProjects: () => ipcRenderer.invoke("projects:list"),
  getProjectLibrary: () => ipcRenderer.invoke("projects:getLibrary"),
  createProjectGroup: (name: string) => ipcRenderer.invoke("projects:createGroup", name),
  renameProjectGroup: (groupId: string, name: string) => ipcRenderer.invoke("projects:renameGroup", groupId, name),
  deleteProjectGroup: (groupId: string) => ipcRenderer.invoke("projects:deleteGroup", groupId),
  setProjectGroup: (projectId: string, groupId?: string) => ipcRenderer.invoke("projects:setGroup", projectId, groupId),
  markProjectOpened: (projectId: string) => ipcRenderer.invoke("projects:markOpened", projectId),
  removeRecentProject: (projectId: string) => ipcRenderer.invoke("projects:removeRecent", projectId),
  getUiPreferences: () => ipcRenderer.invoke("preferences:get"),
  updateUiPreferences: (input: Record<string, unknown>) => ipcRenderer.invoke("preferences:update", input),
  addProject: (directoryPath: string) => ipcRenderer.invoke("projects:add", directoryPath),
  initializeRepository: (directoryPath: string, initialBranch: string, createGitignore: boolean) =>
    ipcRenderer.invoke("projects:initializeRepository", directoryPath, initialBranch, createGitignore),
  cloneRepository: (sourceUrl: string, destinationPath: string, options: { branch?: string; depth?: number; recurseSubmodules?: boolean }) =>
    ipcRenderer.invoke("projects:cloneRepository", sourceUrl, destinationPath, options),
  testRemoteProject: (input: { host: string; username?: string; port?: number; repositoryPath: string; identityFile?: string }) =>
    ipcRenderer.invoke("projects:testRemote", input),
  addRemoteProject: (input: { host: string; username?: string; port?: number; repositoryPath: string; identityFile?: string }) =>
    ipcRenderer.invoke("projects:addRemote", input),
  scanProjects: (rootPath: string) => ipcRenderer.invoke("projects:scan", rootPath),
  reorderProjects: (projectIds: string[]) => ipcRenderer.invoke("projects:reorder", projectIds),
  setProjectFavorite: (projectId: string, favorite: boolean) => ipcRenderer.invoke("projects:setFavorite", projectId, favorite),
  removeProject: (projectId: string) => ipcRenderer.invoke("projects:remove", projectId),
  getProjectStatus: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:getStatus", repositoryPath),
  getHistory: (repositoryPath: RepositoryTarget, filter?: { mode: "auto" | "all" | "custom"; refIds?: string[] }) => ipcRenderer.invoke("git:getHistory", repositoryPath, filter),
  getHistoryPage: (repositoryPath: RepositoryTarget, query: Record<string, unknown>) => ipcRenderer.invoke("git:getHistoryPage", repositoryPath, query),
  getBlame: (repositoryPath: RepositoryTarget, filePath: string, revision?: string) => ipcRenderer.invoke("git:getBlame", repositoryPath, filePath, revision),
  getHistoryRefs: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:getHistoryRefs", repositoryPath),
  getCommitDetails: (repositoryPath: RepositoryTarget, hash: string) => ipcRenderer.invoke("git:getCommitDetails", repositoryPath, hash),
  getCommitDiff: (repositoryPath: RepositoryTarget, hash: string, filePath?: string) => ipcRenderer.invoke("git:getCommitDiff", repositoryPath, hash, filePath),
  getCommitFilePreview: (repositoryPath: RepositoryTarget, hash: string, file: { path: string; oldPath?: string; status: string; staged: boolean }) =>
    ipcRenderer.invoke("git:getCommitFilePreview", repositoryPath, hash, file),
  getWorktree: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:getWorktree", repositoryPath),
  getWorktreeDiff: (repositoryPath: RepositoryTarget, filePath: string, staged: boolean) => ipcRenderer.invoke("git:getWorktreeDiff", repositoryPath, filePath, staged),
  getWorktreeFilePreview: (repositoryPath: RepositoryTarget, file: { path: string; oldPath?: string; status: string; staged: boolean }) =>
    ipcRenderer.invoke("git:getWorktreeFilePreview", repositoryPath, file),
  getConflictFileDetails: (repositoryPath: RepositoryTarget, filePath: string) => ipcRenderer.invoke("git:getConflictFileDetails", repositoryPath, filePath),
  resolveConflictFile: (
    repositoryPath: RepositoryTarget,
    filePath: string,
    input: { choice: "content" | "current" | "incoming"; content?: string; expectedToken: string }
  ) => ipcRenderer.invoke("git:resolveConflictFile", repositoryPath, filePath, input),
  stageFile: (repositoryPath: RepositoryTarget, file: { path: string; oldPath?: string; status: string; staged: boolean }) =>
    ipcRenderer.invoke("git:stageFile", repositoryPath, file),
  stageAll: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:stageAll", repositoryPath),
  unstageFile: (repositoryPath: RepositoryTarget, file: { path: string; oldPath?: string; status: string; staged: boolean }) =>
    ipcRenderer.invoke("git:unstageFile", repositoryPath, file),
  unstageAll: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:unstageAll", repositoryPath),
  discardFile: (repositoryPath: RepositoryTarget, file: { path: string; oldPath?: string; status: string; staged: boolean }) =>
    ipcRenderer.invoke("git:discardFile", repositoryPath, file),
  getStashes: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:getStashes", repositoryPath),
  createStash: (repositoryPath: RepositoryTarget, options: { message?: string; includeUntracked?: boolean; keepIndex?: boolean }) =>
    ipcRenderer.invoke("git:createStash", repositoryPath, options),
  applyStash: (repositoryPath: RepositoryTarget, selector: string, restoreIndex = false) =>
    ipcRenderer.invoke("git:applyStash", repositoryPath, selector, restoreIndex),
  popStash: (repositoryPath: RepositoryTarget, selector: string, restoreIndex = false) =>
    ipcRenderer.invoke("git:popStash", repositoryPath, selector, restoreIndex),
  dropStash: (repositoryPath: RepositoryTarget, selector: string) => ipcRenderer.invoke("git:dropStash", repositoryPath, selector),
  commit: (repositoryPath: RepositoryTarget, input: { subject: string; body?: string; amend?: boolean; pushAfterCommit?: boolean }) =>
    ipcRenderer.invoke("git:commit", repositoryPath, input),
  fetch: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:fetch", repositoryPath),
  fetchRemote: (repositoryPath: RepositoryTarget, remoteName: string, prune = false) => ipcRenderer.invoke("git:fetchRemote", repositoryPath, remoteName, prune),
  pull: (repositoryPath: RepositoryTarget, strategy: GitPullStrategy) => ipcRenderer.invoke("git:pull", repositoryPath, strategy),
  mergeRemote: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:mergeRemote", repositoryPath),
  push: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:push", repositoryPath),
  getRemotes: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:getRemotes", repositoryPath),
  addRemote: (repositoryPath: RepositoryTarget, name: string, fetchUrl: string, pushUrl?: string) =>
    ipcRenderer.invoke("git:addRemote", repositoryPath, name, fetchUrl, pushUrl),
  updateRemote: (repositoryPath: RepositoryTarget, currentName: string, input: { name?: string; fetchUrl?: string; pushUrl?: string | null }) =>
    ipcRenderer.invoke("git:updateRemote", repositoryPath, currentName, input),
  removeRemote: (repositoryPath: RepositoryTarget, name: string) => ipcRenderer.invoke("git:removeRemote", repositoryPath, name),
  setBranchUpstream: (repositoryPath: RepositoryTarget, branchName: string, upstream: string) =>
    ipcRenderer.invoke("git:setBranchUpstream", repositoryPath, branchName, upstream),
  unsetBranchUpstream: (repositoryPath: RepositoryTarget, branchName: string) => ipcRenderer.invoke("git:unsetBranchUpstream", repositoryPath, branchName),
  setDefaultRemote: (repositoryPath: RepositoryTarget, remoteName: string, role: "fetch" | "push", branchName?: string) =>
    ipcRenderer.invoke("git:setDefaultRemote", repositoryPath, remoteName, role, branchName),
  getBranches: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:getBranches", repositoryPath),
  createBranch: (repositoryPath: RepositoryTarget, branchName: string, checkout: boolean, startPoint?: string) =>
    ipcRenderer.invoke("git:createBranch", repositoryPath, branchName, checkout, startPoint),
  switchBranch: (repositoryPath: RepositoryTarget, branch: { name: string; fullName: string; type: string; current: boolean; upstream?: string; headHash: string }) =>
    ipcRenderer.invoke("git:switchBranch", repositoryPath, branch),
  getMergePreview: (repositoryPath: RepositoryTarget, targetBranch: string) => ipcRenderer.invoke("git:getMergePreview", repositoryPath, targetBranch),
  mergeCurrentBranch: (repositoryPath: RepositoryTarget, targetBranch: string, strategy: "ff" | "no-ff") =>
    ipcRenderer.invoke("git:mergeCurrentBranch", repositoryPath, targetBranch, strategy),
  continueMerge: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:continueMerge", repositoryPath),
  abortMerge: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:abortMerge", repositoryPath),
  startRebase: (repositoryPath: RepositoryTarget, upstream: string, onto?: string) => ipcRenderer.invoke("git:startRebase", repositoryPath, upstream, onto),
  getRebasePlan: (repositoryPath: RepositoryTarget, upstream: string) => ipcRenderer.invoke("git:getRebasePlan", repositoryPath, upstream),
  startInteractiveRebase: (repositoryPath: RepositoryTarget, upstream: string, plan: Array<Record<string, unknown>>, onto?: string) =>
    ipcRenderer.invoke("git:startInteractiveRebase", repositoryPath, upstream, plan, onto),
  continueRebase: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:continueRebase", repositoryPath),
  skipRebase: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:skipRebase", repositoryPath),
  abortRebase: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:abortRebase", repositoryPath),
  continueCherryPick: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:continueCherryPick", repositoryPath),
  skipCherryPick: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:skipCherryPick", repositoryPath),
  abortCherryPick: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:abortCherryPick", repositoryPath),
  continueRevert: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:continueRevert", repositoryPath),
  skipRevert: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:skipRevert", repositoryPath),
  abortRevert: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:abortRevert", repositoryPath),
  startBisect: (repositoryPath: RepositoryTarget, badRef?: string, goodRef?: string) => ipcRenderer.invoke("git:startBisect", repositoryPath, badRef, goodRef),
  markBisectGood: (repositoryPath: RepositoryTarget, ref?: string) => ipcRenderer.invoke("git:markBisectGood", repositoryPath, ref),
  markBisectBad: (repositoryPath: RepositoryTarget, ref?: string) => ipcRenderer.invoke("git:markBisectBad", repositoryPath, ref),
  skipBisect: (repositoryPath: RepositoryTarget, refs?: string[]) => ipcRenderer.invoke("git:skipBisect", repositoryPath, refs),
  resetBisect: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:resetBisect", repositoryPath),
  showCommitSignature: (repositoryPath: RepositoryTarget, revision: string) => ipcRenderer.invoke("git:showCommitSignature", repositoryPath, revision),
  verifyCommitSignature: (repositoryPath: RepositoryTarget, revision: string) => ipcRenderer.invoke("git:verifyCommitSignature", repositoryPath, revision),
  renameBranch: (repositoryPath: RepositoryTarget, branchName: string, nextName: string, force = false) =>
    ipcRenderer.invoke("git:renameBranch", repositoryPath, branchName, nextName, force),
  deleteBranch: (repositoryPath: RepositoryTarget, branchName: string, force = false) => ipcRenderer.invoke("git:deleteBranch", repositoryPath, branchName, force),
  deleteRemoteBranch: (repositoryPath: RepositoryTarget, remoteName: string, branchName: string) =>
    ipcRenderer.invoke("git:deleteRemoteBranch", repositoryPath, remoteName, branchName),
  getTags: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:getTags", repositoryPath),
  createTag: (repositoryPath: RepositoryTarget, name: string, target: string, message?: string) =>
    ipcRenderer.invoke("git:createTag", repositoryPath, name, target, message),
  deleteTag: (repositoryPath: RepositoryTarget, name: string) => ipcRenderer.invoke("git:deleteTag", repositoryPath, name),
  pushTag: (repositoryPath: RepositoryTarget, remoteName: string, name: string) => ipcRenderer.invoke("git:pushTag", repositoryPath, remoteName, name),
  deleteRemoteTag: (repositoryPath: RepositoryTarget, remoteName: string, name: string) =>
    ipcRenderer.invoke("git:deleteRemoteTag", repositoryPath, remoteName, name),
  getReflog: (repositoryPath: RepositoryTarget, maxCount?: number) => ipcRenderer.invoke("git:getReflog", repositoryPath, maxCount),
  resetToReflogEntry: (repositoryPath: RepositoryTarget, selector: string, mode: "mixed" | "hard") =>
    ipcRenderer.invoke("git:resetToReflogEntry", repositoryPath, selector, mode),
  getLinkedWorktrees: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:getLinkedWorktrees", repositoryPath),
  addLinkedWorktree: (repositoryPath: RepositoryTarget, options: Record<string, unknown>) => ipcRenderer.invoke("git:addLinkedWorktree", repositoryPath, options),
  removeLinkedWorktree: (repositoryPath: RepositoryTarget, worktreePath: string, force = false) =>
    ipcRenderer.invoke("git:removeLinkedWorktree", repositoryPath, worktreePath, force),
  pruneLinkedWorktrees: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:pruneLinkedWorktrees", repositoryPath),
  getSubmodules: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:getSubmodules", repositoryPath),
  initializeSubmodules: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:initializeSubmodules", repositoryPath),
  updateSubmodules: (repositoryPath: RepositoryTarget, options: Record<string, unknown>) => ipcRenderer.invoke("git:updateSubmodules", repositoryPath, options),
  syncSubmodules: (repositoryPath: RepositoryTarget, recursive = true) => ipcRenderer.invoke("git:syncSubmodules", repositoryPath, recursive),
  getLfsStatus: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:getLfsStatus", repositoryPath),
  installLfs: (repositoryPath: RepositoryTarget, scope: "local" | "global" = "local") => ipcRenderer.invoke("git:installLfs", repositoryPath, scope),
  pullLfs: (repositoryPath: RepositoryTarget, remoteName?: string, refs?: string[]) => ipcRenderer.invoke("git:pullLfs", repositoryPath, remoteName, refs),
  pruneLfs: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:pruneLfs", repositoryPath),
  readGitIgnore: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:readGitIgnore", repositoryPath),
  writeGitIgnore: (repositoryPath: RepositoryTarget, content: string, expectedRevision: string) =>
    ipcRenderer.invoke("git:writeGitIgnore", repositoryPath, content, expectedRevision),
  getSigningConfig: (repositoryPath: RepositoryTarget) => ipcRenderer.invoke("git:getSigningConfig", repositoryPath),
  setSigningConfig: (repositoryPath: RepositoryTarget, input: Record<string, unknown>) => ipcRenderer.invoke("git:setSigningConfig", repositoryPath, input),
  getHostingLinks: (repositoryPath: RepositoryTarget, remoteName: string, commitHash?: string, branchName?: string) =>
    ipcRenderer.invoke("git:getHostingLinks", repositoryPath, remoteName, commitHash, branchName),
  amendLastCommitMessage: (repositoryPath: RepositoryTarget, input: { subject: string; body?: string }) =>
    ipcRenderer.invoke("git:amendLastCommitMessage", repositoryPath, input),
  resetLastCommit: (repositoryPath: RepositoryTarget, mode: "soft" | "mixed") => ipcRenderer.invoke("git:resetLastCommit", repositoryPath, mode),
  resetToCommit: (repositoryPath: RepositoryTarget, hash: string, mode: "soft" | "mixed" | "hard") =>
    ipcRenderer.invoke("git:resetToCommit", repositoryPath, hash, mode),
  revertCommit: (repositoryPath: RepositoryTarget, hash: string) => ipcRenderer.invoke("git:revertCommit", repositoryPath, hash),
  cherryPickCommit: (repositoryPath: RepositoryTarget, hash: string) => ipcRenderer.invoke("git:cherryPickCommit", repositoryPath, hash)
});
