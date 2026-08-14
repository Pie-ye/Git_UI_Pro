import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, GitBranch, GitMerge, Loader2, Tag, Upload, X } from "lucide-react";
import { toast } from "sonner";
import type { BranchInfo, GitMergePreview, GitMergeStrategy, GitProject, GitRemoteInfo, GitTagInfo } from "../types/domain";

const GRAPH_TOOLBAR_SELECTOR = ".graph-panel .graph-toolbar";
const ACTIVE_PROJECT_SELECTOR = ".project-rail-item.active";
const LOCAL_BRANCH_CHIP_SELECTOR = ".graph-panel .ref-chip.localBranch";
const HOST_REFRESH_DELAY_MS = 80;
const PROJECT_REFRESH_INTERVAL_MS = 5000;

type MergeRequest = {
  source: BranchInfo;
  target: BranchInfo;
  strategy: GitMergeStrategy;
  preview?: GitMergePreview;
  previewLoading?: boolean;
};

type FloatingPosition = {
  top: number;
  left: number;
};

export function GitKrakenGraphInteractions() {
  const [toolbarTarget, setToolbarTarget] = useState<HTMLElement | null>(null);
  const [project, setProject] = useState<GitProject>();
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [tags, setTags] = useState<GitTagInfo[]>([]);
  const [remotes, setRemotes] = useState<GitRemoteInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [branchMenuPosition, setBranchMenuPosition] = useState<FloatingPosition>();
  const [mergeRequest, setMergeRequest] = useState<MergeRequest>();
  const [pendingSwitch, setPendingSwitch] = useState<BranchInfo>();
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [tagName, setTagName] = useState("");
  const [tagTarget, setTagTarget] = useState("HEAD");
  const [tagMessage, setTagMessage] = useState("");
  const [pushAfterCreate, setPushAfterCreate] = useState(false);
  const [selectedRemote, setSelectedRemote] = useState("");
  const branchButtonRef = useRef<HTMLButtonElement>(null);
  const projectRequestRef = useRef(0);
  const domFrameRef = useRef<number>();
  const draggingChipRef = useRef<HTMLElement>();
  const dropChipRef = useRef<HTMLElement>();

  const currentBranch = project?.status?.currentBranch ?? "Detached HEAD";
  const localBranches = useMemo(() => branches.filter((branch) => branch.type === "local"), [branches]);
  const filteredBranches = useMemo(() => {
    const keyword = branchQuery.trim().toLocaleLowerCase();
    if (!keyword) return branches;
    return branches.filter((branch) => `${branch.name} ${branch.type} ${branch.upstream ?? ""}`.toLocaleLowerCase().includes(keyword));
  }, [branches, branchQuery]);

  useEffect(() => {
    let disposed = false;

    const syncDom = () => {
      window.cancelAnimationFrame(domFrameRef.current ?? 0);
      domFrameRef.current = window.requestAnimationFrame(() => {
        if (disposed) return;
        const nextToolbar = document.querySelector<HTMLElement>(GRAPH_TOOLBAR_SELECTOR);
        setToolbarTarget((current) => current === nextToolbar ? current : nextToolbar);
        annotateBranchChips(busy);
      });
    };

    syncDom();
    const observer = new MutationObserver(syncDom);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"]
    });

    return () => {
      disposed = true;
      observer.disconnect();
      window.cancelAnimationFrame(domFrameRef.current ?? 0);
    };
  }, [busy]);

  useEffect(() => {
    void refreshProjectContext();
    const timer = window.setInterval(() => void refreshProjectContext(false), PROJECT_REFRESH_INTERVAL_MS);

    const handleProjectClick = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest(ACTIVE_PROJECT_SELECTOR)) {
        window.setTimeout(() => void refreshProjectContext(), 0);
      }
    };
    document.addEventListener("click", handleProjectClick, true);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("click", handleProjectClick, true);
    };
  }, []);

  useEffect(() => {
    const handleDoubleClick = (event: MouseEvent) => {
      const chip = branchChipFromEvent(event);
      if (!chip) return;
      const branchName = chipBranchName(chip);
      if (!branchName) return;
      const branch = branches.find((candidate) => candidate.type === "local" && candidate.name === branchName);
      if (!branch) return;
      event.preventDefault();
      event.stopPropagation();
      void requestSwitchBranch(branch);
    };

    const handleDragStart = (event: DragEvent) => {
      const chip = branchChipFromEvent(event);
      if (!chip || busy) return;
      const branchName = chipBranchName(chip);
      const branch = branches.find((candidate) => candidate.type === "local" && candidate.name === branchName);
      if (!branch) return;

      draggingChipRef.current = chip;
      chip.classList.add("gitkraken-drag-source");
      event.dataTransfer?.setData("application/x-git-ui-pro-branch", branch.name);
      event.dataTransfer?.setData("text/plain", branch.name);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    };

    const handleDragOver = (event: DragEvent) => {
      const chip = branchChipFromEvent(event);
      const sourceName = draggingChipRef.current ? chipBranchName(draggingChipRef.current) : event.dataTransfer?.getData("application/x-git-ui-pro-branch");
      const targetName = chip ? chipBranchName(chip) : "";
      if (!chip || !sourceName || !targetName || sourceName === targetName) return;

      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      if (dropChipRef.current !== chip) {
        dropChipRef.current?.classList.remove("gitkraken-drop-target");
        dropChipRef.current = chip;
        chip.classList.add("gitkraken-drop-target");
      }
    };

    const handleDragLeave = (event: DragEvent) => {
      const chip = branchChipFromEvent(event);
      if (!chip || dropChipRef.current !== chip) return;
      const related = event.relatedTarget as Node | null;
      if (related && chip.contains(related)) return;
      chip.classList.remove("gitkraken-drop-target");
      dropChipRef.current = undefined;
    };

    const handleDrop = (event: DragEvent) => {
      const chip = branchChipFromEvent(event);
      const sourceName = draggingChipRef.current ? chipBranchName(draggingChipRef.current) : event.dataTransfer?.getData("application/x-git-ui-pro-branch");
      const targetName = chip ? chipBranchName(chip) : "";
      cleanupDragState();
      if (!sourceName || !targetName || sourceName === targetName) return;

      event.preventDefault();
      event.stopPropagation();
      const source = branches.find((candidate) => candidate.type === "local" && candidate.name === sourceName);
      const target = branches.find((candidate) => candidate.type === "local" && candidate.name === targetName);
      if (!source || !target) {
        toast.error("無法辨識拖曳的分支");
        return;
      }
      void prepareMerge(source, target);
    };

    const handleDragEnd = () => cleanupDragState();

    document.addEventListener("dblclick", handleDoubleClick, true);
    document.addEventListener("dragstart", handleDragStart, true);
    document.addEventListener("dragover", handleDragOver, true);
    document.addEventListener("dragleave", handleDragLeave, true);
    document.addEventListener("drop", handleDrop, true);
    document.addEventListener("dragend", handleDragEnd, true);

    return () => {
      document.removeEventListener("dblclick", handleDoubleClick, true);
      document.removeEventListener("dragstart", handleDragStart, true);
      document.removeEventListener("dragover", handleDragOver, true);
      document.removeEventListener("dragleave", handleDragLeave, true);
      document.removeEventListener("drop", handleDrop, true);
      document.removeEventListener("dragend", handleDragEnd, true);
      cleanupDragState();
    };
  }, [branches, busy, project?.id]);

  async function refreshProjectContext(showErrors = false) {
    const api = window.gitUI;
    if (!api) return;
    const requestId = ++projectRequestRef.current;
    try {
      const projects = await api.getProjects();
      const selected = resolveActiveProject(projects);
      if (requestId !== projectRequestRef.current) return;
      if (!selected) {
        setProject(undefined);
        setBranches([]);
        setTags([]);
        setRemotes([]);
        return;
      }

      const [status, nextBranches, nextTags, nextRemotes] = await Promise.all([
        api.getProjectStatus(selected),
        api.getBranches(selected),
        api.getTags(selected),
        api.getRemotes(selected)
      ]);
      if (requestId !== projectRequestRef.current) return;
      setProject({ ...selected, status });
      setBranches(nextBranches);
      setTags(nextTags);
      setRemotes(nextRemotes);
      setSelectedRemote((current) => current && nextRemotes.some((remote) => remote.name === current) ? current : nextRemotes[0]?.name ?? "");
    } catch (error) {
      if (requestId !== projectRequestRef.current) return;
      if (showErrors) toast.error(errorText(error, "無法讀取分支狀態"));
    }
  }

  function toggleBranchMenu() {
    if (!branchMenuOpen) {
      const rect = branchButtonRef.current?.getBoundingClientRect();
      if (rect) {
        setBranchMenuPosition({
          top: Math.min(window.innerHeight - 360, rect.bottom + 6),
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 300))
        });
      }
      setBranchQuery("");
    }
    setBranchMenuOpen((current) => !current);
  }

  async function requestSwitchBranch(branch: BranchInfo) {
    if (!project || busy) return;
    if (branch.current) {
      setBranchMenuOpen(false);
      toast.info(`目前已在 ${branch.name}`);
      return;
    }

    try {
      const status = await window.gitUI?.getProjectStatus(project);
      if (!status) return;
      if (status.operationState || status.hasConflicts) {
        toast.error("目前有尚未完成的 Git 操作，請先完成或終止後再切換分支。");
        return;
      }
      if (hasWorktreeChanges(status)) {
        setPendingSwitch(branch);
        setBranchMenuOpen(false);
        return;
      }
      await performSwitchBranch(branch);
    } catch (error) {
      toast.error(errorText(error, "切換分支失敗"));
    }
  }

  async function performSwitchBranch(branch: BranchInfo) {
    if (!project || !window.gitUI) return;
    setBusy(true);
    setBranchMenuOpen(false);
    const toastId = toast.loading(`正在切換到 ${branch.name}...`);
    try {
      const result = await window.gitUI.switchBranch(project, branch);
      if (!result.ok) {
        toast.error(result.messageZh ?? "切換分支失敗", { id: toastId, description: gitOutput(result) });
        return;
      }
      toast.success(`已切換到 ${branch.name}`, { id: toastId });
      setPendingSwitch(undefined);
      requestHostRefresh();
      await refreshProjectContext();
    } catch (error) {
      toast.error(errorText(error, "切換分支失敗"), { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  async function prepareMerge(source: BranchInfo, target: BranchInfo) {
    if (!project || !window.gitUI || busy) return;
    try {
      const status = await window.gitUI.getProjectStatus(project);
      if (status.operationState || status.hasConflicts) {
        toast.error("目前有尚未完成的 Git 操作，無法開始新的 merge。");
        return;
      }
      if (hasWorktreeChanges(status)) {
        toast.error("拖曳合併前工作區必須乾淨", { description: "請先 commit、stash 或放棄目前變更。" });
        return;
      }

      setMergeRequest({ source, target, strategy: "ff", previewLoading: source.current });
      if (!source.current) return;

      try {
        const preview = await window.gitUI.getMergePreview(project, target.name);
        setMergeRequest((current) => current && current.source.name === source.name && current.target.name === target.name
          ? { ...current, preview, previewLoading: false }
          : current);
      } catch (error) {
        setMergeRequest(undefined);
        toast.error(errorText(error, "無法預覽 merge"));
      }
    } catch (error) {
      toast.error(errorText(error, "無法準備 merge"));
    }
  }

  async function executeMerge() {
    if (!project || !window.gitUI || !mergeRequest || busy) return;
    const { source, target, strategy } = mergeRequest;
    setBusy(true);
    const toastId = toast.loading(`正在合併 ${source.name} → ${target.name}...`);
    let originalBranch: BranchInfo | undefined;
    let switchedToSource = false;

    try {
      const [status, latestBranches] = await Promise.all([
        window.gitUI.getProjectStatus(project),
        window.gitUI.getBranches(project)
      ]);
      if (status.operationState || status.hasConflicts) {
        throw new Error("目前有尚未完成的 Git 操作。");
      }
      if (hasWorktreeChanges(status)) {
        throw new Error("工作區已有未提交變更，merge 已停止。");
      }

      originalBranch = latestBranches.find((branch) => branch.type === "local" && branch.current);
      const latestSource = latestBranches.find((branch) => branch.type === "local" && branch.name === source.name);
      const latestTarget = latestBranches.find((branch) => branch.type === "local" && branch.name === target.name);
      if (!latestSource || !latestTarget) throw new Error("來源或目標分支已不存在，請重新整理後再試。");

      if (!latestSource.current) {
        const switchResult = await window.gitUI.switchBranch(project, latestSource);
        if (!switchResult.ok) {
          throw new Error(switchResult.messageZh ?? `無法切換到來源分支 ${latestSource.name}`);
        }
        switchedToSource = true;
      }

      const preview = await window.gitUI.getMergePreview(project, latestTarget.name);
      if (preview.mode === "up-to-date") {
        toast.info(`${latestTarget.name} 已包含 ${latestSource.name} 的全部提交`, { id: toastId });
        setMergeRequest(undefined);
        if (switchedToSource && originalBranch && originalBranch.name !== latestSource.name) {
          const refreshedBranches = await window.gitUI.getBranches(project);
          const original = refreshedBranches.find((branch) => branch.type === "local" && branch.name === originalBranch!.name);
          if (original) await window.gitUI.switchBranch(project, original);
        }
        requestHostRefresh();
        await refreshProjectContext();
        return;
      }

      const result = await window.gitUI.mergeCurrentBranch(project, latestTarget.name, strategy);
      setMergeRequest(undefined);
      const nextStatus = await window.gitUI.getProjectStatus(project);
      if (result.ok) {
        toast.success(`合併完成：${latestSource.name} → ${latestTarget.name}`, { id: toastId });
      } else if (nextStatus.operationState === "merge" || nextStatus.hasConflicts) {
        toast.warning("Merge 已開始但產生衝突", {
          id: toastId,
          description: "目前已切到目標分支；請使用既有衝突解決流程完成或終止 merge。"
        });
      } else {
        toast.error(result.messageZh ?? "合併失敗", { id: toastId, description: gitOutput(result) });
        if (switchedToSource && originalBranch && originalBranch.name !== latestSource.name) {
          const refreshedBranches = await window.gitUI.getBranches(project);
          const original = refreshedBranches.find((branch) => branch.type === "local" && branch.name === originalBranch!.name);
          if (original) await window.gitUI.switchBranch(project, original);
        }
      }

      requestHostRefresh();
      await refreshProjectContext();
    } catch (error) {
      toast.error(errorText(error, "合併失敗"), { id: toastId });
      try {
        const status = await window.gitUI.getProjectStatus(project);
        if (!status.operationState && !status.hasConflicts && switchedToSource && originalBranch && status.currentBranch !== originalBranch.name) {
          const refreshedBranches = await window.gitUI.getBranches(project);
          const original = refreshedBranches.find((branch) => branch.type === "local" && branch.name === originalBranch!.name);
          if (original) await window.gitUI.switchBranch(project, original);
        }
      } catch {
        // Preserve the primary merge error.
      }
      requestHostRefresh();
      await refreshProjectContext();
    } finally {
      setBusy(false);
    }
  }

  function openTagDialog() {
    if (!project) {
      toast.info("請先選擇 Repository");
      return;
    }
    setTagName("");
    setTagTarget("HEAD");
    setTagMessage("");
    setPushAfterCreate(false);
    setTagDialogOpen(true);
    void refreshProjectContext();
  }

  async function createTag() {
    if (!project || !window.gitUI || busy) return;
    const name = tagName.trim();
    const target = tagTarget.trim() || "HEAD";
    if (!name) {
      toast.info("請輸入 Tag 名稱");
      return;
    }
    if (pushAfterCreate && !selectedRemote) {
      toast.info("請先選擇要 Push Tag 的 remote");
      return;
    }

    setBusy(true);
    const toastId = toast.loading(`正在建立 Tag ${name}...`);
    try {
      const result = await window.gitUI.createTag(project, name, target, tagMessage.trim() || undefined);
      if (!result.ok) {
        toast.error(result.messageZh ?? "建立 Tag 失敗", { id: toastId, description: gitOutput(result) });
        return;
      }

      if (pushAfterCreate) {
        const pushResult = await window.gitUI.pushTag(project, selectedRemote, name);
        if (!pushResult.ok) {
          toast.warning(`Tag ${name} 已建立，但 Push 失敗`, { id: toastId, description: pushResult.messageZh ?? gitOutput(pushResult) });
          await refreshProjectContext();
          return;
        }
      }

      toast.success(pushAfterCreate ? `已建立並 Push Tag：${name}` : `已建立 Tag：${name}`, { id: toastId });
      setTagName("");
      setTagMessage("");
      setTagTarget("HEAD");
      requestHostRefresh();
      await refreshProjectContext();
    } catch (error) {
      toast.error(errorText(error, "建立 Tag 失敗"), { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  async function pushExistingTag(tag: GitTagInfo) {
    if (!project || !window.gitUI || !selectedRemote || busy) return;
    setBusy(true);
    const toastId = toast.loading(`正在 Push Tag ${tag.name}...`);
    try {
      const result = await window.gitUI.pushTag(project, selectedRemote, tag.name);
      if (result.ok) toast.success(`已 Push Tag：${tag.name}`, { id: toastId });
      else toast.error(result.messageZh ?? "Push Tag 失敗", { id: toastId, description: gitOutput(result) });
    } catch (error) {
      toast.error(errorText(error, "Push Tag 失敗"), { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  function cleanupDragState() {
    draggingChipRef.current?.classList.remove("gitkraken-drag-source");
    dropChipRef.current?.classList.remove("gitkraken-drop-target");
    draggingChipRef.current = undefined;
    dropChipRef.current = undefined;
  }

  return (
    <>
      {toolbarTarget ? createPortal(
        <div className="gitkraken-graph-controls" aria-label="GitKraken 式圖表操作">
          <button
            ref={branchButtonRef}
            type="button"
            className={`gitkraken-branch-switcher ${branchMenuOpen ? "active" : ""}`}
            title="切換分支；也可雙擊圖上的本機分支標籤"
            onClick={toggleBranchMenu}
            disabled={!project || busy}
          >
            <GitBranch size={14} />
            <span>{currentBranch}</span>
            <ChevronDown size={12} />
          </button>
          <button type="button" className="icon-button compact-icon gitkraken-tag-button" title="Tag 管理" aria-label="Tag 管理" onClick={openTagDialog} disabled={!project || busy}>
            <Tag size={15} />
          </button>
        </div>,
        toolbarTarget
      ) : null}

      {branchMenuOpen && branchMenuPosition ? createPortal(
        <div className="gitkraken-floating-menu" style={branchMenuPosition} role="dialog" aria-label="切換分支">
          <div className="gitkraken-menu-heading">
            <span><GitBranch size={14} />切換分支</span>
            <button type="button" aria-label="關閉" onClick={() => setBranchMenuOpen(false)}><X size={13} /></button>
          </div>
          <input autoFocus value={branchQuery} onChange={(event) => setBranchQuery(event.target.value)} placeholder="搜尋 branch" />
          <div className="gitkraken-branch-list">
            {filteredBranches.map((branch) => (
              <button
                type="button"
                className={`gitkraken-branch-item ${branch.current ? "current" : ""}`}
                onClick={() => void requestSwitchBranch(branch)}
                key={branch.fullName}
              >
                <span>{branch.type === "remote" ? "☁" : <GitBranch size={13} />}</span>
                <strong>{branch.name}</strong>
                <small>{branch.current ? "目前分支" : branch.type === "remote" ? "建立 tracking branch" : branch.upstream ?? "local"}</small>
                {branch.current ? <Check size={13} /> : null}
              </button>
            ))}
            {filteredBranches.length === 0 ? <div className="gitkraken-empty">沒有符合的 branch。</div> : null}
          </div>
        </div>,
        document.querySelector(".app-shell") ?? document.body
      ) : null}

      {pendingSwitch ? createPortal(
        <ConfirmDialog
          title="切換分支"
          detail={`工作區有未提交改動。仍要嘗試切換到 ${pendingSwitch.name} 嗎？`}
          confirmLabel="繼續切換"
          onCancel={() => setPendingSwitch(undefined)}
          onConfirm={() => void performSwitchBranch(pendingSwitch)}
        />,
        document.querySelector(".app-shell") ?? document.body
      ) : null}

      {mergeRequest ? createPortal(
        <div className="gitkraken-dialog-backdrop" role="presentation" onMouseDown={() => !busy && setMergeRequest(undefined)}>
          <section className="gitkraken-dialog gitkraken-merge-dialog" role="dialog" aria-modal="true" aria-labelledby="gitkraken-merge-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <span><GitMerge size={17} /><strong id="gitkraken-merge-title">拖曳合併</strong></span>
              <button type="button" aria-label="關閉" disabled={busy} onClick={() => setMergeRequest(undefined)}><X size={15} /></button>
            </header>
            <div className="gitkraken-merge-route">
              <span>{mergeRequest.source.name}</span>
              <strong>→</strong>
              <span>{mergeRequest.target.name}</span>
            </div>
            {mergeRequest.previewLoading ? <div className="gitkraken-dialog-note"><Loader2 size={14} className="spin" />正在預覽 merge...</div> : mergeRequest.preview ? (
              <div className="gitkraken-dialog-note">
                {mergeRequest.preview.mode === "fast-forward" ? "可 Fast-forward" : mergeRequest.preview.mode === "merge-commit" ? "將建立 Merge commit" : "目標分支已包含來源分支"}
              </div>
            ) : !mergeRequest.source.current ? (
              <div className="gitkraken-dialog-note warning">來源不是目前分支；執行時會先切到 {mergeRequest.source.name}，再把它合併到 {mergeRequest.target.name}。</div>
            ) : null}
            <div className="gitkraken-strategy-grid">
              <button type="button" className={mergeRequest.strategy === "ff" ? "selected" : ""} onClick={() => setMergeRequest((current) => current ? { ...current, strategy: "ff" } : current)}>
                <strong>Fast-forward if possible</strong><small>對應 git merge --ff</small>
              </button>
              <button type="button" className={mergeRequest.strategy === "no-ff" ? "selected" : ""} onClick={() => setMergeRequest((current) => current ? { ...current, strategy: "no-ff" } : current)}>
                <strong>Create merge commit</strong><small>對應 git merge --no-ff</small>
              </button>
            </div>
            <footer>
              <button type="button" className="secondary" disabled={busy} onClick={() => setMergeRequest(undefined)}>取消</button>
              <button type="button" className="primary" disabled={busy || mergeRequest.previewLoading || mergeRequest.preview?.mode === "up-to-date"} onClick={() => void executeMerge()}>
                {busy ? "合併中..." : "合併"}
              </button>
            </footer>
          </section>
        </div>,
        document.querySelector(".app-shell") ?? document.body
      ) : null}

      {tagDialogOpen ? createPortal(
        <div className="gitkraken-dialog-backdrop" role="presentation" onMouseDown={() => !busy && setTagDialogOpen(false)}>
          <section className="gitkraken-dialog gitkraken-tag-dialog" role="dialog" aria-modal="true" aria-labelledby="gitkraken-tag-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <span><Tag size={17} /><strong id="gitkraken-tag-title">Tags</strong></span>
              <button type="button" aria-label="關閉" disabled={busy} onClick={() => setTagDialogOpen(false)}><X size={15} /></button>
            </header>
            <div className="gitkraken-tag-create">
              <label><span>Tag 名稱</span><input value={tagName} onChange={(event) => setTagName(event.target.value)} placeholder="v0.1.38-rc1" /></label>
              <label><span>Target</span><input list="gitkraken-tag-targets" value={tagTarget} onChange={(event) => setTagTarget(event.target.value)} placeholder="HEAD、branch 或 commit hash" /></label>
              <datalist id="gitkraken-tag-targets">
                <option value="HEAD" />
                {localBranches.map((branch) => <option value={branch.name} key={branch.fullName}>{branch.name}</option>)}
              </datalist>
              <label className="wide"><span>Annotation（選填）</span><textarea value={tagMessage} onChange={(event) => setTagMessage(event.target.value)} placeholder="填寫後會建立 annotated tag；留空則建立 lightweight tag。" /></label>
              <label className="gitkraken-check wide"><input type="checkbox" checked={pushAfterCreate} onChange={(event) => setPushAfterCreate(event.target.checked)} /><span>建立後立即 Push</span></label>
              {pushAfterCreate ? (
                <label className="wide"><span>Remote</span><select value={selectedRemote} onChange={(event) => setSelectedRemote(event.target.value)}>{remotes.map((remote) => <option value={remote.name} key={remote.name}>{remote.name}</option>)}</select></label>
              ) : null}
              <button type="button" className="primary gitkraken-create-tag" disabled={busy} onClick={() => void createTag()}>{busy ? "處理中..." : "建立 Tag"}</button>
            </div>
            <div className="gitkraken-tag-list-heading"><span>Local Tags</span><small>{tags.length}</small></div>
            <div className="gitkraken-tag-list">
              {tags.map((tag) => (
                <div className="gitkraken-tag-row" key={`${tag.name}-${tag.hash}`}>
                  <Tag size={13} />
                  <span><strong>{tag.name}</strong><small>{tag.targetHash.slice(0, 10)} · {tag.annotated ? "annotated" : "lightweight"}</small></span>
                  {remotes.length > 0 ? <button type="button" title={`Push 到 ${selectedRemote}`} disabled={busy || !selectedRemote} onClick={() => void pushExistingTag(tag)}><Upload size={13} />Push</button> : null}
                </div>
              ))}
              {tags.length === 0 ? <div className="gitkraken-empty">目前沒有 local Tag。</div> : null}
            </div>
          </section>
        </div>,
        document.querySelector(".app-shell") ?? document.body
      ) : null}
    </>
  );
}

function ConfirmDialog({ title, detail, confirmLabel, onCancel, onConfirm }: { title: string; detail: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="gitkraken-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <section className="gitkraken-dialog gitkraken-confirm-dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header><span><GitBranch size={17} /><strong>{title}</strong></span><button type="button" aria-label="關閉" onClick={onCancel}><X size={15} /></button></header>
        <p>{detail}</p>
        <footer><button type="button" className="secondary" onClick={onCancel}>取消</button><button type="button" className="primary" onClick={onConfirm}>{confirmLabel}</button></footer>
      </section>
    </div>
  );
}

function annotateBranchChips(disabled: boolean) {
  document.querySelectorAll<HTMLElement>(LOCAL_BRANCH_CHIP_SELECTOR).forEach((chip) => {
    if (chip.closest(".commit-hover-card")) return;
    const name = chipBranchName(chip);
    if (!name) return;
    chip.draggable = !disabled;
    chip.dataset.gitkrakenBranch = name;
    chip.classList.add("gitkraken-branch-chip");
    chip.title = "雙擊切換分支；拖曳到另一個本機分支以合併";
  });
}

function branchChipFromEvent(event: Event): HTMLElement | null {
  const target = event.target as Element | null;
  const chip = target?.closest<HTMLElement>(LOCAL_BRANCH_CHIP_SELECTOR) ?? null;
  return chip?.closest(".commit-hover-card") ? null : chip;
}

function chipBranchName(chip: HTMLElement): string {
  return chip.dataset.gitkrakenBranch ?? chip.querySelector<HTMLElement>(".ref-chip-label")?.textContent?.trim() ?? "";
}

function resolveActiveProject(projects: GitProject[]): GitProject | undefined {
  const active = document.querySelector<HTMLElement>(ACTIVE_PROJECT_SELECTOR);
  if (!active) return undefined;

  const activePath = active.querySelector<HTMLElement>(".project-rail-name .sr-only")?.textContent?.trim();
  if (activePath) {
    const pathMatch = projects.find((candidate) => normalizePath(candidate.path) === normalizePath(activePath));
    if (pathMatch) return pathMatch;
  }

  const activeName = active.querySelector<HTMLElement>(".project-rail-name-text")?.textContent?.trim();
  if (!activeName) return undefined;
  const matches = projects.filter((candidate) => candidate.name === activeName);
  if (matches.length === 1) return matches[0];
  return matches
    .filter((candidate) => candidate.lastOpenedAt)
    .sort((left, right) => Date.parse(right.lastOpenedAt ?? "") - Date.parse(left.lastOpenedAt ?? ""))[0];
}

function requestHostRefresh() {
  window.setTimeout(() => {
    document.querySelector<HTMLButtonElement>(ACTIVE_PROJECT_SELECTOR)?.click();
  }, HOST_REFRESH_DELAY_MS);
}

function hasWorktreeChanges(status: NonNullable<GitProject["status"]>): boolean {
  return status.stagedCount + status.unstagedCount + status.untrackedCount > 0;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+':\s*/u, "");
  return fallback;
}

function gitOutput(result: { stdout: string; stderr: string }): string | undefined {
  const text = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  return text ? text.slice(0, 1000) : undefined;
}
