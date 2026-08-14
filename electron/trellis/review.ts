import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseChecklist, type TrellisChecklistResult } from "./checklist";
import { MAX_TRELLIS_FILE_BYTES, TrellisReaderError, summarizeTask } from "./reader";
import type {
  TrellisArtifacts,
  TrellisChecklistEvidence,
  TrellisNextStep,
  TrellisReview,
  TrellisReviewJudgment,
  TrellisReviewSummary,
  TrellisTaskSummary
} from "./models";

export const TRELLIS_REVIEW_RULES_VERSION = "review-1";

async function readMarkdown(taskDir: string, name: string): Promise<string | undefined> {
  try {
    let data = await readFile(path.join(taskDir, name));
    if (data.length > MAX_TRELLIS_FILE_BYTES) {
      data = data.subarray(0, MAX_TRELLIS_FILE_BYTES);
    }
    return data.toString("utf8");
  } catch {
    return undefined;
  }
}

function checklistEvidence(result: TrellisChecklistResult): TrellisChecklistEvidence {
  return {
    maintained: result.maintained,
    checked: result.checked,
    total: result.total,
    ratio: result.ratio,
    uncheckedSamples: result.uncheckedSamples
  };
}

function statusPrior(status?: string): number {
  switch ((status ?? "").toLowerCase()) {
    case "planning": return 0.2;
    case "in_progress": return 0.6;
    case "completed": return 1;
    default: return 0.5;
  }
}

function artifactScore(artifacts: TrellisArtifacts): number {
  return (artifacts.prd ? 0.5 : 0) + (artifacts.design ? 0.25 : 0) + (artifacts.implement ? 0.25 : 0);
}

function computeScore(input: {
  ac: TrellisChecklistResult;
  implement: TrellisChecklistResult;
  hasImplementFile: boolean;
  artifacts: TrellisArtifacts;
  status?: string;
}): number {
  const parts: Array<[number, number]> = [];
  if (input.ac.maintained && input.ac.ratio !== undefined) {
    parts.push([0.4, input.ac.ratio]);
  }
  if (input.hasImplementFile && input.implement.maintained && input.implement.ratio !== undefined) {
    parts.push([0.3, input.implement.ratio]);
  } else if (input.hasImplementFile && !input.implement.maintained) {
    parts.push([0.3, 0.5]);
  }
  parts.push([0.2, artifactScore(input.artifacts)]);
  parts.push([0.1, statusPrior(input.status)]);
  const weight = parts.reduce((sum, [itemWeight]) => sum + itemWeight, 0);
  return weight > 0 ? parts.reduce((sum, [itemWeight, value]) => sum + itemWeight * value, 0) / weight : 0;
}

function buildFlags(input: {
  artifacts: TrellisArtifacts;
  ac: TrellisChecklistResult;
  implement: TrellisChecklistResult;
  hasImplementFile: boolean;
  status?: string;
  score: number;
}): string[] {
  const flags: string[] = [];
  if (!input.artifacts.prd) flags.push("missing_prd");
  if (!input.artifacts.design) flags.push("missing_design");
  if (!input.ac.maintained) flags.push("ac_unmaintained");
  else if (input.ac.ratio !== undefined && input.ac.ratio < 1) flags.push("ac_incomplete");
  if (!input.hasImplementFile) flags.push("implement_missing_file");
  else if (input.implement.maintained && input.implement.ratio !== undefined) {
    if (input.implement.ratio >= 1 && input.implement.total > 0) flags.push("implement_done");
    else if (input.implement.ratio < 1) flags.push("implement_incomplete");
  }
  const status = (input.status ?? "").toLowerCase();
  if (status === "planning") flags.push("status_planning");
  if (status === "in_progress") flags.push("status_in_progress");
  if (input.score >= 0.75) flags.push("high_score");
  if (input.score < 0.4) flags.push("low_score");
  return flags;
}

