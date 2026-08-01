import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "../api/client";
import type {
  BranchInfo,
  GitHostingLinks,
  GitOperationResult,
  GitProject,
  GitStatusSummary,
  ProjectLibraryState,
  UiPreferences
} from "../types/domain";
import {
  RepositoryCenter,
  type RepositoryActiveOperation,
  type RepositoryCenterActions,
  type RepositoryCenterData,
  type RepositoryCenterSection,
  type RepositoryCenterTab,
  type RepositoryHostingLink,
  type RepositoryPreferences,
  type RepositoryProjectSummary,
  type RepositoryResource,
  type RepositorySigningSettings
} from "./RepositoryCenter";

interface RepositoryCenterContainerProps {
  open: boolean;
  project?: GitProject;
  projects: GitProject[];
  initialTab?: RepositoryCenterTab;
  onClose: () => void;
  onOpenProject: (projectId: string) => void;
  onProjectsChange: (projects: GitProject[]) => void;
  onLibraryChange: (library: ProjectLibraryState) => void;
  onRepositoryChange: () => void | Promise<void>;
  onPreferencesChange: (preferences: UiPreferences) => void;
}

const shortcutLabels: Record<string, string> = {
  "project.search": "搜索项目",
  "repository.center": "打开仓库中心",
  "git.fetch": "获取远程更新",
  "git.pull": "拉取当前分支",
  "git.push": "推送当前分支",
  "terminal.toggle": "显示或隐藏控制台"
};

