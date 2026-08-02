import { CircleCheck, CircleX, LoaderCircle, X } from "lucide-react";
import type { GitLongOperationProgress } from "../types/operations";
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

  return (
    <aside className="git-operation-center liquid-glass" aria-label="Git 后台任务" aria-live="polite">
      <header>
        <span>后台任务</span>
        <small>{operations.filter((operation) => operation.phase === "running" || operation.phase === "cancelling").length} 项进行中</small>
      </header>
      <div className="git-operation-list">
        {operations.map((operation) => {
          const active = operation.phase === "running" || operation.phase === "cancelling";
          return (
            <section className="git-operation-item" key={operation.id} data-phase={operation.phase}>
              <span className="git-operation-icon" aria-hidden="true">
                {active ? <LoaderCircle className="spin" size={16} /> : operation.phase === "completed" ? <CircleCheck size={16} /> : <CircleX size={16} />}
              </span>
              <span className="git-operation-copy">
                <strong>{operation.label}</strong>
                <small>{operation.message ?? operationStatusLabel(operation.phase)}</small>
                {operation.percent !== undefined ? (
                  <span className="git-operation-progress" role="progressbar" aria-label={`${operation.label}进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(operation.percent)}>
                    <i style={{ width: `${Math.max(0, Math.min(100, operation.percent))}%` }} />
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                className="git-operation-action icon-button"
                aria-label={active ? `取消${operation.label}` : `移除${operation.label}记录`}
                onClick={() => active ? onCancel(operation.id) : onDismiss(operation.id)}
                disabled={operation.phase === "cancelling"}
              >
                <X size={15} />
              </button>
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function operationStatusLabel(phase: GitLongOperationProgress["phase"]): string {
  if (phase === "running") return "正在执行";
  if (phase === "cancelling") return "正在取消";
  if (phase === "completed") return "已完成";
  if (phase === "cancelled") return "已取消";
  return "执行失败";
}
