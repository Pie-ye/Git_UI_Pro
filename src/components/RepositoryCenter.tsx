import {
  Archive,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpRight,
  Blocks,
  Box,
  Check,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Cloud,
  CloudOff,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  FolderClock,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitCompareArrows,
  GitMerge,
  HardDrive,
  History,
  KeyRound,
  Layers3,
  Link2,
  ListRestart,
  LoaderCircle,
  MonitorCog,
  Package,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Tags,
  Terminal,
  Trash2,
  UploadCloud,
  X
} from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import "../styles/repository-center.css";

export type RepositoryCenterTab = "recovery" | "refs" | "remotes" | "tools" | "projects" | "preferences";

export type RepositoryCenterSection =
  | "stashes"
  | "operation"
  | "rebaseTargets"
  | "remotes"
  | "branches"
  | "tags"
  | "reflog"
  | "worktrees"
  | "submodules"
  | "lfs"
  | "gitignore"
  | "signing"
  | "hosting"
  | "projects"
  | "groups"
  | "recent"
  | "preferences";

export type RepositoryResourceStatus = "loading" | "ready" | "error";

export interface RepositoryResource<T> {
  status: RepositoryResourceStatus;
  data: T;
  error?: string;
}

export interface RepositoryCenterContext {
  id: string;
  name: string;
  path: string;
  branch: string | null;
  upstream?: string;
  ahead: number;
  behind: number;
  changedFiles: number;
  hasConflicts: boolean;
}

export interface RepositoryStash {
  id: string;
  targetHash: string;
  index: number;
  subject: string;
  branch: string;
  createdAt: string;
  author?: string;
  fileCount?: number;
}

export type RepositoryOperationKind = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";

export interface RepositoryActiveOperation {
  kind: RepositoryOperationKind;
  currentStep?: number;
  totalSteps?: number;
  source?: string;
  target?: string;
  conflictedFiles: number;
  canContinue: boolean;
  canSkip: boolean;
  canAbort: boolean;
}

export interface RepositoryRebaseTarget {
  ref: string;
  label: string;
  kind: "local" | "remote" | "tag";
  isCurrent?: boolean;
}

export type RepositoryRebaseAction = "pick" | "edit" | "squash" | "fixup" | "drop";

export interface RepositoryRebasePlanItem {
  hash: string;
  shortHash: string;
  subject: string;
  action: RepositoryRebaseAction;
}

export interface RepositoryRemote {
  id: string;
  name: string;
  fetchUrl: string;
  pushUrl: string;
  explicitPushUrl?: string;
  isDefaultFetch?: boolean;
  isDefaultPush?: boolean;
}

export interface RepositoryBranch {
  id: string;
  name: string;
  kind: "local" | "remote";
  current: boolean;
  upstream?: string;
  headHash: string;
  ahead?: number;
  behind?: number;
  merged?: boolean;
}

export interface RepositoryTag {
  id: string;
  name: string;
  targetHash: string;
  subject?: string;
  annotated: boolean;
  pushedRemotes: string[];
}

export interface RepositoryReflogEntry {
  id: string;
  targetHash: string;
  selector: string;
  shortHash: string;
  action: string;
  subject: string;
  createdAt: string;
}

export interface RepositoryWorktree {
  id: string;
  path: string;
  branch?: string;
  headHash: string;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
}

export interface RepositorySubmodule {
  id: string;
  name: string;
  path: string;
  url: string;
  branch?: string;
  status: "ready" | "uninitialized" | "modified" | "conflict";
  headHash?: string;
}

export interface RepositoryLfsStatus {
  installed: boolean;
  initialized: boolean;
  version: string;
  changedFileCount: number;
  stagedFileCount: number;
}

export interface RepositoryGitignore {
  path: string;
  content: string;
  revision: string;
  modified: boolean;
}

export type RepositorySigningFormat = "openpgp" | "ssh" | "x509";

export interface RepositorySigningSettings {
  enabled: boolean;
  format: RepositorySigningFormat;
  key: string;
  signTags: boolean;
}

export interface RepositoryHostingLink {
  id: string;
  label: string;
  provider: "github" | "gitlab" | "gitee" | "other";
  kind: "repository" | "commits" | "branches" | "pullRequests" | "issues";
  url: string;
}

export interface RepositoryProjectSummary {
  id: string;
  name: string;
  path: string;
  branch: string | null;
  groupId?: string;
  changedFiles: number;
  ahead: number;
  behind: number;
  statusError?: string;
  lastOpenedAt?: string;
}

export interface RepositoryProjectGroup {
  id: string;
  name: string;
  projectIds: string[];
}

export interface RepositoryShortcut {
  id: string;
  label: string;
  keys: string;
}

export interface RepositoryPreferences {
  theme: "system" | "light" | "dark";
  fontFamily: "system" | "mono";
  fontSize: number;
  diffMode: "split" | "inline";
  diffWrap: boolean;
  pullStrategy: "ff-only" | "rebase" | "rebase-autostash";
  density: "compact" | "comfortable";
  sidebarPosition: "left" | "right";
  sidebarWidth: number;
  rightPanelWidth: number;
  consoleHeight: number;
  bottomConsoleVisible: boolean;
  confirmDestructiveActions: boolean;
  shortcuts: RepositoryShortcut[];
}

export interface RepositoryCenterData {
  stashes: RepositoryResource<RepositoryStash[]>;
  operation: RepositoryResource<RepositoryActiveOperation | null>;
  rebaseTargets: RepositoryResource<RepositoryRebaseTarget[]>;
  remotes: RepositoryResource<RepositoryRemote[]>;
  branches: RepositoryResource<RepositoryBranch[]>;
  tags: RepositoryResource<RepositoryTag[]>;
  reflog: RepositoryResource<RepositoryReflogEntry[]>;
  worktrees: RepositoryResource<RepositoryWorktree[]>;
  submodules: RepositoryResource<RepositorySubmodule[]>;
  lfs: RepositoryResource<RepositoryLfsStatus>;
  gitignore: RepositoryResource<RepositoryGitignore>;
  signing: RepositoryResource<RepositorySigningSettings>;
  hosting: RepositoryResource<RepositoryHostingLink[]>;
  projects: RepositoryResource<RepositoryProjectSummary[]>;
  groups: RepositoryResource<RepositoryProjectGroup[]>;
  recent: RepositoryResource<RepositoryProjectSummary[]>;
  preferences: RepositoryResource<RepositoryPreferences>;
}

export interface RepositoryRemoteInput {
  id?: string;
  name: string;
  fetchUrl: string;
  pushUrl?: string | null;
}

export interface RepositoryCloneInput {
  url: string;
  destination: string;
  branch?: string;
  depth?: number;
  recurseSubmodules: boolean;
}

export interface RepositoryInitInput {
  path: string;
  initialBranch: string;
  createGitignore: boolean;
}

export type RepositoryBatchAction = "refresh" | "fetch" | "pull" | "prune";
export type RepositoryActionFeedback = void | string | Promise<void | string>;

export interface RepositoryCenterActions {
  onClose: () => void;
  onReload: (section: RepositoryCenterSection) => void | Promise<void>;
  onCreateStash: (input: { message: string; includeUntracked: boolean; keepIndex: boolean }) => void | Promise<void>;
  onApplyStash: (stashId: string) => void | Promise<void>;
  onPopStash: (stashId: string) => void | Promise<void>;
  onDeleteStash: (stashId: string) => void | Promise<void>;
  onContinueOperation: (kind: RepositoryOperationKind) => void | Promise<void>;
  onSkipOperation: (kind: RepositoryOperationKind) => void | Promise<void>;
  onAbortOperation: (kind: RepositoryOperationKind) => void | Promise<void>;
  onMarkBisect: (result: "good" | "bad") => RepositoryActionFeedback;
  onStartBisect: (input: { badRef: string; goodRef: string }) => void | Promise<void>;
  onLoadRebasePlan: (target: string) => Promise<RepositoryRebasePlanItem[]>;
  onStartRebase: (input: { target: string; interactive: boolean; onto?: string; plan?: RepositoryRebasePlanItem[] }) => void | Promise<void>;
  onSaveRemote: (input: RepositoryRemoteInput) => void | Promise<void>;
  onDeleteRemote: (remoteId: string) => void | Promise<void>;
  onFetchRemote: (remoteId: string) => void | Promise<void>;
  onPruneRemote: (remoteId: string) => void | Promise<void>;
  onSetDefaultRemote: (input: { remoteId: string; role: "fetch" | "push" }) => void | Promise<void>;
  onRenameBranch: (input: { branchId: string; nextName: string }) => void | Promise<void>;
  onDeleteBranch: (branchId: string, force: boolean) => void | Promise<void>;
  onDeleteRemoteBranch: (branchId: string) => void | Promise<void>;
  onSetBranchUpstream: (input: { branchId: string; upstream: string | null }) => void | Promise<void>;
  onCreateTag: (input: { name: string; target: string; message?: string; annotated: boolean }) => void | Promise<void>;
  onDeleteTag: (tagId: string) => void | Promise<void>;
  onDeleteRemoteTag: (input: { tagId: string; remoteId: string }) => void | Promise<void>;
  onPushTag: (input: { tagId: string; remoteId: string }) => void | Promise<void>;
  onRestoreReflog: (input: { entryId: string; mode: "branch" | "reset-mixed" | "reset-hard"; branchName?: string }) => void | Promise<void>;
  onAddWorktree: (input: { path: string; branch: string; createBranch: boolean }) => void | Promise<void>;
  onRemoveWorktree: (worktreeId: string, force: boolean) => void | Promise<void>;
  onPruneWorktrees: () => void | Promise<void>;
  onInitSubmodules: () => void | Promise<void>;
  onUpdateSubmodules: (recursive: boolean) => void | Promise<void>;
  onSyncSubmodules: () => void | Promise<void>;
  onInstallLfs: () => void | Promise<void>;
  onPullLfs: () => void | Promise<void>;
  onPruneLfs: () => void | Promise<void>;
  onSaveGitignore: (content: string, expectedRevision: string) => void | Promise<void>;
  onSaveSigning: (settings: RepositorySigningSettings) => void | Promise<void>;
  onTestSigning: (settings: RepositorySigningSettings) => RepositoryActionFeedback;
  onOpenHostingLink: (linkId: string) => void | Promise<void>;
  onCopyHostingLink: (linkId: string) => void | Promise<void>;
  onCloneRepository: (input: RepositoryCloneInput) => void | Promise<void>;
  onInitRepository: (input: RepositoryInitInput) => void | Promise<void>;
  onCreateGroup: (name: string) => void | Promise<void>;
  onRenameGroup: (input: { groupId: string; name: string }) => void | Promise<void>;
  onDeleteGroup: (groupId: string) => void | Promise<void>;
  onAssignProjectGroup: (input: { projectId: string; groupId: string | null }) => void | Promise<void>;
  onOpenProject: (projectId: string) => void | Promise<void>;
  onRemoveRecentProject: (projectId: string) => void | Promise<void>;
  onRunBatchAction: (input: { projectIds: string[]; action: RepositoryBatchAction }) => void | Promise<void>;
  onSavePreferences: (preferences: RepositoryPreferences) => void | Promise<void>;
}

