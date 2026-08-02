import { safeStorage } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type HostingProvider = "github" | "gitlab" | "gitee";
export type HostingChangeState = "open" | "closed" | "merged";
export type HostingReviewEvent = "approve" | "request-changes";
export type HostingMergeMethod = "merge" | "squash" | "rebase";
export type HostingMergeReadiness = "allowed" | "blocked" | "unknown";

export interface HostingAccountSummary {
  provider: HostingProvider;
  host: string;
  login: string;
  configured: true;
  updatedAt: string;
}

export interface HostingChangeRequest {
  id: number;
  number: number;
  title: string;
  state: HostingChangeState;
  draft: boolean;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  webUrl: string;
  createdAt: string;
  updatedAt: string;
  mergeReadiness: HostingMergeReadiness;
  mergeStatus?: string;
  reviewStatus?: string;
}

export interface HostingCreateChangeInput {
  title: string;
  body?: string;
  sourceBranch: string;
  targetBranch: string;
  sourceRemoteUrl?: string;
  draft?: boolean;
}

export interface HostingReviewInput {
  number: number;
  headSha: string;
  event: HostingReviewEvent;
  body?: string;
}

export interface HostingMergeInput {
  number: number;
  headSha: string;
  method: HostingMergeMethod;
}

const HOSTING_CAPABILITIES: Readonly<Record<HostingProvider, {
  draft: boolean;
  reviewEvents: readonly HostingReviewEvent[];
  mergeMethods: readonly HostingMergeMethod[];
}>> = {
  github: { draft: true, reviewEvents: ["approve", "request-changes"], mergeMethods: ["squash", "merge", "rebase"] },
  gitlab: { draft: true, reviewEvents: ["approve", "request-changes"], mergeMethods: ["squash", "merge"] },
  gitee: { draft: true, reviewEvents: ["approve"], mergeMethods: ["squash", "merge", "rebase"] }
};

const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;

interface StoredHostingAccount extends HostingAccountSummary {
  encryptedToken: string;
}

interface HostingStoreDocument {
  version: 1;
  accounts: StoredHostingAccount[];
}

interface HostingRepositoryTarget {
  provider: HostingProvider;
  host: string;
  origin: string;
  ownerPath: string;
  repositoryName: string;
}

export class HostingService {
  private readonly storePath: string;
  private store: HostingStoreDocument | null = null;

  constructor(userDataPath: string) {
    this.storePath = path.join(userDataPath, "hosting-accounts.secure.json");
  }

  async listAccounts(): Promise<HostingAccountSummary[]> {
    const store = await this.loadStore();
    return store.accounts.map(publicAccount);
  }

  async saveAccount(provider: HostingProvider, remoteUrl: string, tokenValue: string): Promise<HostingAccountSummary> {
    const token = tokenValue.trim();
    if (!token) {
      throw new Error("访问令牌不能为空。");
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("当前系统无法提供凭据加密，已拒绝保存访问令牌。");
    }

    const target = parseHostingRemote(provider, remoteUrl);
    const login = await this.validateAccount(target, token);
    const now = new Date().toISOString();
    const account: StoredHostingAccount = {
      provider,
      host: target.host,
      login,
      configured: true,
      updatedAt: now,
      encryptedToken: safeStorage.encryptString(token).toString("base64")
    };
    const store = await this.loadStore();
    store.accounts = [...store.accounts.filter((item) => accountKey(item.provider, item.host) !== accountKey(provider, target.host)), account];
    await this.persistStore(store);
    return publicAccount(account);
  }

  async removeAccount(provider: HostingProvider, hostValue: string): Promise<boolean> {
    const host = requireHost(hostValue);
    const store = await this.loadStore();
    const next = store.accounts.filter((item) => accountKey(item.provider, item.host) !== accountKey(provider, host));
    if (next.length === store.accounts.length) {
      return false;
    }
    store.accounts = next;
    await this.persistStore(store);
    return true;
  }

  async listChangeRequests(provider: HostingProvider, remoteUrl: string): Promise<HostingChangeRequest[]> {
    const target = parseHostingRemote(provider, remoteUrl);
    const token = await this.requireToken(target);
    if (provider === "github") {
      const rows = await this.requestAllPages<any>(target, token, `/repos/${encodeRepoPath(target)}/pulls?state=all&sort=updated&direction=desc`);
      return rows.map(mapGitHubChange);
    }
    if (provider === "gitlab") {
      const rows = await this.requestAllPages<any>(target, token, `/projects/${encodeURIComponent(repoPath(target))}/merge_requests?scope=all&state=all&order_by=updated_at&sort=desc`);
      return rows.map(mapGitLabChange);
    }
    const rows = await this.requestAllPages<any>(target, token, `/repos/${encodeRepoPath(target)}/pulls?state=all&sort=updated&direction=desc`);
    return rows.map(mapGiteeChange);
  }

