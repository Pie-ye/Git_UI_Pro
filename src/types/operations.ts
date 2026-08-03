export type GitLongOperationKind = "clone" | "fetch" | "pull" | "push" | "lfs-pull" | "lfs-migrate";

export type GitLongOperationPhase = "running" | "cancelling" | "completed" | "failed" | "cancelled";

export interface GitLongOperationProgress {
  id: string;
  kind: GitLongOperationKind;
  phase: GitLongOperationPhase;
  label: string;
  repositoryPath?: string;
  message?: string;
  percent?: number;
  receivedObjects?: number;
  totalObjects?: number;
  updatedAt: string;
}

export interface GitLongOperationOptions {
  operationId: string;
}
