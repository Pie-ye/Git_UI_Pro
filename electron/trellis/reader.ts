import { constants, type Dirent } from "node:fs";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { computeReadiness } from "./readiness";
import type {
  TrellisArtifacts,
  TrellisMarkdownDocument,
  TrellisSpecFile,
  TrellisSpecNode,
  TrellisTaskDetail,
  TrellisTaskSummary
} from "./models";

export const MAX_TRELLIS_FILE_BYTES = 2 * 1024 * 1024;
const MARKDOWN_DOCUMENTS = ["prd.md", "design.md", "implement.md"] as const;

export class TrellisReaderError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "TrellisReaderError";
    this.statusCode = statusCode;
  }
}

function tasksDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".trellis", "tasks");
}

function specDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".trellis", "spec");
}

export function resolveUnder(root: string, candidate: string): string {
  const rootResolved = path.resolve(root);
  const candidateResolved = path.resolve(candidate);
  const relative = path.relative(rootResolved, candidateResolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TrellisReaderError("Path escapes allowed directory", 400);
  }
  return candidateResolved;
}

async function resolveExistingUnder(root: string, candidate: string): Promise<string> {
  const lexicalCandidate = resolveUnder(root, candidate);
  try {
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(lexicalCandidate)]);
    return resolveUnder(realRoot, realCandidate);
  } catch (error) {
    if (error instanceof TrellisReaderError) {
      throw error;
    }
    return lexicalCandidate;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

export async function readTextLimited(target: string): Promise<{ content: string; truncated: boolean }> {
  let data = await readFile(target);
  const truncated = data.length > MAX_TRELLIS_FILE_BYTES;
  if (truncated) {
    data = data.subarray(0, MAX_TRELLIS_FILE_BYTES);
  }
  return { content: data.toString("utf8"), truncated };
}

async function artifactFlags(taskDir: string): Promise<TrellisArtifacts> {
  const [prd, design, implement, implementJsonl, checkJsonl] = await Promise.all([
    isFile(path.join(taskDir, "prd.md")),
    isFile(path.join(taskDir, "design.md")),
    isFile(path.join(taskDir, "implement.md")),
    isFile(path.join(taskDir, "implement.jsonl")),
    isFile(path.join(taskDir, "check.jsonl"))
  ]);
  return { prd, design, implement, implementJsonl, checkJsonl };
}

async function loadTaskJson(taskDir: string): Promise<{
  data?: Record<string, unknown>;
  error?: string;
  hasJson: boolean;
}> {
  const target = path.join(taskDir, "task.json");
  if (!(await isFile(target))) {
    return { hasJson: false };
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
    if (!isRecord(parsed)) {
      return { hasJson: true, error: "task.json root must be an object" };
    }
    return { hasJson: true, data: parsed };
  } catch (error) {
    return { hasJson: true, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function detectTrellisProject(projectRoot: string): Promise<boolean> {
  return isDirectory(path.join(path.resolve(projectRoot), ".trellis"));
}

export async function listActiveTasks(projectRoot: string): Promise<TrellisTaskSummary[]> {
  const root = path.resolve(projectRoot);
  const directory = tasksDir(root);
  if (!(await isDirectory(directory))) {
    return [];
  }
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== "archive")
    .sort((left, right) => left.name.localeCompare(right.name));
  return Promise.all(entries.map((entry) => summarizeTask(root, entry.name)));
}

export async function summarizeTask(projectRoot: string, dirName: string): Promise<TrellisTaskSummary> {
  const root = path.resolve(projectRoot);
  const directory = await resolveExistingUnder(tasksDir(root), path.join(tasksDir(root), dirName));
  if (!(await isDirectory(directory))) {
    throw new TrellisReaderError(`Task not found: ${dirName}`, 404);
  }

  const loaded = await loadTaskJson(directory);
  const artifacts = await artifactFlags(directory);
  const readiness = computeReadiness({
    hasTaskJson: loaded.hasJson,
    artifacts,
    parseError: loaded.error
  });
  const data = loaded.data ?? {};
  const childrenRaw = data.children ?? data.subtasks;

  return {
    dirName,
    id: stringValue(data, "id"),
    name: stringValue(data, "name"),
    title: stringValue(data, "title") ?? dirName,
    status: stringValue(data, "status"),
    priority: stringValue(data, "priority"),
    assignee: stringValue(data, "assignee"),
    package: stringValue(data, "package"),
    scope: stringValue(data, "scope"),
    parent: stringValue(data, "parent"),
    children: Array.isArray(childrenRaw) ? [...childrenRaw] : [],
    description: stringValue(data, "description"),
    notes: stringValue(data, "notes"),
    artifacts,
    readiness,
    error: loaded.error
  };
}

export async function getTaskDetail(projectRoot: string, dirName: string): Promise<TrellisTaskDetail> {
  const root = path.resolve(projectRoot);
  const summary = await summarizeTask(root, dirName);
  const directory = await resolveExistingUnder(tasksDir(root), path.join(tasksDir(root), dirName));
  const documents: Record<string, TrellisMarkdownDocument> = {};

  for (const fileName of MARKDOWN_DOCUMENTS) {
    const key = fileName.slice(0, -3);
    const target = path.join(directory, fileName);
    if (!(await isFile(target))) {
      documents[key] = { name: fileName, missing: true, truncated: false };
      continue;
    }
    const document = await readTextLimited(target);
    documents[key] = {
      name: fileName,
      missing: false,
      content: document.content,
      truncated: document.truncated
    };
  }

  const loaded = await loadTaskJson(directory);
  return {
    ...summary,
    documents,
    rawTaskJson: loaded.data
  };
}

async function walkSpec(directory: string, relativePath: string): Promise<TrellisSpecNode> {
  let entries: Dirent[] = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const sorted = entries
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      return left.name.toLocaleLowerCase().localeCompare(right.name.toLocaleLowerCase());
    });
  const children: TrellisSpecNode[] = [];

  for (const entry of sorted) {
    const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const childPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      children.push(await walkSpec(childPath, childRelative));
    } else if (entry.isFile()) {
      children.push({ name: entry.name, type: "file", relPath: childRelative });
    }
  }

  return {
    name: relativePath ? path.basename(directory) : "spec",
    type: "dir",
    relPath: relativePath,
    children
  };
}

