import { CircleCheck, CircleX, ListChecks, LoaderCircle, X } from "lucide-react";
import type { GitLongOperationProgress } from "../types/operations";
import { PathTooltip } from "./PathTooltip";
import "../styles/git-operation-center.css";

interface GitOperationCenterProps {
  operations: GitLongOperationProgress[];
  onCancel: (operationId: string) => void;
  onDismiss: (operationId: string) => void;
}

export function GitOperationCenter({ operations, onCancel, onDismiss }: GitOperationCenterProps) {
  if (operations.length === 0) {
    return null;
  }

  const activeCount = operations.filter((operation) => operation.phase === "running" || operation.phase === "cancelling").length;

  return (
    <aside className="git-operation-center liquid-glass" aria-label="Git 后台任务" aria-live="polite">
      <header>
        <span className="git-operation-center-title"><ListChecks size={16} aria-hidden="true" /><strong>后台任务</strong></span>
        <small data-active={activeCount > 0}>{activeCount > 0 ? `${activeCount} 项进行中` : "刚刚完成"}</small>
      </header>
      <div className="git-operation-list">
        {operations.map((operation) => {
          const active = operation.phase === "running" || operation.phase === "cancelling";
          const percent = operation.percent === undefined ? undefined : Math.max(0, Math.min(100, operation.percent));
          return (
            <section className="git-operation-item" key={operation.id} data-phase={operation.phase}>
              <span className="git-operation-icon" aria-hidden="true">
                {active ? <LoaderCircle className="spin" size={16} /> : operation.phase === "completed" ? <CircleCheck size={16} /> : <CircleX size={16} />}
              </span>
              <span className="git-operation-copy">
                <span className="git-operation-heading">
                  <strong>{operation.label}</strong>
                  <em>{operationStatusLabel(operation.phase)}</em>
                </span>
                <small title={operation.repositoryPath}>{operationDetail(operation)}</small>
                {active ? (
                  <span className="git-operation-progress-row">
                    <span
                      className="git-operation-progress"
                      data-indeterminate={percent === undefined}
                      role="progressbar"
                      aria-label={`${operation.label}进度`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent === undefined ? undefined : Math.round(percent)}
                    >
                      <i style={percent === undefined ? undefined : { width: `${percent}%` }} />
                    </span>
                    <small>{percent === undefined ? "处理中" : `${Math.round(percent)}%`}</small>
                  </span>
                ) : null}
              </span>
              <PathTooltip content={active ? `取消${operation.label}` : "关闭任务记录"} className="git-operation-action-tooltip">
                <button
                  type="button"
                  className="git-operation-action icon-button"
                  aria-label={active ? `取消${operation.label}` : `移除${operation.label}记录`}
                  onClick={() => active ? onCancel(operation.id) : onDismiss(operation.id)}
                  disabled={operation.phase === "cancelling"}
                >
                  <X size={14} />
                </button>
              </PathTooltip>
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function operationDetail(operation: GitLongOperationProgress): string {
  const phaseLabel = operationStatusLabel(operation.phase);
  const message = operation.message?.trim();
  const repository = operation.repositoryPath?.split(/[\\/]/).filter(Boolean).at(-1);
  const detail = message && message !== phaseLabel ? message : operationKindLabel(operation.kind);
  return repository ? `${repository} · ${detail}` : detail;
}

function operationKindLabel(kind: GitLongOperationProgress["kind"]): string {
  if (kind === "clone") return "克隆仓库内容";
  if (kind === "fetch") return "获取远程更新";
  if (kind === "pull") return "拉取并整合更改";
  if (kind === "push") return "推送本地提交";
  if (kind === "lfs-pull") return "拉取 LFS 对象";
  return "迁移 LFS 对象";
}

function operationStatusLabel(phase: GitLongOperationProgress["phase"]): string {
  if (phase === "running") return "正在执行";
  if (phase === "cancelling") return "正在取消";
  if (phase === "completed") return "已完成";
  if (phase === "cancelled") return "已取消";
  return "执行失败";
}
