import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
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
  ShieldCheck,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import packageInfo from "../../package.json";
import type { ReleaseHistoryItem, UpdateOperation, UpdatePhase, UpdateState } from "../types/electron";

const TARGET_PHASES = new Set<UpdatePhase>(["available", "downloading", "downloaded", "installing"]);
const MOCK_PHASES = new Set<UpdatePhase>(["idle", "checking", "up-to-date", "available", "downloading", "downloaded", "error"]);
const CURRENT_VERSION = packageInfo.version;

export function AppUpdateControl() {
  const mockState = useMemo(() => readMockUpdateState(), []);
  const isMock = mockState !== null;
  const [state, setState] = useState<UpdateState>(() => mockState ?? fallbackUpdateState());
  const [open, setOpen] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [historyItems, setHistoryItems] = useState<ReleaseHistoryItem[]>([]);
  const [selectedHistoryVersion, setSelectedHistoryVersion] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const mockTimerRef = useRef<number>();

  useEffect(() => {
    if (isMock) {
      return;
    }

    let cancelled = false;
    const bridge = window.gitUI;
    if (!bridge?.getUpdateState) {
      return;
    }

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (!cancelled) {
          setState(nextState);
        }
      })
      .catch(() => undefined);

    const unsubscribe = bridge.onUpdateState?.((nextState) => {
      if (!cancelled) {
        setState(nextState);
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
      if (!rootRef.current?.contains(event.target as Node)) {
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
  const releaseNotes = releaseNotesForDisplay(state.releaseNotes);
  const triggerLabel = triggerContent(state);
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
      const items = isMock || !window.gitUI?.listUpdateReleases
        ? createMockReleaseHistory(state.currentVersion)
        : await window.gitUI.listUpdateReleases(force);
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
    if (isMock || !window.gitUI?.checkForUpdates) {
      setState((current) => ({ ...current, phase: "checking", operation: "upgrade", error: undefined }));
      mockTimerRef.current = window.setTimeout(() => {
        setState((current) => ({
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
      setState(await window.gitUI.checkForUpdates());
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
    if (isMock || !window.gitUI?.prepareRollback) {
      setState({
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
      setState(await window.gitUI.prepareRollback(selected.version));
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
    if (isMock || !window.gitUI?.cancelRollback) {
      if (mockTimerRef.current !== undefined) {
        window.clearTimeout(mockTimerRef.current);
        mockTimerRef.current = undefined;
      }
      setState({ phase: "idle", operation: "upgrade", currentVersion: state.currentVersion });
      setActionPending(false);
      return;
    }

    try {
      setState(await window.gitUI.cancelRollback());
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
    if (isMock || !window.gitUI?.downloadUpdate) {
      setState({
        ...state,
        phase: "downloading",
        error: undefined,
        progress: { percent: 38, transferred: 31_876_324, total: 83_885_063, bytesPerSecond: 5_242_880 }
      });
      setActionPending(false);
      mockTimerRef.current = window.setTimeout(() => {
        setState((current) => ({
          ...current,
          phase: "downloaded",
          progress: { percent: 100, transferred: 83_885_063, total: 83_885_063, bytesPerSecond: 0 }
        }));
      }, 900);
      return;
    }

    try {
      setState(await window.gitUI.downloadUpdate());
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
    if (isMock || !window.gitUI?.installUpdate) {
      setState({ ...state, phase: "installing", error: undefined });
      setActionPending(false);
      return;
    }

    try {
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
    if (window.gitUI?.openExternal) {
      void window.gitUI.openExternal(url).catch(() => undefined);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="app-update-control" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="app-update-trigger"
        data-phase={state.phase}
        data-operation={state.operation}
        title={triggerLabel.title}
        aria-label={triggerLabel.title}
        aria-expanded={open}
        aria-controls="app-update-popover"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="app-update-trigger-version">v{stripVersionPrefix(state.currentVersion)}</span>
        <span className="app-update-trigger-state" aria-hidden="true">
          <UpdateIcon phase={state.phase} operation={state.operation} size={12} />
        </span>
        {triggerLabel.attention ? <span className="app-update-trigger-dot" aria-hidden="true" /> : null}
      </button>

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
            <h2 id="app-update-title">版本与更新</h2>
            <div className="app-update-header-actions">
              <button type="button" className="app-update-icon-button" title="检查最新版本" aria-label="检查最新版本" disabled={!canCheck} onClick={() => void checkForUpdates()}>
                <RefreshCw className={state.phase === "checking" ? "app-update-spin" : ""} size={15} />
              </button>
              <button type="button" className="app-update-icon-button" title="关闭版本窗口" aria-label="关闭版本窗口" onClick={closePanel}>
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="app-update-scroll-region">
            <section
              className="app-update-overview"
              data-has-target={hasTarget}
              data-operation={state.operation}
              aria-label={hasTarget
                ? `从 ${state.currentVersion} ${state.operation === "rollback" ? "回退" : "更新"}到 ${state.availableVersion}`
                : `当前版本 v${stripVersionPrefix(state.currentVersion)}`}
            >
              <div className="app-update-version-strip">
                <div className="app-update-version-block">
                  <span>{hasTarget ? "当前" : "当前版本"}</span>
                  <strong>v{stripVersionPrefix(state.currentVersion)}</strong>
                </div>
                {hasTarget ? <>
                  <span className="app-update-version-flow" aria-hidden="true">
                    {state.operation === "rollback" ? <RotateCcw size={17} /> : <ArrowRight size={18} />}
                  </span>
                  <div className="app-update-version-block is-target">
                    <span>{state.operation === "rollback" ? "回退至" : "更新至"}</span>
                    <strong>v{stripVersionPrefix(state.availableVersion ?? state.currentVersion)}</strong>
                  </div>
                </> : null}
              </div>
              <div className="app-update-overview-meta" data-phase={state.phase} data-operation={state.operation} aria-live="polite">
                <span className="app-update-overview-status">
                  <span className="app-update-status-icon"><UpdateIcon phase={state.phase} operation={state.operation} size={13} /></span>
                  <strong>{statusLabel}</strong>
                </span>
                <button type="button" className="app-update-release-link" onClick={() => openRelease()}>
                  <ExternalLink size={13} />发布页
                </button>
              </div>
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

            {hasTarget && releaseNotes ? (
              <section className="app-update-notes" aria-labelledby="app-update-notes-title">
                <div className="app-update-notes-heading">
                  <div>
                    <h3 id="app-update-notes-title">版本说明</h3>
                    {state.releaseDate ? <time dateTime={state.releaseDate}>{formatReleaseDate(state.releaseDate)}</time> : null}
                  </div>
                </div>
                <div className="app-update-notes-content">{releaseNotes}</div>
              </section>
            ) : null}

            <section className="app-update-history" data-expanded={historyExpanded}>
              <button
                type="button"
                className="app-update-history-toggle"
                title="仅显示带 SHA-256 校验的 GitHub 正式安装版"
                aria-expanded={historyExpanded}
                onClick={() => setHistoryExpanded((current) => !current)}
              >
                <span className="app-update-history-title"><History size={16} /><strong>历史版本</strong>{historyItems.length > 0 ? <small>{historyItems.length}</small> : null}</span>
                <ChevronDown size={16} />
              </button>

              {historyExpanded ? (
                <div className="app-update-history-body">
                  {historyLoading ? (
                    <div className="app-update-history-empty"><LoaderCircle className="app-update-spin" size={16} />正在读取历史版本</div>
                  ) : historyError ? (
                    <div className="app-update-history-error" role="alert">
                      <AlertTriangle size={14} /><span>{historyError}</span>
                      <button type="button" className="app-update-icon-button" title="重新读取历史版本" aria-label="重新读取历史版本" onClick={() => void loadReleaseHistory(true)}><RefreshCw size={14} /></button>
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
                          <button type="button" className="app-update-icon-button" title={`查看 v${item.version} 发布页`} aria-label={`查看 v${item.version} 发布页`} onClick={() => openRelease(item.releaseUrl)}><ExternalLink size={13} /></button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="app-update-history-empty"><History size={16} />暂无可安全回退的正式版本</div>
                  )}

                  {historyItems.length > 0 ? (
                    <>
                      <div className="app-update-history-caution"><ShieldCheck size={13} /><span>程序回退，项目保留；旧版可能不兼容当前配置。</span></div>
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
                    </>
                  ) : null}
                </div>
              ) : null}
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

function UpdateIcon({ phase, operation, size }: { phase: UpdatePhase; operation: UpdateOperation; size: number }) {
  if (phase === "checking" || phase === "downloading" || phase === "installing") {
    return <LoaderCircle className="app-update-spin" size={size} />;
  }
  if (phase === "downloaded") {
    return <PackageCheck size={size} />;
  }
  if (phase === "error") {
    return <AlertTriangle size={size} />;
  }
  if (phase === "available") {
    return operation === "rollback" ? <RotateCcw size={size} /> : <Download size={size} />;
  }
  return <CheckCircle2 size={size} />;
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
      return rollback ? "已选择回退版本" : "发现新版本";
  }
}

function releaseNotesForDisplay(value: string | undefined): string {
  if (!value) {
    return "";
  }

  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !isGeneratedChangelogLine(line))
    .join("\n")
    .trim();
}

function isGeneratedChangelogLine(line: string): boolean {
  const normalized = line.replace(/\*\*/g, "").trim();
  const prefix = "Full Changelog:";
  if (!normalized.startsWith(prefix)) {
    return false;
  }

  try {
    const url = new URL(normalized.slice(prefix.length).trim());
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname.startsWith("/zjx150504-lgtm/Git_UI_Pro/compare/");
  } catch {
    return false;
  }
}

function triggerContent(state: UpdateState): { title: string; attention: boolean } {
  if (state.phase === "available") {
    return { title: state.operation === "rollback" ? `已准备回退到 v${state.availableVersion}` : `发现新版本 v${state.availableVersion}`, attention: true };
  }
  if (state.phase === "downloading") {
    return { title: `${state.operation === "rollback" ? "回退包" : "更新包"}下载中`, attention: true };
  }
  if (state.phase === "downloaded") {
    return { title: `v${state.availableVersion} 已可安装`, attention: true };
  }
  if (state.phase === "error") {
    return { title: "版本操作失败，点击查看详情", attention: true };
  }
  return { title: `当前版本 v${state.currentVersion}`, attention: false };
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

function fallbackUpdateState(): UpdateState {
  return { phase: "unsupported", operation: "upgrade", currentVersion: CURRENT_VERSION };
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
      releaseNotes: `1. Git UI Pro v${version} 正式版本\n2. 历史发布记录来自 GitHub Release`,
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
