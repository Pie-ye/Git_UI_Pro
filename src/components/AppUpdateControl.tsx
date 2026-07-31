import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  PackageCheck,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { UpdatePhase, UpdateState } from "../types/electron";

const VISIBLE_PHASES = new Set<UpdatePhase>(["available", "downloading", "downloaded", "installing"]);
const MOCK_PHASES = new Set<UpdatePhase>(["available", "downloading", "downloaded", "error"]);

export function AppUpdateControl() {
  const mockState = useMemo(() => readMockUpdateState(), []);
  const isMock = mockState !== null;
  const [state, setState] = useState<UpdateState | null>(mockState);
  const [open, setOpen] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
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
        setOpen(false);
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

  useEffect(
    () => () => {
      if (mockTimerRef.current !== undefined) {
        window.clearTimeout(mockTimerRef.current);
      }
    },
    []
  );

  if (!state || !shouldShowUpdate(state)) {
    return null;
  }

  const progressPercent = normalizedPercent(state.progress?.percent);
  const releaseNotes = state.releaseNotes?.trim() || "本次发布未提供版本说明。";
  const status = phaseContent(state, progressPercent);

  async function downloadUpdate() {
    if (!state || actionPending || state.phase === "downloading") {
      return;
    }

    setActionPending(true);
    if (isMock) {
      setState({
        ...state,
        phase: "downloading",
        error: undefined,
        progress: { percent: 38, transferred: 31_876_324, total: 83_885_063, bytesPerSecond: 5_242_880 }
      });
      setActionPending(false);
      mockTimerRef.current = window.setTimeout(() => {
        setState((current) =>
          current
            ? {
                ...current,
                phase: "downloaded",
                progress: { percent: 100, transferred: 83_885_063, total: 83_885_063, bytesPerSecond: 0 }
              }
            : current
        );
      }, 900);
      return;
    }

    try {
      const nextState = await window.gitUI?.downloadUpdate();
      if (nextState) {
        setState(nextState);
      }
    } catch (error) {
      setRecoverableError(error);
    } finally {
      setActionPending(false);
    }
  }

  async function installUpdate() {
    if (!state || actionPending || state.phase !== "downloaded") {
      return;
    }

    setActionPending(true);
    if (isMock) {
      setState({ ...state, phase: "installing", error: undefined });
      setActionPending(false);
      return;
    }

    try {
      const started = await window.gitUI?.installUpdate();
      if (started === false) {
        throw new Error("安装程序未能启动，请稍后重试。");
      }
    } catch (error) {
      setRecoverableError(error);
      setActionPending(false);
    }
  }

  function setRecoverableError(error: unknown) {
    const message = error instanceof Error ? error.message : "更新操作失败，请稍后重试。";
    setState((current) => (current ? { ...current, phase: "error", error: message } : current));
  }

  function openRelease() {
    if (!state?.releaseUrl) {
      return;
    }

    if (window.gitUI?.openExternal) {
      void window.gitUI.openExternal(state.releaseUrl).catch(() => undefined);
      return;
    }

    window.open(state.releaseUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="app-update-control" ref={rootRef}>
      <button
        type="button"
        className="app-update-trigger"
        data-phase={state.phase}
        title={status.triggerLabel}
        aria-label={status.triggerLabel}
        aria-expanded={open}
        aria-controls="app-update-popover"
        onClick={() => setOpen((current) => !current)}
      >
        <UpdateIcon phase={state.phase} />
        <span className="app-update-trigger-dot" aria-hidden="true" />
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
            <div>
              <span className="app-update-eyebrow">Windows 正式版</span>
              <h2 id="app-update-title">软件更新</h2>
            </div>
            <button type="button" className="app-update-close" title="关闭更新窗口" aria-label="关闭更新窗口" onClick={() => setOpen(false)}>
              <X size={16} />
            </button>
          </div>

          <div className="app-update-version-lens" aria-label={`从 ${state.currentVersion} 更新到 ${state.availableVersion}`}>
            <div>
              <span>当前版本</span>
              <strong>v{stripVersionPrefix(state.currentVersion)}</strong>
            </div>
            <span className="app-update-version-flow" aria-hidden="true">
              <ArrowRight size={18} />
            </span>
            <div className="is-target">
              <span>可更新</span>
              <strong>v{stripVersionPrefix(state.availableVersion ?? state.currentVersion)}</strong>
            </div>
          </div>

          <div className="app-update-status" data-phase={state.phase} aria-live="polite">
            <span className="app-update-status-icon">
              <UpdateIcon phase={state.phase} />
            </span>
            <div>
              <strong>{status.title}</strong>
              <span>{status.description}</span>
            </div>
          </div>

          {state.phase === "downloading" ? (
            <div className="app-update-progress" role="progressbar" aria-label="更新包下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}>
              <div className="app-update-progress-meta">
                <strong>{progressPercent}%</strong>
                <span>
                  {formatBytes(state.progress?.transferred)} / {formatBytes(state.progress?.total)}
                </span>
              </div>
              <div className="app-update-progress-track">
                <span style={{ width: `${progressPercent}%` }} />
              </div>
              {state.progress?.bytesPerSecond ? <span className="app-update-progress-speed">{formatBytes(state.progress.bytesPerSecond)}/s</span> : null}
            </div>
          ) : null}

          {state.error ? (
            <div className="app-update-error" role="alert">
              <AlertTriangle size={15} />
              <span>{state.error}</span>
            </div>
          ) : null}

          <section className="app-update-notes" aria-labelledby="app-update-notes-title">
            <div className="app-update-notes-heading">
              <div>
                <h3 id="app-update-notes-title">{state.releaseName?.trim() || "版本说明"}</h3>
                {state.releaseDate ? <time dateTime={state.releaseDate}>{formatReleaseDate(state.releaseDate)}</time> : null}
              </div>
              <span title="版本说明来自 GitHub Release，不可在此编辑">
                <LockKeyhole size={12} />
                发布记录
              </span>
            </div>
            <div className="app-update-notes-content">{releaseNotes}</div>
          </section>

          <div className="app-update-actions">
            {state.releaseUrl ? (
              <button type="button" className="app-update-secondary" onClick={openRelease}>
                <ExternalLink size={15} />
                查看发布
              </button>
            ) : null}
            <button
              type="button"
              className="app-update-primary"
              disabled={actionPending || state.phase === "downloading" || state.phase === "installing"}
              onClick={state.phase === "downloaded" ? installUpdate : downloadUpdate}
            >
              {state.phase === "downloaded" ? <PackageCheck size={16} /> : state.phase === "downloading" || state.phase === "installing" ? <LoaderCircle className="app-update-spin" size={16} /> : <Download size={16} />}
              {primaryActionLabel(state.phase, progressPercent, actionPending)}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function shouldShowUpdate(state: UpdateState): boolean {
  return VISIBLE_PHASES.has(state.phase) || (state.phase === "error" && Boolean(state.availableVersion));
}

function UpdateIcon({ phase }: { phase: UpdatePhase }) {
  if (phase === "downloading" || phase === "installing") {
    return <LoaderCircle className="app-update-spin" size={15} />;
  }
  if (phase === "downloaded") {
    return <CheckCircle2 size={15} />;
  }
  if (phase === "error") {
    return <AlertTriangle size={15} />;
  }
  return <Download size={15} />;
}

function phaseContent(state: UpdateState, progressPercent: number) {
  switch (state.phase) {
    case "downloading":
      return {
        title: "正在下载更新",
        description: `已完成 ${progressPercent}%，下载期间可继续使用软件。`,
        triggerLabel: `正在下载 v${stripVersionPrefix(state.availableVersion ?? "")}，已完成 ${progressPercent}%`
      };
    case "downloaded":
      return {
        title: "更新已准备好",
        description: "安装时软件将关闭，并自动启动新版。",
        triggerLabel: `v${stripVersionPrefix(state.availableVersion ?? "")} 已可安装`
      };
    case "installing":
      return {
        title: "正在启动安装",
        description: "请稍候，软件即将关闭并完成更新。",
        triggerLabel: "正在启动更新安装程序"
      };
    case "error":
      return {
        title: "更新未完成",
        description: "当前版本不会受影响，可以直接重试。",
        triggerLabel: "更新失败，点击查看详情并重试"
      };
    default:
      return {
        title: "发现新版本",
        description: "确认版本说明后，可手动下载并安装。",
        triggerLabel: `发现新版本 v${stripVersionPrefix(state.availableVersion ?? "")}`
      };
  }
}

function primaryActionLabel(phase: UpdatePhase, progressPercent: number, actionPending: boolean): string {
  if (phase === "downloading") {
    return `下载中 ${progressPercent}%`;
  }
  if (phase === "downloaded") {
    return actionPending ? "正在启动" : "安装并重启";
  }
  if (phase === "installing") {
    return "正在启动安装";
  }
  if (phase === "error") {
    return actionPending ? "正在重试" : "重新下载";
  }
  return actionPending ? "正在准备" : "下载更新";
}

function normalizedPercent(percent: number | undefined): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.round(Math.min(100, Math.max(0, percent ?? 0)));
}

function formatBytes(bytes: number | undefined): string {
  if (!Number.isFinite(bytes) || !bytes || bytes <= 0) {
    return "0 MB";
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

function readMockUpdateState(): UpdateState | null {
  const params = new URLSearchParams(window.location.search);
  const phase = params.get("mockUpdate") as UpdatePhase | null;
  if (!phase || !MOCK_PHASES.has(phase)) {
    return null;
  }

  const currentVersion = params.get("currentVersion")?.trim() || "0.1.12";
  const availableVersion = params.get("nextVersion")?.trim() || "0.1.13";
  const baseState: UpdateState = {
    phase,
    currentVersion,
    availableVersion,
    releaseName: `Git UI Pro v${stripVersionPrefix(availableVersion)}`,
    releaseDate: "2026-07-31T12:00:00.000Z",
    releaseUrl: `https://github.com/zjx150504-lgtm/Git_UI_Pro/releases/tag/v${stripVersionPrefix(availableVersion)}`,
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