export interface RepositoryCenterProps {
  open: boolean;
  repository: RepositoryCenterContext;
  data: RepositoryCenterData;
  actions: RepositoryCenterActions;
  initialTab?: RepositoryCenterTab;
}

interface TabDefinition {
  id: RepositoryCenterTab;
  label: string;
  description: string;
  icon: typeof Archive;
}

const TABS: TabDefinition[] = [
  { id: "recovery", label: "安全与恢复", description: "暂存、进行中操作与找回", icon: ShieldCheck },
  { id: "refs", label: "分支与发布", description: "变基、分支和标签", icon: GitBranch },
  { id: "remotes", label: "远程与托管", description: "远程仓库与平台入口", icon: Cloud },
  { id: "tools", label: "仓库工具", description: "工作树、子模块与 LFS", icon: Blocks },
  { id: "projects", label: "项目管理", description: "创建、分组和批处理", icon: FolderGit2 },
  { id: "preferences", label: "偏好设置", description: "显示、差异和快捷键", icon: Settings2 }
];

const OPERATION_LABELS: Record<RepositoryOperationKind, string> = {
  merge: "合并",
  rebase: "变基",
  "cherry-pick": "摘取提交",
  revert: "还原提交",
  bisect: "二分查找"
};

const SECTION_LABELS: Record<RepositoryCenterSection, string> = {
  stashes: "暂存记录",
  operation: "进行中操作",
  rebaseTargets: "变基目标",
  remotes: "远程仓库",
  branches: "分支",
  tags: "标签",
  reflog: "引用日志",
  worktrees: "Git 工作树",
  submodules: "子模块",
  lfs: "Git LFS",
  gitignore: ".gitignore",
  signing: "提交签名",
  hosting: "托管平台",
  projects: "项目",
  groups: "项目分组",
  recent: "最近项目",
  preferences: "偏好设置"
};

const DestructiveConfirmationContext = createContext(true);

export function RepositoryCenter({ open, repository, data, actions, initialTab = "recovery" }: RepositoryCenterProps) {
  const [activeTab, setActiveTab] = useState<RepositoryCenterTab>(initialTab);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const closeActionRef = useRef(actions.onClose);
  const pendingActionRef = useRef<string | null>(null);

  useEffect(() => {
    closeActionRef.current = actions.onClose;
  }, [actions.onClose]);

  useEffect(() => {
    pendingActionRef.current = pendingAction;
  }, [pendingAction]);

  useEffect(() => {
    if (open) {
      setActionError("");
      setActionNotice("");
      setActiveTab(initialTab);
    }
  }, [initialTab, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (pendingActionRef.current === null) {
          closeActionRef.current();
        }
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) {
        return;
      }
      const focusable = dialogFocusableElements(dialogRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      openerRef.current?.focus();
    };
  }, [open]);

  if (!open) {
    return null;
  }

  async function runAction(key: string, task: () => RepositoryActionFeedback) {
    if (pendingAction !== null) {
      return;
    }
    pendingActionRef.current = key;
    setPendingAction(key);
    setActionError("");
    setActionNotice("");
    try {
      const feedback = await task();
      if (typeof feedback === "string" && feedback.trim()) {
        setActionNotice(feedback.trim());
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  }

  function reload(section: RepositoryCenterSection) {
    void runAction(`reload:${section}`, () => actions.onReload(section));
  }

  const activeDefinition = TABS.find((tab) => tab.id === activeTab)!;

  return (
    <DestructiveConfirmationContext.Provider value={data.preferences.data.confirmDestructiveActions !== false}>
    <div className="repository-center-backdrop" role="presentation">
      <section ref={dialogRef} tabIndex={-1} className="repository-center" role="dialog" aria-modal="true" aria-labelledby="repository-center-title" aria-busy={pendingAction !== null}>
        <header className="repository-center-header">
          <div className="repository-center-heading">
            <span className="repository-center-heading-icon"><FolderGit2 size={19} /></span>
            <span>
              <small>仓库中心</small>
              <strong id="repository-center-title">{repository.name}</strong>
            </span>
          </div>
          <div className="repository-center-repository-lens" data-conflicts={repository.hasConflicts}>
            <span><GitBranch size={14} />{repository.branch ?? "游离 HEAD"}</span>
            {repository.upstream ? <code>{repository.upstream}</code> : <em>未设置上游</em>}
            <span className="repository-center-sync-counts">
              <span aria-label={`领先 ${repository.ahead} 个提交`}>↑ {repository.ahead}</span>
              <span aria-label={`落后 ${repository.behind} 个提交`}>↓ {repository.behind}</span>
              <span>{repository.changedFiles} 项变更</span>
            </span>
          </div>
          <button className="repository-center-icon-button" type="button" title={pendingAction ? "操作完成后才能关闭" : "关闭仓库中心"} aria-label="关闭仓库中心" disabled={pendingAction !== null} onClick={actions.onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="repository-center-feedback">
          {actionError ? (
            <div className="repository-center-action-error" role="alert">
              <CircleAlert size={16} />
              <span>{actionError}</span>
              <button type="button" aria-label="关闭错误提示" title="关闭错误提示" onClick={() => setActionError("")}><X size={15} /></button>
            </div>
          ) : null}
          {actionNotice ? (
            <div className="repository-center-action-notice" role="status">
              <Check size={16} />
              <span>{actionNotice}</span>
              <button type="button" aria-label="关闭操作结果" title="关闭操作结果" onClick={() => setActionNotice("")}><X size={15} /></button>
            </div>
          ) : null}
        </div>

        <div className="repository-center-layout">
          <nav className="repository-center-nav" aria-label="仓库管理功能">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={activeTab === tab.id ? "active" : ""}
                  aria-current={activeTab === tab.id ? "page" : undefined}
                  disabled={pendingAction !== null}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <Icon size={17} />
                  <span><strong>{tab.label}</strong><small>{tab.description}</small></span>
                  <ChevronRight size={15} />
                </button>
              );
            })}
            <div className="repository-center-path" title={repository.path}>
              <HardDrive size={14} />
              <code>{repository.path}</code>
            </div>
          </nav>

          <main className="repository-center-content">
            <div className="repository-center-content-heading">
              <span>
                <small>{activeDefinition.description}</small>
                <strong>{activeDefinition.label}</strong>
              </span>
            </div>
            {activeTab === "recovery" ? <RecoveryWorkspace data={data} actions={actions} pendingAction={pendingAction} runAction={runAction} reload={reload} /> : null}
            {activeTab === "refs" ? <RefsWorkspace data={data} actions={actions} pendingAction={pendingAction} runAction={runAction} reload={reload} /> : null}
            {activeTab === "remotes" ? <RemotesWorkspace data={data} actions={actions} pendingAction={pendingAction} runAction={runAction} reload={reload} /> : null}
            {activeTab === "tools" ? <ToolsWorkspace data={data} actions={actions} pendingAction={pendingAction} runAction={runAction} reload={reload} /> : null}
            {activeTab === "projects" ? <ProjectsWorkspace data={data} actions={actions} pendingAction={pendingAction} runAction={runAction} reload={reload} /> : null}
            {activeTab === "preferences" ? <PreferencesWorkspace data={data} actions={actions} pendingAction={pendingAction} runAction={runAction} reload={reload} /> : null}
          </main>
        </div>
      </section>
    </div>
    </DestructiveConfirmationContext.Provider>
  );
}

type RunAction = (key: string, task: () => RepositoryActionFeedback) => Promise<void>;

interface WorkspaceProps {
  data: RepositoryCenterData;
  actions: RepositoryCenterActions;
  pendingAction: string | null;
  runAction: RunAction;
  reload: (section: RepositoryCenterSection) => void;
}

function ResourceBoundary<T>({ section, resource, reload, children }: {
  section: RepositoryCenterSection;
  resource: RepositoryResource<T>;
  reload: (section: RepositoryCenterSection) => void;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === "loading") {
    return <div className="repository-center-state"><LoaderCircle className="spin" size={18} /><span>正在读取{SECTION_LABELS[section]}…</span></div>;
  }
  if (resource.status === "error") {
    return (
      <div className="repository-center-state error" role="alert">
        <CircleAlert size={18} />
        <span><strong>{SECTION_LABELS[section]}读取失败</strong><small>{resource.error}</small></span>
        <button type="button" className="repository-center-button secondary" onClick={() => reload(section)}><RefreshCw size={15} />重试</button>
      </div>
    );
  }
  return <>{children(resource.data)}</>;
}