  async getChangeRequest(provider: HostingProvider, remoteUrl: string, number: number): Promise<HostingChangeRequest> {
    const target = parseHostingRemote(provider, remoteUrl);
    const token = await this.requireToken(target);
    return this.getChangeRequestWithToken(target, token, number);
  }

  async createChangeRequest(
    provider: HostingProvider,
    remoteUrl: string,
    input: HostingCreateChangeInput
  ): Promise<HostingChangeRequest> {
    const title = input.title.trim();
    const sourceBranch = requireBranch(input.sourceBranch, "源分支");
    const targetBranch = requireBranch(input.targetBranch, "目标分支");
    if (!title) {
      throw new Error("标题不能为空。");
    }
    if (input.draft && !HOSTING_CAPABILITIES[provider].draft) {
      throw new Error(`${providerLabel(provider)} 不支持创建草稿合并请求。`);
    }
    const target = parseHostingRemote(provider, remoteUrl);
    const sourceTarget = input.sourceRemoteUrl ? parseHostingRemote(provider, input.sourceRemoteUrl) : target;
    if (sourceTarget.host !== target.host) {
      throw new Error("源仓库与目标仓库不在同一托管平台主机，无法创建跨主机合并请求。");
    }
    const crossRepository = repoPath(sourceTarget) !== repoPath(target);
    const token = await this.requireToken(target);
    if (provider === "github") {
      const row = await this.requestJson<any>(target, token, "POST", `/repos/${encodeRepoPath(target)}/pulls`, {
        title: input.draft && !title.toLocaleLowerCase().startsWith("draft:") ? `Draft: ${title}` : title,
        body: input.body?.trim() || undefined,
        head: crossRepository ? `${sourceTarget.ownerPath}:${sourceBranch}` : sourceBranch,
        base: targetBranch,
        draft: input.draft === true
      });
      return mapGitHubChange(row);
    }
    if (provider === "gitlab") {
      let sourceProjectId: number | undefined;
      if (crossRepository) {
        const sourceProject = await this.requestJson<any>(
          target,
          token,
          "GET",
          `/projects/${encodeURIComponent(repoPath(sourceTarget))}`
        );
        sourceProjectId = Number(sourceProject?.id);
        if (!Number.isInteger(sourceProjectId) || sourceProjectId < 1) {
          throw new Error("GitLab 没有返回有效的源项目编号，已取消创建合并请求。");
        }
      }
      const row = await this.requestJson<any>(target, token, "POST", `/projects/${encodeURIComponent(repoPath(target))}/merge_requests`, {
        title: input.draft && !title.toLocaleLowerCase().startsWith("draft:") ? `Draft: ${title}` : title,
        description: input.body?.trim() || undefined,
        source_branch: sourceBranch,
        target_branch: targetBranch,
        source_project_id: sourceProjectId
      });
      return mapGitLabChange(row);
    }
    const row = await this.requestJson<any>(target, token, "POST", `/repos/${encodeRepoPath(target)}/pulls`, {
      title,
      body: input.body?.trim() || undefined,
      head: crossRepository ? `${sourceTarget.ownerPath}:${sourceBranch}` : sourceBranch,
      base: targetBranch,
      draft: input.draft === true
    });
    return mapGiteeChange(row);
  }

  async addComment(provider: HostingProvider, remoteUrl: string, number: number, bodyValue: string): Promise<void> {
    const body = bodyValue.trim();
    if (!body) {
      throw new Error("评论内容不能为空。");
    }
    const target = parseHostingRemote(provider, remoteUrl);
    const token = await this.requireToken(target);
    if (provider === "github") {
      await this.requestJson(target, token, "POST", `/repos/${encodeRepoPath(target)}/issues/${requireNumber(number)}/comments`, { body });
    } else if (provider === "gitlab") {
      await this.requestJson(target, token, "POST", `/projects/${encodeURIComponent(repoPath(target))}/merge_requests/${requireNumber(number)}/notes`, { body });
    } else {
      await this.requestJson(target, token, "POST", `/repos/${encodeRepoPath(target)}/pulls/${requireNumber(number)}/comments`, { body });
    }
  }

