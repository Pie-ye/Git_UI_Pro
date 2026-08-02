import type { GitLongOperationKind, GitLongOperationProgress } from "../types/operations";

const operations = new Map<string, GitLongOperationProgress>();
const listeners = new Set<() => void>();
const dismissTimers = new Map<string, number>();
let snapshot: GitLongOperationProgress[] = [];
let bridgeSubscribed = false;

export function subscribeGitOperations(listener: () => void): () => void {
  listeners.add(listener);
  ensureBridgeSubscription();
  return () => listeners.delete(listener);
}

export function getGitOperationsSnapshot(): GitLongOperationProgress[] {
  ensureBridgeSubscription();
  return snapshot;
}

export function beginGitOperation(kind: GitLongOperationKind, label: string, repositoryPath?: string): string {
  const id = crypto.randomUUID();
  updateOperation({
    id,
    kind,
    phase: "running",
    label,
    repositoryPath,
    message: "正在启动",
    updatedAt: new Date().toISOString()
  });
  return id;
}

export function finishGitOperation(operationId: string, ok: boolean, message?: string): void {
  const current = operations.get(operationId);
  if (!current) {
    return;
  }
  if (current.phase === "cancelled") {
    return;
  }
  const cancelled = current.phase === "cancelling";
  updateOperation({
    ...current,
    phase: cancelled ? "cancelled" : ok ? "completed" : "failed",
    message: cancelled ? "已取消" : message ?? (ok ? "已完成" : "执行失败"),
    percent: ok ? 100 : current.percent,
    updatedAt: new Date().toISOString()
  });
}

export async function cancelGitOperation(operationId: string): Promise<boolean> {
  const current = operations.get(operationId);
  if (!current || current.phase !== "running") {
    return false;
  }
  updateOperation({ ...current, phase: "cancelling", message: "正在取消", updatedAt: new Date().toISOString() });
  if (!window.gitUI) {
    updateOperation({ ...current, phase: "cancelled", message: "已取消", updatedAt: new Date().toISOString() });
    return true;
  }
  try {
    const cancelled = await window.gitUI.cancelGitOperation(operationId);
    if (!cancelled) {
      updateOperation({ ...current, phase: "failed", message: "任务已经结束，无法取消", updatedAt: new Date().toISOString() });
    }
    return cancelled;
  } catch (error) {
    updateOperation({
      ...current,
      phase: "failed",
      message: error instanceof Error && error.message.trim() ? error.message : "取消任务失败",
      updatedAt: new Date().toISOString()
    });
    return false;
  }
}

export function dismissGitOperation(operationId: string): void {
  const current = operations.get(operationId);
  if (!current || current.phase === "running" || current.phase === "cancelling") {
    return;
  }
  operations.delete(operationId);
  const timer = dismissTimers.get(operationId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    dismissTimers.delete(operationId);
  }
  publish();
}

function ensureBridgeSubscription(): void {
  if (bridgeSubscribed || !window.gitUI) {
    return;
  }
  bridgeSubscribed = true;
  window.gitUI.onGitOperationProgress((progress) => updateOperation(progress));
}

function updateOperation(progress: GitLongOperationProgress): void {
  const next = { ...operations.get(progress.id), ...progress };
  operations.set(progress.id, next);
  publish();
  if (next.phase === "completed" || next.phase === "failed" || next.phase === "cancelled") {
    const existingTimer = dismissTimers.get(next.id);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }
    dismissTimers.set(next.id, window.setTimeout(() => dismissGitOperation(next.id), 10_000));
  }
}

function publish(): void {
  snapshot = [...operations.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  listeners.forEach((listener) => listener());
}