function SectionHeader({ icon, title, description, actions }: { icon: ReactNode; title: string; description: string; actions?: ReactNode }) {
  return (
    <header className="repository-center-section-header">
      <span className="repository-center-section-icon">{icon}</span>
      <span><strong>{title}</strong><small>{description}</small></span>
      {actions ? <div className="repository-center-section-actions">{actions}</div> : null}
    </header>
  );
}

function EmptyState({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return <div className="repository-center-empty">{icon}<span><strong>{title}</strong><small>{description}</small></span></div>;
}

function ActionButton({ label, actionKey, pendingAction, onClick, icon, tone = "secondary", disabled = false, type = "button", requiresConfirmation = false, confirmLabel }: {
  label: string;
  actionKey: string;
  pendingAction: string | null;
  onClick?: () => void;
  icon: ReactNode;
  tone?: "primary" | "secondary" | "danger" | "warning";
  disabled?: boolean;
  type?: "button" | "submit";
  requiresConfirmation?: boolean;
  confirmLabel?: string;
}) {
  const loading = pendingAction === actionKey;
  const [confirming, setConfirming] = useState(false);
  const confirmationEnabled = useContext(DestructiveConfirmationContext);
  const confirmationText = confirmLabel ?? `确认${label}`;

  useEffect(() => {
    if (loading) {
      setConfirming(false);
    }
  }, [loading]);

  function handleClick(event: ReactMouseEvent<HTMLButtonElement>) {
    if (requiresConfirmation && confirmationEnabled && !confirming) {
      event.preventDefault();
      setConfirming(true);
      return;
    }
    onClick?.();
  }

  return (
    <button
      className={`repository-center-button ${tone} ${confirming ? "confirming" : ""}`}
      type={type}
      disabled={disabled || pendingAction !== null}
      onClick={handleClick}
      onBlur={() => setConfirming(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setConfirming(false);
        }
      }}
    >
      {loading ? <LoaderCircle className="spin" size={15} /> : confirming ? <CircleAlert size={15} /> : icon}
      {confirming ? confirmationText : label}
    </button>
  );
}

