import type { RepositoryTarget } from "./domain";
import type {
  TrellisAvailability,
  TrellisOverview,
  TrellisReview,
  TrellisSpecFile,
  TrellisSpecNode,
  TrellisTaskDetail,
  TrellisTaskSummary
} from "./trellis";

export interface TrellisUIBridge {
  detect: (repository: RepositoryTarget) => Promise<TrellisAvailability>;
  getOverview: (repository: RepositoryTarget) => Promise<TrellisOverview>;
  listTasks: (repository: RepositoryTarget) => Promise<TrellisTaskSummary[]>;
  getTask: (repository: RepositoryTarget, dirName: string) => Promise<TrellisTaskDetail>;
  getReview: (repository: RepositoryTarget, dirName: string) => Promise<TrellisReview>;
  getSpecTree: (repository: RepositoryTarget) => Promise<TrellisSpecNode | undefined>;
  getSpecFile: (repository: RepositoryTarget, relativePath: string) => Promise<TrellisSpecFile>;
}

declare global {
  interface Window {
    trellisUI?: TrellisUIBridge;
  }
}

export {};
