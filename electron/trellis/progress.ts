import type { TrellisProgress, TrellisTaskSummary } from "./models";

function increment(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

function percent(value: number, total: number): number {
  return total > 0 ? Math.round((1000 * value) / total) / 10 : 0;
}

export function summarizeProgress(tasks: readonly TrellisTaskSummary[]): TrellisProgress {
  const byStatus: Record<string, number> = {};
  const byReadiness: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  let withPrd = 0;
  let withDesign = 0;
  let withImplement = 0;

  for (const task of tasks) {
    increment(byStatus, task.status ?? "unknown");
    increment(byReadiness, task.readiness?.level ?? "unknown");
    increment(byPriority, task.priority ?? "unset");
    if (task.artifacts.prd) withPrd += 1;
    if (task.artifacts.design) withDesign += 1;
    if (task.artifacts.implement) withImplement += 1;
  }

  const total = tasks.length;
  return {
    total,
    byStatus,
    byReadiness,
    byPriority,
    artifacts: { prd: withPrd, design: withDesign, implement: withImplement },
    percentInProgress: percent(byStatus.in_progress ?? 0, total),
    percentPlanning: percent(byStatus.planning ?? 0, total),
    percentCompleted: percent(byStatus.completed ?? 0, total)
  };
}