function RecoveryWorkspace({ data, actions, pendingAction, runAction, reload }: WorkspaceProps) {
  const [stashMessage, setStashMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [keepIndex, setKeepIndex] = useState(false);
  const [restoreMode, setRestoreMode] = useState<"branch" | "reset-mixed" | "reset-hard">("branch");
  const [restoreBranch, setRestoreBranch] = useState("recovery");
  const [bisectBadRef, setBisectBadRef] = useState("HEAD");
  const [bisectGoodRef, setBisectGoodRef] = useState("");

  return (
    <div className="repository-center-workspace repository-center-recovery-workspace">
      <section className="repository-center-section">
        <SectionHeader icon={<Archive size={17} />} title="暂存工作区" description="保存当前修改并在需要时恢复" />
        <form className="repository-center-composer" onSubmit={(event) => {
          event.preventDefault();
          void runAction("stash:create", async () => {
            await actions.onCreateStash({ message: stashMessage.trim(), includeUntracked, keepIndex });
            setStashMessage("");
          });
        }}>
          <label className="repository-center-field grow"><span>说明</span><input value={stashMessage} onChange={(event) => setStashMessage(event.target.value)} placeholder="例如：切换分支前保存登录页修改" /></label>
          <label className="repository-center-check"><input type="checkbox" checked={includeUntracked} onChange={(event) => setIncludeUntracked(event.target.checked)} /><span>包含未跟踪文件</span></label>
          <label className="repository-center-check"><input type="checkbox" checked={keepIndex} onChange={(event) => setKeepIndex(event.target.checked)} /><span>保留暂存区</span></label>
          <ActionButton label="创建暂存" actionKey="stash:create" pendingAction={pendingAction} type="submit" icon={<Plus size={15} />} tone="primary" />
        </form>
        <ResourceBoundary section="stashes" resource={data.stashes} reload={reload}>{(stashes) => stashes.length === 0 ? (
          <EmptyState icon={<Archive size={20} />} title="没有暂存记录" description="创建后可在这里应用、弹出或删除。" />
        ) : (
          <div className="repository-center-record-list">
            {stashes.map((stash) => <div className="repository-center-record" key={stash.id}>
              <span className="repository-center-record-leading"><Archive size={16} /></span>
              <span className="repository-center-record-main"><strong>{stash.subject}</strong><small><code>stash@&#123;{stash.index}&#125;</code> · {stash.branch} · {stash.createdAt}{stash.fileCount !== undefined ? ` · ${stash.fileCount} 个文件` : ""}</small></span>
              <div className="repository-center-row-actions">
                <ActionButton label="应用" actionKey={`stash:apply:${stash.id}`} pendingAction={pendingAction} onClick={() => void runAction(`stash:apply:${stash.id}`, () => actions.onApplyStash(stash.targetHash))} icon={<Play size={14} />} />
                <ActionButton label="弹出" actionKey={`stash:pop:${stash.id}`} pendingAction={pendingAction} onClick={() => void runAction(`stash:pop:${stash.id}`, () => actions.onPopStash(stash.targetHash))} icon={<ArrowDownToLine size={14} />} />
                <ActionButton label="删除" actionKey={`stash:delete:${stash.id}`} pendingAction={pendingAction} onClick={() => void runAction(`stash:delete:${stash.id}`, () => actions.onDeleteStash(stash.targetHash))} icon={<Trash2 size={14} />} tone="danger" requiresConfirmation confirmLabel="确认删除暂存" />
              </div>
            </div>)}
          </div>
        )}</ResourceBoundary>
        {data.operation.status === "ready" && data.operation.data === null ? (
          <form className="repository-center-composer compact" onSubmit={(event) => {
            event.preventDefault();
            void runAction("bisect:start", () => actions.onStartBisect({ badRef: bisectBadRef.trim(), goodRef: bisectGoodRef.trim() }));
          }}>
            <label className="repository-center-field"><span>已知异常提交</span><input value={bisectBadRef} onChange={(event) => setBisectBadRef(event.target.value)} /></label>
            <label className="repository-center-field grow"><span>已知正常提交</span><input value={bisectGoodRef} onChange={(event) => setBisectGoodRef(event.target.value)} placeholder="例如：v1.0.0" /></label>
            <ActionButton label="开始二分定位" actionKey="bisect:start" pendingAction={pendingAction} disabled={!bisectBadRef.trim() || !bisectGoodRef.trim()} type="submit" icon={<GitCompareArrows size={14} />} />
          </form>
        ) : null}
      </section>

      <section className="repository-center-section">
        <SectionHeader icon={<GitMerge size={17} />} title="进行中的 Git 操作" description="继续、跳过或终止未完成流程" />
        <ResourceBoundary section="operation" resource={data.operation} reload={reload}>{(operation) => operation === null ? (
          <EmptyState icon={<Check size={20} />} title="仓库没有未完成操作" description="合并、变基、摘取和还原状态均已清理。" />
        ) : (
          <div className="repository-center-operation" data-conflicts={operation.conflictedFiles > 0}>
            <span className="repository-center-operation-marker"><CircleDot size={20} /></span>
            <span className="repository-center-record-main">
              <strong>{OPERATION_LABELS[operation.kind]}进行中{operation.currentStep && operation.totalSteps ? ` · ${operation.currentStep}/${operation.totalSteps}` : ""}</strong>
              <small>{operation.source && operation.target ? `${operation.source} → ${operation.target}` : "等待完成当前步骤"} · {operation.conflictedFiles} 个冲突文件</small>
            </span>
            <div className="repository-center-row-actions">
              {operation.kind === "bisect" ? (
                <>
                  <ActionButton label="标记正常" actionKey="operation:bisect-good" pendingAction={pendingAction} onClick={() => void runAction("operation:bisect-good", () => actions.onMarkBisect("good"))} icon={<Check size={14} />} tone="primary" />
                  <ActionButton label="标记异常" actionKey="operation:bisect-bad" pendingAction={pendingAction} onClick={() => void runAction("operation:bisect-bad", () => actions.onMarkBisect("bad"))} icon={<CircleAlert size={14} />} tone="warning" />
                </>
              ) : <ActionButton label="继续" actionKey="operation:continue" pendingAction={pendingAction} disabled={!operation.canContinue || operation.conflictedFiles > 0} onClick={() => void runAction("operation:continue", () => actions.onContinueOperation(operation.kind))} icon={<Play size={14} />} tone="primary" />}
              {operation.canSkip ? <ActionButton label="跳过" actionKey="operation:skip" pendingAction={pendingAction} onClick={() => void runAction("operation:skip", () => actions.onSkipOperation(operation.kind))} icon={<ChevronRight size={14} />} /> : null}
              <ActionButton label="终止" actionKey="operation:abort" pendingAction={pendingAction} disabled={!operation.canAbort} onClick={() => void runAction("operation:abort", () => actions.onAbortOperation(operation.kind))} icon={<X size={14} />} tone="danger" requiresConfirmation confirmLabel="确认终止操作" />
            </div>
          </div>
        )}</ResourceBoundary>
      </section>

      <section className="repository-center-section">
        <SectionHeader icon={<History size={17} />} title="引用日志恢复" description="从 HEAD 移动记录中找回提交或工作区状态" />
        <div className="repository-center-inline-settings">
          <label className="repository-center-field"><span>恢复方式</span><select value={restoreMode} onChange={(event) => setRestoreMode(event.target.value as typeof restoreMode)}><option value="branch">创建恢复分支</option><option value="reset-mixed">重置 HEAD，保留文件修改</option><option value="reset-hard">强制恢复到该记录</option></select></label>
          {restoreMode === "branch" ? <label className="repository-center-field"><span>分支名</span><input value={restoreBranch} onChange={(event) => setRestoreBranch(event.target.value)} /></label> : null}
        </div>
        <ResourceBoundary section="reflog" resource={data.reflog} reload={reload}>{(entries) => entries.length === 0 ? (
          <EmptyState icon={<History size={20} />} title="没有引用日志" description="当前仓库未返回可恢复的 HEAD 移动记录。" />
        ) : <div className="repository-center-record-list technical">
          {entries.map((entry) => <div className="repository-center-record" key={entry.id}>
            <span className="repository-center-hash">{entry.shortHash}</span>
            <span className="repository-center-record-main"><strong>{entry.subject}</strong><small><code>{entry.selector}</code> · {entry.action} · {entry.createdAt}</small></span>
            <ActionButton label="恢复" actionKey={`reflog:${entry.id}`} pendingAction={pendingAction} disabled={restoreMode === "branch" && restoreBranch.trim().length === 0} onClick={() => void runAction(`reflog:${entry.id}`, () => actions.onRestoreReflog({ entryId: entry.targetHash, mode: restoreMode, branchName: restoreMode === "branch" ? restoreBranch.trim() : undefined }))} icon={<RotateCcw size={14} />} tone={restoreMode === "reset-hard" ? "danger" : "secondary"} requiresConfirmation={restoreMode === "reset-hard"} confirmLabel="确认强制恢复" />
          </div>)}
        </div>}</ResourceBoundary>
      </section>
    </div>
  );
}

function RefsWorkspace({ data, actions, pendingAction, runAction, reload }: WorkspaceProps) {
  const [rebaseTarget, setRebaseTarget] = useState("");
  const [rebaseOnto, setRebaseOnto] = useState("");
  const [interactive, setInteractive] = useState(false);
  const [rebasePlan, setRebasePlan] = useState<RepositoryRebasePlanItem[]>([]);
  const [rebasePlanLoading, setRebasePlanLoading] = useState(false);
  const [rebasePlanError, setRebasePlanError] = useState("");
  const [tagName, setTagName] = useState("");
  const [tagTarget, setTagTarget] = useState("HEAD");
  const [tagMessage, setTagMessage] = useState("");
  const [annotatedTag, setAnnotatedTag] = useState(true);
  const [tagRemote, setTagRemote] = useState("");
  const loadRebasePlanRef = useRef(actions.onLoadRebasePlan);

  useEffect(() => {
    loadRebasePlanRef.current = actions.onLoadRebasePlan;
  }, [actions.onLoadRebasePlan]);

  useEffect(() => {
    if (data.rebaseTargets.status === "ready" && !data.rebaseTargets.data.some((target) => target.ref === rebaseTarget)) {
      setRebaseTarget("");
    }
  }, [data.rebaseTargets, rebaseTarget]);

  useEffect(() => {
    if (data.remotes.status === "ready" && !data.remotes.data.some((remote) => remote.id === tagRemote)) {
      setTagRemote(data.remotes.data.find((remote) => remote.isDefaultPush)?.id ?? data.remotes.data[0]?.id ?? "");
    }
  }, [data.remotes, tagRemote]);

  useEffect(() => {
    if (!interactive || !rebaseTarget) {
      setRebasePlan([]);
      setRebasePlanError("");
      return;
    }
    let cancelled = false;
    setRebasePlanLoading(true);
    setRebasePlanError("");
    void loadRebasePlanRef.current(rebaseTarget).then((plan) => {
      if (!cancelled) setRebasePlan(plan);
    }).catch((error) => {
      if (!cancelled) {
        setRebasePlan([]);
        setRebasePlanError(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (!cancelled) setRebasePlanLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [interactive, rebaseTarget]);

  function moveRebaseItem(index: number, offset: -1 | 1) {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= rebasePlan.length) return;
    setRebasePlan((current) => {
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  return <div className="repository-center-workspace">
    <section className="repository-center-section">
      <SectionHeader icon={<GitCompareArrows size={17} />} title="变基" description="选择明确目标并控制交互式流程" />
      <ResourceBoundary section="rebaseTargets" resource={data.rebaseTargets} reload={reload}>{(targets) => targets.length === 0 ? (
        <EmptyState icon={<GitCompareArrows size={20} />} title="没有可用目标" description="仓库中没有其他本地、远程分支或标签。" />
      ) : <form className="repository-center-composer" onSubmit={(event) => {
        event.preventDefault();
        void runAction("rebase:start", () => actions.onStartRebase({
          target: rebaseTarget,
          interactive,
          onto: rebaseOnto.trim() || undefined,
          plan: interactive ? rebasePlan : undefined
        }));
      }}>
        <label className="repository-center-field grow"><span>目标引用</span><select value={rebaseTarget} onChange={(event) => setRebaseTarget(event.target.value)}><option value="">请选择目标引用</option>{targets.map((target) => <option key={target.ref} value={target.ref} disabled={target.isCurrent}>{target.label} · {target.kind}{target.isCurrent ? "（当前）" : ""}</option>)}</select></label>
        <label className="repository-center-field"><span>onto（可选）</span><input value={rebaseOnto} onChange={(event) => setRebaseOnto(event.target.value)} placeholder="新的基底" /></label>
        <label className="repository-center-check"><input type="checkbox" checked={interactive} onChange={(event) => setInteractive(event.target.checked)} /><span>交互式变基</span></label>
        <ActionButton label="开始变基" actionKey="rebase:start" pendingAction={pendingAction} disabled={!rebaseTarget || rebasePlanLoading || (interactive && (rebasePlan.length === 0 || rebasePlan[0]?.action === "squash" || rebasePlan[0]?.action === "fixup"))} type="submit" icon={<Play size={15} />} tone="primary" requiresConfirmation confirmLabel={interactive && rebasePlan.some((item) => item.action === "drop") ? "确认变基并删除计划中的提交" : "确认开始变基"} />
      </form>}</ResourceBoundary>
      {interactive ? (
        <div className="repository-rebase-plan">
          {rebasePlanLoading ? <div className="repository-center-state"><LoaderCircle className="spin" size={18} /><span>正在生成提交计划…</span></div> : null}
          {rebasePlanError ? <div className="repository-center-state error"><CircleAlert size={18} /><span><strong>无法生成计划</strong><small>{rebasePlanError}</small></span></div> : null}
          {!rebasePlanLoading && !rebasePlanError && rebasePlan.length === 0 ? <EmptyState icon={<GitCompareArrows size={20} />} title="没有需要变基的提交" description="目标引用与当前 HEAD 之间没有可重放提交。" /> : null}
          {rebasePlan.length > 0 ? rebasePlan.map((item, index) => (
            <div className={`repository-rebase-plan-row action-${item.action}`} key={item.hash}>
              <span className="repository-rebase-order">{index + 1}</span>
              <select value={item.action} onChange={(event) => setRebasePlan((current) => current.map((entry) => entry.hash === item.hash ? { ...entry, action: event.target.value as RepositoryRebaseAction } : entry))} aria-label={`${item.shortHash} 的变基动作`}>
                <option value="pick">pick · 保留</option>
                <option value="edit">edit · 暂停修改</option>
                <option value="squash">squash · 合并并保留说明</option>
                <option value="fixup">fixup · 合并并丢弃说明</option>
                <option value="drop">drop · 删除</option>
              </select>
              <code>{item.shortHash}</code>
              <strong>{item.subject}</strong>
              <span className="repository-rebase-move">
                <button type="button" title="上移" aria-label="上移提交" disabled={index === 0} onClick={() => moveRebaseItem(index, -1)}><ArrowUp size={14} /></button>
                <button type="button" title="下移" aria-label="下移提交" disabled={index === rebasePlan.length - 1} onClick={() => moveRebaseItem(index, 1)}><ArrowDown size={14} /></button>
              </span>
            </div>
          )) : null}
        </div>
      ) : null}
    </section>

    <section className="repository-center-section">
      <SectionHeader icon={<GitBranch size={17} />} title="分支管理" description="重命名、删除和设置上游分支" />
      <ResourceBoundary section="branches" resource={data.branches} reload={reload}>{(branches) => branches.length === 0 ? <EmptyState icon={<GitBranch size={20} />} title="没有分支" description="当前仓库未返回任何本地或远程分支。" /> : <div className="repository-center-record-list">{branches.map((branch) => <BranchRow key={branch.id} branch={branch} branches={branches} actions={actions} runAction={runAction} pendingAction={pendingAction} />)}</div>}</ResourceBoundary>
    </section>

    <section className="repository-center-section">
      <SectionHeader icon={<Tags size={17} />} title="标签" description="创建附注标签，并按远程推送或删除" />
      <form className="repository-center-composer multi-row" onSubmit={(event) => {
        event.preventDefault();
        void runAction("tag:create", async () => {
          await actions.onCreateTag({ name: tagName.trim(), target: tagTarget.trim(), message: annotatedTag ? tagMessage.trim() : undefined, annotated: annotatedTag });
          setTagName("");
          setTagMessage("");
        });
      }}>
        <label className="repository-center-field"><span>标签名</span><input value={tagName} onChange={(event) => setTagName(event.target.value)} placeholder="v1.2.0" /></label>
        <label className="repository-center-field"><span>目标</span><input value={tagTarget} onChange={(event) => setTagTarget(event.target.value)} /></label>
        <label className="repository-center-field grow"><span>附注</span><input value={tagMessage} disabled={!annotatedTag} onChange={(event) => setTagMessage(event.target.value)} placeholder="版本说明" /></label>
        <label className="repository-center-check"><input type="checkbox" checked={annotatedTag} onChange={(event) => setAnnotatedTag(event.target.checked)} /><span>附注标签</span></label>
        <ActionButton label="创建标签" actionKey="tag:create" pendingAction={pendingAction} disabled={!tagName.trim() || !tagTarget.trim() || (annotatedTag && !tagMessage.trim())} type="submit" icon={<Plus size={15} />} tone="primary" />
      </form>
      <ResourceBoundary section="tags" resource={data.tags} reload={reload}>{(tags) => tags.length === 0 ? <EmptyState icon={<Tags size={20} />} title="没有标签" description="为稳定节点创建标签后会显示在这里。" /> : <div className="repository-center-record-list">{tags.map((tag) => <div className="repository-center-record" key={tag.id}>
        <span className="repository-center-record-leading"><Tags size={16} /></span>
        <span className="repository-center-record-main"><strong>{tag.name}<em>{tag.annotated ? "附注" : "轻量"}</em></strong><small><code>{tag.targetHash}</code>{tag.subject ? ` · ${tag.subject}` : ""}</small></span>
        <div className="repository-center-row-actions">
          <select className="repository-center-compact-select" value={tagRemote} onChange={(event) => setTagRemote(event.target.value)} aria-label={`选择 ${tag.name} 的推送远程`}><option value="">选择远程</option>{data.remotes.data.map((remote) => <option key={remote.id} value={remote.id}>{remote.name}</option>)}</select>
          <ActionButton label="推送" actionKey={`tag:push:${tag.id}`} pendingAction={pendingAction} disabled={!tagRemote} onClick={() => void runAction(`tag:push:${tag.id}`, () => actions.onPushTag({ tagId: tag.id, remoteId: tagRemote }))} icon={<UploadCloud size={14} />} />
          <ActionButton label="删除远程" actionKey={`tag:delete-remote:${tag.id}`} pendingAction={pendingAction} disabled={!tagRemote} onClick={() => void runAction(`tag:delete-remote:${tag.id}`, () => actions.onDeleteRemoteTag({ tagId: tag.id, remoteId: tagRemote }))} icon={<CloudOff size={14} />} tone="danger" requiresConfirmation confirmLabel="确认删除远程标签" />
          <ActionButton label="删除" actionKey={`tag:delete:${tag.id}`} pendingAction={pendingAction} onClick={() => void runAction(`tag:delete:${tag.id}`, () => actions.onDeleteTag(tag.id))} icon={<Trash2 size={14} />} tone="danger" requiresConfirmation confirmLabel="确认删除标签" />
        </div>
      </div>)}</div>}</ResourceBoundary>
    </section>
  </div>;
}

function BranchRow({ branch, branches, actions, pendingAction, runAction }: { branch: RepositoryBranch; branches: RepositoryBranch[]; actions: RepositoryCenterActions; pendingAction: string | null; runAction: RunAction }) {
  const [name, setName] = useState(branch.name);
  const [upstream, setUpstream] = useState(branch.upstream ?? "");
  useEffect(() => setName(branch.name), [branch.name]);
  useEffect(() => setUpstream(branch.upstream ?? ""), [branch.upstream]);
  return <div className="repository-center-record branch-record">
    <span className="repository-center-record-leading"><GitBranch size={16} /></span>
    <span className="repository-center-record-main"><strong>{branch.name}{branch.current ? <em>当前</em> : null}{branch.kind === "remote" ? <em>远程</em> : null}</strong><small><code>{branch.headHash}</code> · ↑ {branch.ahead ?? "?"} ↓ {branch.behind ?? "?"}{branch.merged === undefined ? "" : ` · ${branch.merged ? "已合并" : "未合并"}`}</small></span>
    {branch.kind === "local" ? <div className="repository-center-row-editor">
      <label><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <ActionButton label="重命名" actionKey={`branch:rename:${branch.id}`} pendingAction={pendingAction} disabled={!name.trim() || name.trim() === branch.name} onClick={() => void runAction(`branch:rename:${branch.id}`, () => actions.onRenameBranch({ branchId: branch.id, nextName: name.trim() }))} icon={<Pencil size={14} />} />
      <label><span>上游</span><select value={upstream} onChange={(event) => setUpstream(event.target.value)}><option value="">不跟踪</option>{branches.filter((candidate) => candidate.kind === "remote").map((candidate) => <option key={candidate.id} value={candidate.name}>{candidate.name}</option>)}</select></label>
      <ActionButton label="保存上游" actionKey={`branch:upstream:${branch.id}`} pendingAction={pendingAction} disabled={upstream === (branch.upstream ?? "")} onClick={() => void runAction(`branch:upstream:${branch.id}`, () => actions.onSetBranchUpstream({ branchId: branch.id, upstream: upstream || null }))} icon={<Save size={14} />} />
      <ActionButton label="删除" actionKey={`branch:delete:${branch.id}`} pendingAction={pendingAction} disabled={branch.current} onClick={() => void runAction(`branch:delete:${branch.id}`, () => actions.onDeleteBranch(branch.id, false))} icon={<Trash2 size={14} />} tone="danger" requiresConfirmation confirmLabel="确认删除分支" />
      <ActionButton label="强制删除" actionKey={`branch:force-delete:${branch.id}`} pendingAction={pendingAction} disabled={branch.current} onClick={() => void runAction(`branch:force-delete:${branch.id}`, () => actions.onDeleteBranch(branch.id, true))} icon={<CircleAlert size={14} />} tone="danger" requiresConfirmation confirmLabel="确认强制删除" />
    </div> : <div className="repository-center-row-actions">
      <ActionButton label="删除远程分支" actionKey={`branch:delete-remote:${branch.id}`} pendingAction={pendingAction} onClick={() => void runAction(`branch:delete-remote:${branch.id}`, () => actions.onDeleteRemoteBranch(branch.id))} icon={<Trash2 size={14} />} tone="danger" requiresConfirmation confirmLabel="确认删除远程分支" />
    </div>}
  </div>;
}

function RemotesWorkspace({ data, actions, pendingAction, runAction, reload }: WorkspaceProps) {
  const [editing, setEditing] = useState<RepositoryRemoteInput>({ name: "", fetchUrl: "", pushUrl: "" });
  function editRemote(remote?: RepositoryRemote) {
    setEditing(remote ? { id: remote.id, name: remote.name, fetchUrl: remote.fetchUrl, pushUrl: remote.explicitPushUrl ?? "" } : { name: "", fetchUrl: "", pushUrl: "" });
  }
  return <div className="repository-center-workspace">
    <section className="repository-center-section">
      <SectionHeader icon={<Cloud size={17} />} title="远程仓库" description="集中管理 fetch、push 地址和默认远程" />
      <form className="repository-center-composer multi-row" onSubmit={(event) => {
        event.preventDefault();
        void runAction("remote:save", async () => {
          const pushUrl = editing.pushUrl?.trim();
          await actions.onSaveRemote({ ...editing, name: editing.name.trim(), fetchUrl: editing.fetchUrl.trim(), pushUrl: pushUrl || (editing.id ? null : undefined) });
          editRemote();
        });
      }}>
        <label className="repository-center-field"><span>名称</span><input value={editing.name} onChange={(event) => setEditing((value) => ({ ...value, name: event.target.value }))} placeholder="origin" /></label>
        <label className="repository-center-field grow"><span>Fetch URL</span><input value={editing.fetchUrl} onChange={(event) => setEditing((value) => ({ ...value, fetchUrl: event.target.value }))} placeholder="git@github.com:owner/repository.git" /></label>
        <label className="repository-center-field grow"><span>Push URL（可选）</span><input value={editing.pushUrl ?? ""} onChange={(event) => setEditing((value) => ({ ...value, pushUrl: event.target.value }))} placeholder="留空则使用 Fetch URL" /><small>编辑时留空会清除独立 Push URL。</small></label>
        <ActionButton label={editing.id ? "保存远程" : "添加远程"} actionKey="remote:save" pendingAction={pendingAction} disabled={!editing.name.trim() || !editing.fetchUrl.trim()} type="submit" icon={editing.id ? <Save size={15} /> : <Plus size={15} />} tone="primary" />
        {editing.id ? <button className="repository-center-button secondary" type="button" onClick={() => editRemote()}><X size={15} />取消编辑</button> : null}
      </form>
      <ResourceBoundary section="remotes" resource={data.remotes} reload={reload}>{(remotes) => remotes.length === 0 ? <EmptyState icon={<Cloud size={20} />} title="没有远程仓库" description="添加 fetch 和 push 地址后可执行同步。" /> : <div className="repository-center-record-list">{remotes.map((remote) => <div className="repository-center-record" key={remote.id}>
        <span className="repository-center-record-leading"><Cloud size={16} /></span>
        <span className="repository-center-record-main"><strong>{remote.name}{remote.isDefaultFetch ? <em>默认拉取</em> : null}{remote.isDefaultPush ? <em>默认推送</em> : null}</strong><small title={remote.fetchUrl}>取：{remote.fetchUrl}</small><small title={remote.pushUrl}>推：{remote.pushUrl}{remote.explicitPushUrl === undefined ? "（继承 Fetch URL）" : ""}</small></span>
        <div className="repository-center-row-actions wrap">
          <ActionButton label="编辑" actionKey={`remote:edit:${remote.id}`} pendingAction={pendingAction} onClick={() => editRemote(remote)} icon={<Pencil size={14} />} />
          <ActionButton label="获取" actionKey={`remote:fetch:${remote.id}`} pendingAction={pendingAction} onClick={() => void runAction(`remote:fetch:${remote.id}`, () => actions.onFetchRemote(remote.id))} icon={<Download size={14} />} />
          <ActionButton label="清理" actionKey={`remote:prune:${remote.id}`} pendingAction={pendingAction} onClick={() => void runAction(`remote:prune:${remote.id}`, () => actions.onPruneRemote(remote.id))} icon={<ListRestart size={14} />} />
          {!remote.isDefaultFetch ? <ActionButton label="默认拉取" actionKey={`remote:default-fetch:${remote.id}`} pendingAction={pendingAction} onClick={() => void runAction(`remote:default-fetch:${remote.id}`, () => actions.onSetDefaultRemote({ remoteId: remote.id, role: "fetch" }))} icon={<ArrowDownToLine size={14} />} /> : null}
          {!remote.isDefaultPush ? <ActionButton label="默认推送" actionKey={`remote:default-push:${remote.id}`} pendingAction={pendingAction} onClick={() => void runAction(`remote:default-push:${remote.id}`, () => actions.onSetDefaultRemote({ remoteId: remote.id, role: "push" }))} icon={<UploadCloud size={14} />} /> : null}
          <ActionButton label="删除" actionKey={`remote:delete:${remote.id}`} pendingAction={pendingAction} onClick={() => void runAction(`remote:delete:${remote.id}`, () => actions.onDeleteRemote(remote.id))} icon={<Trash2 size={14} />} tone="danger" requiresConfirmation confirmLabel="确认删除远程" />
        </div>
      </div>)}</div>}</ResourceBoundary>
    </section>

    <section className="repository-center-section">
      <SectionHeader icon={<Link2 size={17} />} title="托管平台入口" description="在浏览器中打开仓库、提交、分支、PR 或 Issue" />
      <ResourceBoundary section="hosting" resource={data.hosting} reload={reload}>{(links) => links.length === 0 ? <EmptyState icon={<Link2 size={20} />} title="没有可用入口" description="配置标准远程地址后可生成托管平台链接。" /> : <div className="repository-center-link-grid">{links.map((link) => <div className="repository-center-link" key={link.id}>
        <span><ExternalLink size={17} /><strong>{link.label}</strong><small>{link.provider} · {hostingKindLabel(link.kind)}</small></span>
        <code title={link.url}>{link.url}</code>
        <div className="repository-center-row-actions">
          <ActionButton label="复制" actionKey={`hosting:copy:${link.id}`} pendingAction={pendingAction} onClick={() => void runAction(`hosting:copy:${link.id}`, () => actions.onCopyHostingLink(link.id))} icon={<Copy size={14} />} />
          <ActionButton label="打开" actionKey={`hosting:open:${link.id}`} pendingAction={pendingAction} onClick={() => void runAction(`hosting:open:${link.id}`, () => actions.onOpenHostingLink(link.id))} icon={<ArrowUpRight size={14} />} tone="primary" />
        </div>
      </div>)}</div>}</ResourceBoundary>
    </section>
  </div>;
}

function ToolsWorkspace({ data, actions, pendingAction, runAction, reload }: WorkspaceProps) {
  const [worktreePath, setWorktreePath] = useState("");
  const [worktreeBranch, setWorktreeBranch] = useState("");
  const [createBranch, setCreateBranch] = useState(false);
  const [gitignore, setGitignore] = useState(data.gitignore.data.content);
  const [signing, setSigning] = useState(data.signing.data);

  useEffect(() => setGitignore(data.gitignore.data.content), [data.gitignore.data.content]);
  useEffect(() => setSigning(data.signing.data), [data.signing.data]);

  return <div className="repository-center-workspace">
    <section className="repository-center-section">
      <SectionHeader icon={<Layers3 size={17} />} title="Git 工作树" description="同一仓库并行维护多个分支目录" actions={<ActionButton label="清理失效项" actionKey="worktree:prune" pendingAction={pendingAction} onClick={() => void runAction("worktree:prune", actions.onPruneWorktrees)} icon={<ListRestart size={14} />} requiresConfirmation confirmLabel="确认清理失效项" />} />
      <form className="repository-center-composer" onSubmit={(event) => {
        event.preventDefault();
        void runAction("worktree:add", async () => {
          await actions.onAddWorktree({ path: worktreePath.trim(), branch: worktreeBranch.trim(), createBranch });
          setWorktreePath("");
          setWorktreeBranch("");
        });
      }}>
        <label className="repository-center-field grow"><span>目录</span><input value={worktreePath} onChange={(event) => setWorktreePath(event.target.value)} placeholder="E:\\projects\\feature-worktree" /></label>
        <label className="repository-center-field"><span>分支</span><input value={worktreeBranch} onChange={(event) => setWorktreeBranch(event.target.value)} placeholder="feature/name" /></label>
        <label className="repository-center-check"><input type="checkbox" checked={createBranch} onChange={(event) => setCreateBranch(event.target.checked)} /><span>创建新分支</span></label>
        <ActionButton label="添加工作树" actionKey="worktree:add" pendingAction={pendingAction} disabled={!worktreePath.trim() || !worktreeBranch.trim()} type="submit" icon={<Plus size={15} />} tone="primary" />
      </form>
      <ResourceBoundary section="worktrees" resource={data.worktrees} reload={reload}>{(worktrees) => worktrees.length === 0 ? <EmptyState icon={<Layers3 size={20} />} title="没有工作树" description="主工作区之外尚未创建 Git worktree。" /> : <div className="repository-center-record-list">{worktrees.map((worktree) => <div className="repository-center-record" key={worktree.id}>
        <span className="repository-center-record-leading"><FolderGit2 size={16} /></span>
        <span className="repository-center-record-main"><strong>{worktree.branch ?? "游离 HEAD"}{worktree.isMain ? <em>主工作树</em> : null}{worktree.locked ? <em>已锁定</em> : null}{worktree.prunable ? <em>可清理</em> : null}</strong><small title={worktree.path}>{worktree.path} · <code>{worktree.headHash}</code></small></span>
        {!worktree.isMain ? <div className="repository-center-row-actions">
          {!worktree.locked ? <ActionButton label="移除" actionKey={`worktree:remove:${worktree.id}`} pendingAction={pendingAction} onClick={() => void runAction(`worktree:remove:${worktree.id}`, () => actions.onRemoveWorktree(worktree.id, false))} icon={<Trash2 size={14} />} tone="danger" requiresConfirmation confirmLabel="确认移除工作树" /> : null}
          <ActionButton label="强制移除" actionKey={`worktree:force-remove:${worktree.id}`} pendingAction={pendingAction} onClick={() => void runAction(`worktree:force-remove:${worktree.id}`, () => actions.onRemoveWorktree(worktree.id, true))} icon={<CircleAlert size={14} />} tone="danger" requiresConfirmation confirmLabel={worktree.locked ? "确认强制移除锁定工作树" : "确认强制移除含未提交修改的工作树"} />
        </div> : null}
      </div>)}</div>}</ResourceBoundary>
    </section>

    <section className="repository-center-section split-section">
      <div className="repository-center-section-column">
        <SectionHeader icon={<Blocks size={17} />} title="子模块" description="初始化、同步地址并递归更新" actions={<div className="repository-center-row-actions"><ActionButton label="初始化" actionKey="submodule:init" pendingAction={pendingAction} onClick={() => void runAction("submodule:init", actions.onInitSubmodules)} icon={<Play size={14} />} /><ActionButton label="同步" actionKey="submodule:sync" pendingAction={pendingAction} onClick={() => void runAction("submodule:sync", actions.onSyncSubmodules)} icon={<RefreshCw size={14} />} /><ActionButton label="递归更新" actionKey="submodule:update" pendingAction={pendingAction} onClick={() => void runAction("submodule:update", () => actions.onUpdateSubmodules(true))} icon={<Download size={14} />} tone="primary" /></div>} />
        <ResourceBoundary section="submodules" resource={data.submodules} reload={reload}>{(modules) => modules.length === 0 ? <EmptyState icon={<Blocks size={20} />} title="没有子模块" description="仓库没有配置 .gitmodules。" /> : <div className="repository-center-record-list compact">{modules.map((module) => <div className="repository-center-record" key={module.id}><span className={`repository-center-status-dot ${module.status}`} /><span className="repository-center-record-main"><strong>{module.name}{module.branch ? <em>{module.branch}</em> : null}</strong><small title={`${module.path}\n${module.url}`}>{module.path} · {module.url} · {submoduleStatusLabel(module.status)}{module.headHash ? ` · ${module.headHash}` : ""}</small></span></div>)}</div>}</ResourceBoundary>
      </div>
      <div className="repository-center-section-column">
        <SectionHeader icon={<Package size={17} />} title="Git LFS" description="大文件扩展状态和本地对象维护" />
        <ResourceBoundary section="lfs" resource={data.lfs} reload={reload}>{(lfs) => <div className="repository-center-metrics repository-center-lfs-metrics">
          <span><small>安装状态</small><strong>{lfs.installed ? "已安装" : "未安装"}</strong></span>
          <span className="repository-center-lfs-version"><small>版本</small><strong title={lfs.version}>{lfsVersionLabel(lfs.version)}</strong></span>
          <span><small>工作区变更</small><strong>{lfs.changedFileCount}</strong></span>
          <span><small>已暂存变更</small><strong>{lfs.stagedFileCount}</strong></span>
          <div className="repository-center-row-actions full"><ActionButton label="安装 LFS" actionKey="lfs:install" pendingAction={pendingAction} disabled={lfs.installed && lfs.initialized} onClick={() => void runAction("lfs:install", actions.onInstallLfs)} icon={<Package size={14} />} /><ActionButton label="拉取对象" actionKey="lfs:pull" pendingAction={pendingAction} disabled={!lfs.installed} onClick={() => void runAction("lfs:pull", actions.onPullLfs)} icon={<Download size={14} />} tone="primary" /><ActionButton label="清理本地对象" actionKey="lfs:prune" pendingAction={pendingAction} disabled={!lfs.installed} onClick={() => void runAction("lfs:prune", actions.onPruneLfs)} icon={<ListRestart size={14} />} requiresConfirmation confirmLabel="确认清理 LFS 对象" /></div>
        </div>}</ResourceBoundary>
      </div>
    </section>

    <section className="repository-center-section split-section editors">
      <div className="repository-center-section-column">
        <SectionHeader icon={<FileCode2 size={17} />} title=".gitignore" description={data.gitignore.data.path} actions={<ActionButton label="保存规则" actionKey="gitignore:save" pendingAction={pendingAction} disabled={data.gitignore.status !== "ready" || gitignore === data.gitignore.data.content} onClick={() => void runAction("gitignore:save", () => actions.onSaveGitignore(gitignore, data.gitignore.data.revision))} icon={<Save size={14} />} tone="primary" />} />
        <ResourceBoundary section="gitignore" resource={data.gitignore} reload={reload}>{() => <textarea className="repository-center-code-editor" spellCheck={false} value={gitignore} onChange={(event) => setGitignore(event.target.value)} aria-label="编辑 gitignore 规则" />}</ResourceBoundary>
      </div>
      <div className="repository-center-section-column">
        <SectionHeader icon={<KeyRound size={17} />} title="提交签名" description="配置 OpenPGP 或 SSH 签名密钥" />
        <ResourceBoundary section="signing" resource={data.signing} reload={reload}>{() => <div className="repository-center-form-grid">
          <label className="repository-center-switch"><input type="checkbox" checked={signing.enabled} onChange={(event) => setSigning((value) => ({ ...value, enabled: event.target.checked }))} /><span>签署 Git 提交</span></label>
          <label className="repository-center-switch"><input type="checkbox" checked={signing.signTags} onChange={(event) => setSigning((value) => ({ ...value, signTags: event.target.checked }))} /><span>同时签署标签</span></label>
          <label className="repository-center-field"><span>签名格式</span><select value={signing.format} onChange={(event) => setSigning((value) => ({ ...value, format: event.target.value as RepositorySigningFormat }))}><option value="openpgp">OpenPGP</option><option value="ssh">SSH</option><option value="x509">X.509</option></select></label>
          <label className="repository-center-field grow"><span>密钥 ID 或公钥路径</span><input value={signing.key} onChange={(event) => setSigning((value) => ({ ...value, key: event.target.value }))} /></label>
          <div className="repository-center-row-actions full"><ActionButton label="验证 HEAD 签名" actionKey="signing:test" pendingAction={pendingAction} onClick={() => void runAction("signing:test", () => actions.onTestSigning(signing))} icon={<ShieldCheck size={14} />} /><ActionButton label="保存设置" actionKey="signing:save" pendingAction={pendingAction} disabled={signing.enabled && !signing.key.trim()} onClick={() => void runAction("signing:save", () => actions.onSaveSigning(signing))} icon={<Save size={14} />} tone="primary" /></div>
        </div>}</ResourceBoundary>
      </div>
    </section>
  </div>;
}

function ProjectsWorkspace({ data, actions, pendingAction, runAction, reload }: WorkspaceProps) {
  const [clone, setClone] = useState<RepositoryCloneInput>({ url: "", destination: "", branch: "", recurseSubmodules: true });
  const [init, setInit] = useState<RepositoryInitInput>({ path: "", initialBranch: "main", createGitignore: true });
  const [groupName, setGroupName] = useState("");
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [batchAction, setBatchAction] = useState<RepositoryBatchAction>("refresh");

  function toggleProject(projectId: string) {
    setSelectedProjects((current) => current.includes(projectId) ? current.filter((id) => id !== projectId) : [...current, projectId]);
  }

  return <div className="repository-center-workspace">
    <section className="repository-center-section split-section">
      <div className="repository-center-section-column">
        <SectionHeader icon={<Download size={17} />} title="克隆仓库" description="从 HTTPS 或 SSH 地址创建本地副本" />
        <form className="repository-center-form-grid" onSubmit={(event) => { event.preventDefault(); void runAction("project:clone", () => actions.onCloneRepository({ ...clone, url: clone.url.trim(), destination: clone.destination.trim(), branch: clone.branch?.trim() || undefined })); }}>
          <label className="repository-center-field grow"><span>仓库地址</span><input value={clone.url} onChange={(event) => setClone((value) => ({ ...value, url: event.target.value }))} placeholder="https://github.com/owner/repository.git" /></label>
          <label className="repository-center-field grow"><span>本地目录</span><input value={clone.destination} onChange={(event) => setClone((value) => ({ ...value, destination: event.target.value }))} /></label>
          <label className="repository-center-field"><span>分支（可选）</span><input value={clone.branch} onChange={(event) => setClone((value) => ({ ...value, branch: event.target.value }))} /></label>
          <label className="repository-center-field"><span>浅克隆深度</span><input type="number" min={1} value={clone.depth ?? ""} onChange={(event) => setClone((value) => ({ ...value, depth: event.target.value ? Number(event.target.value) : undefined }))} /></label>
          <label className="repository-center-check"><input type="checkbox" checked={clone.recurseSubmodules} onChange={(event) => setClone((value) => ({ ...value, recurseSubmodules: event.target.checked }))} /><span>递归克隆子模块</span></label>
          <ActionButton label="开始克隆" actionKey="project:clone" pendingAction={pendingAction} disabled={!clone.url.trim() || !clone.destination.trim()} type="submit" icon={<Download size={15} />} tone="primary" />
        </form>
      </div>
      <div className="repository-center-section-column">
        <SectionHeader icon={<FolderPlus size={17} />} title="初始化仓库" description="在指定目录创建新的 Git 仓库" />
        <form className="repository-center-form-grid" onSubmit={(event) => { event.preventDefault(); void runAction("project:init", () => actions.onInitRepository({ ...init, path: init.path.trim(), initialBranch: init.initialBranch.trim() })); }}>
          <label className="repository-center-field grow"><span>目标目录</span><input value={init.path} onChange={(event) => setInit((value) => ({ ...value, path: event.target.value }))} /></label>
          <label className="repository-center-field"><span>初始分支</span><input value={init.initialBranch} onChange={(event) => setInit((value) => ({ ...value, initialBranch: event.target.value }))} /></label>
          <label className="repository-center-check"><input type="checkbox" checked={init.createGitignore} onChange={(event) => setInit((value) => ({ ...value, createGitignore: event.target.checked }))} /><span>同时创建 .gitignore</span></label>
          <ActionButton label="初始化" actionKey="project:init" pendingAction={pendingAction} disabled={!init.path.trim() || !init.initialBranch.trim()} type="submit" icon={<FolderPlus size={15} />} tone="primary" />
        </form>
      </div>
    </section>

    <section className="repository-center-section split-section">
      <div className="repository-center-section-column">
        <SectionHeader icon={<Box size={17} />} title="项目分组" description="组织项目并调整所属分组" />
        <form className="repository-center-composer compact" onSubmit={(event) => { event.preventDefault(); void runAction("group:create", async () => { await actions.onCreateGroup(groupName.trim()); setGroupName(""); }); }}><label className="repository-center-field grow"><span>新分组名称</span><input value={groupName} onChange={(event) => setGroupName(event.target.value)} /></label><ActionButton label="创建分组" actionKey="group:create" pendingAction={pendingAction} disabled={!groupName.trim()} type="submit" icon={<Plus size={14} />} tone="primary" /></form>
        <ResourceBoundary section="groups" resource={data.groups} reload={reload}>{(groups) => groups.length === 0 ? <EmptyState icon={<Box size={20} />} title="没有项目分组" description="创建分组后可把项目归类管理。" /> : <div className="repository-center-record-list compact">{groups.map((group) => <GroupRow key={group.id} group={group} actions={actions} pendingAction={pendingAction} runAction={runAction} />)}</div>}</ResourceBoundary>
      </div>
      <div className="repository-center-section-column">
        <SectionHeader icon={<FolderClock size={17} />} title="最近项目" description="快速打开或移出最近使用列表" />
        <ResourceBoundary section="recent" resource={data.recent} reload={reload}>{(recent) => recent.length === 0 ? <EmptyState icon={<FolderClock size={20} />} title="没有最近项目" description="打开仓库后会记录在这里。" /> : (
          <div className="repository-center-record-list compact repository-center-recent-list">
            {recent.map((project) => (
              <div className="repository-center-record repository-center-recent-record" key={project.id}>
                <span className="repository-center-record-leading"><FolderGit2 size={16} /></span>
                <span className="repository-center-record-main">
                  <strong>{project.name}</strong>
                  <small title={project.path}>{project.path}</small>
                  {project.lastOpenedAt ? <small className="repository-center-record-time">最近打开 {formatRecentProjectTime(project.lastOpenedAt)}</small> : null}
                </span>
                <div className="repository-center-row-actions">
                  <ActionButton label="打开" actionKey={`recent:open:${project.id}`} pendingAction={pendingAction} onClick={() => void runAction(`recent:open:${project.id}`, () => actions.onOpenProject(project.id))} icon={<ArrowUpRight size={14} />} tone="primary" />
                  <ActionButton label="移出" actionKey={`recent:remove:${project.id}`} pendingAction={pendingAction} onClick={() => void runAction(`recent:remove:${project.id}`, () => actions.onRemoveRecentProject(project.id))} icon={<X size={14} />} />
                </div>
              </div>
            ))}
          </div>
        )}</ResourceBoundary>
      </div>
    </section>

    <section className="repository-center-section">
      <SectionHeader icon={<SlidersHorizontal size={17} />} title="多项目批量操作" description="对选中的仓库统一刷新、获取、拉取或清理远程引用" actions={<div className="repository-center-row-actions"><select className="repository-center-compact-select" value={batchAction} onChange={(event) => setBatchAction(event.target.value as RepositoryBatchAction)}><option value="refresh">刷新状态</option><option value="fetch">获取远程</option><option value="pull">拉取更新（{pullStrategyLabel(data.preferences.data.pullStrategy)}）</option><option value="prune">清理远程引用</option></select><ActionButton label={`执行（${selectedProjects.length}）`} actionKey="batch:run" pendingAction={pendingAction} disabled={selectedProjects.length === 0} onClick={() => void runAction("batch:run", () => actions.onRunBatchAction({ projectIds: selectedProjects, action: batchAction }))} icon={<Play size={14} />} tone="primary" /></div>} />
      <ResourceBoundary section="projects" resource={data.projects} reload={reload}>{(projects) => projects.length === 0 ? <EmptyState icon={<FolderGit2 size={20} />} title="没有项目" description="添加、克隆或初始化仓库后可执行批量操作。" /> : <div className="repository-center-project-table">{projects.map((project) => <div className="repository-center-project-row" key={project.id}><input type="checkbox" aria-label={`选择 ${project.name}`} checked={selectedProjects.includes(project.id)} onChange={() => toggleProject(project.id)} /><span className="repository-center-record-main"><strong>{project.name}<em>{project.statusError ? "状态不可用" : project.branch ?? "游离 HEAD"}</em></strong><small title={project.statusError ?? project.path}>{project.path}</small></span>{project.statusError ? <span className="repository-center-project-status-error" title={project.statusError}>状态读取失败</span> : <span className="repository-center-project-stats"><span>{project.changedFiles} 变更</span><span>↑ {project.ahead}</span><span>↓ {project.behind}</span></span>}<select value={project.groupId ?? ""} onChange={(event) => void runAction(`project:group:${project.id}`, () => actions.onAssignProjectGroup({ projectId: project.id, groupId: event.target.value || null }))} aria-label={`设置 ${project.name} 的分组`}><option value="">未分组</option>{data.groups.data.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></div>)}</div>}</ResourceBoundary>
    </section>
  </div>;
}

function GroupRow({ group, actions, pendingAction, runAction }: { group: RepositoryProjectGroup; actions: RepositoryCenterActions; pendingAction: string | null; runAction: RunAction }) {
  const [name, setName] = useState(group.name);
  useEffect(() => setName(group.name), [group.name]);
  return <div className="repository-center-record repository-center-group-record"><span className="repository-center-record-leading"><Box size={16} /></span><span className="repository-center-record-main"><strong>{group.name}</strong><small>{group.projectIds.length} 个项目</small></span><div className="repository-center-row-editor"><label><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label><ActionButton label="重命名" actionKey={`group:rename:${group.id}`} pendingAction={pendingAction} disabled={!name.trim() || name.trim() === group.name} onClick={() => void runAction(`group:rename:${group.id}`, () => actions.onRenameGroup({ groupId: group.id, name: name.trim() }))} icon={<Pencil size={14} />} /><ActionButton label="删除" actionKey={`group:delete:${group.id}`} pendingAction={pendingAction} onClick={() => void runAction(`group:delete:${group.id}`, () => actions.onDeleteGroup(group.id))} icon={<Trash2 size={14} />} tone="danger" requiresConfirmation confirmLabel="确认删除分组" /></div></div>;
}

function PreferencesWorkspace({ data, actions, pendingAction, runAction, reload }: WorkspaceProps) {
  const [preferences, setPreferences] = useState(data.preferences.data);
  useEffect(() => setPreferences(data.preferences.data), [data.preferences.data]);
  const hasChanges = JSON.stringify(preferences) !== JSON.stringify(data.preferences.data);

  function updateShortcut(id: string, keys: string) {
    setPreferences((current) => ({ ...current, shortcuts: current.shortcuts.map((shortcut) => shortcut.id === id ? { ...shortcut, keys } : shortcut) }));
  }

  return <div className="repository-center-workspace">
    <section className="repository-center-section">
      <SectionHeader icon={<MonitorCog size={17} />} title="显示与布局" description="主题、字体、差异视图和操作密度" />
      <ResourceBoundary section="preferences" resource={data.preferences} reload={reload}>{() => <>
        <div className="repository-center-preferences-savebar" data-dirty={hasChanges}>
          <span><strong>{hasChanges ? "有未保存的更改" : "偏好设置已保存"}</strong><small>{hasChanges ? "保存后立即应用到主界面。" : "修改任意选项后即可保存。"}</small></span>
          <ActionButton label={hasChanges ? "保存设置" : "已保存"} actionKey="preferences:save" pendingAction={pendingAction} disabled={!hasChanges} onClick={() => void runAction("preferences:save", () => actions.onSavePreferences(preferences))} icon={hasChanges ? <Save size={14} /> : <Check size={14} />} tone={hasChanges ? "primary" : "secondary"} />
        </div>
        <div className="repository-center-preferences-grid">
        <fieldset><legend>外观主题</legend><div className="repository-center-segmented">{(["system", "light", "dark"] as const).map((theme) => <button type="button" key={theme} className={preferences.theme === theme ? "active" : ""} onClick={() => setPreferences((value) => ({ ...value, theme }))}>{theme === "system" ? "跟随系统" : theme === "light" ? "浅色" : "深色"}</button>)}</div></fieldset>
        <fieldset><legend>字体</legend><div className="repository-center-inline-settings"><label className="repository-center-field"><span>字体族</span><select value={preferences.fontFamily} onChange={(event) => setPreferences((value) => ({ ...value, fontFamily: event.target.value as RepositoryPreferences["fontFamily"] }))}><option value="system">系统界面字体</option><option value="mono">等宽字体</option></select></label><label className="repository-center-field"><span>字号</span><input type="number" min={11} max={20} value={preferences.fontSize} onChange={(event) => setPreferences((value) => ({ ...value, fontSize: Number(event.target.value) }))} /></label></div></fieldset>
        <fieldset><legend>差异视图</legend><div className="repository-center-segmented">{(["split", "inline"] as const).map((mode) => <button type="button" key={mode} className={preferences.diffMode === mode ? "active" : ""} onClick={() => setPreferences((value) => ({ ...value, diffMode: mode }))}>{mode === "split" ? "左右对比" : "行内对比"}</button>)}</div><label className="repository-center-switch"><input type="checkbox" checked={preferences.diffWrap} onChange={(event) => setPreferences((value) => ({ ...value, diffWrap: event.target.checked }))} /><span>自动换行</span></label></fieldset>
        <fieldset><legend>拉取策略</legend><div className="repository-center-segmented">{(["ff-only", "rebase", "rebase-autostash"] as const).map((strategy) => <button type="button" key={strategy} className={preferences.pullStrategy === strategy ? "active" : ""} onClick={() => setPreferences((value) => ({ ...value, pullStrategy: strategy }))}>{strategy === "ff-only" ? "仅快进" : strategy === "rebase" ? "变基" : "变基并暂存"}</button>)}</div></fieldset>
        <fieldset><legend>工作区布局</legend><div className="repository-center-inline-settings"><label className="repository-center-field"><span>密度</span><select value={preferences.density} onChange={(event) => setPreferences((value) => ({ ...value, density: event.target.value as RepositoryPreferences["density"] }))}><option value="compact">紧凑</option><option value="comfortable">舒适</option></select></label><label className="repository-center-field"><span>项目栏位置</span><select value={preferences.sidebarPosition} onChange={(event) => setPreferences((value) => ({ ...value, sidebarPosition: event.target.value as RepositoryPreferences["sidebarPosition"] }))}><option value="left">左侧</option><option value="right">右侧</option></select></label></div><label className="repository-center-switch"><input type="checkbox" checked={preferences.bottomConsoleVisible} onChange={(event) => setPreferences((value) => ({ ...value, bottomConsoleVisible: event.target.checked }))} /><span>显示底部控制台</span></label></fieldset>
        <fieldset className="wide"><legend>面板尺寸</legend><div className="repository-center-inline-settings"><label className="repository-center-field"><span>项目栏宽度</span><input type="number" min={180} max={340} value={preferences.sidebarWidth} onChange={(event) => setPreferences((value) => ({ ...value, sidebarWidth: Number(event.target.value) }))} /></label><label className="repository-center-field"><span>变更区宽度</span><input type="number" min={280} max={720} value={preferences.rightPanelWidth} onChange={(event) => setPreferences((value) => ({ ...value, rightPanelWidth: Number(event.target.value) }))} /></label><label className="repository-center-field"><span>控制台高度</span><input type="number" min={80} max={720} value={preferences.consoleHeight} onChange={(event) => setPreferences((value) => ({ ...value, consoleHeight: Number(event.target.value) }))} /></label></div></fieldset>
        <fieldset className="wide"><legend>危险操作</legend><label className="repository-center-switch"><input type="checkbox" checked={preferences.confirmDestructiveActions} onChange={(event) => setPreferences((value) => ({ ...value, confirmDestructiveActions: event.target.checked }))} /><span>执行强制重置、删除分支和清理工作树前要求确认</span></label></fieldset>
        </div>
      </>}</ResourceBoundary>
    </section>

    <section className="repository-center-section">
      <SectionHeader icon={<Terminal size={17} />} title="快捷键" description="为常用命令设置独立组合键" />
      {data.preferences.status === "ready" ? <div className="repository-center-shortcuts">{preferences.shortcuts.length === 0 ? <EmptyState icon={<Terminal size={20} />} title="没有快捷键项目" description="宿主应用未提供可配置的命令。" /> : preferences.shortcuts.map((shortcut) => <label key={shortcut.id}><span><strong>{shortcut.label}</strong><small>{shortcut.id}</small></span><input value={shortcut.keys} onChange={(event) => updateShortcut(shortcut.id, event.target.value)} aria-label={`${shortcut.label}快捷键`} /></label>)}</div> : null}
    </section>
  </div>;
}

function lfsVersionLabel(value: string) {
  return value.trim().split(/\s+/)[0] || "-";
}

function formatRecentProjectTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function hostingKindLabel(kind: RepositoryHostingLink["kind"]) {
  const labels: Record<RepositoryHostingLink["kind"], string> = {
    repository: "仓库主页",
    commits: "提交记录",
    branches: "分支",
    pullRequests: "合并请求",
    issues: "问题"
  };
  return labels[kind];
}

function dialogFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"))
    .filter((element) => element.getClientRects().length > 0);
}

function submoduleStatusLabel(status: RepositorySubmodule["status"]): string {
  return status === "ready" ? "已同步" : status === "uninitialized" ? "未初始化" : status === "modified" ? "提交已变化" : "存在冲突";
}

function pullStrategyLabel(strategy: RepositoryPreferences["pullStrategy"]): string {
  return strategy === "ff-only" ? "仅快进" : strategy === "rebase" ? "变基" : "变基并暂存";
}