export function RepositoryCenterContainer({
  open,
  project,
  projects,
  initialTab,
  onClose,
  onOpenProject,
  onProjectsChange,
  onLibraryChange,
  onRepositoryChange,
  onPreferencesChange
}: RepositoryCenterContainerProps) {
  const [data, setData] = useState<RepositoryCenterData>(() => emptyCenterData());
  const loadTokenRef = useRef(0);

  const loadAll = useCallback(async (projectSource: GitProject[] = projects) => {
    const loadToken = ++loadTokenRef.current;
    setData((current) => loadingCenterData(current));

    const libraryPromise = asResource(() => apiClient.getProjectLibrary());
    const preferencesPromise = asResource(() => apiClient.getUiPreferences());
    const statusPromise = project ? asResource(() => apiClient.getProjectStatus(project)) : Promise.resolve(readyResource<GitStatusSummary | undefined>(undefined));
    const branchesPromise = project ? asResource(() => apiClient.getBranches(project)) : Promise.resolve(readyResource<BranchInfo[]>([]));
    const remotesPromise = project ? asResource(() => apiClient.getRemotes(project)) : Promise.resolve(readyResource([]));

    const [library, preferences, status, branches, remotes, stashes, tags, reflog, worktrees, submodules, lfs, gitignore, signing] = await Promise.all([
      libraryPromise,
      preferencesPromise,
      statusPromise,
      branchesPromise,
      remotesPromise,
      project ? asResource(() => apiClient.getStashes(project)) : Promise.resolve(readyResource([])),
      project ? asResource(() => apiClient.getTags(project)) : Promise.resolve(readyResource([])),
      project ? asResource(() => apiClient.getReflog(project, 150)) : Promise.resolve(readyResource([])),
      project ? asResource(() => apiClient.getLinkedWorktrees(project)) : Promise.resolve(readyResource([])),
      project ? asResource(() => apiClient.getSubmodules(project)) : Promise.resolve(readyResource([])),
      project ? asResource(() => apiClient.getLfsStatus(project)) : Promise.resolve(readyResource(undefined)),
      project ? asResource(() => apiClient.readGitIgnore(project)) : Promise.resolve(readyResource(undefined)),
      project ? asResource(() => apiClient.getSigningConfig(project)) : Promise.resolve(readyResource(undefined))
    ]);

    const resolvedStatus = status.status === "ready" ? status.data : undefined;
    const hosting = !project
      ? readyResource<RepositoryHostingLink[]>([])
      : remotes.status === "error"
        ? errorResource<RepositoryHostingLink[]>(remotes.error, [])
        : await loadHostingResources(project, remotes.data, resolvedStatus?.currentBranch ?? undefined);

    if (loadToken !== loadTokenRef.current) {
      return;
    }

    if (library.status === "ready") {
      onLibraryChange(library.data);
    }

    const libraryData = library.status === "ready" ? library.data : { groups: [], recentProjectIds: [] };
    const projectSummaries = projectSource.map(projectSummary);
    const recentById = new Map(projectSummaries.map((item) => [item.id, item]));
    const branchData = branches.status === "ready" ? branches.data : [];

    setData({
      stashes: mapResource(stashes, (entries) => entries.map((entry, index) => ({
        id: entry.selector,
        targetHash: entry.hash,
        index: stashIndex(entry.selector, index),
        subject: entry.subject,
        branch: stashBranch(entry.subject),
        createdAt: entry.createdAt
      })), []),
      operation: status.status === "error" ? errorResource(status.error, null) : readyResource(activeOperation(resolvedStatus)),
      rebaseTargets: branches.status === "error"
        ? errorResource(branches.error, [])
        : tags.status === "error"
          ? errorResource(tags.error, [])
          : readyResource([
              ...branches.data.map((branch) => ({
                ref: branch.name,
                label: branch.name,
                kind: branch.type === "local" ? "local" as const : "remote" as const,
                isCurrent: branch.current
              })),
              ...tags.data.map((tag) => ({ ref: tag.name, label: tag.name, kind: "tag" as const }))
            ]),
      remotes: mapResource(remotes, (entries) => entries.map((remote) => ({
        id: remote.name,
        name: remote.name,
        fetchUrl: remote.fetchUrls[0] ?? "",
        pushUrl: remote.pushUrls[0] ?? remote.fetchUrls[0] ?? "",
        isDefaultFetch: remote.defaultFetch,
        isDefaultPush: remote.defaultPush
      })), []),
      branches: mapResource(branches, (entries) => entries.map((branch) => ({
        id: branch.fullName,
        name: branch.name,
        kind: branch.type,
        current: branch.current,
        upstream: branch.upstream,
        headHash: branch.headHash.slice(0, 10),
        ahead: branch.ahead,
        behind: branch.behind,
        merged: branch.merged
      })), []),
      tags: mapResource(tags, (entries) => entries.map((tag) => ({
        id: tag.name,
        name: tag.name,
        targetHash: tag.targetHash.slice(0, 10),
        subject: tag.subject,
        annotated: tag.annotated,
        pushedRemotes: []
      })), []),
      reflog: mapResource(reflog, (entries) => entries.map((entry) => ({
        id: entry.selector,
        targetHash: entry.hash,
        selector: entry.selector,
        shortHash: entry.hash.slice(0, 10),
        action: entry.action,
        subject: entry.message || entry.action,
        createdAt: entry.authorDate
      })), []),
      worktrees: mapResource(worktrees, (entries) => entries.map((entry) => ({
        id: entry.path,
        path: entry.path,
        branch: entry.branch,
        headHash: entry.head.slice(0, 10),
        locked: Boolean(entry.lockedReason),
        prunable: Boolean(entry.prunableReason),
        isMain: Boolean(project && normalizePath(entry.path) === normalizePath(project.path))
      })), []),
      submodules: mapResource(submodules, (entries) => entries.map((entry) => ({
        id: entry.path,
        name: entry.path.split(/[\\/]/).filter(Boolean).at(-1) ?? entry.path,
        path: entry.path,
        url: entry.url,
        branch: entry.branch,
        status: entry.state === "initialized" ? "ready" as const : entry.state === "uninitialized" ? "uninitialized" as const : entry.state === "conflicted" ? "conflict" as const : "modified" as const,
        headHash: entry.hash.slice(0, 10)
      })), []),
      lfs: mapResource(lfs, (value) => ({
        installed: value?.installed ?? false,
        initialized: value?.initialized ?? false,
        version: value?.version ?? "",
        changedFileCount: value?.files.length ?? 0,
        stagedFileCount: value?.files.filter((file) => file.staged).length ?? 0
      }), { installed: false, initialized: false, version: "", changedFileCount: 0, stagedFileCount: 0 }),
      gitignore: mapResource(gitignore, (value) => ({ path: ".gitignore", content: value?.content ?? "", revision: value?.revision ?? "missing", modified: false }), { path: ".gitignore", content: "", revision: "missing", modified: false }),
      signing: mapResource(signing, (value): RepositorySigningSettings => ({
        enabled: Boolean(value?.commitGpgSign),
        format: value?.format ?? "openpgp",
        key: value?.signingKey ?? "",
        signTags: Boolean(value?.tagGpgSign)
      }), { enabled: false, format: "openpgp", key: "", signTags: false }),
      hosting,
      projects: readyResource(projectSummaries),
      groups: library.status === "error" ? errorResource(library.error, []) : readyResource(libraryData.groups.map((group) => ({
        id: group.id,
        name: group.name,
        projectIds: projectSource.filter((item) => item.groupId === group.id).map((item) => item.id)
      }))),
      recent: library.status === "error" ? errorResource(library.error, []) : readyResource(
        libraryData.recentProjectIds.map((id) => recentById.get(id)).filter((item): item is RepositoryProjectSummary => Boolean(item))
      ),
      preferences: mapResource(preferences, toRepositoryPreferences, toRepositoryPreferences(defaultPreferences()))
    });
  }, [onLibraryChange, project, projects]);

  useEffect(() => {
    if (open) {
      void loadAll();
    }
  }, [loadAll, open]);

  async function completeGit(resultPromise: Promise<GitOperationResult>) {
    ensureGitSuccess(await resultPromise);
    await onRepositoryChange();
    await loadAll();
  }

  async function reloadProjects() {
    const configuredProjects = await apiClient.getProjects();
    const statusById = new Map(projects.map((item) => [item.id, item.status]));
    const nextProjects = configuredProjects.map((item) => ({ ...item, status: statusById.get(item.id) }));
    onProjectsChange(nextProjects);
    await loadAll(nextProjects);
  }

  function requireProject(): GitProject {
    if (!project) {
      throw new Error("请先选择一个 Git 项目。");
    }
    return project;
  }

  function findBranch(branchId: string) {
    const branch = data.branches.data.find((item) => item.id === branchId);
    if (!branch) {
      throw new Error("分支记录已变化，请刷新后重试。");
    }
    return branch;
  }

  const actions = useMemo<RepositoryCenterActions>(() => ({
    onClose,
    onReload: (_section: RepositoryCenterSection) => loadAll(),
    onCreateStash: (input) => completeGit(apiClient.createStash(requireProject(), input)),
    onApplyStash: (stashId) => completeGit(apiClient.applyStash(requireProject(), stashId)),
    onPopStash: (stashId) => completeGit(apiClient.popStash(requireProject(), stashId)),
    onDeleteStash: (stashId) => completeGit(apiClient.dropStash(requireProject(), stashId)),
    onContinueOperation: (kind) => {
      const selected = requireProject();
      if (kind === "merge") return completeGit(apiClient.continueMerge(selected));
      if (kind === "rebase") return completeGit(apiClient.continueRebase(selected));
      if (kind === "cherry-pick") return completeGit(apiClient.continueCherryPick(selected));
      if (kind === "revert") return completeGit(apiClient.continueRevert(selected));
      throw new Error("二分定位请明确选择标记正常或标记异常。");
    },
    onSkipOperation: (kind) => {
      const selected = requireProject();
      if (kind === "rebase") return completeGit(apiClient.skipRebase(selected));
      if (kind === "cherry-pick") return completeGit(apiClient.skipCherryPick(selected));
      if (kind === "revert") return completeGit(apiClient.skipRevert(selected));
      if (kind === "bisect") return completeGit(apiClient.skipBisect(selected));
      throw new Error("合并操作不支持跳过。");
    },
    onAbortOperation: (kind) => {
      const selected = requireProject();
      if (kind === "merge") return completeGit(apiClient.abortMerge(selected));
      if (kind === "rebase") return completeGit(apiClient.abortRebase(selected));
      if (kind === "cherry-pick") return completeGit(apiClient.abortCherryPick(selected));
      if (kind === "revert") return completeGit(apiClient.abortRevert(selected));
      return completeGit(apiClient.resetBisect(selected));
    },
    onMarkBisect: (result) => completeGit(result === "good" ? apiClient.markBisectGood(requireProject()) : apiClient.markBisectBad(requireProject())),
    onStartBisect: ({ badRef, goodRef }) => completeGit(apiClient.startBisect(requireProject(), badRef, goodRef)),
    onLoadRebasePlan: async (target) => apiClient.getRebasePlan(requireProject(), target),
    onStartRebase: ({ target, interactive, onto, plan }) => interactive
      ? completeGit(apiClient.startInteractiveRebase(requireProject(), target, plan ?? [], onto))
      : completeGit(apiClient.startRebase(requireProject(), target, onto)),
    onSaveRemote: async (input) => {
      const selected = requireProject();
      if (input.id) {
        await completeGit(apiClient.updateRemote(selected, input.id, { name: input.name, fetchUrl: input.fetchUrl, pushUrl: input.pushUrl }));
        return;
      }
      ensureGitSuccess(await apiClient.addRemote(selected, input.name, input.fetchUrl, input.pushUrl));
      await onRepositoryChange();
      await loadAll();
    },
    onDeleteRemote: (remoteId) => completeGit(apiClient.removeRemote(requireProject(), remoteId)),
    onFetchRemote: (remoteId) => completeGit(apiClient.fetchRemote(requireProject(), remoteId)),
    onPruneRemote: (remoteId) => completeGit(apiClient.fetchRemote(requireProject(), remoteId, true)),
    onSetDefaultRemote: ({ remoteId, role }) => completeGit(apiClient.setDefaultRemote(requireProject(), remoteId, role, requireProject().status?.currentBranch ?? undefined)),
    onRenameBranch: ({ branchId, nextName }) => completeGit(apiClient.renameBranch(requireProject(), findBranch(branchId).name, nextName)),
    onDeleteBranch: (branchId, force) => completeGit(apiClient.deleteBranch(requireProject(), findBranch(branchId).name, force)),
    onDeleteRemoteBranch: (branchId) => {
      const branch = findBranch(branchId);
      const separator = branch.name.indexOf("/");
      if (branch.kind !== "remote" || separator <= 0 || separator === branch.name.length - 1) {
        throw new Error("远程分支引用无效，无法确定远程仓库与分支名。");
      }
      return completeGit(apiClient.deleteRemoteBranch(requireProject(), branch.name.slice(0, separator), branch.name.slice(separator + 1)));
    },
    onSetBranchUpstream: ({ branchId, upstream }) => {
      const branch = findBranch(branchId);
      return completeGit(upstream ? apiClient.setBranchUpstream(requireProject(), branch.name, upstream) : apiClient.unsetBranchUpstream(requireProject(), branch.name));
    },
    onCreateTag: ({ name, target, message, annotated }) => completeGit(apiClient.createTag(requireProject(), name, target, annotated ? message : undefined)),
    onDeleteTag: (tagId) => completeGit(apiClient.deleteTag(requireProject(), tagId)),
    onDeleteRemoteTag: ({ tagId, remoteId }) => completeGit(apiClient.deleteRemoteTag(requireProject(), remoteId, tagId)),
    onPushTag: ({ tagId, remoteId }) => completeGit(apiClient.pushTag(requireProject(), remoteId, tagId)),
    onRestoreReflog: ({ entryId, mode, branchName }) => mode === "branch"
      ? completeGit(apiClient.createBranch(requireProject(), branchName ?? "", false, entryId))
      : completeGit(apiClient.resetToReflogEntry(requireProject(), entryId, mode === "reset-hard" ? "hard" : "mixed")),
    onAddWorktree: ({ path, branch, createBranch }) => completeGit(apiClient.addLinkedWorktree(requireProject(), createBranch ? { path, newBranch: branch } : { path, ref: branch || undefined })),
    onRemoveWorktree: (worktreeId, force) => completeGit(apiClient.removeLinkedWorktree(requireProject(), worktreeId, force)),
    onPruneWorktrees: () => completeGit(apiClient.pruneLinkedWorktrees(requireProject())),
    onInitSubmodules: () => completeGit(apiClient.initializeSubmodules(requireProject())),
    onUpdateSubmodules: (recursive) => completeGit(apiClient.updateSubmodules(requireProject(), { initialize: true, recursive })),
    onSyncSubmodules: () => completeGit(apiClient.syncSubmodules(requireProject(), true)),
    onInstallLfs: () => completeGit(apiClient.installLfs(requireProject(), "local")),
    onPullLfs: () => completeGit(apiClient.pullLfs(requireProject())),
    onPruneLfs: () => completeGit(apiClient.pruneLfs(requireProject())),
    onSaveGitignore: async (content, expectedRevision) => {
      await apiClient.writeGitIgnore(requireProject(), content, expectedRevision);
      await onRepositoryChange();
      await loadAll();
    },
    onSaveSigning: (settings) => completeGit(apiClient.setSigningConfig(requireProject(), {
      commitGpgSign: settings.enabled,
      tagGpgSign: settings.signTags,
      format: settings.format,
      signingKey: settings.key || null
    })),
    onTestSigning: () => completeGit(apiClient.verifyCommitSignature(requireProject(), "HEAD")),
    onOpenHostingLink: async (linkId) => {
      const link = data.hosting.data.find((item) => item.id === linkId);
      if (!link) throw new Error("托管平台链接已变化，请刷新后重试。");
      await apiClient.openExternal(link.url);
    },
    onCopyHostingLink: async (linkId) => {
      const link = data.hosting.data.find((item) => item.id === linkId);
      if (!link) throw new Error("托管平台链接已变化，请刷新后重试。");
      await navigator.clipboard.writeText(link.url);
    },
    onCloneRepository: async (input) => {
      const created = await apiClient.cloneRepository(input.url, input.destination, {
        branch: input.branch,
        depth: input.depth,
        recurseSubmodules: input.recurseSubmodules
      });
      ensureGitSuccess(created.result);
      await reloadProjects();
    },
    onInitRepository: async (input) => {
      const created = await apiClient.initializeRepository(input.path, input.initialBranch, input.createGitignore);
      ensureGitSuccess(created.result);
      await reloadProjects();
    },
    onCreateGroup: async (name) => { await apiClient.createProjectGroup(name); await loadAll(); },
    onRenameGroup: async ({ groupId, name }) => { await apiClient.renameProjectGroup(groupId, name); await loadAll(); },
    onDeleteGroup: async (groupId) => { await apiClient.deleteProjectGroup(groupId); await reloadProjects(); },
    onAssignProjectGroup: async ({ projectId, groupId }) => { await apiClient.setProjectGroup(projectId, groupId ?? undefined); await reloadProjects(); },
    onOpenProject: async (projectId) => { await apiClient.markProjectOpened(projectId); onOpenProject(projectId); await loadAll(); },
    onRemoveRecentProject: async (projectId) => { await apiClient.removeRecentProject(projectId); await loadAll(); },
    onRunBatchAction: async ({ projectIds, action }) => {
      const results = await Promise.all(projectIds.map(async (projectId) => {
        const target = projects.find((item) => item.id === projectId);
        if (!target) {
          return { projectId, name: projectId, error: "项目已被移除。" };
        }
        try {
          if (action === "fetch") {
            ensureGitSuccess(await apiClient.fetch(target));
          } else if (action === "pull") {
            ensureGitSuccess(await apiClient.pull(target));
          } else if (action === "prune") {
            const targetRemotes = await apiClient.getRemotes(target);
            for (const remote of targetRemotes) {
              ensureGitSuccess(await apiClient.fetchRemote(target, remote.name, true));
            }
          }
          return { projectId, name: target.name, status: await apiClient.getProjectStatus(target) };
        } catch (error) {
          return { projectId, name: target.name, error: error instanceof Error ? error.message : String(error) };
        }
      }));

      const statusById = new Map(results.flatMap((result) => result.status ? [[result.projectId, result.status] as const] : []));
      const updatedProjects = projects.map((item) => statusById.has(item.id) ? { ...item, status: statusById.get(item.id) } : item);
      onProjectsChange(updatedProjects);
      await loadAll(updatedProjects);

      const failures = results.filter((result) => result.error);
      if (failures.length > 0) {
        throw new Error([
          `批量操作完成：${results.length - failures.length} 个成功，${failures.length} 个失败。`,
          ...failures.map((result) => `${result.name}：${result.error}`)
        ].join("\n"));
      }
      await onRepositoryChange();
    },
    onSavePreferences: async (preferences) => {
      const saved = await apiClient.updateUiPreferences(fromRepositoryPreferences(preferences));
      onPreferencesChange(saved);
      await loadAll();
    }
  }), [data, loadAll, onClose, onOpenProject, onPreferencesChange, onProjectsChange, onRepositoryChange, project, projects]);

  const currentStatus = project?.status;
  return (
    <RepositoryCenter
      open={open}
      initialTab={initialTab}
      repository={{
        id: project?.id ?? "no-project",
        name: project?.name ?? "项目管理",
        path: project?.path ?? "未选择仓库",
        branch: currentStatus?.currentBranch ?? null,
        upstream: currentStatus?.upstream,
        ahead: currentStatus?.ahead ?? 0,
        behind: currentStatus?.behind ?? 0,
        changedFiles: currentStatus ? currentStatus.stagedCount + currentStatus.unstagedCount + currentStatus.untrackedCount + currentStatus.conflictedCount : 0,
        hasConflicts: Boolean(currentStatus?.hasConflicts)
      }}
      data={data}
      actions={actions}
    />
  );
}