  async reviewChangeRequest(
    provider: HostingProvider,
    remoteUrl: string,
    input: HostingReviewInput
  ): Promise<void> {
    const target = parseHostingRemote(provider, remoteUrl);
    const token = await this.requireToken(target);
    const number = requireNumber(input.number);
    const headSha = requireSha(input.headSha);
    const body = input.body?.trim() || undefined;
    if (!HOSTING_CAPABILITIES[provider].reviewEvents.includes(input.event)) {
      throw new Error(`${providerLabel(provider)} 不支持“${reviewEventLabel(input.event)}”审核操作。`);
    }
    if (input.event === "request-changes" && !body) {
      throw new Error("请求修改必须填写说明。");
    }
    if (provider === "github") {
      const githubEvent = input.event === "approve" ? "APPROVE" : "REQUEST_CHANGES";
      await this.requestJson(target, token, "POST", `/repos/${encodeRepoPath(target)}/pulls/${number}/reviews`, {
        event: githubEvent,
        body,
        commit_id: headSha
      });
      return;
    }
    if (provider === "gitlab") {
      if (input.event === "request-changes") {
        const latest = await this.getChangeRequestWithToken(target, token, number);
        requireMatchingHeadSha(latest, headSha);
        await this.requestJson(target, token, "POST", `/projects/${encodeURIComponent(repoPath(target))}/merge_requests/${number}/draft_notes/bulk_publish`, {
          note: body,
          reviewer_state: "requested_changes"
        });
      } else {
        await this.requestJson(target, token, "POST", `/projects/${encodeURIComponent(repoPath(target))}/merge_requests/${number}/approve`, { sha: headSha });
      }
      return;
    }
    const latest = await this.getChangeRequestWithToken(target, token, number);
    requireMatchingHeadSha(latest, headSha);
    if (input.event === "approve") {
      await this.requestJson(target, token, "POST", `/repos/${encodeRepoPath(target)}/pulls/${number}/review`, { force: false });
      return;
    }
    throw new Error("Gitee 不支持请求修改审核状态。");
  }

  async mergeChangeRequest(
    provider: HostingProvider,
    remoteUrl: string,
    input: HostingMergeInput
  ): Promise<void> {
    const target = parseHostingRemote(provider, remoteUrl);
    const token = await this.requireToken(target);
    const number = requireNumber(input.number);
    const headSha = requireSha(input.headSha);
    if (!HOSTING_CAPABILITIES[provider].mergeMethods.includes(input.method)) {
      throw new Error(`${providerLabel(provider)} 不支持“${mergeMethodLabel(input.method)}”合并方式。`);
    }
    const latest = await this.getChangeRequestWithToken(target, token, number);
    requireMatchingHeadSha(latest, headSha);
    if (latest.state !== "open") {
      throw new Error(`该合并请求当前状态为“${latest.state}”，不能执行合并。`);
    }
    if (latest.draft) {
      throw new Error("草稿合并请求不能执行合并，请先在平台上标记为可评审。");
    }
    if (latest.mergeReadiness !== "allowed") {
      const reason = latest.mergeStatus ? `：${latest.mergeStatus}` : "";
      throw new Error(latest.mergeReadiness === "unknown" ? `平台尚未确认该合并请求可以合并${reason}` : `平台已阻止该合并请求合并${reason}`);
    }
    if (provider === "github") {
      const result = await this.requestJson<any>(target, token, "PUT", `/repos/${encodeRepoPath(target)}/pulls/${number}/merge`, {
        merge_method: input.method,
        sha: headSha
      });
      if (result?.merged !== true) {
        throw new Error(`GitHub 未完成合并：${String(result?.message ?? "平台未返回已合并状态")}`);
      }
    } else if (provider === "gitlab") {
      const result = await this.requestJson<any>(target, token, "PUT", `/projects/${encodeURIComponent(repoPath(target))}/merge_requests/${number}/merge`, {
        squash: input.method === "squash",
        should_remove_source_branch: false,
        sha: headSha
      });
      if (result?.state !== "merged" && !result?.merged_at) {
        throw new Error("GitLab 未返回已合并状态。");
      }
    } else {
      await this.requestJson(target, token, "PUT", `/repos/${encodeRepoPath(target)}/pulls/${number}/merge`, { merge_method: input.method });
    }
  }

