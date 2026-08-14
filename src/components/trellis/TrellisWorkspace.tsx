import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ClipboardList, FileText, Folder, RefreshCw } from "lucide-react";
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

export function TrellisWorkspace({ project }: { project?: GitProject }) {
  const [overview, setOverview] = useState<TrellisOverview>(EMPTY_OVERVIEW);
  const [selectedTaskDir, setSelectedTaskDir] = useState("");
  const [task, setTask] = useState<TrellisTaskDetail>();
  const [review, setReview] = useState<TrellisReview>();
  const [specTree, setSpecTree] = useState<TrellisSpecNode>();
  const [specFile, setSpecFile] = useState<TrellisSpecFile>();
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const projectIdRef = useRef<string>();

  useEffect(() => {
    projectIdRef.current = project?.id;
    setOverview(EMPTY_OVERVIEW);
    setSelectedTaskDir("");
    setTask(undefined);
    setReview(undefined);
    setSpecTree(undefined);
    setSpecFile(undefined);
    setActiveTab("overview");
    setError(undefined);

    if (!project) return;
    void loadProject(project);
    const timer = window.setInterval(() => void refreshOverview(project), 5000);
    return () => window.clearInterval(timer);
  }, [project?.id]);

  async function loadProject(currentProject: GitProject) {
    setLoading(true);
    setError(undefined);
    try {
      const nextOverview = await trellisClient.getOverview(currentProject);
      if (!isCurrentProject(currentProject)) return;
      setOverview(nextOverview);

      if (!nextOverview.availability.detected) {
        setTask(undefined);
        setReview(undefined);
        setSpecTree(undefined);
        return;
      }

      const [nextSpecTree] = await Promise.all([trellisClient.getSpecTree(currentProject)]);
      if (!isCurrentProject(currentProject)) return;
      setSpecTree(nextSpecTree);

      const firstTask = nextOverview.tasks[0];
      if (firstTask) {
        await loadTask(currentProject, firstTask.dirName);
      }
    } catch (cause) {
      if (!isCurrentProject(currentProject)) return;
      setOverview(EMPTY_OVERVIEW);
      setError(errorText(cause));
    } finally {
      if (isCurrentProject(currentProject)) setLoading(false);
    }
  }

  async function refreshOverview(currentProject: GitProject) {
    try {
      const nextOverview = await trellisClient.getOverview(currentProject);
      if (!isCurrentProject(currentProject)) return;
      setOverview(nextOverview);
      setError(undefined);
    } catch (cause) {
      if (isCurrentProject(currentProject)) setError(errorText(cause));
    }
  }

  async function loadTask(currentProject: GitProject, dirName: string) {
    setSelectedTaskDir(dirName);
    setLoading(true);
    setError(undefined);
    try {
      const [nextTask, nextReview] = await Promise.all([
        trellisClient.getTask(currentProject, dirName),
        trellisClient.getReview(currentProject, dirName)
      ]);
      if (!isCurrentProject(currentProject)) return;
      setTask(nextTask);
      setReview(nextReview);
      setSpecFile(undefined);
      setActiveTab((current) => current === "specs" ? "overview" : current);
    } catch (cause) {
      if (!isCurrentProject(currentProject)) return;
      setTask(undefined);
      setReview(undefined);
      setError(errorText(cause));
    } finally {
      if (isCurrentProject(currentProject)) setLoading(false);
    }
  }

  async function openSpec(node: TrellisSpecNode) {
    if (!project || node.type !== "file") return;
    setLoading(true);
    try {
      const nextFile = await trellisClient.getSpecFile(project, node.relPath);
      if (!isCurrentProject(project)) return;
      setSpecFile(nextFile);
      setError(undefined);
    } catch (cause) {
      if (isCurrentProject(project)) setError(errorText(cause));
    } finally {
      if (isCurrentProject(project)) setLoading(false);
    }
  }

  function isCurrentProject(currentProject: GitProject) {
    return projectIdRef.current === currentProject.id;
  }

  if (!project) {
    return <WorkspaceEmpty icon="trellis" title="Trellis" detail="選擇左側 Repository 後，在沒有開啟檔案時顯示 Trellis。" />;
  }

  if (!overview.availability.supported) {
    return <WorkspaceEmpty icon="trellis" title="Trellis 暫不可用" detail="目前僅支援本機 Repository 的唯讀 Trellis 檢視。" />;
  }

  if (!overview.availability.detected) {
    return <WorkspaceEmpty icon="trellis" title="這不是 Trellis 專案" detail={`${project.name} 根目錄沒有 .trellis/；點選檔案仍可正常查看 Git 變更。`} />;
  }

  return (
    <section className="trellis-workspace" aria-label="Trellis 唯讀檢視">
      <header className="trellis-workspace-header">
        <div className="trellis-workspace-heading">
          <span className="trellis-workspace-icon"><ClipboardList size={16} /></span>
          <span>
            <strong>Trellis</strong>
            <small>{project.name} · 唯讀</small>
          </span>
        </div>
        <div className="trellis-workspace-header-actions">
          <span className="trellis-workspace-count" title="Active Tasks">{overview.progress.total}</span>
          <button type="button" className="icon-button compact-icon" title="重新整理 Trellis" aria-label="重新整理 Trellis" disabled={loading} onClick={() => void loadProject(project)}>
            <RefreshCw size={14} className={loading ? "trellis-spin" : ""} />
          </button>
        </div>
      </header>

      {error ? <div className="trellis-message trellis-message-error"><AlertCircle size={14} /><span>{error}</span></div> : null}

      <div className="trellis-task-control">
        <label htmlFor="trellis-task-select">Task</label>
        <select
          id="trellis-task-select"
          value={selectedTaskDir}
          disabled={overview.tasks.length === 0 || loading}
          onChange={(event) => void loadTask(project, event.target.value)}
        >
          {overview.tasks.length === 0 ? <option value="">沒有 active task</option> : null}
          {overview.tasks.map((item) => (
            <option key={item.dirName} value={item.dirName}>
              {item.title ?? item.dirName}{item.status ? ` · ${item.status}` : ""}
            </option>
          ))}
        </select>
      </div>

      <nav className="trellis-tabs" aria-label="Trellis 文件分頁">
        <TabButton id="overview" active={activeTab} onSelect={setActiveTab}>概覽</TabButton>
        <TabButton id="prd" active={activeTab} onSelect={setActiveTab}>PRD</TabButton>
        <TabButton id="design" active={activeTab} onSelect={setActiveTab}>Design</TabButton>
        <TabButton id="implement" active={activeTab} onSelect={setActiveTab}>Implement</TabButton>
        <TabButton id="review" active={activeTab} onSelect={setActiveTab}>Review</TabButton>
        <TabButton id="specs" active={activeTab} onSelect={setActiveTab}>Specs</TabButton>
      </nav>

      <div className="trellis-detail-content">
        {activeTab === "specs" ? (
          <SpecsView tree={specTree} file={specFile} onOpen={openSpec} />
        ) : !task ? (
          <WorkspaceEmpty title="沒有可顯示的 Task" detail="目前沒有 active task。" compact />
        ) : activeTab === "overview" ? (
          <OverviewView task={task} />
        ) : activeTab === "review" ? (
          <ReviewView review={review} />
        ) : (
          <DocumentView task={task} tab={activeTab} />
        )}
      </div>
    </section>
  );
}

