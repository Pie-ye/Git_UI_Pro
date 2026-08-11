import {
  AlertTriangle,
  ArrowDownToLine,
  Check,
  CheckCircle2,
  ChevronDown,
  Download,
  ExternalLink,
  History,
  LoaderCircle,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  Terminal,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import packageInfo from "../../package.json";
import type { ReleaseHistoryItem, UpdateOperation, UpdatePhase, UpdateState } from "../types/electron";
import { PathTooltip } from "./PathTooltip";

const TARGET_PHASES = new Set<UpdatePhase>(["available", "downloading", "downloaded", "installing"]);
const MOCK_PHASES = new Set<UpdatePhase>(["idle", "checking", "up-to-date", "available", "downloading", "downloaded", "error"]);
const CURRENT_VERSION = packageInfo.version;
const UPDATE_BRIDGE_UNAVAILABLE = "更新服务不可用：桌面进程未提供所需接口。";

interface AppUpdateControlProps {
  gitVersion: string;
  gitReady?: boolean;
}

export function AppUpdateControl({ gitVersion, gitReady = true }: AppUpdateControlProps) {
  const mockState = useMemo(() => readMockUpdateState(), []);
  const isMock = mockState !== null;
  const [state, setState] = useState<UpdateState>(() => mockState ?? unsupportedUpdateState());
  const [open, setOpen] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [historyItems, setHistoryItems] = useState<ReleaseHistoryItem[]>([]);
  const [selectedHistoryVersion, setSelectedHistoryVersion] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const mockTimerRef = useRef<number>();

  useEffect(() => {
    if (isMock) {
      return;
    }

    let cancelled = false;
    let receivedAuthoritativeState = false;
    const bridge = window.gitUI;
    if (!bridge?.getUpdateState) {
      setState((current) => ({ ...current, phase: "error", operation: "upgrade", error: UPDATE_BRIDGE_UNAVAILABLE }));
      return;
    }

    const unsubscribe = bridge.onUpdateState?.((nextState) => {
      if (!cancelled) {
        receivedAuthoritativeState = true;
        setState((current) => acceptAuthoritativeUpdateState(current, nextState));
      }
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (!cancelled) {
          receivedAuthoritativeState = true;
          setState((current) => acceptAuthoritativeUpdateState(current, nextState));
        }
      })
      .catch((error) => {
        if (!cancelled && !receivedAuthoritativeState) {
          setState((current) => ({ ...current, phase: "error", error: cleanActionError(error, "无法读取更新状态。") }));
        }
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [isMock]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      const clickedTrigger = triggerRef.current?.contains(target) ?? false;
      const clickedPanel = panelRef.current?.contains(target) ?? false;
      if (!clickedTrigger && !clickedPanel) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.requestAnimationFrame(() => panelRef.current?.focus());
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open && historyExpanded && historyItems.length === 0 && !historyLoading && !historyError) {
      void loadReleaseHistory(false);
    }
  }, [open, historyExpanded]);

  useEffect(
    () => () => {
      if (mockTimerRef.current !== undefined) {
        window.clearTimeout(mockTimerRef.current);
      }
    },
    []
  );

  const progressPercent = normalizedPercent(state.progress?.percent);
  const statusLabel = phaseLabel(state);
  const hasTarget = hasTargetVersion(state);
  const hasUpgradeNotification = state.operation === "upgrade" &&
    Boolean(state.availableVersion) &&
    stripVersionPrefix(state.availableVersion ?? "") !== stripVersionPrefix(state.currentVersion) &&
    (TARGET_PHASES.has(state.phase) || state.phase === "error");
  const triggerLabel = hasUpgradeNotification
    ? `发现新版本 v${stripVersionPrefix(state.availableVersion ?? state.currentVersion)}`
    : "关于、版本与更新";
  const gitVersionLabel = gitVersion.replace(/^git version\s*/i, "").trim() || gitVersion;
  const gitStatusLabel = gitVersion.trim() === "检测中" ? "检测中" : gitReady ? "可用" : "不可用";
  const canCheck = !actionPending && state.operation !== "rollback" && !["checking", "downloading", "downloaded", "installing"].includes(state.phase);
  const selectedRollbackPrepared = state.operation === "rollback" &&
    state.availableVersion === selectedHistoryVersion &&
    (TARGET_PHASES.has(state.phase) || (state.phase === "error" && Boolean(state.progress)));
  const rollbackNeedsPreparation = state.operation === "rollback" && state.phase === "error" && !state.progress;

  function closePanel() {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  async function loadReleaseHistory(force: boolean) {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const items = isMock
        ? createMockReleaseHistory(state.currentVersion)
        : await requireUpdateBridgeMethod(window.gitUI?.listUpdateReleases)(force);
      setHistoryItems(items);
      setSelectedHistoryVersion((current) => current && items.some((item) => item.version === current) ? current : items[0]?.version ?? "");
    } catch (error) {
      setHistoryError(cleanActionError(error, "无法读取历史版本，请稍后重试。"));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function checkForUpdates() {
    if (!canCheck) {
      return;
    }

    setActionPending(true);
    setHistoryError("");
    if (isMock) {
      setState((current) => ({ ...current, revision: current.revision + 1, phase: "checking", operation: "upgrade", error: undefined }));
      mockTimerRef.current = window.setTimeout(() => {
        setState((current) => ({
          revision: current.revision + 1,
          phase: "up-to-date",
          operation: "upgrade",
          currentVersion: current.currentVersion,
          availableVersion: current.currentVersion,
          releaseDate: new Date().toISOString(),
          releaseUrl: releaseUrlFor(current.currentVersion)
        }));
        setActionPending(false);
      }, 650);
      return;
    }

    try {
      if (!window.gitUI?.checkForUpdates) {
        throw new Error(UPDATE_BRIDGE_UNAVAILABLE);
      }
      const nextState = await window.gitUI.checkForUpdates();
      setState((current) => acceptAuthoritativeUpdateState(current, nextState));
    } catch (error) {
      setRecoverableError(error, "upgrade");
    } finally {
      setActionPending(false);
    }
  }

  async function prepareRollback() {
    const selected = historyItems.find((item) => item.version === selectedHistoryVersion);
    if (!selected || actionPending || selectedRollbackPrepared) {
      return;
    }

    setActionPending(true);
    setHistoryError("");
    if (isMock) {
      setState({
        revision: state.revision + 1,
        phase: "available",
        operation: "rollback",
        currentVersion: state.currentVersion,
        availableVersion: selected.version,
        releaseName: selected.releaseName,
        releaseNotes: selected.releaseNotes,
        releaseDate: selected.publishedAt,
        releaseUrl: selected.releaseUrl
      });
      setActionPending(false);
      return;
    }

    try {
      if (!window.gitUI?.prepareRollback) {
        throw new Error(UPDATE_BRIDGE_UNAVAILABLE);
      }
      const nextState = await window.gitUI.prepareRollback(selected.version);
      setState((current) => acceptAuthoritativeUpdateState(current, nextState));
    } catch (error) {
      setHistoryError(cleanActionError(error, "无法准备该回退版本。"));
    } finally {
      setActionPending(false);
    }
  }

  async function cancelRollback() {
    if (actionPending || state.phase === "installing") {
      return;
    }

    setActionPending(true);
    if (isMock) {
      if (mockTimerRef.current !== undefined) {
        window.clearTimeout(mockTimerRef.current);
        mockTimerRef.current = undefined;
      }
      setState({ revision: state.revision + 1, phase: "idle", operation: "upgrade", currentVersion: state.currentVersion });
      setActionPending(false);
      return;
    }

    try {
      if (!window.gitUI?.cancelRollback) {
        throw new Error(UPDATE_BRIDGE_UNAVAILABLE);
      }
      const nextState = await window.gitUI.cancelRollback();
      setState((current) => acceptAuthoritativeUpdateState(current, nextState));
    } catch (error) {
      setRecoverableError(error, "rollback");
    } finally {
      setActionPending(false);
    }
  }

  async function downloadUpdate() {
    if (actionPending || state.phase === "downloading") {
      return;
    }

    setActionPending(true);
    if (isMock) {
      setState({
        ...state,
        revision: state.revision + 1,
        phase: "downloading",
        error: undefined,
        progress: { percent: 38, transferred: 31_876_324, total: 83_885_063, bytesPerSecond: 5_242_880 }
      });
      setActionPending(false);
      mockTimerRef.current = window.setTimeout(() => {
        setState((current) => ({
          ...current,
          revision: current.revision + 1,
          phase: "downloaded",
          progress: { percent: 100, transferred: 83_885_063, total: 83_885_063, bytesPerSecond: 0 }
        }));
      }, 900);
      return;
    }

    try {
      if (!window.gitUI?.downloadUpdate) {
        throw new Error(UPDATE_BRIDGE_UNAVAILABLE);
      }
      const nextState = await window.gitUI.downloadUpdate();
      setState((current) => acceptAuthoritativeUpdateState(current, nextState));
    } catch (error) {
      setRecoverableError(error, state.operation);
    } finally {
      setActionPending(false);
    }
  }

  async function installUpdate() {
    if (actionPending || state.phase !== "downloaded") {
      return;
    }

    setActionPending(true);
    if (isMock) {
      setState({ ...state, revision: state.revision + 1, phase: "installing", error: undefined });
      setActionPending(false);
      return;
    }

    try {
      if (!window.gitUI?.installUpdate) {
        throw new Error(UPDATE_BRIDGE_UNAVAILABLE);
      }
      const started = await window.gitUI.installUpdate();
      if (!started) {
        throw new Error("安装程序未能启动，请稍后重试。");
      }
    } catch (error) {
      setRecoverableError(error, state.operation);
      setActionPending(false);
    }
  }

  function setRecoverableError(error: unknown, operation: UpdateOperation) {
    const message = cleanActionError(error, "更新操作失败，请稍后重试。");
    setState((current) => ({ ...current, operation, phase: "error", error: message }));
  }

  function openRelease(url = state.releaseUrl || releaseUrlFor(state.currentVersion)) {
    if (isMock) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    if (!window.gitUI?.openExternal) {
      setRecoverableError(new Error(UPDATE_BRIDGE_UNAVAILABLE), state.operation);
      return;
    }
    void window.gitUI.openExternal(url).catch((error) => setRecoverableError(error, state.operation));
  }

  return (
    <div className="app-update-control">
      <PathTooltip content={triggerLabel} className="app-update-trigger-tooltip">
        <button
          ref={triggerRef}
          type="button"
          className="app-update-trigger"
          aria-label={hasUpgradeNotification ? `${triggerLabel}，打开关于与更新` : "打开关于、版本与更新"}
          aria-expanded={open}
          aria-controls="app-update-popover"
          data-phase={state.phase}
          data-operation={state.operation}
          data-update-notice={hasUpgradeNotification}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="app-update-trigger-label">关于</span>
          {hasUpgradeNotification ? <span className="app-update-trigger-dot" aria-hidden="true" /> : null}
        </button>
      </PathTooltip>

      {open ? (
        <div
          id="app-update-popover"
          ref={panelRef}
          className="app-update-popover"
          role="dialog"
          aria-modal={false}
          aria-labelledby="app-update-title"
          tabIndex={-1}
        >
          <div className="app-update-panel-header">
            <h2 id="app-update-title">关于 Git UI Pro</h2>
            <div className="app-update-header-actions">
              <PathTooltip
                content={`查看 v${stripVersionPrefix(state.availableVersion ?? state.currentVersion)} 发布页`}
                className="app-update-action-tooltip"
              >
                <button
                  type="button"
                  className="app-update-icon-button"
                  aria-label={`查看 v${stripVersionPrefix(state.availableVersion ?? state.currentVersion)} 发布页`}
                  onClick={() => openRelease()}
                >
                  <ExternalLink size={15} />
                </button>
              </PathTooltip>
              <PathTooltip content="检查最新版本" className="app-update-action-tooltip">
                <button type="button" className="app-update-icon-button" aria-label="检查最新版本" disabled={!canCheck} onClick={() => void checkForUpdates()}>
                  <RefreshCw className={state.phase === "checking" ? "app-update-spin" : ""} size={15} />
                </button>
              </PathTooltip>
              <PathTooltip content="关闭版本窗口" className="app-update-action-tooltip">
                <button type="button" className="app-update-icon-button" aria-label="关闭版本窗口" onClick={closePanel}>
                  <X size={16} />
                </button>
              </PathTooltip>
            </div>
          </div>

          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {hasTarget
              ? `${state.operation === "rollback" ? "回退" : "更新"}版本 v${stripVersionPrefix(state.availableVersion ?? state.currentVersion)}，${statusLabel}`
              : `当前版本 v${stripVersionPrefix(state.currentVersion)}，${statusLabel}`}
          </span>

          <div className="app-update-scroll-region">
            <section
              className="app-update-overview"
              data-has-target={hasTarget}
              data-operation={state.operation}
              aria-label={hasTarget
                ? `从 ${state.currentVersion} ${state.operation === "rollback" ? "回退" : "更新"}到 ${state.availableVersion}`
                : `当前版本 v${stripVersionPrefix(state.currentVersion)}`}
            >
              <div className={`app-update-version-route ${hasTarget ? "has-target" : "is-current-only"}`}>
                <div className="app-update-version-node is-current">
                  <span className="app-update-version-label">{hasTarget ? "当前版本" : "应用版本"}</span>
                  <strong className="app-update-version-value">v{stripVersionPrefix(state.currentVersion)}</strong>
                  {!hasTarget ? <em className="app-update-version-status">{statusLabel}</em> : null}
                </div>
                {hasTarget ? <>
                  <span className="app-update-version-rail" aria-hidden="true">
                    <span className="app-update-version-action">{state.operation === "rollback" ? "回退" : "升级"}</span>
                    <i className="app-update-version-track" />
                  </span>
                  <div className="app-update-version-node is-target">
                    <span className="app-update-version-label">{state.operation === "rollback" ? "回退版本" : "最新版本"}</span>
                    <strong className="app-update-version-value">v{stripVersionPrefix(state.availableVersion ?? state.currentVersion)}</strong>
                    <em className="app-update-version-status">{statusLabel}</em>
                  </div>
                </> : null}
              </div>
            </section>

            <section className={`app-update-environment ${gitReady ? "" : "warning"}`} aria-label={`Git 版本 ${gitVersionLabel}，${gitStatusLabel}`}>
              <span className="app-update-environment-label"><Terminal size={15} />Git 环境</span>
              <code title={gitVersion}>{gitVersionLabel}</code>
              <small>{gitStatusLabel}</small>
            </section>

            {state.phase === "downloading" ? (
              <div className="app-update-progress" role="progressbar" aria-label="安装包下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}>
                <div className="app-update-progress-meta">
                  <strong>{progressPercent}%</strong>
                  <span>{formatBytes(state.progress?.transferred)} / {formatBytes(state.progress?.total)}</span>
                </div>
                <div className="app-update-progress-track"><span style={{ width: `${progressPercent}%` }} /></div>
                {state.progress?.bytesPerSecond ? <span className="app-update-progress-speed">{formatBytes(state.progress.bytesPerSecond)}/s</span> : null}
              </div>
            ) : null}

            {state.error ? (
              <div className="app-update-error" role="alert">
                <AlertTriangle size={15} />
                <span>{state.error}</span>
              </div>
            ) : null}

            <section className="app-update-history" data-expanded={historyExpanded}>
              <PathTooltip content="仅显示带 SHA-256 校验的正式安装版" className="app-update-history-tooltip">
                <button
                  type="button"
                  className="app-update-history-toggle"
                  aria-label="历史版本，仅显示带 SHA-256 校验的正式安装版"
                  aria-expanded={historyExpanded}
                  aria-controls="app-update-history-body"
                  onClick={() => setHistoryExpanded((current) => !current)}
                >
                  <span className="app-update-history-title"><History size={16} /><strong>历史版本</strong>{historyItems.length > 0 ? <small>{historyItems.length}</small> : null}</span>
                  <ChevronDown size={16} />
                </button>
              </PathTooltip>

              <div id="app-update-history-body" className="app-update-history-body" hidden={!historyExpanded}>
                {historyExpanded ? <>
                  {historyLoading ? (
                    <div className="app-update-history-empty"><LoaderCircle className="app-update-spin" size={16} />正在读取历史版本</div>
                  ) : historyError ? (
                    <div className="app-update-history-error" role="alert">
                      <AlertTriangle size={14} /><span>{historyError}</span>
                      <PathTooltip content="重新读取历史版本" className="app-update-action-tooltip">
                        <button type="button" className="app-update-icon-button" aria-label="重新读取历史版本" onClick={() => void loadReleaseHistory(true)}><RefreshCw size={14} /></button>
                      </PathTooltip>
                    </div>
                  ) : historyItems.length > 0 ? (
                    <div className="app-update-history-list" role="radiogroup" aria-label="选择回退版本">
                      {historyItems.map((item) => (
                        <div className="app-update-history-item" key={item.version}>
                          <label className="app-update-history-choice">
                            <input
                              type="radio"
                              name="rollback-version"
                              value={item.version}
                              checked={selectedHistoryVersion === item.version}
                              onChange={() => setSelectedHistoryVersion(item.version)}
                              disabled={actionPending || ["downloading", "downloaded", "installing"].includes(state.phase)}
                            />
                            <span className="app-update-history-radio" aria-hidden="true"><Check size={11} /></span>
                            <span className="app-update-history-meta"><strong>v{item.version}</strong><small>{formatReleaseDate(item.publishedAt)}</small></span>
                            <span className="app-update-history-size">{formatBytes(item.installerSize)}</span>
                          </label>
                          <PathTooltip content={`查看 v${item.version} 发布页`} className="app-update-action-tooltip">
                            <button type="button" className="app-update-icon-button" aria-label={`查看 v${item.version} 发布页`} onClick={() => openRelease(item.releaseUrl)}><ExternalLink size={13} /></button>
                          </PathTooltip>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="app-update-history-empty"><History size={16} />暂无可安全回退的正式版本</div>
                  )}

                  {historyItems.length > 0 ? (
                    <button
                      type="button"
                      className="app-update-prepare-rollback"
                      disabled={!selectedHistoryVersion || actionPending || selectedRollbackPrepared || ["downloading", "downloaded", "installing"].includes(state.phase)}
                      onClick={() => void prepareRollback()}
                    >
                      {selectedRollbackPrepared
                        ? <CheckCircle2 size={15} />
                        : actionPending
                          ? <LoaderCircle className="app-update-spin" size={15} />
                          : <ArrowDownToLine size={15} />}
                      {selectedRollbackPrepared ? `已选择 v${selectedHistoryVersion}` : `选为回退目标`}
                    </button>
                  ) : null}
                </> : null}
              </div>
            </section>
          </div>

          {hasTarget || state.operation === "rollback" ? (
            <div className="app-update-actions">
              {state.operation === "rollback" ? (
                <button type="button" className="app-update-secondary" disabled={actionPending || state.phase === "installing"} onClick={() => void cancelRollback()}>
                  <X size={14} />取消
                </button>
              ) : null}
              {state.availableVersion && !rollbackNeedsPreparation ? (
                <button
                  type="button"
                  className="app-update-primary"
                  disabled={actionPending || state.phase === "checking" || state.phase === "downloading" || state.phase === "installing"}
                  onClick={state.phase === "downloaded" ? () => void installUpdate() : () => void downloadUpdate()}
                >
                  {state.phase === "downloaded" ? <PackageCheck size={16} /> : state.phase === "downloading" || state.phase === "installing" ? <LoaderCircle className="app-update-spin" size={16} /> : state.operation === "rollback" ? <RotateCcw size={16} /> : <Download size={16} />}
                  {primaryActionLabel(state, actionPending)}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function phaseLabel(state: UpdateState): string {
  const rollback = state.operation === "rollback";
  switch (state.phase) {
    case "unsupported":
      return "仅支持 Windows 安装版";
    case "idle":
      return "正式版";
    case "checking":
      return rollback ? "正在校验" : "正在检查更新";
    case "up-to-date":
      return "已是最新版本";
    case "downloading":
      return rollback ? "正在下载回退版本" : "正在下载更新";
    case "downloaded":
      return rollback ? "回退版本已就绪" : "更新已就绪";
    case "installing":
      return "正在启动安装";
    case "error":
      return rollback ? "回退未完成" : "更新未完成";
    default:
      return rollback ? "已选择" : "可更新";
  }
}

function primaryActionLabel(state: UpdateState, actionPending: boolean): string {
  if (state.phase === "checking") {
    return "正在校验";
  }
  if (state.phase === "downloading") {
    return "正在下载";
  }
  if (state.phase === "downloaded") {
    return actionPending ? "正在启动" : state.operation === "rollback" ? "回退并重启" : "安装并重启";
  }
  if (state.phase === "installing") {
    return "正在启动安装";
  }
  if (state.phase === "error") {
    return actionPending ? "正在重试" : state.operation === "rollback" ? "重新下载回退包" : "重新下载";
  }
  return actionPending ? "正在准备" : state.operation === "rollback" ? "下载回退版本" : "下载更新";
}

function hasTargetVersion(state: UpdateState): boolean {
  return Boolean(state.availableVersion) && (TARGET_PHASES.has(state.phase) || state.operation === "rollback" || state.phase === "error");
}

function unsupportedUpdateState(): UpdateState {
  return { revision: 0, phase: "unsupported", operation: "upgrade", currentVersion: CURRENT_VERSION };
}

function requireUpdateBridgeMethod<T>(method: T | undefined): T {
  if (method === undefined) {
    throw new Error(UPDATE_BRIDGE_UNAVAILABLE);
  }
  return method;
}

function acceptAuthoritativeUpdateState(current: UpdateState, incoming: UpdateState): UpdateState {
  return incoming.revision >= current.revision ? incoming : current;
}

function normalizedPercent(percent: number | undefined): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.round(Math.min(100, Math.max(0, percent ?? 0)));
}

function formatBytes(bytes: number | undefined): string {
  if (!Number.isFinite(bytes) || !bytes || bytes <= 0) {
    return "--";
  }
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatReleaseDate(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(timestamp);
}

function stripVersionPrefix(version: string): string {
  return version.replace(/^v/i, "");
}

function cleanActionError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  return raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, "").trim() || fallback;
}

function releaseUrlFor(version: string): string {
  return `https://github.com/zjx150504-lgtm/Git_UI_Pro/releases/tag/v${stripVersionPrefix(version)}`;
}

function createMockReleaseHistory(currentVersion: string): ReleaseHistoryItem[] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(stripVersionPrefix(currentVersion));
  if (!match) {
    return [];
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return Array.from({ length: Math.min(3, patch) }, (_, index) => {
    const version = `${major}.${minor}.${patch - index - 1}`;
    return {
      version,
      tagName: `v${version}`,
      releaseName: `Git UI Pro v${version}`,
      releaseNotes: `1. Git UI Pro v${version} 正式版本\n2. 历史发布记录来自在线发行版`,
      publishedAt: new Date(Date.UTC(2026, 6, 23 - index * 4)).toISOString(),
      releaseUrl: releaseUrlFor(version),
      installerSize: 82_000_000 - index * 1_400_000
    };
  });
}

function readMockUpdateState(): UpdateState | null {
  const params = new URLSearchParams(window.location.search);
  const rawPhase = params.get("mockUpdate");
  if (!rawPhase) {
    return null;
  }
  const phase = rawPhase === "current" ? "up-to-date" : rawPhase as UpdatePhase;
  if (!MOCK_PHASES.has(phase)) {
    return null;
  }

  const currentVersion = params.get("currentVersion")?.trim() || CURRENT_VERSION;
  const availableVersion = params.get("nextVersion")?.trim() || incrementPatchVersion(currentVersion);
  const baseState: UpdateState = {
    revision: 0,
    phase,
    operation: "upgrade",
    currentVersion,
    availableVersion: phase === "idle" || phase === "checking" ? undefined : phase === "up-to-date" ? currentVersion : availableVersion,
    releaseName: `Git UI Pro v${stripVersionPrefix(availableVersion)}`,
    releaseDate: "2026-07-31T12:00:00.000Z",
    releaseUrl: releaseUrlFor(phase === "up-to-date" ? currentVersion : availableVersion),
    releaseNotes: "1. 新增 Windows 正式版应用内更新入口\n2. 下载完成后可直接安装并重启软件\n3. 优化更新进度与失败重试反馈"
  };

  if (phase === "downloading") {
    baseState.progress = { percent: 64, transferred: 53_687_091, total: 83_885_063, bytesPerSecond: 5_242_880 };
  } else if (phase === "downloaded") {
    baseState.progress = { percent: 100, transferred: 83_885_063, total: 83_885_063, bytesPerSecond: 0 };
  } else if (phase === "error") {
    baseState.error = "下载连接已中断，请检查网络后重新下载。";
  }

  return baseState;
}

function incrementPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(stripVersionPrefix(version));
  return match ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : version;
}
