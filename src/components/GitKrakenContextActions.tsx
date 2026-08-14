import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  GitBranch,
  GitMerge,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Tag,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { toast } from "sonner";
import type { BranchInfo, GitProject, GitRemoteInfo } from "../types/domain";

const ACTIVE_PROJECT_SELECTOR = ".project-rail-item.active";
const PROJECT_ITEM_SELECTOR = ".project-rail-item";
const LOCAL_BRANCH_CHIP_SELECTOR = ".graph-panel .ref-chip.localBranch";
const TAG_CHIP_SELECTOR = ".graph-panel .ref-chip.tag";
const COMMIT_ROW_SELECTOR = ".graph-panel .graph-commit-row";
const COMMIT_MENU_SELECTOR = ".graph-commit-menu";

type MenuState =
  | { kind: "branch"; name: string; x: number; y: number }
  | { kind: "tag"; name: string; x: number; y: number }
  | { kind: "drop"; source: string; target: string; x: number; y: number };

type TagDialogState = {
  target: string;
  annotated: boolean;
};

type BranchDialogState =
  | { kind: "rename"; branchName: string }
  | { kind: "create"; startPoint: string; label: string };

type ConfirmState = {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  action: () => Promise<void>;
};

export function GitKrakenContextActions() {
  const [project, setProject] = useState<GitProject>();
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [remotes, setRemotes] = useState<GitRemoteInfo[]>([]);
  const [menu, setMenu] = useState<MenuState>();
  const [tagDialog, setTagDialog] = useState<TagDialogState>();
  const [branchDialog, setBranchDialog] = useState<BranchDialogState>();
  const [confirmState, setConfirmState] = useState<ConfirmState>();
  const [busy, setBusy] = useState(false);
  const commitTargetRef = useRef("");
  const contextRequestRef = useRef(0);

  const currentBranch = project?.status?.currentBranch ?? "";

  useEffect(() => {
    void refreshProjectContext();

    const handleProjectClick = (event: MouseEvent) => {
      const element = event.target as Element | null;
      if (!element?.closest(PROJECT_ITEM_SELECTOR)) return;
      window.setTimeout(() => void refreshProjectContext(), 0);
    };

    document.addEventListener("click", handleProjectClick, true);
    return () => document.removeEventListener("click", handleProjectClick, true);
  }, []);

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      const element = event.target as Element | null;
      if (!element) return;

      const branchChip = element.closest<HTMLElement>(LOCAL_BRANCH_CHIP_SELECTOR);
      if (branchChip) {
        const name = chipLabel(branchChip);
        if (!name) return;
        event.preventDefault();
        event.stopPropagation();
        setMenu(positionMenu({ kind: "branch", name, x: event.clientX, y: event.clientY }));
        void refreshProjectContext(false);
        return;
      }

      const tagChip = element.closest<HTMLElement>(TAG_CHIP_SELECTOR);
      if (tagChip) {
        const name = chipLabel(tagChip);
        if (!name) return;
        event.preventDefault();
        event.stopPropagation();
        setMenu(positionMenu({ kind: "tag", name, x: event.clientX, y: event.clientY }));
        void refreshProjectContext(false);
        return;
      }

      const commitRow = element.closest<HTMLElement>(COMMIT_ROW_SELECTOR);
      if (commitRow) {
        commitTargetRef.current = commitRow.querySelector("code")?.textContent?.trim() ?? "";
        window.setTimeout(enhanceCommitMenu, 0);
      }
    };

    const handleDrop = (event: DragEvent) => {
      const element = event.target as Element | null;
      const targetChip = element?.closest<HTMLElement>(LOCAL_BRANCH_CHIP_SELECTOR);
      if (!targetChip) return;

      const source = event.dataTransfer?.getData("application/x-git-ui-pro-branch")
        || event.dataTransfer?.getData("text/plain")
        || "";
      const target = chipLabel(targetChip);
      if (!source || !target || source === target) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      document.querySelectorAll(".gitkraken-drop-target").forEach((node) => node.classList.remove("gitkraken-drop-target"));
      setMenu(positionMenu({ kind: "drop", source, target, x: event.clientX, y: event.clientY }));
      void refreshProjectContext(false);
    };

    const handlePointerDown = (event: PointerEvent) => {
      const element = event.target as Element | null;
      if (element?.closest(".gitkraken-context-menu, .gitkraken-action-dialog")) return;
      setMenu(undefined);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenu(undefined);
      setTagDialog(undefined);
      setBranchDialog(undefined);
      setConfirmState(undefined);
    };

    document.addEventListener("contextmenu", handleContextMenu, true);
    document.addEventListener("drop", handleDrop, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      document.removeEventListener("contextmenu", handleContextMenu, true);
      document.removeEventListener("drop", handleDrop, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [branches, project?.id]);

  useEffect(() => {
    const observer = new MutationObserver(() => enhanceCommitMenu());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  async function refreshProjectContext(showErrors = false) {
    const api = window.gitUI;
    if (!api) return;
    const requestId = ++contextRequestRef.current;
    try {
      const projects = await api.getProjects();
      const selected = resolveActiveProject(projects);
      if (requestId !== contextRequestRef.current) return;
      if (!selected) {
        setProject(undefined);
        setBranches([]);
        setRemotes([]);
        return;
      }

      const [status, nextBranches, nextRemotes] = await Promise.all([
        api.getProjectStatus(selected),
        api.getBranches(selected),
        api.getRemotes(selected)
      ]);
      if (requestId !== contextRequestRef.current) return;
      setProject({ ...selected, status });
      setBranches(nextBranches);
      setRemotes(nextRemotes);
    } catch (error) {
      if (requestId !== contextRequestRef.current) return;
      if (showErrors) toast.error(errorText(error, "無法讀取 Git 狀態"));
    }
  }

  function enhanceCommitMenu() {
    const target = commitTargetRef.current;
    if (!target) return;
    const host = document.querySelector<HTMLElement>(COMMIT_MENU_SELECTOR);
    if (!host || host.dataset.gitkrakenTagActions === target) return;

    host.dataset.gitkrakenTagActions = target;
    host.querySelectorAll("[data-gitkraken-injected='tag-action']").forEach((node) => node.remove());

    const separators = host.querySelectorAll<HTMLElement>(".menu-separator");
    const anchor = separators[1] ?? separators[0] ?? null;
    const lightweight = injectedMenuButton("建立 Tag", () => openCommitTagDialog(target, false));
    const annotated = injectedMenuButton("建立 Annotated Tag", () => openCommitTagDialog(target, true));

    if (anchor) {
      host.insertBefore(lightweight, anchor);
      host.insertBefore(annotated, anchor);
    } else {
      host.append(lightweight, annotated);
    }
  }

  function injectedMenuButton(label: string, action: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.dataset.gitkrakenInjected = "tag-action";
    const glyph = document.createElement("span");
    glyph.className = "gitkraken-context-glyph";
    glyph.textContent = "TAG";
    button.append(glyph, document.createTextNode(label));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    return button;
  }

  function openCommitTagDialog(target: string, annotated: boolean) {
    commitTargetRef.current = "";
    setTagDialog({ target, annotated });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  async function requestCheckout(branchName: string) {
    setMenu(undefined);
    const selectedProject = await currentProjectOrRefresh();
    if (!selectedProject || !window.gitUI) return;
    const branch = await findLocalBranch(branchName);
    if (!branch) return toast.error(`找不到分支 ${branchName}`);
    if (branch.current) return toast.info(`目前已在 ${branchName}`);

    const status = await window.gitUI.getProjectStatus(selectedProject);
    if (status.operationState || status.hasConflicts) {
      return toast.error("目前有尚未完成的 Git 操作，請先完成或終止後再切換分支。");
    }

    const perform = async () => performCheckout(selectedProject, branch);
    if (hasWorktreeChanges(status)) {
      setConfirmState({
        title: `切換到 ${branchName}`,
        message: "工作區有尚未提交的變更。Git 會嘗試保留這些變更；若與目標分支衝突，切換會被 Git 阻止。",
        confirmLabel: "繼續切換",
        action: perform
      });
      return;
    }
    await perform();
  }

  async function performCheckout(selectedProject: GitProject, branch: BranchInfo) {
    if (!window.gitUI) return;
    setBusy(true);
    const toastId = toast.loading(`正在切換到 ${branch.name}...`);
    try {
      const result = await window.gitUI.switchBranch(selectedProject, branch);
      if (!result.ok) {
        toast.error(result.messageZh ?? "切換分支失敗", { id: toastId, description: gitOutput(result) });
        return;
      }
      toast.success(`已切換到 ${branch.name}`, { id: toastId });
      requestHostRefresh();
      await refreshProjectContext(false);
    } catch (error) {
      toast.error(errorText(error, "切換分支失敗"), { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  function openRenameBranch(branchName: string) {
    setMenu(undefined);
    setBranchDialog({ kind: "rename", branchName });
  }

  async function renameBranch(branchName: string, nextName: string) {
    const selectedProject = await currentProjectOrRefresh();
    if (!selectedProject || !window.gitUI) return;
    setBusy(true);
    const toastId = toast.loading(`正在重新命名 ${branchName}...`);
    try {
      const result = await window.gitUI.renameBranch(selectedProject, branchName, nextName, false);
      if (!result.ok) {
        toast.error(result.messageZh ?? "重新命名分支失敗", { id: toastId, description: gitOutput(result) });
        return;
      }
      toast.success(`已重新命名為 ${nextName}`, { id: toastId });
      setBranchDialog(undefined);
      requestHostRefresh();
      await refreshProjectContext(false);
    } catch (error) {
      toast.error(errorText(error, "重新命名分支失敗"), { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  function requestDeleteBranch(branchName: string) {
    setMenu(undefined);
    setConfirmState({
      title: `刪除 ${branchName}`,
      message: "刪除本機分支不會刪除其提交，但未被其他 ref 指向的提交之後可能被 Git 清理。此操作不會刪除遠端分支。",
      confirmLabel: "刪除分支",
      danger: true,
      action: async () => deleteBranch(branchName)
    });
  }

  async function deleteBranch(branchName: string) {
    const selectedProject = await currentProjectOrRefresh();
    if (!selectedProject || !window.gitUI) return;
    setBusy(true);
    const toastId = toast.loading(`正在刪除 ${branchName}...`);
    try {
      const result = await window.gitUI.deleteBranch(selectedProject, branchName, false);
      if (!result.ok) {
        toast.error(result.messageZh ?? "刪除分支失敗", {
          id: toastId,
          description: gitOutput(result) || "若分支尚未合併，請先確認提交是否仍需要保留。"
        });
        return;
      }
      toast.success(`已刪除 ${branchName}`, { id: toastId });
      requestHostRefresh();
      await refreshProjectContext(false);
    } catch (error) {
      toast.error(errorText(error, "刪除分支失敗"), { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  function openTagForRef(target: string, annotated = false) {
    setMenu(undefined);
    setTagDialog({ target, annotated });
  }

  async function createTag(target: string, name: string, message?: string) {
    const selectedProject = await currentProjectOrRefresh();
    if (!selectedProject || !window.gitUI) return;
    setBusy(true);
    const toastId = toast.loading(`正在建立 Tag ${name}...`);
    try {
      const result = await window.gitUI.createTag(selectedProject, name, target, message || undefined);
      if (!result.ok) {
        toast.error(result.messageZh ?? "建立 Tag 失敗", { id: toastId, description: gitOutput(result) });
        return;
      }
      toast.success(`已建立 Tag ${name}`, { id: toastId });
      setTagDialog(undefined);
      requestHostRefresh();
      await refreshProjectContext(false);
    } catch (error) {
      toast.error(errorText(error, "建立 Tag 失敗"), { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  function openBranchFromRef(startPoint: string, label: string) {
    setMenu(undefined);
    setBranchDialog({ kind: "create", startPoint, label });
  }

  async function createBranchFromRef(startPoint: string, name: string) {
    const selectedProject = await currentProjectOrRefresh();
    if (!selectedProject || !window.gitUI) return;
    setBusy(true);
    const toastId = toast.loading(`正在建立分支 ${name}...`);
    try {
      const result = await window.gitUI.createBranch(selectedProject, name, true, startPoint);
      if (!result.ok) {
        toast.error(result.messageZh ?? "建立分支失敗", { id: toastId, description: gitOutput(result) });
        return;
      }
      toast.success(`已建立並切換到 ${name}`, { id: toastId });
      setBranchDialog(undefined);
      requestHostRefresh();
      await refreshProjectContext(false);
    } catch (error) {
      toast.error(errorText(error, "建立分支失敗"), { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  async function pushTag(tagName: string, remoteName: string) {
    setMenu(undefined);
    const selectedProject = await currentProjectOrRefresh();
    if (!selectedProject || !window.gitUI) return;
    setBusy(true);
    const toastId = toast.loading(`正在推送 ${tagName} → ${remoteName}...`);
    try {
      const result = await window.gitUI.pushTag(selectedProject, remoteName, tagName);
      if (!result.ok) {
        toast.error(result.messageZh ?? "推送 Tag 失敗", { id: toastId, description: gitOutput(result) });
        return;
      }
      toast.success(`已推送 ${tagName} 到 ${remoteName}`, { id: toastId });
    } catch (error) {
      toast.error(errorText(error, "推送 Tag 失敗"), { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  function requestDeleteTag(tagName: string) {
    setMenu(undefined);
    setConfirmState({
      title: `刪除 Tag ${tagName}`,
      message: "這只會刪除本機 Tag；若 Tag 已推送到遠端，遠端 Tag 仍會保留。",
      confirmLabel: "刪除 Tag",
      danger: true,
      action: async () => deleteTag(tagName)
    });
  }

  async function deleteTag(tagName: string) {
    const selectedProject = await currentProjectOrRefresh();
    if (!selectedProject || !window.gitUI) return;
    setBusy(true);
    const toastId = toast.loading(`正在刪除 Tag ${tagName}...`);
    try {
      const result = await window.gitUI.deleteTag(selectedProject, tagName);
      if (!result.ok) {
        toast.error(result.messageZh ?? "刪除 Tag 失敗", { id: toastId, description: gitOutput(result) });
        return;
      }
      toast.success(`已刪除 Tag ${tagName}`, { id: toastId });
      requestHostRefresh();
      await refreshProjectContext(false);
    } catch (error) {
      toast.error(errorText(error, "刪除 Tag 失敗"), { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  async function performMerge(sourceName: string, targetName: string) {
    setMenu(undefined);
    const selectedProject = await currentProjectOrRefresh();
    if (!selectedProject || !window.gitUI) return;
    if (!(await requireCleanWorktree(selectedProject, "Merge"))) return;

    setBusy(true);
    const toastId = toast.loading(`正在 Merge ${sourceName} → ${targetName}...`);
    try {
      const latestBranches = await window.gitUI.getBranches(selectedProject);
      const source = latestBranches.find((branch) => branch.type === "local" && branch.name === sourceName);
      const target = latestBranches.find((branch) => branch.type === "local" && branch.name === targetName);
      if (!source || !target) throw new Error("來源或目標分支已不存在，請重新整理後再試。");

      if (!source.current) {
        const switched = await window.gitUI.switchBranch(selectedProject, source);
        if (!switched.ok) throw new Error(switched.messageZh ?? `無法切換到 ${sourceName}`);
      }

      const preview = await window.gitUI.getMergePreview(selectedProject, targetName);
      if (preview.mode === "up-to-date") {
        const refreshed = await window.gitUI.getBranches(selectedProject);
        const targetAfterSwitch = refreshed.find((branch) => branch.type === "local" && branch.name === targetName);
        if (targetAfterSwitch && !targetAfterSwitch.current) await window.gitUI.switchBranch(selectedProject, targetAfterSwitch);
        toast.info(`${targetName} 已包含 ${sourceName} 的全部提交`, { id: toastId });
        requestHostRefresh();
        await refreshProjectContext(false);
        return;
      }

      const result = await window.gitUI.mergeCurrentBranch(selectedProject, targetName, "ff");
      const status = await window.gitUI.getProjectStatus(selectedProject);
      if (result.ok) {
        toast.success(`Merge 完成：${sourceName} → ${targetName}`, { id: toastId });
      } else if (status.operationState === "merge" || status.hasConflicts) {
        toast.warning("Merge 已進入衝突處理流程", { id: toastId, description: "請使用既有 Conflict / Continue / Abort 介面完成合併。" });
      } else {
        toast.error(result.messageZh ?? "Merge 失敗", { id: toastId, description: gitOutput(result) });
      }
      requestHostRefresh();
      await refreshProjectContext(false);
    } catch (error) {
      toast.error(errorText(error, "Merge 失敗"), { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  function requestRebase(source: string, target: string) {
    setMenu(undefined);
    setConfirmState({
      title: `Rebase ${source} onto ${target}`,
      message: "Rebase 會改寫來源分支的提交歷史。若這個分支已被其他人使用或已推送，完成後可能需要 force-with-lease。",
      confirmLabel: "開始 Rebase",
      action: async () => performRebase(source, target)
    });
  }

  async function performRebase(sourceName: string, targetName: string) {
    const selectedProject = await currentProjectOrRefresh();
    if (!selectedProject || !window.gitUI) return;
    if (!(await requireCleanWorktree(selectedProject, "Rebase"))) return;

    setBusy(true);
    const toastId = toast.loading(`正在 Rebase ${sourceName} onto ${targetName}...`);
    try {
      const latestBranches = await window.gitUI.getBranches(selectedProject);
      const source = latestBranches.find((branch) => branch.type === "local" && branch.name === sourceName);
      const target = latestBranches.find((branch) => branch.type === "local" && branch.name === targetName);
      if (!source || !target) throw new Error("來源或目標分支已不存在，請重新整理後再試。");

      if (!source.current) {
        const switched = await window.gitUI.switchBranch(selectedProject, source);
        if (!switched.ok) throw new Error(switched.messageZh ?? `無法切換到 ${sourceName}`);
      }

      const result = await window.gitUI.startRebase(selectedProject, targetName);
      const status = await window.gitUI.getProjectStatus(selectedProject);
      if (result.ok) {
        toast.success(`Rebase 完成：${sourceName} onto ${targetName}`, { id: toastId });
      } else if (status.operationState === "rebase" || status.hasConflicts) {
        toast.warning("Rebase 已進入衝突處理流程", { id: toastId, description: "請使用既有 Continue / Skip / Abort 流程處理。" });
      } else {
        toast.error(result.messageZh ?? "Rebase 失敗", { id: toastId, description: gitOutput(result) });
      }
      requestHostRefresh();
      await refreshProjectContext(false);
    } catch (error) {
      toast.error(errorText(error, "Rebase 失敗"), { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  async function requireCleanWorktree(selectedProject: GitProject, actionName: string) {
    if (!window.gitUI) return false;
    const status = await window.gitUI.getProjectStatus(selectedProject);
    if (status.operationState || status.hasConflicts) {
      toast.error(`目前有尚未完成的 Git 操作，無法開始 ${actionName}。`);
      return false;
    }
    if (hasWorktreeChanges(status)) {
      toast.error(`${actionName} 前工作區必須乾淨`, { description: "請先 commit、stash 或放棄目前變更。" });
      return false;
    }
    return true;
  }

  async function currentProjectOrRefresh() {
    if (project) return project;
    await refreshProjectContext(true);
    const api = window.gitUI;
    if (!api) return undefined;
    const projects = await api.getProjects();
    return resolveActiveProject(projects);
  }

  async function findLocalBranch(name: string) {
    const cached = branches.find((branch) => branch.type === "local" && branch.name === name);
    if (cached) return cached;
    const selectedProject = await currentProjectOrRefresh();
    if (!selectedProject || !window.gitUI) return undefined;
    const latest = await window.gitUI.getBranches(selectedProject);
    setBranches(latest);
    return latest.find((branch) => branch.type === "local" && branch.name === name);
  }

  const portalHost = typeof document !== "undefined" ? document.querySelector(".app-shell") ?? document.body : null;
  if (!portalHost) return null;

  return createPortal(
    <>
      {menu?.kind === "branch" ? (
        <ContextMenu x={menu.x} y={menu.y} title={menu.name}>
          <MenuButton icon={<GitBranch size={14} />} disabled={busy || menu.name === currentBranch} onClick={() => void requestCheckout(menu.name)}>
            {menu.name === currentBranch ? "目前分支" : `切換到 ${menu.name}`}
          </MenuButton>
          <MenuButton
            icon={<GitMerge size={14} />}
            disabled={busy || !currentBranch || menu.name === currentBranch}
            onClick={() => void performMerge(menu.name, currentBranch)}
          >
            Merge 到 {currentBranch || "目前分支"}
          </MenuButton>
          <MenuSeparator />
          <MenuButton icon={<Tag size={14} />} disabled={busy} onClick={() => openTagForRef(menu.name)}>
            在此建立 Tag
          </MenuButton>
          <MenuButton icon={<Pencil size={14} />} disabled={busy} onClick={() => openRenameBranch(menu.name)}>
            重新命名分支…
          </MenuButton>
          <MenuButton
            icon={<Trash2 size={14} />}
            disabled={busy || menu.name === currentBranch}
            danger
            onClick={() => requestDeleteBranch(menu.name)}
          >
            刪除分支…
          </MenuButton>
        </ContextMenu>
      ) : null}

      {menu?.kind === "tag" ? (
        <ContextMenu x={menu.x} y={menu.y} title={menu.name}>
          <MenuButton icon={<Plus size={14} />} disabled={busy} onClick={() => openBranchFromRef(menu.name, `Tag ${menu.name}`)}>
            從此 Tag 建立分支…
          </MenuButton>
          {remotes.length > 0 ? <MenuSeparator /> : null}
          {remotes.map((remote) => (
            <MenuButton key={remote.name} icon={<Upload size={14} />} disabled={busy} onClick={() => void pushTag(menu.name, remote.name)}>
              Push Tag 到 {remote.name}
            </MenuButton>
          ))}
          <MenuSeparator />
          <MenuButton icon={<Trash2 size={14} />} disabled={busy} danger onClick={() => requestDeleteTag(menu.name)}>
            刪除本機 Tag…
          </MenuButton>
        </ContextMenu>
      ) : null}

      {menu?.kind === "drop" ? (
        <ContextMenu x={menu.x} y={menu.y} title={`${menu.source} → ${menu.target}`} subtitle="選擇拖放操作">
          <MenuButton icon={<GitMerge size={14} />} disabled={busy} onClick={() => void performMerge(menu.source, menu.target)}>
            Merge {menu.source} into {menu.target}
          </MenuButton>
          <MenuButton icon={<RefreshCw size={14} />} disabled={busy} onClick={() => requestRebase(menu.source, menu.target)}>
            Rebase {menu.source} onto {menu.target}
          </MenuButton>
        </ContextMenu>
      ) : null}

      {tagDialog ? (
        <TagActionDialog
          state={tagDialog}
          busy={busy}
          onClose={() => setTagDialog(undefined)}
          onSubmit={(name, message) => void createTag(tagDialog.target, name, message)}
        />
      ) : null}

      {branchDialog ? (
        <BranchActionDialog
          state={branchDialog}
          busy={busy}
          onClose={() => setBranchDialog(undefined)}
          onSubmit={(name) => branchDialog.kind === "rename"
            ? void renameBranch(branchDialog.branchName, name)
            : void createBranchFromRef(branchDialog.startPoint, name)}
        />
      ) : null}

      {confirmState ? (
        <ConfirmDialog
          state={confirmState}
          busy={busy}
          onClose={() => setConfirmState(undefined)}
          onConfirm={() => {
            const action = confirmState.action;
            setConfirmState(undefined);
            void action();
          }}
        />
      ) : null}
    </>,
    portalHost
  );
}

function ContextMenu({ x, y, title, subtitle, children }: { x: number; y: number; title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="gitkraken-context-menu" role="menu" style={{ left: x, top: y }} onPointerDown={(event) => event.stopPropagation()}>
      <div className="gitkraken-context-heading">
        <strong>{title}</strong>
        {subtitle ? <span>{subtitle}</span> : null}
      </div>
      {children}
    </div>
  );
}

function MenuButton({ icon, children, disabled, danger, onClick }: { icon: React.ReactNode; children: React.ReactNode; disabled?: boolean; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className={danger ? "danger" : ""} disabled={disabled} onClick={onClick}>
      {icon}
      <span>{children}</span>
    </button>
  );
}

function MenuSeparator() {
  return <div className="gitkraken-context-separator" role="separator" />;
}

function TagActionDialog({ state, busy, onClose, onSubmit }: { state: TagDialogState; busy: boolean; onClose: () => void; onSubmit: (name: string, message?: string) => void }) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const annotated = state.annotated;
  return (
    <div className="gitkraken-action-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="gitkraken-action-dialog" role="dialog" aria-modal="true" aria-label="建立 Tag">
        <header>
          <div>
            <span className="gitkraken-dialog-kicker">TAG</span>
            <h3>{annotated ? "建立 Annotated Tag" : "建立 Tag"}</h3>
            <p>建立在 <code>{state.target}</code></p>
          </div>
          <button type="button" className="gitkraken-dialog-close" onClick={onClose} aria-label="關閉"><X size={16} /></button>
        </header>
        <label>
          <span>Tag 名稱</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="v0.1.38" />
        </label>
        {annotated ? (
          <label>
            <span>Annotation</span>
            <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={4} placeholder="Release notes / annotation" />
          </label>
        ) : null}
        <footer>
          <button type="button" className="secondary" onClick={onClose}>取消</button>
          <button type="button" className="primary" disabled={busy || !name.trim() || (annotated && !message.trim())} onClick={() => onSubmit(name.trim(), annotated ? message.trim() : undefined)}>
            {busy ? <Loader2 size={14} className="spin" /> : <Tag size={14} />}
            建立
          </button>
        </footer>
      </section>
    </div>
  );
}

function BranchActionDialog({ state, busy, onClose, onSubmit }: { state: BranchDialogState; busy: boolean; onClose: () => void; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(state.kind === "rename" ? state.branchName : "");
  const title = state.kind === "rename" ? `重新命名 ${state.branchName}` : `從 ${state.label} 建立分支`;
  return (
    <div className="gitkraken-action-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="gitkraken-action-dialog compact" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <div>
            <span className="gitkraken-dialog-kicker">BRANCH</span>
            <h3>{title}</h3>
          </div>
          <button type="button" className="gitkraken-dialog-close" onClick={onClose} aria-label="關閉"><X size={16} /></button>
        </header>
        <label>
          <span>分支名稱</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && name.trim() && onSubmit(name.trim())} />
        </label>
        <footer>
          <button type="button" className="secondary" onClick={onClose}>取消</button>
          <button type="button" className="primary" disabled={busy || !name.trim() || (state.kind === "rename" && name.trim() === state.branchName)} onClick={() => onSubmit(name.trim())}>
            {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
            確認
          </button>
        </footer>
      </section>
    </div>
  );
}

function ConfirmDialog({ state, busy, onClose, onConfirm }: { state: ConfirmState; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="gitkraken-action-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="gitkraken-action-dialog compact" role="alertdialog" aria-modal="true" aria-label={state.title}>
        <header>
          <div>
            <span className={`gitkraken-dialog-kicker ${state.danger ? "danger" : ""}`}>{state.danger ? "CAUTION" : "GIT"}</span>
            <h3>{state.title}</h3>
          </div>
          <button type="button" className="gitkraken-dialog-close" onClick={onClose} aria-label="關閉"><X size={16} /></button>
        </header>
        <div className="gitkraken-confirm-copy">
          {state.danger ? <AlertTriangle size={18} /> : <GitBranch size={18} />}
          <p>{state.message}</p>
        </div>
        <footer>
          <button type="button" className="secondary" onClick={onClose}>取消</button>
          <button type="button" className={state.danger ? "danger-primary" : "primary"} disabled={busy} onClick={onConfirm}>
            {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
            {state.confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}

function chipLabel(chip: HTMLElement) {
  return chip.querySelector<HTMLElement>(".ref-chip-label")?.textContent?.trim() ?? "";
}

function positionMenu<T extends MenuState>(menu: T): T {
  return {
    ...menu,
    x: Math.max(8, Math.min(menu.x, window.innerWidth - 330)),
    y: Math.max(8, Math.min(menu.y, window.innerHeight - 320))
  };
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
  const nameMatches = projects.filter((candidate) => candidate.name === activeName);
  if (nameMatches.length === 1) return nameMatches[0];

  return nameMatches
    .filter((candidate) => candidate.lastOpenedAt)
    .sort((left, right) => Date.parse(right.lastOpenedAt ?? "") - Date.parse(left.lastOpenedAt ?? ""))[0];
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

function hasWorktreeChanges(status: { stagedCount: number; unstagedCount: number; untrackedCount: number }) {
  return status.stagedCount > 0 || status.unstagedCount > 0 || status.untrackedCount > 0;
}

function gitOutput(result: { stdout?: string; stderr?: string }) {
  return [result.stderr, result.stdout].map((value) => value?.trim()).filter(Boolean).join("\n").slice(0, 1400);
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function requestHostRefresh() {
  window.setTimeout(() => {
    const active = document.querySelector<HTMLElement>(ACTIVE_PROJECT_SELECTOR);
    active?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, 80);
}