function emptyCenterData(): RepositoryCenterData {
  return {
    stashes: readyResource([]), operation: readyResource(null), rebaseTargets: readyResource([]), remotes: readyResource([]), branches: readyResource([]),
    tags: readyResource([]), reflog: readyResource([]), worktrees: readyResource([]), submodules: readyResource([]),
    lfs: readyResource({ installed: false, initialized: false, version: "", changedFileCount: 0, stagedFileCount: 0 }),
    gitignore: readyResource({ path: ".gitignore", content: "", revision: "missing", modified: false }),
    signing: readyResource({ enabled: false, format: "openpgp", key: "", signTags: false }),
    hosting: readyResource([]), projects: readyResource([]), groups: readyResource([]), recent: readyResource([]),
    preferences: readyResource(toRepositoryPreferences(defaultPreferences()))
  };
}

function loadingCenterData(data: RepositoryCenterData): RepositoryCenterData {
  return Object.fromEntries(Object.entries(data).map(([key, resource]) => [key, { ...resource, status: "loading", error: undefined }])) as unknown as RepositoryCenterData;
}

async function asResource<T>(loader: () => Promise<T>): Promise<RepositoryResource<T>> {
  try {
    return readyResource(await loader());
  } catch (error) {
    return errorResource(error instanceof Error ? error.message : String(error));
  }
}

