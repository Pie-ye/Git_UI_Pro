import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface GitProject {
  id: string;
  name: string;
  path: string;
  remote?: SshConnection;
  groupId?: string;
  favorite: boolean;
  lastOpenedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SshConnection {
  type: "ssh";
  host: string;
  username?: string;
  port?: number;
  identityFile?: string;
}

export interface RemoteProjectInput {
  host: string;
  username?: string;
  port?: number;
  repositoryPath: string;
  identityFile?: string;
}

export interface ProjectGroup {
  id: string;
  name: string;
  sortOrder: number;
}

export interface AppConfig {
  version: number;
  projects: GitProject[];
  groups: ProjectGroup[];
  recentProjectIds: string[];
  ui: {
    theme: "system" | "light" | "dark";
    language: "zh-CN";
    bottomConsoleVisible: boolean;
    rightPanelWidth: number;
  };
}

const defaultConfig: AppConfig = {
  version: 1,
  projects: [],
  groups: [
    { id: "work", name: "工作项目", sortOrder: 10 },
    { id: "personal", name: "个人项目", sortOrder: 20 },
    { id: "client", name: "客户项目", sortOrder: 30 }
  ],
  recentProjectIds: [],
  ui: {
    theme: "system",
    language: "zh-CN",
    bottomConsoleVisible: true,
    rightPanelWidth: 420
  }
};

export class ConfigStore {
  private readonly configPath: string;
  private readonly backupPath: string;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    this.configPath = path.join(userDataPath, "config.json");
    this.backupPath = path.join(userDataPath, "config.json.bak");
  }

  async read(): Promise<AppConfig> {
    return this.enqueue(() => this.readUnlocked());
  }

  async write(config: AppConfig): Promise<void> {
    await this.enqueue(() => this.writeUnlocked(config));
  }

  async listProjects(): Promise<GitProject[]> {
    const config = await this.read();
    return config.projects;
  }

  async addProject(repositoryPath: string): Promise<GitProject> {
    return this.enqueue(async () => {
      const config = await this.readUnlocked();
      const normalizedPath = path.resolve(repositoryPath);
      const existing = config.projects.find((project) => !project.remote && path.resolve(project.path) === normalizedPath);

      if (existing) {
        return existing;
      }

      const now = new Date().toISOString();
      const project: GitProject = {
        id: randomUUID(),
        name: path.basename(normalizedPath),
        path: normalizedPath,
        favorite: false,
        lastOpenedAt: now,
        createdAt: now,
        updatedAt: now
      };

      config.projects = placeProjectAfterPinned(config.projects, project);
      config.recentProjectIds = [project.id, ...config.recentProjectIds.filter((id) => id !== project.id)].slice(0, 20);
      await this.writeUnlocked(config);
      return project;
    });
  }

  async addRemoteProject(input: RemoteProjectInput, repositoryRoot: string): Promise<GitProject> {
    return this.enqueue(async () => {
      const config = await this.readUnlocked();
      const remote: SshConnection = {
        type: "ssh",
        host: input.host.trim(),
        username: input.username?.trim() || undefined,
        port: input.port,
        identityFile: input.identityFile?.trim() || undefined
      };
      const normalizedPath = normalizeRemotePath(repositoryRoot);
      const existing = config.projects.find(
        (project) => project.remote && remoteProjectKey(project.remote, project.path) === remoteProjectKey(remote, normalizedPath)
      );

      if (existing) {
        const updatedProject: GitProject = {
          ...existing,
          remote,
          updatedAt: new Date().toISOString()
        };
        config.projects = config.projects.map((project) => (project.id === existing.id ? updatedProject : project));
        await this.writeUnlocked(config);
        return updatedProject;
      }

      const now = new Date().toISOString();
      const project: GitProject = {
        id: randomUUID(),
        name: path.posix.basename(normalizedPath) || remote.host,
        path: normalizedPath,
        remote,
        favorite: false,
        lastOpenedAt: now,
        createdAt: now,
        updatedAt: now
      };

      config.projects = placeProjectAfterPinned(config.projects, project);
      config.recentProjectIds = [project.id, ...config.recentProjectIds.filter((id) => id !== project.id)].slice(0, 20);
      await this.writeUnlocked(config);
      return project;
    });
  }

  async reorderProjects(projectIds: string[]): Promise<void> {
    await this.enqueue(async () => {
      const config = await this.readUnlocked();
      const projectById = new Map(config.projects.map((project) => [project.id, project]));
      const orderedProjects = projectIds
        .map((projectId) => projectById.get(projectId))
        .filter((project): project is GitProject => Boolean(project));
      const orderedIds = new Set(orderedProjects.map((project) => project.id));
      const remainingProjects = config.projects.filter((project) => !orderedIds.has(project.id));

      config.projects = orderProjectsWithPinnedFirst([...orderedProjects, ...remainingProjects]);
      await this.writeUnlocked(config);
    });
  }

  async setProjectFavorite(projectId: string, favorite: boolean): Promise<GitProject | undefined> {
    return this.enqueue(async () => {
      const config = await this.readUnlocked();
      const projectIndex = config.projects.findIndex((project) => project.id === projectId);
      if (projectIndex < 0) {
        return undefined;
      }

      const updatedProject: GitProject = {
        ...config.projects[projectIndex],
        favorite,
        updatedAt: new Date().toISOString()
      };
      const remainingProjects = config.projects.filter((project) => project.id !== projectId);
      config.projects = favorite ? [updatedProject, ...remainingProjects] : placeProjectAfterPinned(remainingProjects, updatedProject);

      await this.writeUnlocked(config);
      return updatedProject;
    });
  }

  async removeProject(projectId: string): Promise<void> {
    await this.enqueue(async () => {
      const config = await this.readUnlocked();
      config.projects = config.projects.filter((project) => project.id !== projectId);
      config.recentProjectIds = config.recentProjectIds.filter((id) => id !== projectId);
      await this.writeUnlocked(config);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readUnlocked(): Promise<AppConfig> {
    let raw: string;
    try {
      raw = await readFile(this.configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`无法读取项目配置，原文件已保留：${error instanceof Error ? error.message : String(error)}`);
      }

      const backup = await this.readBackup();
      if (backup) {
        await this.replaceConfigFile(backup, false);
        return backup;
      }

      const config = cloneDefaultConfig();
      await this.writeUnlocked(config);
      return config;
    }

    try {
      return parseConfig(raw);
    } catch (error) {
      const backup = await this.readBackup();
      if (!backup) {
        throw new Error(`无法读取项目配置，原文件已保留：${error instanceof Error ? error.message : String(error)}`);
      }

      const corruptPath = path.join(
        path.dirname(this.configPath),
        `config.corrupt.${new Date().toISOString().replace(/[:.]/g, "-")}.${randomUUID()}.json`
      );
      await copyFile(this.configPath, corruptPath);
      await this.replaceConfigFile(backup, false);
      return backup;
    }
  }

  private async readBackup(): Promise<AppConfig | null> {
    try {
      return parseConfig(await readFile(this.backupPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new Error(`无法恢复项目配置备份，现有文件均未覆盖：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async writeUnlocked(config: AppConfig): Promise<void> {
    await this.replaceConfigFile(config, true);
  }

  private async replaceConfigFile(config: AppConfig, backupCurrent: boolean): Promise<void> {
    const directory = path.dirname(this.configPath);
    const temporaryPath = path.join(directory, `config.${process.pid}.${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(config, null, 2), "utf8");
    try {
      if (backupCurrent) {
        try {
          await copyFile(this.configPath, this.backupPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }
      await rename(temporaryPath, this.configPath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

}

function parseConfig(raw: string): AppConfig {
  const parsed = JSON.parse(raw) as Partial<AppConfig>;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.projects)) {
    throw new Error("config.json 缺少有效的 projects 列表");
  }

  const projects = orderProjectsWithPinnedFirst(parsed.projects.map((project) => ({ ...project, favorite: Boolean(project.favorite) })));
  return {
    ...defaultConfig,
    ...parsed,
    projects,
    groups: Array.isArray(parsed.groups) ? parsed.groups : defaultConfig.groups.map((group) => ({ ...group })),
    recentProjectIds: Array.isArray(parsed.recentProjectIds) ? parsed.recentProjectIds : [],
    ui: { ...defaultConfig.ui, ...parsed.ui }
  };
}

function cloneDefaultConfig(): AppConfig {
  return {
    ...defaultConfig,
    projects: [],
    groups: defaultConfig.groups.map((group) => ({ ...group })),
    recentProjectIds: [],
    ui: { ...defaultConfig.ui }
  };
}

function normalizeRemotePath(repositoryPath: string): string {
  const normalized = path.posix.normalize(repositoryPath.trim().replace(/\\/g, "/"));
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

function remoteProjectKey(remote: SshConnection, repositoryPath: string): string {
  return [
    remote.host.trim().toLowerCase(),
    remote.username?.trim() ?? "",
    remote.port ?? 22,
    normalizeRemotePath(repositoryPath)
  ].join("\u0000");
}

function placeProjectAfterPinned(projects: GitProject[], project: GitProject): GitProject[] {
  const firstUnpinnedIndex = projects.findIndex((item) => !item.favorite);
  if (firstUnpinnedIndex < 0) {
    return [...projects, project];
  }

  return [...projects.slice(0, firstUnpinnedIndex), project, ...projects.slice(firstUnpinnedIndex)];
}

function orderProjectsWithPinnedFirst(projects: GitProject[]): GitProject[] {
  const pinnedProjects = projects.filter((project) => project.favorite);
  const regularProjects = projects.filter((project) => !project.favorite);
  return [...pinnedProjects, ...regularProjects];
}
