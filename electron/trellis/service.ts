import path from "node:path";
import type { RepositoryLocation } from "../gitService";
import { summarizeProgress } from "./progress";
import { attachReviewSummaries, reviewTask } from "./review";
import {
  buildSpecTree,
  detectTrellisProject,
  getTaskDetail,
  listActiveTasks,
  readSpecFile
} from "./reader";
import type {
  TrellisProgress,
  TrellisReview,
  TrellisSpecFile,
  TrellisSpecNode,
  TrellisTaskDetail,
  TrellisTaskSummary
} from "./models";

export interface TrellisAvailability {
  supported: boolean;
  detected: boolean;
  reason?: "remote_not_supported" | "not_trellis";
}

export interface TrellisOverview {
  availability: TrellisAvailability;
  tasks: TrellisTaskSummary[];
  progress: TrellisProgress;
}

function repositoryTarget(repository: RepositoryLocation): { path: string; remote: boolean } {
  if (typeof repository === "string") {
    return { path: repository, remote: false };
  }
  return { path: repository.path, remote: Boolean(repository.remote) };
}

function requireLocalRepository(repository: RepositoryLocation): string {
  const target = repositoryTarget(repository);
  if (target.remote) {
    throw new Error("遠端 Trellis 檢視尚未支援。");
  }
  if (!target.path.trim()) {
    throw new Error("Trellis 專案路徑不可為空。");
  }
  return path.resolve(target.path);
}

export class TrellisService {
  async detect(repository: RepositoryLocation): Promise<TrellisAvailability> {
    const target = repositoryTarget(repository);
    if (target.remote) {
      return { supported: false, detected: false, reason: "remote_not_supported" };
    }
    const detected = await detectTrellisProject(path.resolve(target.path));
    return detected
      ? { supported: true, detected: true }
      : { supported: true, detected: false, reason: "not_trellis" };
  }

  async getOverview(repository: RepositoryLocation): Promise<TrellisOverview> {
    const availability = await this.detect(repository);
    if (!availability.supported || !availability.detected) {
      return { availability, tasks: [], progress: summarizeProgress([]) };
    }
    const root = requireLocalRepository(repository);
    const rawTasks = await listActiveTasks(root);
    const tasks = await attachReviewSummaries(root, rawTasks);
    return { availability, tasks, progress: summarizeProgress(tasks) };
  }

  async listTasks(repository: RepositoryLocation): Promise<TrellisTaskSummary[]> {
    return listActiveTasks(requireLocalRepository(repository));
  }

  async getTask(repository: RepositoryLocation, dirName: string): Promise<TrellisTaskDetail> {
    return getTaskDetail(requireLocalRepository(repository), dirName);
  }

  async getReview(repository: RepositoryLocation, dirName: string): Promise<TrellisReview> {
    return reviewTask(requireLocalRepository(repository), dirName);
  }

  async getSpecTree(repository: RepositoryLocation): Promise<TrellisSpecNode | undefined> {
    return buildSpecTree(requireLocalRepository(repository));
  }

  async getSpecFile(repository: RepositoryLocation, relativePath: string): Promise<TrellisSpecFile> {
    return readSpecFile(requireLocalRepository(repository), relativePath);
  }
}