function readyResource<T>(data: T): RepositoryResource<T> {
  return { status: "ready", data };
}

function errorResource<T>(error = "读取失败", data = undefined as T): RepositoryResource<T> {
  return { status: "error", data, error };
}

function mapResource<T, U>(resource: RepositoryResource<T>, mapper: (value: T) => U, fallback: U): RepositoryResource<U> {
  return resource.status === "ready" ? readyResource(mapper(resource.data)) : errorResource(resource.error, fallback);
}

function ensureGitSuccess(result: GitOperationResult) {
  if (!result.ok) {
    throw new Error([result.messageZh, result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n") || "Git 操作失败。");
  }
}

function activeOperation(status?: GitStatusSummary): RepositoryActiveOperation | null {
  const kind = status?.operationState;
  if (!kind) return null;
  return {
    kind,
    source: status?.mergeSourceBranch,
    target: status?.mergeTargetBranch,
    conflictedFiles: status.conflictedCount,
    canContinue: !status.hasConflicts,
    canSkip: kind !== "merge",
    canAbort: true
  };
}

function projectSummary(project: GitProject): RepositoryProjectSummary {
  const status = project.status;
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    branch: status?.currentBranch ?? null,
    groupId: project.groupId,
    changedFiles: status ? status.stagedCount + status.unstagedCount + status.untrackedCount + status.conflictedCount : 0,
    ahead: status?.ahead ?? 0,
    behind: status?.behind ?? 0,
    lastOpenedAt: project.lastOpenedAt
  };
}

async function loadHostingResources(
  project: GitProject,
  remotes: Array<{ name: string; fetchUrls: string[] }>,
  branchName?: string
): Promise<RepositoryResource<RepositoryHostingLink[]>> {
  const supportedRemotes = remotes.filter((remote) => remote.fetchUrls.some(isSupportedHostingRemote));
  if (supportedRemotes.length === 0) {
    return readyResource([]);
  }
  const resources = await Promise.all(supportedRemotes.map(async (remote) => ({
    remote,
    resource: await asResource(() => apiClient.getHostingLinks(project, remote.name, undefined, branchName))
  })));
  const failed = resources.filter((item) => item.resource.status === "error");
  if (failed.length > 0) {
    return errorResource(failed.map((item) => `${item.remote.name}：${item.resource.error}`).join("\n"), []);
  }
  return readyResource(resources.flatMap(({ remote, resource }) => hostingLinks(resource.data, remote.name)));
}

function hostingLinks(links: GitHostingLinks, remoteName: string): RepositoryHostingLink[] {
  const entries: RepositoryHostingLink[] = [
    { id: `${remoteName}:repository`, label: `${remoteName} · 仓库主页`, provider: links.provider, kind: "repository", url: links.repositoryUrl },
    { id: `${remoteName}:commits`, label: `${remoteName} · 提交记录`, provider: links.provider, kind: "commits", url: links.commitsUrl },
    { id: `${remoteName}:branches`, label: `${remoteName} · 分支管理`, provider: links.provider, kind: "branches", url: links.branchesUrl },
    { id: `${remoteName}:pullRequests`, label: `${remoteName} · ${links.provider === "github" ? "Pull Requests" : "合并请求"}`, provider: links.provider, kind: "pullRequests", url: links.pullRequestsUrl },
    { id: `${remoteName}:issues`, label: `${remoteName} · Issues`, provider: links.provider, kind: "issues", url: links.issuesUrl }
  ];
  if (links.branchUrl) entries.push({ id: `${remoteName}:current-branch`, label: `${remoteName} · 当前分支`, provider: links.provider, kind: "branches", url: links.branchUrl });
  return entries;
}

function isSupportedHostingRemote(remoteUrl: string): boolean {
  const source = remoteUrl.trim();
  let host = "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    try {
      host = new URL(source).hostname.toLocaleLowerCase();
    } catch {
      return false;
    }
  } else {
    host = source.match(/^(?:[^@/:]+@)?([^/:]+):/)?.[1]?.toLocaleLowerCase() ?? "";
  }
  return ["github.com", "gitlab.com", "gitee.com"].includes(host.replace(/^www\./, ""));
}