function TabButton({ id, active, onSelect, children }: { id: DetailTab; active: DetailTab; onSelect: (tab: DetailTab) => void; children: string }) {
  return <button type="button" className={active === id ? "active" : ""} onClick={() => onSelect(id)}>{children}</button>;
}

function OverviewView({ task }: { task: TrellisTaskDetail }) {
  const fields = [
    ["Status", task.status ?? "—"],
    ["Priority", task.priority ?? "—"],
    ["Assignee", task.assignee ?? "—"],
    ["Scope", task.scope ?? "—"],
    ["Parent", task.parent ?? "—"]
  ];

  return (
    <div className="trellis-overview">
      <div className="trellis-title-block">
        <h3>{task.title ?? task.dirName}</h3>
        <code>{task.dirName}</code>
      </div>
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
      <div className={`trellis-readiness-card ${task.readiness.level}`}>
        <strong>Readiness · {task.readiness.level}</strong>
        <span>{task.readiness.flags.length > 0 ? task.readiness.flags.join(" · ") : "沒有警告。"}</span>
      </div>
    </div>
  );
}

function Artifact({ label, present }: { label: string; present: boolean }) {
  return <span className={present ? "present" : "missing"}>{present ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}{label}</span>;
}

function DocumentView({ task, tab }: { task: TrellisTaskDetail; tab: "prd" | "design" | "implement" }) {
  const document = task.documents[tab];
  if (!document || document.missing) {
    return <WorkspaceEmpty title={`${tab}.md 不存在`} detail="Trellis 檢視是唯讀，不會自動建立文件。" compact />;
  }

  return (
    <article className="trellis-document">
      <div className="trellis-document-heading">
        <FileText size={14} />
        <strong>{document.name}</strong>
        {document.truncated ? <span>內容超過 2 MiB，僅顯示前段</span> : null}
      </div>
      <pre>{document.content}</pre>
    </article>
  );
}