  private async getChangeRequestWithToken(
    target: HostingRepositoryTarget,
    token: string,
    numberValue: number
  ): Promise<HostingChangeRequest> {
    const number = requireNumber(numberValue);
    if (target.provider === "github") {
      const row = await this.requestJson<any>(target, token, "GET", `/repos/${encodeRepoPath(target)}/pulls/${number}`);
      return mapGitHubChange(row);
    }
    if (target.provider === "gitlab") {
      const row = await this.requestJson<any>(target, token, "GET", `/projects/${encodeURIComponent(repoPath(target))}/merge_requests/${number}`);
      return mapGitLabChange(row);
    }
    const row = await this.requestJson<any>(target, token, "GET", `/repos/${encodeRepoPath(target)}/pulls/${number}`);
    return mapGiteeChange(row);
  }

  private async requestAllPages<T>(
    target: HostingRepositoryTarget,
    token: string,
    apiPath: string
  ): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = apiPath.includes("?") ? "&" : "?";
      const batch = await this.requestJson<T[]>(target, token, "GET", `${apiPath}${separator}per_page=${PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(batch)) {
        throw new Error(`${target.host} 的分页响应不是列表。`);
      }
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) {
        return rows;
      }
    }
    throw new Error(`${target.host} 的合并请求超过 ${MAX_PAGES * PAGE_SIZE} 条，已停止加载以避免无限分页。`);
  }

  private async validateAccount(target: HostingRepositoryTarget, token: string): Promise<string> {
    const user = await this.requestJson<any>(target, token, "GET", "/user");
    const login = String(user.login ?? user.username ?? user.name ?? "").trim();
    if (!login) {
      throw new Error("平台没有返回可识别的账号名称。");
    }
    return login;
  }

  private async requireToken(target: HostingRepositoryTarget): Promise<string> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("当前系统无法解密平台凭据。");
    }
    const store = await this.loadStore();
    const account = store.accounts.find((item) => accountKey(item.provider, item.host) === accountKey(target.provider, target.host));
    if (!account) {
      throw new Error(`尚未连接 ${target.host} 账号。`);
    }
    try {
      return safeStorage.decryptString(Buffer.from(account.encryptedToken, "base64"));
    } catch {
      throw new Error(`${target.host} 的访问令牌无法解密，请重新连接账号。`);
    }
  }

  private async requestJson<T>(
    target: HostingRepositoryTarget,
    token: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    apiPath: string,
    body?: unknown
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const requestUrl = new URL(`${apiOrigin(target)}${apiPath}`);
      let requestBody = body;
      if (target.provider === "gitee") {
        if (method === "GET" || method === "DELETE") {
          requestUrl.searchParams.set("access_token", token);
        } else if (body && typeof body === "object" && !Array.isArray(body)) {
          requestBody = { ...(body as Record<string, unknown>), access_token: token };
        }
      }
      const response = await fetch(requestUrl, {
        method,
        signal: controller.signal,
        redirect: "error",
        headers: requestHeaders(target.provider, token, requestBody !== undefined),
        body: requestBody === undefined ? undefined : JSON.stringify(requestBody)
      });
      const text = await response.text();
      const payload = text ? parseJson(text) : undefined;
      if (!response.ok) {
        const message = apiErrorMessage(payload) || response.statusText || `HTTP ${response.status}`;
        throw new Error(`${target.provider} 请求失败（${response.status}）：${message}`);
      }
      return payload as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`${target.host} 请求超时。`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async loadStore(): Promise<HostingStoreDocument> {
    if (this.store) {
      return this.store;
    }
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as Partial<HostingStoreDocument>;
      this.store = {
        version: 1,
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts.filter(isStoredAccount) : []
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.store = { version: 1, accounts: [] };
    }
    return this.store;
  }

  private async persistStore(store: HostingStoreDocument): Promise<void> {
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const temporaryPath = `${this.storePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.storePath);
    this.store = store;
  }
}