function judgment(input: {
  flags: string[];
  artifacts: TrellisArtifacts;
  ac: TrellisChecklistResult;
  hasImplementFile: boolean;
  status?: string;
  score: number;
  hasTaskJson: boolean;
}): TrellisReviewJudgment {
  if (!input.hasTaskJson || input.flags.includes("missing_prd")) return "insufficient_evidence";
  const status = (input.status ?? "").toLowerCase();
  if (status === "planning" && !input.hasImplementFile) return "planning";
  const implementDone = input.flags.includes("implement_done");
  const acOk = (input.ac.maintained && input.ac.ratio !== undefined && input.ac.ratio >= 0.8) || !input.ac.maintained;
  if (implementDone && acOk && input.artifacts.prd) return "ready_to_archive";
  if (implementDone && input.ac.maintained && input.ac.ratio !== undefined && input.ac.ratio < 0.8) return "needs_verification";
  if (input.score >= 0.75 && status === "in_progress") return "needs_verification";
  if (status === "planning") return "planning";
  return "in_progress";
}

function summaryText(value: TrellisReviewJudgment, flags: string[], score: number): string {
  const percentage = Math.round(score * 100);
  if (value === "insufficient_evidence") return `證據不足（分數約 ${percentage}%）：缺少 prd 或 task.json，無法可靠判斷是否可結案。`;
  if (value === "ready_to_archive") return `文件證據傾向可結案（分數約 ${percentage}%）。建議快速手測 Goal 後執行 archive；本工具不會自動改狀態。`;
  if (value === "needs_verification") {
    const extra = flags.includes("ac_incomplete") ? "AC 未全部勾選，" : flags.includes("ac_unmaintained") ? "PRD 未維護 checkbox，" : "";
    return `像是做完了但仍建議手測（分數約 ${percentage}%）。${extra}通過後再 archive。`;
  }
  if (value === "planning") return `仍在規劃階段（分數約 ${percentage}%）。應補齊規劃產物，或確認取消後再 archive。`;
  return `仍有進行中證據（分數約 ${percentage}%）。可依 implement 未完成項繼續，或縮 scope 後重評。`;
}

function nextSteps(value: TrellisReviewJudgment, dirName: string, acSamples: string[], implementSamples: string[]): TrellisNextStep[] {
  const archiveCommand = `python3 ./.trellis/scripts/task.py archive ${dirName}`;
  if (value === "ready_to_archive") {
    return [
      { id: "verify-goal", title: "快速手測 Goal", detail: "用 prd 的 Goal 做 1～3 分鐘驗證，確認主路徑可用。", actionType: "manual" },
      { id: "archive-cli", title: "複製 archive 指令", detail: archiveCommand, actionType: "copy_cli" },
      { id: "note-limits", title: "可選：記錄已知限制", detail: "若有小尾巴，在 notes 或 follow-up task 註明後再結案。", actionType: "manual" }
    ];
  }
  if (value === "needs_verification") {
    const samples = acSamples.length > 0 ? acSamples : implementSamples;
    const detail = samples.length > 0 ? `建議手測：\n- ${samples.join("\n- ")}` : "對照 prd Goal 做手測；AC checkbox 可能未維護。";
    return [
      { id: "hand-test", title: "手測關鍵項目", detail, actionType: "manual" },
      { id: "archive-if-ok", title: "通過後 archive", detail: archiveCommand, actionType: "copy_cli" },
      { id: "write-gap", title: "不通過則寫下缺口", detail: "把失敗點寫回 prd notes 或開 follow-up，避免永遠卡在 in_progress。", actionType: "manual" }
    ];
  }
  if (value === "planning") {
    return [
      { id: "finish-prd", title: "補齊 prd 驗收條件", detail: "寫清楚 Goal 與 Acceptance，或確認此 task 要取消。", actionType: "open_tab" },
      { id: "freeze-archive", title: "若已放棄：archive 凍結", detail: `${archiveCommand}\n（可在 notes 註明取消／凍結原因）`, actionType: "copy_cli" },
      { id: "dont-fake-progress", title: "不要長期假 in_progress", detail: "planning 很久應重開更小 task 或結案，避免污染清單。", actionType: "manual" }
    ];
  }
  if (value === "insufficient_evidence") {
    return [
      { id: "add-prd", title: "補 prd.md", detail: "至少寫 Goal 與可測的 Acceptance。", actionType: "open_tab" },
      { id: "check-dir", title: "確認 task 目錄完整", detail: "檢查 task.json 是否可讀、路徑是否正確。", actionType: "manual" }
    ];
  }
  const detail = implementSamples.length > 0 ? `未完成 implement 項：\n- ${implementSamples.join("\n- ")}` : "查看 implement.md 或 prd 未勾項目，收斂剩餘工作。";
  return [
    { id: "continue-impl", title: "繼續未完成項", detail, actionType: "open_tab" },
    { id: "shrink-scope", title: "考慮縮 scope", detail: "若主功能已好，把剩餘拆 follow-up 後走手測與 archive。", actionType: "manual" },
    { id: "archive-when-ready", title: "就緒時的 archive 指令", detail: archiveCommand, actionType: "copy_cli" }
  ];
}

