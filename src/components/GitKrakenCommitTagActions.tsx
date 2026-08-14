import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Tag, X } from "lucide-react";
import { toast } from "sonner";
import type { CommitNode, GitProject } from "../types/domain";

const ACTIVE_PROJECT_SELECTOR = ".project-rail-item.active";
const COMMIT_ROW_SELECTOR = ".graph-panel .graph-commit-row";
const COMMIT_MENU_SELECTOR = ".graph-commit-menu";
const EXTENSION_WIDTH = 230;
const EXTENSION_GAP = 6;

type CommitDescriptor = {
  subject: string;
  author: string;
  refs: string[];
  occurrence: number;
};

type ExtensionMenuState = {
  descriptor: CommitDescriptor;
  left: number;
  top: number;
};

type TagDialogState = {
  target: string;
  label: string;
  annotated: boolean;
};

export function GitKrakenCommitTagActions() {
  const descriptorRef = useRef<CommitDescriptor>();
  const [extension, setExtension] = useState<ExtensionMenuState>();
  const [dialog, setDialog] = useState<TagDialogState>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      const row = (event.target as Element | null)?.closest<HTMLElement>(COMMIT_ROW_SELECTOR);
      if (!row) return;
      descriptorRef.current = describeCommitRow(row);
      setExtension(undefined);
      window.requestAnimationFrame(syncExtensionMenu);
    };

    const handlePointerDown = (event: PointerEvent) => {
      const element = event.target as Element | null;
      if (element?.closest(".gitkraken-commit-extension-menu, .graph-commit-menu, .gitkraken-action-dialog")) return;
      setExtension(undefined);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExtension(undefined);
    };

    const observer = new MutationObserver(syncExtensionMenu);
    document.addEventListener("contextmenu", handleContextMenu, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      document.removeEventListener("contextmenu", handleContextMenu, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      observer.disconnect();
    };
  }, []);

  function syncExtensionMenu() {
    const descriptor = descriptorRef.current;
    const host = document.querySelector<HTMLElement>(COMMIT_MENU_SELECTOR);
    if (!descriptor || !host) {
      setExtension((current) => current ? undefined : current);
      return;
    }

    const rect = host.getBoundingClientRect();
    const left = rect.right + EXTENSION_GAP + EXTENSION_WIDTH <= window.innerWidth
      ? rect.right + EXTENSION_GAP
      : Math.max(8, rect.left - EXTENSION_WIDTH - EXTENSION_GAP);
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - 150));

    setExtension((current) => {
      if (
        current
        && sameDescriptor(current.descriptor, descriptor)
        && Math.abs(current.left - left) < 1
        && Math.abs(current.top - top) < 1
      ) return current;
      return { descriptor, left, top };
    });
  }

  async function openTagDialog(descriptor: CommitDescriptor, annotated: boolean) {
    if (!window.gitUI) return;

    setExtension(undefined);
    closeNativeCommitMenu();
    const toastId = toast.loading("正在解析提交…");
    try {
      const project = await resolveActiveProject();
      if (!project) throw new Error("找不到目前專案");
      const history = await window.gitUI.getHistory(project, { mode: "all" });
      const commit = resolveCommitFromHistory(history, descriptor);
      if (!commit) throw new Error("無法唯一辨識這筆提交，請重新整理 Commit Graph 後再試。");

      setDialog({ target: commit.hash, label: `${commit.shortHash} · ${commit.subject}`, annotated });
      toast.dismiss(toastId);
    } catch (error) {
      toast.error(errorText(error, "無法解析提交"), { id: toastId });
    }
  }

  async function createTag(name: string, message?: string) {
    if (!dialog || !window.gitUI || busy) return;
    const project = await resolveActiveProject();
    if (!project) return toast.error("找不到目前專案");

    setBusy(true);
    const toastId = toast.loading(`正在建立 Tag ${name}...`);
    try {
      const result = await window.gitUI.createTag(project, name, dialog.target, message || undefined);
      if (!result.ok) {
        toast.error(result.messageZh ?? "建立 Tag 失敗", {
          id: toastId,
          description: [result.stderr, result.stdout].filter(Boolean).join("\n").slice(0, 1200)
        });
        return;
      }
      toast.success(`已建立 Tag ${name}`, { id: toastId });
      setDialog(undefined);
      descriptorRef.current = undefined;
      requestHostRefresh();
    } catch (error) {
      toast.error(errorText(error, "建立 Tag 失敗"), { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  const portalHost = typeof document !== "undefined" ? document.querySelector(".app-shell") ?? document.body : null;
  if (!portalHost) return null;

  return createPortal(
    <>
      {extension ? (
        <div
          className="gitkraken-context-menu gitkraken-commit-extension-menu"
          role="menu"
          aria-label="Commit Tag Actions"
          style={{ left: extension.left, top: extension.top, width: EXTENSION_WIDTH }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="gitkraken-context-heading">
            <strong>Tag</strong>
            <span>{extension.descriptor.subject || "Selected commit"}</span>
          </div>
          <button type="button" role="menuitem" onClick={() => void openTagDialog(extension.descriptor, false)}>
            <Tag size={14} />
            <span>建立 Tag</span>
          </button>
          <button type="button" role="menuitem" onClick={() => void openTagDialog(extension.descriptor, true)}>
            <Tag size={14} />
            <span>建立 Annotated Tag</span>
          </button>
        </div>
      ) : null}

      {dialog ? (
        <CommitTagDialog
          state={dialog}
          busy={busy}
          onClose={() => setDialog(undefined)}
          onSubmit={(name, message) => void createTag(name, message)}
        />
      ) : null}
    </>,
    portalHost
  );
}

function CommitTagDialog({
  state,
  busy,
  onClose,
  onSubmit
}: {
  state: TagDialogState;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string, message?: string) => void;
}) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  return (
    <div className="gitkraken-action-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="gitkraken-action-dialog" role="dialog" aria-modal="true" aria-label={state.annotated ? "建立 Annotated Tag" : "建立 Tag"}>
        <header>
          <div>
            <span className="gitkraken-dialog-kicker">COMMIT TAG</span>
            <h3>{state.annotated ? "建立 Annotated Tag" : "建立 Tag"}</h3>
            <p>建立在 <code>{state.label}</code></p>
          </div>
          <button type="button" className="gitkraken-dialog-close" onClick={onClose} aria-label="關閉"><X size={16} /></button>
        </header>
        <label>
          <span>Tag 名稱</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="v0.1.38" />
        </label>
        {state.annotated ? (
          <label>
            <span>Annotation</span>
            <textarea rows={4} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Release notes / annotation" />
          </label>
        ) : null}
        <footer>
          <button type="button" className="secondary" onClick={onClose}>取消</button>
          <button
            type="button"
            className="primary"
            disabled={busy || !name.trim() || (state.annotated && !message.trim())}
            onClick={() => onSubmit(name.trim(), state.annotated ? message.trim() : undefined)}
          >
            {busy ? <Loader2 size={14} className="spin" /> : <Tag size={14} />}
            建立
          </button>
        </footer>
      </section>
    </div>
  );
}

function describeCommitRow(row: HTMLElement): CommitDescriptor {
  const subject = row.querySelector<HTMLElement>(".graph-commit-subject")?.textContent?.trim() ?? "";
  const author = row.querySelector<HTMLElement>(".graph-commit-author")?.textContent?.trim() ?? "";
  const refs = Array.from(row.querySelectorAll<HTMLElement>(".ref-chip-label"))
    .map((node) => node.textContent?.trim() ?? "")
    .filter(Boolean);

  const peers = Array.from(document.querySelectorAll<HTMLElement>(COMMIT_ROW_SELECTOR)).filter((candidate) => {
    const candidateSubject = candidate.querySelector<HTMLElement>(".graph-commit-subject")?.textContent?.trim() ?? "";
    const candidateAuthor = candidate.querySelector<HTMLElement>(".graph-commit-author")?.textContent?.trim() ?? "";
    return candidateSubject === subject && candidateAuthor === author;
  });

  return {
    subject,
    author,
    refs,
    occurrence: Math.max(0, peers.indexOf(row))
  };
}

function resolveCommitFromHistory(history: CommitNode[], descriptor: CommitDescriptor): CommitNode | undefined {
  let candidates = history.filter((commit) => commit.subject === descriptor.subject);
  if (descriptor.author) {
    const byAuthor = candidates.filter((commit) => commit.authorName === descriptor.author);
    if (byAuthor.length > 0) candidates = byAuthor;
  }

  if (descriptor.refs.length > 0) {
    const byRefs = candidates.filter((commit) => descriptor.refs.every((name) => commit.refs.some((ref) => ref.name === name)));
    if (byRefs.length > 0) candidates = byRefs;
  }

  if (candidates.length === 1) return candidates[0];
  return candidates[descriptor.occurrence];
}

function sameDescriptor(left: CommitDescriptor, right: CommitDescriptor) {
  return left.subject === right.subject
    && left.author === right.author
    && left.occurrence === right.occurrence
    && left.refs.join("\u0000") === right.refs.join("\u0000");
}

async function resolveActiveProject(): Promise<GitProject | undefined> {
  if (!window.gitUI) return undefined;
  const projects = await window.gitUI.getProjects();
  const active = document.querySelector<HTMLElement>(ACTIVE_PROJECT_SELECTOR);
  if (!active) return undefined;

  const activePath = active.querySelector<HTMLElement>(".project-rail-name .sr-only")?.textContent?.trim();
  if (activePath) {
    const match = projects.find((candidate) => normalizePath(candidate.path) === normalizePath(activePath));
    if (match) return match;
  }

  const activeName = active.querySelector<HTMLElement>(".project-rail-name-text")?.textContent?.trim();
  if (!activeName) return undefined;
  const nameMatches = projects.filter((candidate) => candidate.name === activeName);
  if (nameMatches.length === 1) return nameMatches[0];
  return nameMatches
    .filter((candidate) => candidate.lastOpenedAt)
    .sort((left, right) => Date.parse(right.lastOpenedAt ?? "") - Date.parse(left.lastOpenedAt ?? ""))[0];
}

function closeNativeCommitMenu() {
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
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