export function parseHostingRemote(provider: HostingProvider, remoteValue: string): HostingRepositoryTarget {
  const remote = remoteValue.trim();
  if (!remote || remote.startsWith("-")) {
    throw new Error("远程仓库地址不合法。");
  }
  let host = "";
  let origin = "";
  let repositoryPath = "";
  const scpMatch = remote.match(/^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/);
  if (scpMatch && !remote.includes("://")) {
    host = requireHost(scpMatch[1]);
    origin = `https://${host}`;
    repositoryPath = scpMatch[2];
  } else {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      throw new Error("无法解析远程仓库地址。");
    }
    if (!(["https:", "ssh:"] as string[]).includes(url.protocol)) {
      throw new Error("托管平台只支持 HTTPS 或 SSH 远程地址。");
    }
    host = requireHost(url.protocol === "ssh:" ? url.hostname : url.host);
    origin = url.protocol === "ssh:" ? `https://${url.hostname}` : url.origin;
    repositoryPath = url.pathname;
  }
  requireMatchingPublicProvider(provider, host);
  const segments = repositoryPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error("远程地址缺少仓库所有者或仓库名。");
  }
  if (provider !== "gitlab" && segments.length !== 2) {
    throw new Error(`${providerLabel(provider)} 远程地址必须是“所有者/仓库”结构。`);
  }
  const repositoryName = segments.pop()!;
  const ownerPath = segments.join("/");
  return { provider, host, origin, ownerPath, repositoryName };
}

function apiOrigin(target: HostingRepositoryTarget): string {
  if (target.provider === "github") {
    return target.host.toLocaleLowerCase() === "github.com" ? "https://api.github.com" : `${target.origin}/api/v3`;
  }
  if (target.provider === "gitee") {
    return `${target.origin}/api/v5`;
  }
  return `${target.origin}/api/v4`;
}

function requestHeaders(provider: HostingProvider, token: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "Git-UI-Pro"
  };
  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }
  if (provider === "gitlab") {
    headers["PRIVATE-TOKEN"] = token;
  } else if (provider === "github") {
    headers.Authorization = `Bearer ${token}`;
    headers.Accept = "application/vnd.github+json";
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  }
  return headers;
}

function repoPath(target: HostingRepositoryTarget): string {
  return `${target.ownerPath}/${target.repositoryName}`;
}

function encodeRepoPath(target: HostingRepositoryTarget): string {
  return repoPath(target).split("/").map(encodeURIComponent).join("/");
}

function requireHost(value: string): string {
  const host = value.trim().toLocaleLowerCase();
  if (!host || /[\s\0\r\n/@]/.test(host)) {
    throw new Error("托管平台主机名不合法。");
  }
  return host;
}

function requireMatchingPublicProvider(provider: HostingProvider, host: string): void {
  let hostname = host;
  try {
    hostname = new URL(`https://${host}`).hostname;
  } catch {
    throw new Error("托管平台主机名不合法。");
  }
  const normalized = hostname.replace(/^\[|\]$/g, "").toLocaleLowerCase();
  const expected = normalized === "github.com"
    ? "github"
    : normalized === "gitlab.com"
      ? "gitlab"
      : normalized === "gitee.com"
        ? "gitee"
        : undefined;
  if (expected && expected !== provider) {
    throw new Error(`远程地址属于 ${providerLabel(expected)}，不能使用 ${providerLabel(provider)} 账号访问。`);
  }
}

function requireBranch(value: string, label: string): string {
  const branch = value.trim();
  if (!branch || branch.startsWith("-") || /[\0\r\n]/.test(branch)) {
    throw new Error(`${label}不合法。`);
  }
  return branch;
}

function requireNumber(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("PR/MR 编号不合法。");
  }
  return value;
}

function requireSha(value: string): string {
  const sha = value.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
    throw new Error("合并请求的头提交 SHA 无效，请重新检查平台状态。");
  }
  return sha;
}

function requireMatchingHeadSha(change: HostingChangeRequest, expectedSha: string): void {
  if (!change.headSha) {
    throw new Error("平台没有返回当前头提交 SHA，已拒绝继续修改远端状态。");
  }
  if (change.headSha.toLocaleLowerCase() !== expectedSha.toLocaleLowerCase()) {
    throw new Error(`合并请求已有新提交（当前 ${change.headSha.slice(0, 8)}），请重新检查后再操作。`);
  }
}

function providerLabel(provider: HostingProvider): string {
  if (provider === "github") return "GitHub";
  if (provider === "gitlab") return "GitLab";
  return "Gitee";
}

function reviewEventLabel(event: HostingReviewEvent): string {
  return event === "approve" ? "批准" : "请求修改";
}

function mergeMethodLabel(method: HostingMergeMethod): string {
  if (method === "squash") return "压缩合并";
  if (method === "rebase") return "变基合并";
  return "创建合并提交";
}

function accountKey(provider: HostingProvider, host: string): string {
  return `${provider}:${host.toLocaleLowerCase()}`;
}