function ReviewView({ review }: { review?: TrellisReview }) {
  if (!review) return <WorkspaceEmpty title="沒有 Review 資料" detail="無法從目前 task 計算 review。" compact />;

  return (
    <div className="trellis-review">
      <div className="trellis-review-score">
        <strong>{Math.round(review.score * 100)}%</strong>
        <div><span>{review.judgment}</span><small>{review.rulesVersion}</small></div>
      </div>
      <p>{review.summary}</p>
      <div className="trellis-evidence-grid">
        <Evidence label="Acceptance" checked={review.evidence.ac.checked} total={review.evidence.ac.total} maintained={review.evidence.ac.maintained} />
        <Evidence label="Implement" checked={review.evidence.implement.checked} total={review.evidence.implement.total} maintained={review.evidence.implement.maintained} />
      </div>
      {review.flags.length > 0 ? <div className="trellis-flags">{review.flags.map((flag) => <code key={flag}>{flag}</code>)}</div> : null}
      {review.nextSteps.length > 0 ? (
        <div className="trellis-next-steps">
          <strong>建議下一步</strong>
          {review.nextSteps.map((step) => <div key={step.id}><span>{step.title}</span><small>{step.detail}</small></div>)}
        </div>
      ) : null}
    </div>
  );
}

function Evidence({ label, checked, total, maintained }: { label: string; checked: number; total: number; maintained: boolean }) {
  return <div><span>{label}</span><strong>{maintained ? `${checked} / ${total}` : "未維護 checkbox"}</strong></div>;
}

function SpecsView({ tree, file, onOpen }: { tree?: TrellisSpecNode; file?: TrellisSpecFile; onOpen: (node: TrellisSpecNode) => void }) {
  return (
    <div className="trellis-specs">
      <div className="trellis-spec-tree">
        {tree ? <SpecNode node={tree} depth={0} onOpen={onOpen} /> : <span className="trellis-spec-empty">沒有 spec。</span>}
      </div>
      <div className="trellis-spec-document">
        {file ? (
          <>
            <strong>{file.relPath}</strong>
            {file.truncated ? <small>內容超過 2 MiB，僅顯示前段</small> : null}
            <pre>{file.content}</pre>
          </>
        ) : <WorkspaceEmpty title="選擇 Spec" detail="從上方清單選擇文件。" compact />}
      </div>
    </div>
  );
}

function SpecNode({ node, depth, onOpen }: { node: TrellisSpecNode; depth: number; onOpen: (node: TrellisSpecNode) => void }) {
  if (node.type === "file") {
    return (
      <button type="button" className="trellis-spec-node" style={{ paddingLeft: 10 + depth * 12 }} onClick={() => onOpen(node)}>
        <FileText size={12} />
        <span>{node.name}</span>
      </button>
    );
  }

  return (
    <div>
      {depth > 0 ? <div className="trellis-spec-folder" style={{ paddingLeft: 10 + depth * 12 }}><Folder size={12} /><span>{node.name}</span></div> : null}
      {node.children?.map((child) => <SpecNode key={child.relPath || child.name} node={child} depth={depth + (depth > 0 ? 1 : 0)} onOpen={onOpen} />)}
    </div>
  );
}

function WorkspaceEmpty({ title, detail, compact = false, icon }: { title: string; detail: string; compact?: boolean; icon?: "trellis" }) {
  return (
    <div className={`trellis-empty-state ${compact ? "compact" : ""}`}>
      {icon ? <span className="trellis-empty-icon"><ClipboardList size={20} /></span> : null}
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
