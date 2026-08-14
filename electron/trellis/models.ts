export type TrellisReadinessLevel = "ok" | "partial" | "missing_required";
export type TrellisReviewJudgment =
  | "ready_to_archive"
  | "needs_verification"
  | "in_progress"
  | "planning"
  | "insufficient_evidence";
export type TrellisNextStepAction = "manual" | "copy_cli" | "open_tab";

export interface TrellisArtifacts {
  prd: boolean;
  design: boolean;
  implement: boolean;
  implementJsonl: boolean;
  checkJsonl: boolean;
}

export interface TrellisReadiness {
  level: TrellisReadinessLevel;
  flags: string[];
}

export interface TrellisChecklistEvidence {
  maintained: boolean;
  checked: number;
  total: number;
  ratio?: number;
  uncheckedSamples: string[];
}

export interface TrellisReviewEvidence {
  ac: TrellisChecklistEvidence;
  implement: TrellisChecklistEvidence;
  artifacts: TrellisArtifacts;
  readiness: TrellisReadiness;
}

export interface TrellisNextStep {
  id: string;
  title: string;
  detail: string;
  actionType: TrellisNextStepAction;
}

export interface TrellisReviewSummary {
  judgment: TrellisReviewJudgment;
  score: number;
  flags: string[];
}

export interface TrellisReview {
  rulesVersion: string;
  dirName: string;
  title?: string;
  status?: string;
  score: number;
  judgment: TrellisReviewJudgment;
  summary: string;
  flags: string[];
  evidence: TrellisReviewEvidence;
  nextSteps: TrellisNextStep[];
  archiveCommand: string;
}

export interface TrellisTaskSummary {
  dirName: string;
  id?: string;
  name?: string;
  title?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  package?: string;
  scope?: string;
  parent?: string;
  children: unknown[];
  description?: string;
  notes?: string;
  artifacts: TrellisArtifacts;
  readiness: TrellisReadiness;
  error?: string;
  review?: TrellisReviewSummary;
}

export interface TrellisMarkdownDocument {
  name: string;
  missing: boolean;
  content?: string;
  truncated: boolean;
}

export interface TrellisTaskDetail extends TrellisTaskSummary {
  documents: Record<string, TrellisMarkdownDocument>;
  rawTaskJson?: Record<string, unknown>;
}

export interface TrellisSpecNode {
  name: string;
  type: "dir" | "file";
  relPath: string;
  children?: TrellisSpecNode[];
}

export interface TrellisSpecFile {
  relPath: string;
  content: string;
  truncated: boolean;
}

export interface TrellisProgress {
  total: number;
  byStatus: Record<string, number>;
  byReadiness: Record<string, number>;
  byPriority: Record<string, number>;
  artifacts: {
    prd: number;
    design: number;
    implement: number;
  };
  percentInProgress: number;
  percentPlanning: number;
  percentCompleted: number;
}