function publicAccount(account: StoredHostingAccount): HostingAccountSummary {
  const { provider, host, login, configured, updatedAt } = account;
  return { provider, host, login, configured, updatedAt };
}

function isStoredAccount(value: unknown): value is StoredHostingAccount {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<StoredHostingAccount>;
  return (item.provider === "github" || item.provider === "gitlab" || item.provider === "gitee") &&
    typeof item.host === "string" && typeof item.login === "string" && typeof item.encryptedToken === "string" && typeof item.updatedAt === "string";
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function apiErrorMessage(payload: any): string {
  if (!payload) {
    return "";
  }
  if (typeof payload.message === "string") {
    return payload.message;
  }
  if (typeof payload.error_description === "string") {
    return payload.error_description;
  }
  if (typeof payload.error === "string") {
    return payload.error;
  }
  return "";
}

function mapGitHubChange(row: any): HostingChangeRequest {
  const state: HostingChangeState = row.merged_at ? "merged" : row.state === "closed" ? "closed" : "open";
  const draft = row.draft === true;
  const mergeStatus = typeof row.mergeable_state === "string" ? row.mergeable_state : undefined;
  const mergeReadiness: HostingMergeReadiness = state !== "open" || draft
    ? "blocked"
    : row.mergeable === true && mergeStatus === "clean"
      ? "allowed"
      : row.mergeable === false || (mergeStatus !== undefined && mergeStatus !== "unknown" && mergeStatus !== "clean")
        ? "blocked"
        : "unknown";
  return {
    id: Number(row.id),
    number: Number(row.number),
    title: String(row.title ?? ""),
    state,
    draft,
    author: String(row.user?.login ?? ""),
    sourceBranch: String(row.head?.ref ?? ""),
    targetBranch: String(row.base?.ref ?? ""),
    headSha: String(row.head?.sha ?? ""),
    webUrl: String(row.html_url ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    mergeReadiness,
    mergeStatus,
    reviewStatus: row.requested_reviewers?.length ? `待 ${row.requested_reviewers.length} 人审核` : undefined
  };
}

function mapGitLabChange(row: any): HostingChangeRequest {
  const state: HostingChangeState = row.state === "merged" ? "merged" : row.state === "closed" ? "closed" : "open";
  const draft = row.draft === true || row.work_in_progress === true;
  const mergeStatus = String(row.detailed_merge_status ?? row.merge_status ?? "").trim() || undefined;
  const pendingStatuses = new Set(["unchecked", "checking", "preparing", "approvals_syncing"]);
  const mergeReadiness: HostingMergeReadiness = state !== "open" || draft
    ? "blocked"
    : mergeStatus === "mergeable"
      ? "allowed"
      : !mergeStatus || pendingStatuses.has(mergeStatus)
        ? "unknown"
        : "blocked";
  return {
    id: Number(row.id),
    number: Number(row.iid),
    title: String(row.title ?? ""),
    state,
    draft,
    author: String(row.author?.username ?? row.author?.name ?? ""),
    sourceBranch: String(row.source_branch ?? ""),
    targetBranch: String(row.target_branch ?? ""),
    headSha: String(row.sha ?? row.diff_refs?.head_sha ?? ""),
    webUrl: String(row.web_url ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    mergeReadiness,
    mergeStatus,
    reviewStatus: row.detailed_merge_status ? String(row.detailed_merge_status) : undefined
  };
}

function mapGiteeChange(row: any): HostingChangeRequest {
  const state: HostingChangeState = row.state === "merged" || row.merged === true ? "merged" : row.state === "closed" ? "closed" : "open";
  const draft = row.draft === true;
  const mergeStatus = typeof row.merge_status === "string" ? row.merge_status : undefined;
  const mergeReadiness: HostingMergeReadiness = state !== "open" || draft
    ? "blocked"
    : row.mergeable === true
      ? "allowed"
      : row.mergeable === false
        ? "blocked"
        : "unknown";
  return {
    id: Number(row.id),
    number: Number(row.number),
    title: String(row.title ?? ""),
    state,
    draft,
    author: String(row.user?.login ?? row.author?.login ?? ""),
    sourceBranch: String(row.head?.ref ?? ""),
    targetBranch: String(row.base?.ref ?? ""),
    headSha: String(row.head?.sha ?? ""),
    webUrl: String(row.html_url ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    mergeReadiness,
    mergeStatus
  };
}