function toRepositoryPreferences(value: UiPreferences): RepositoryPreferences {
  return {
    theme: value.theme,
    fontFamily: value.fontFamily.toLowerCase().includes("mono") ? "mono" : "system",
    fontSize: value.fontSize,
    diffMode: value.diffViewMode,
    diffWrap: value.diffWrap,
    density: value.density,
    sidebarPosition: value.sidebarPosition,
    sidebarWidth: value.sidebarWidth,
    rightPanelWidth: value.rightPanelWidth,
    consoleHeight: value.consoleHeight,
    bottomConsoleVisible: value.bottomConsoleVisible,
    confirmDestructiveActions: value.confirmDestructiveActions,
    shortcuts: Object.entries(value.shortcuts).map(([id, keys]) => ({ id, label: shortcutLabels[id] ?? id, keys }))
  };
}

function fromRepositoryPreferences(value: RepositoryPreferences): Partial<UiPreferences> {
  return {
    theme: value.theme,
    fontFamily: value.fontFamily === "mono" ? "monospace" : "system-ui",
    fontSize: value.fontSize,
    diffViewMode: value.diffMode,
    diffWrap: value.diffWrap,
    density: value.density,
    sidebarPosition: value.sidebarPosition,
    sidebarWidth: value.sidebarWidth,
    rightPanelWidth: value.rightPanelWidth,
    consoleHeight: value.consoleHeight,
    bottomConsoleVisible: value.bottomConsoleVisible,
    confirmDestructiveActions: value.confirmDestructiveActions,
    shortcuts: Object.fromEntries(value.shortcuts.map((shortcut) => [shortcut.id, shortcut.keys]))
  };
}

function defaultPreferences(): UiPreferences {
  return {
    theme: "system", language: "zh-CN", bottomConsoleVisible: true, sidebarWidth: 240, rightPanelWidth: 420, consoleHeight: 240,
    fontSize: 14, fontFamily: "system-ui", diffViewMode: "split", diffWrap: false, density: "comfortable", sidebarPosition: "left",
    confirmDestructiveActions: true, shortcuts: {}
  };
}

function stashIndex(selector: string, fallback: number) {
  const match = selector.match(/\{(\d+)\}/);
  return match ? Number(match[1]) : fallback;
}

function stashBranch(subject: string) {
  return subject.match(/(?:WIP on|On) ([^:]+):/)?.[1] ?? "当前分支";
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}
