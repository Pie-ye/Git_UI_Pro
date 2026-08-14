import type { GitProject, RepositoryTarget } from "../types/domain";
import type {
  TrellisAvailability,
  TrellisOverview,
  TrellisReview,
  TrellisSpecFile,
  TrellisSpecNode,
  TrellisTaskDetail,
  TrellisTaskSummary
} from "../types/trellis";

function repositoryTarget(project: GitProject): RepositoryTarget {
  return project.remote ? { path: project.path, remote: project.remote } : { path: project.path };
}

function bridge() {
  return window.trellisUI;
}

export const trellisClient = {
  async detect(project: GitProject): Promise<TrellisAvailability> {
    const api = bridge();
    if (!api) {
      return { supported: false, detected: false, reason: "desktop_only" };
    }
    return api.detect(repositoryTarget(project));
  },

  async getOverview(project: GitProject): Promise<TrellisOverview> {
    const api = bridge();
    if (!api) {
      return {
        availability: { supported: false, detected: false, reason: "desktop_only" },
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
    }
    return api.getOverview(repositoryTarget(project));
  },

  async listTasks(project: GitProject): Promise<TrellisTaskSummary[]> {
    const api = bridge();
    return api ? api.listTasks(repositoryTarget(project)) : [];
  },

  async getTask(project: GitProject, dirName: string): Promise<TrellisTaskDetail> {
    const api = bridge();
    if (!api) throw new Error("Trellis 僅支援桌面版 Git UI Pro。");
    return api.getTask(repositoryTarget(project), dirName);
  },

  async getReview(project: GitProject, dirName: string): Promise<TrellisReview> {
    const api = bridge();
    if (!api) throw new Error("Trellis 僅支援桌面版 Git UI Pro。");
    return api.getReview(repositoryTarget(project), dirName);
  },

  async getSpecTree(project: GitProject): Promise<TrellisSpecNode | undefined> {
    const api = bridge();
    return api ? api.getSpecTree(repositoryTarget(project)) : undefined;
  },

  async getSpecFile(project: GitProject, relativePath: string): Promise<TrellisSpecFile> {
    const api = bridge();
    if (!api) throw new Error("Trellis 僅支援桌面版 Git UI Pro。");
    return api.getSpecFile(repositoryTarget(project), relativePath);
  }
};