export async function buildSpecTree(projectRoot: string): Promise<TrellisSpecNode | undefined> {
  const directory = specDir(projectRoot);
  if (!(await isDirectory(directory))) {
    return undefined;
  }
  return walkSpec(directory, "");
}

export async function readSpecFile(projectRoot: string, relativePath: string): Promise<TrellisSpecFile> {
  if (!relativePath.trim()) {
    throw new TrellisReaderError("path is required", 400);
  }
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/u.test(relativePath)) {
    throw new TrellisReaderError("Invalid path", 400);
  }
  const cleaned = relativePath.replace(/\\/gu, "/").replace(/^\/+/, "");
  if (cleaned.split("/").includes("..")) {
    throw new TrellisReaderError("Invalid path", 400);
  }

  const directory = specDir(projectRoot);
  if (!(await isDirectory(directory))) {
    throw new TrellisReaderError("No .trellis/spec directory", 404);
  }
  const target = await resolveExistingUnder(directory, path.join(directory, ...cleaned.split("/")));
  if (!(await isFile(target))) {
    throw new TrellisReaderError(`Spec file not found: ${cleaned}`, 404);
  }
  const document = await readTextLimited(target);
  return { relPath: cleaned, content: document.content, truncated: document.truncated };
}

export async function trellisPathExists(projectRoot: string, relativePath: string): Promise<boolean> {
  const trellisRoot = path.join(path.resolve(projectRoot), ".trellis");
  const target = resolveUnder(trellisRoot, path.join(trellisRoot, relativePath));
  return pathExists(target);
}
