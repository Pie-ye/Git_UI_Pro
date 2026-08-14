import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  FileText,
  Folder,
  RefreshCw,
  X
} from "lucide-react";
import { trellisClient } from "../../api/trellisClient";
import type { GitProject } from "../../types/domain";
import type {
  TrellisOverview,
  TrellisReview,
  TrellisSpecFile,
  TrellisSpecNode,
  TrellisTaskDetail
} from "../../types/trellis";

type DetailTab = "overview" | "prd" | "design" | "implement" | "review" | "specs";

const EMPTY_OVERVIEW: TrellisOverview = {
  availability: { supported: true, detected: false, reason: "not_trellis" },
  tasks: [],
  progress: {
    total: 0,
    byStatus: {},
    byReadiness: {},
    byPriority: {},
    artifacts: { prd: 0, design: 0, implement: 0 },
    percentInProgress: 0,
    percentPlanning: 0,
    percentCompleted: 0
  }
};

export function TrellisDrawer() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<GitProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [overview, setOverview] = useState<TrellisOverview>(EMPTY_OVERVIEW);
  const [selectedTaskDir, setSelectedTaskDir] = useState<string>("");
  const [task, setTask] = useState<TrellisTaskDetail>();
  const [review, setReview] = useState<TrellisReview>();
  const [specTree, setSpecTree] = useState<TrellisSpecNode>();
  const [specFile, setSpecFile] = useState<TrellisSpecFile>();
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId),
    [projects, selectedProjectId]
  );

  useEffect(() => {
    if (!open) return;
    void loadProjects();
  }, [open]);

  useEffect(() => {
    if (!open || !selectedProject) return;
    void loadProject(selectedProject);
    const timer = window.setInterval(() => {
      void refreshOverview(selectedProject, false);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [open, selectedProject?.id]);

  async function loadProjects() {
    if (!window.gitUI) {
      setProjects([]);
      setError("Trellis 檢視僅支援桌面版 Git UI Pro。");
      return;
    }
    try {
      const nextProjects = await window.gitUI.getProjects();
      setProjects(nextProjects);
      setSelectedProjectId((current) => {
        if (current && nextProjects.some((project) => project.id === current)) return current;
        return nextProjects.find((project) => !project.remote)?.id ?? nextProjects[0]?.id ?? "";
      });
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function loadProject(project: GitProject) {
    setLoading(true);
    setError(undefined);
    setTask(undefined);
    setReview(undefined);
    setSpecFile(undefined);
    setSelectedTaskDir("");
    setActiveTab("overview");
    try {
      const nextOverview = await trellisClient.getOverview(project);
      setOverview(nextOverview);
      if (nextOverview.availability.detected && nextOverview.tasks.length > 0) {
        const firstTask = nextOverview.tasks[0];
        setSelectedTaskDir(firstTask.dirName);
        await loadTask(project, firstTask.dirName);
      }
      if (nextOverview.availability.detected) {
        setSpecTree(await trellisClient.getSpecTree(project));
      } else {
        setSpecTree(undefined);
      }
    } catch (cause) {
      setOverview(EMPTY_OVERVIEW);
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }

  async function refreshOverview(project: GitProject, showLoading = true) {
    if (showLoading) setLoading(true);
    try {
      const nextOverview = await trellisClient.getOverview(project);
      setOverview(nextOverview);
      setError(undefined);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  async function loadTask(project: GitProject, dirName: string) {
    setSelectedTaskDir(dirName);
    setLoading(true);
    setError(undefined);
    try {
      const [nextTask, nextReview] = await Promise.all([
        trellisClient.getTask(project, dirName),
        trellisClient.getReview(project, dirName)
      ]);
      setTask(nextTask);
      setReview(nextReview);
      if (activeTab === "specs") setActiveTab("overview");
    } catch (cause) {
      setTask(undefined);
      setReview(undefined);
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }

  async function openSpec(node: TrellisSpecNode) {
    if (!selectedProject || node.type !== "file") return;
    setLoading(true);
    try {
      setSpecFile(await trellisClient.getSpecFile(selectedProject, node.relPath));
      setError(undefined);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button type="button" className="trellis-launcher" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <ClipboardList size={17} />
        Trellis
        {overview.availability.detected && overview.progress.total > 0 ? <span>{overview.progress.total}</span> : null}
      </button>

      {open ? (
        <aside className="trellis-drawer" aria-label="Trellis 唯讀檢視">
          <header className="trellis-drawer-header">
            <div>
              <strong>Trellis</strong>
              <small>唯讀專案檢視</small>
            </div>
            <div className="trellis-drawer-actions">
              <button type="button" title="重新整理" aria-label="重新整理 Trellis" disabled={!selectedProject || loading} onClick={() => selectedProject && void loadProject(selectedProject)}>
                <RefreshCw size={15} className={loading ? "spin" : ""} />
              </button>
              <button type="button" title="關閉" aria-label="關閉 Trellis" onClick={() => setOpen(false)}>
                <X size={16} />
              </button>
            </div>
          </header>

          <div className="trellis-project-picker">
            <label htmlFor="trellis-project">Repository</label>
            <select id="trellis-project" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>
              {projects.length === 0 ? <option value="">沒有專案</option> : null}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}{project.remote ? " · Remote" : ""}</option>
              ))}
            </select>
          </div>

          {error ? <div className="trellis-message trellis-message-error"><AlertCircle size={16} /><span>{error}</span></div> : null}

          {!selectedProject ? (
            <EmptyState title="尚未選擇 Repository" detail="先在 Git UI Pro 加入本機 repository。" />
          ) : !overview.availability.supported ? (
            <EmptyState title="此 Repository 暫不支援 Trellis" detail="v1 僅讀取本機 repository；遠端 SSH Trellis 將在後續版本處理。" />
          ) : !overview.availability.detected ? (
            <EmptyState title="不是 Trellis 專案" detail="此 repository 根目錄沒有 .trellis/，Git 功能仍可正常使用。" />
          ) : (
            <div className="trellis-drawer-body">
              <section className="trellis-task-column">
                <div className="trellis-progress-card">
                  <div><span>Active Tasks</span><strong>{overview.progress.total}</strong></div>
                  <div className="trellis-progress-meta">
                    <span>進行中 {overview.progress.byStatus.in_progress ?? 0}</span>
                    <span>規劃 {overview.progress.byStatus.planning ?? 0}</span>
                    <span>完成 {overview.progress.byStatus.completed ?? 0}</span>
                  </div>
                </div>

                <div className="trellis-task-list">
                  {overview.tasks.length === 0 ? <div className="trellis-task-empty">沒有 active task。</div> : overview.tasks.map((item) => (
                    <button type="button" key={item.dirName} className={`trellis-task-row ${selectedTaskDir === item.dirName ? "selected" : ""}`} onClick={() => selectedProject && void loadTask(selectedProject, item.dirName)}>
                      <span className={`trellis-readiness-dot ${item.readiness.level}`} />
                      <span className="trellis-task-main">
                        <strong>{item.title ?? item.dirName}</strong>
                        <small>{[item.status ?? "unknown", item.priority].filter(Boolean).join(" · ")}</small>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </div>
              </section>

              <section className="trellis-detail-column">
                <nav className="trellis-tabs" aria-label="Trellis 文件分頁">
                  <TabButton id="overview" active={activeTab} onSelect={setActiveTab}>概覽</TabButton>
                  <TabButton id="prd" active={activeTab} onSelect={setActiveTab}>PRD</TabButton>
                  <TabButton id="design" active={activeTab} onSelect={setActiveTab}>Design</TabButton>
                  <TabButton id="implement" active={activeTab} onSelect={setActiveTab}>Implement</TabButton>
                  <TabButton id="review" active={activeTab} onSelect={setActiveTab}>Review</TabButton>
                  <TabButton id="specs" active={activeTab} onSelect={setActiveTab}>Specs</TabButton>
                </nav>

                <div className="trellis-detail-content">
                  {activeTab === "specs" ? <SpecsView tree={specTree} file={specFile} onOpen={openSpec} /> : !task ? (
                    <EmptyState title="沒有可顯示的 Task" detail="選擇左側 task 查看 Trellis 文件。" compact />
                  ) : activeTab === "overview" ? <OverviewView task={task} /> : activeTab === "review" ? <ReviewView review={review} /> : (
                    <DocumentView task={task} tab={activeTab} />
                  )}
                </div>
              </section>
            </div>
          )}
        </aside>
      ) : null}
    </>
  );
}

function TabButton({ id, active, onSelect, children }: { id: DetailTab; active: DetailTab; onSelect: (tab: DetailTab) => void; children: string }) {
  return <button type="button" className={active === id ? "active" : ""} onClick={() => onSelect(id)}>{children}</button>;
}

function OverviewView({ task }: { task: TrellisTaskDetail }) {
  const fields = [["Status", task.status ?? "—"], ["Priority", task.priority ?? "—"], ["Assignee", task.assignee ?? "—"], ["Scope", task.scope ?? "—"], ["Parent", task.parent ?? "—"]];
  return (
    <div className="trellis-overview">
      <div className="trellis-title-block"><h3>{task.title ?? task.dirName}</h3><code>{task.dirName}</code></div>
      <dl className="trellis-metadata">
        {fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {task.description ? <p className="trellis-description">{task.description}</p> : null}
      <div className="trellis-artifacts">
        <Artifact label="PRD" present={task.artifacts.prd} />
        <Artifact label="Design" present={task.artifacts.design} />
        <Artifact label="Implement" present={task.artifacts.implement} />
        <Artifact label="Check" present={task.artifacts.checkJsonl} />
      </div>
      <div className={`trellis-readiness-card ${task.readiness.level}`}><strong>Readiness · {task.readiness.level}</strong><span>{task.readiness.flags.length > 0 ? task.readiness.flags.join(" · ") : "沒有警告。"}</span></div>
    </div>
  );
}

function Artifact({ label, present }: { label: string; present: boolean }) {
  return <span className={present ? "present" : "missing"}>{present ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}{label}</span>;
}

function DocumentView({ task, tab }: { task: TrellisTaskDetail; tab: "prd" | "design" | "implement" }) {
  const document = task.documents[tab];
  if (!document || document.missing) return <EmptyState title={`${tab}.md 不存在`} detail="Trellis Drawer 是唯讀檢視，不會自動建立文件。" compact />;
  return (
    <article className="trellis-document">
      <div className="trellis-document-heading"><FileText size={15} /><strong>{document.name}</strong>{document.truncated ? <span>內容超過 2 MiB，僅顯示前段</span> : null}</div>
      <pre>{document.content}</pre>
    </article>
  );
}

function ReviewView({ review }: { review?: TrellisReview }) {
  if (!review) return <EmptyState title="沒有 Review 資料" detail="無法從目前 task 計算 review。" compact />;
  return (
    <div className="trellis-review">
      <div className="trellis-review-score"><strong>{Math.round(review.score * 100)}%</strong><div><span>{review.judgment}</span><small>{review.rulesVersion}</small></div></div>
      <p>{review.summary}</p>
      <div className="trellis-evidence-grid">
        <Evidence label="Acceptance" checked={review.evidence.ac.checked} total={review.evidence.ac.total} maintained={review.evidence.ac.maintained} />
        <Evidence label="Implement" checked={review.evidence.implement.checked} total={review.evidence.implement.total} maintained={review.evidence.implement.maintained} />
      </div>
      {review.flags.length > 0 ? <div className="trellis-flags">{review.flags.map((flag) => <code key={flag}>{flag}</code>)}</div> : null}
      {review.nextSteps.length > 0 ? <div className="trellis-next-steps"><strong>建議下一步</strong>{review.nextSteps.map((step) => <div key={step.id}><span>{step.title}</span><small>{step.detail}</small></div>)}</div> : null}
    </div>
  );
}

function Evidence({ label, checked, total, maintained }: { label: string; checked: number; total: number; maintained: boolean }) {
  return <div><span>{label}</span><strong>{maintained ? `${checked} / ${total}` : "未維護 checkbox"}</strong></div>;
}

function SpecsView({ tree, file, onOpen }: { tree?: TrellisSpecNode; file?: TrellisSpecFile; onOpen: (node: TrellisSpecNode) => void }) {
  if (!tree) return <EmptyState title="沒有 .trellis/spec" detail="此專案目前沒有 spec tree。" compact />;
  return (
    <div className="trellis-specs">
      <div className="trellis-spec-tree"><SpecNode node={tree} level={0} onOpen={onOpen} /></div>
      <article className="trellis-spec-document">
        {file ? <><strong>{file.relPath}</strong>{file.truncated ? <small>內容超過 2 MiB，僅顯示前段</small> : null}<pre>{file.content}</pre></> : <span>選擇左側 spec 文件。</span>}
      </article>
    </div>
  );
}

function SpecNode({ node, level, onOpen }: { node: TrellisSpecNode; level: number; onOpen: (node: TrellisSpecNode) => void }) {
  if (node.type === "file") return <button type="button" className="trellis-spec-node" style={{ paddingLeft: 10 + level * 14 }} onClick={() => onOpen(node)}><FileText size={13} /><span>{node.name}</span></button>;
  return <div>{level > 0 ? <div className="trellis-spec-folder" style={{ paddingLeft: 10 + (level - 1) * 14 }}><Folder size={13} /><span>{node.name}</span></div> : null}{(node.children ?? []).map((child) => <SpecNode key={child.relPath || child.name} node={child} level={level + 1} onOpen={onOpen} />)}</div>;
}

function EmptyState({ title, detail, compact = false }: { title: string; detail: string; compact?: boolean }) {
  return <div className={`trellis-empty-state ${compact ? "compact" : ""}`}><ClipboardList size={compact ? 22 : 30} /><strong>{title}</strong><span>{detail}</span></div>;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+':\s*/u, "");
  return String(error);
}