export async function buildReviewFromSummary(
  task: TrellisTaskSummary,
  input: { taskDir: string; hasTaskJson?: boolean }
): Promise<TrellisReview> {
  const prdText = task.artifacts.prd ? await readMarkdown(input.taskDir, "prd.md") : undefined;
  const implementText = task.artifacts.implement ? await readMarkdown(input.taskDir, "implement.md") : undefined;
  const ac = parseChecklist(prdText);
  const implement = parseChecklist(implementText);
  const score = computeScore({ ac, implement, hasImplementFile: task.artifacts.implement, artifacts: task.artifacts, status: task.status });
  const flags = buildFlags({ artifacts: task.artifacts, ac, implement, hasImplementFile: task.artifacts.implement, status: task.status, score });
  const value = judgment({ flags, artifacts: task.artifacts, ac, hasImplementFile: task.artifacts.implement, status: task.status, score, hasTaskJson: input.hasTaskJson ?? true });
  const archiveCommand = `python3 ./.trellis/scripts/task.py archive ${task.dirName}`;
  return {
    rulesVersion: TRELLIS_REVIEW_RULES_VERSION,
    dirName: task.dirName,
    title: task.title,
    status: task.status,
    score: Math.round(score * 10_000) / 10_000,
    judgment: value,
    summary: summaryText(value, flags, score),
    flags,
    evidence: {
      ac: checklistEvidence(ac),
      implement: checklistEvidence(implement),
      artifacts: task.artifacts,
      readiness: task.readiness
    },
    nextSteps: nextSteps(value, task.dirName, ac.uncheckedSamples, implement.uncheckedSamples).slice(0, 3),
    archiveCommand
  };
}

export function reviewSummaryOnly(review: TrellisReview): TrellisReviewSummary {
  return { judgment: review.judgment, score: review.score, flags: [...review.flags] };
}

export async function reviewTask(projectRoot: string, dirName: string): Promise<TrellisReview> {
  const root = path.resolve(projectRoot);
  const task = await summarizeTask(root, dirName);
  const taskDir = path.join(root, ".trellis", "tasks", dirName);
  try {
    const metadata = await stat(taskDir);
    if (!metadata.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new TrellisReaderError(`Task not found: ${dirName}`, 404);
  }
  let hasTaskJson = true;
  try {
    await readFile(path.join(taskDir, "task.json"));
  } catch {
    hasTaskJson = false;
  }
  return buildReviewFromSummary(task, { taskDir, hasTaskJson });
}

export async function attachReviewSummaries(projectRoot: string, tasks: readonly TrellisTaskSummary[]): Promise<TrellisTaskSummary[]> {
  const root = path.resolve(projectRoot);
  return Promise.all(tasks.map(async (task) => {
    try {
      const taskDir = path.join(root, ".trellis", "tasks", task.dirName);
      let hasTaskJson = true;
      try {
        await readFile(path.join(taskDir, "task.json"));
      } catch {
        hasTaskJson = false;
      }
      const review = await buildReviewFromSummary(task, { taskDir, hasTaskJson });
      return { ...task, review: reviewSummaryOnly(review) };
    } catch {
      return { ...task, review: undefined };
    }
  }));
}
