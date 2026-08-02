import { spawn } from "node:child_process";
import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

export type SshHostTrustStatus = "trusted" | "unknown" | "changed";

export interface SshHostKeyFingerprint {
  algorithm: string;
  bits: number;
  fingerprint: string;
}

export interface SshHostInspection {
  host: string;
  port: number;
  lookup: string;
  status: SshHostTrustStatus;
  currentFingerprints: SshHostKeyFingerprint[];
  scannedFingerprints: SshHostKeyFingerprint[];
}

export interface ScannedSshHost extends SshHostInspection {
  keyLines: string[];
}

const sshTimeoutMs = 12_000;

export async function inspectSshHost(hostValue: string, portValue?: number): Promise<ScannedSshHost> {
  const requestedHost = requireSshHost(hostValue);
  const endpoint = await resolveSshEndpoint(requestedHost, portValue);
  const { host, port, lookup } = endpoint;
  const knownHostsPath = getKnownHostsPath();
  const currentLines = await findKnownHostLines(knownHostsPath, lookup);
  const scannedLines = (await scanHostKeyLines(host, port)).map((line) => replaceKnownHostName(line, lookup));
  const [currentFingerprints, scannedFingerprints] = await Promise.all([
    fingerprintKeyLines(currentLines),
    fingerprintKeyLines(scannedLines)
  ]);
  const currentKeyIds = new Set(currentLines.map(keyIdentity).filter(Boolean));
  const scannedKeyIds = new Set(scannedLines.map(keyIdentity).filter(Boolean));
  const trusted = [...scannedKeyIds].some((identity) => currentKeyIds.has(identity));

  return {
    host,
    port,
    lookup,
    status: trusted ? "trusted" : currentLines.length > 0 ? "changed" : "unknown",
    currentFingerprints,
    scannedFingerprints,
    keyLines: scannedLines
  };
}

async function resolveSshEndpoint(host: string, portValue?: number): Promise<{ host: string; port: number; lookup: string }> {
  const requestedPort = portValue === undefined ? undefined : requireSshPort(portValue);
  const result = await runProcess(
    "ssh",
    ["-G", ...(requestedPort === undefined ? [] : ["-p", String(requestedPort)]), "--", host],
    sshTimeoutMs,
    true
  );
  if (result.exitCode !== 0) {
    throw new Error(`无法解析 SSH 主机配置：${result.stderr.trim() || "ssh -G 执行失败"}`);
  }
  const config = new Map<string, string>();
  result.stdout.split(/\r?\n/).forEach((line) => {
    const separator = line.indexOf(" ");
    if (separator > 0) {
      const key = line.slice(0, separator).trim().toLocaleLowerCase();
      if (!config.has(key)) {
        config.set(key, line.slice(separator + 1).trim());
      }
    }
  });
  const resolvedHost = requireSshHost(config.get("hostname") || host);
  const port = requireSshPort(requestedPort ?? Number(config.get("port") || 22));
  const alias = config.get("hostkeyalias");
  const lookupHost = alias ? requireSshHost(alias) : resolvedHost;
  return {
    host: resolvedHost,
    port,
    lookup: port === 22 ? lookupHost : `[${lookupHost}]:${port}`
  };
}

export async function trustScannedSshHost(scan: ScannedSshHost, replaceExisting: boolean): Promise<void> {
  if (scan.status === "changed" && !replaceExisting) {
    throw new Error("检测到主机密钥变化，必须明确确认替换后才能继续。");
  }
  if (scan.keyLines.length === 0) {
    throw new Error("没有可写入的 SSH 主机密钥。");
  }

  const knownHostsPath = getKnownHostsPath();
  await mkdir(path.dirname(knownHostsPath), { recursive: true });
  if (replaceExisting) {
    await removeKnownHost(knownHostsPath, scan.lookup);
  }

  const existing = await readFile(knownHostsPath, "utf8").catch(() => "");
  const existingKeyIds = new Set(existing.split(/\r?\n/).map(keyIdentity).filter(Boolean));
  const nextLines = scan.keyLines.filter((line) => {
    const identity = keyIdentity(line);
    return identity !== "" && !existingKeyIds.has(identity);
  });
  if (nextLines.length === 0) {
    return;
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await appendFile(knownHostsPath, `${prefix}${nextLines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

function getKnownHostsPath(): string {
  return path.join(os.homedir(), ".ssh", "known_hosts");
}

function requireSshHost(value: string): string {
  const host = value.trim();
  if (!host || /[\s\0\r\n]/.test(host) || host.startsWith("-")) {
    throw new Error("SSH 主机地址不合法。");
  }
  return host;
}

function requireSshPort(value?: number): number {
  const port = value ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SSH 端口必须是 1 到 65535 之间的整数。");
  }
  return port;
}

async function scanHostKeyLines(host: string, port: number): Promise<string[]> {
  const result = await runProcess("ssh-keyscan", ["-T", "8", "-p", String(port), "--", host], sshTimeoutMs);
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && keyIdentity(line) !== "");
  if (lines.length === 0) {
    const detail = result.stderr.trim();
    throw new Error(detail ? `无法读取 SSH 主机密钥：${detail}` : "无法读取 SSH 主机密钥，请检查地址、端口和网络连接。");
  }
  return [...new Set(lines)];
}

async function findKnownHostLines(filePath: string, lookup: string): Promise<string[]> {
  try {
    await access(filePath, fsConstants.R_OK);
  } catch {
    return [];
  }
  const result = await runProcess("ssh-keygen", ["-F", lookup, "-f", filePath], sshTimeoutMs, true);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && keyIdentity(line) !== "");
}

async function removeKnownHost(filePath: string, lookup: string): Promise<void> {
  try {
    await access(filePath, fsConstants.F_OK);
  } catch {
    return;
  }
  const result = await runProcess("ssh-keygen", ["-R", lookup, "-f", filePath], sshTimeoutMs, true);
  if (result.exitCode !== 0 && result.stderr.trim()) {
    throw new Error(`无法替换旧的 SSH 主机密钥：${result.stderr.trim()}`);
  }
}

async function fingerprintKeyLines(lines: string[]): Promise<SshHostKeyFingerprint[]> {
  const fingerprints = await Promise.all(lines.map(async (line) => {
    const result = await runProcess("ssh-keygen", ["-lf", "-", "-E", "sha256"], sshTimeoutMs, false, `${line}\n`);
    if (result.exitCode !== 0) {
      throw new Error(`无法计算 SSH 主机指纹：${result.stderr.trim() || "ssh-keygen 执行失败"}`);
    }
    const match = result.stdout.trim().match(/^(\d+)\s+(SHA256:[^\s]+).*\(([^)]+)\)$/);
    if (!match) {
      throw new Error("ssh-keygen 返回了无法识别的主机指纹。");
    }
    return {
      bits: Number(match[1]),
      fingerprint: match[2],
      algorithm: match[3]
    };
  }));
  const unique = new Map(fingerprints.map((item) => [`${item.algorithm}:${item.fingerprint}`, item]));
  return [...unique.values()];
}

function keyIdentity(line: string): string {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3) {
    return "";
  }
  return `${parts[1]} ${parts[2]}`;
}

function replaceKnownHostName(line: string, lookup: string): string {
  const separator = line.search(/\s/);
  return separator < 0 ? line : `${lookup}${line.slice(separator)}`;
}

function runProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
  allowFailure = false,
  stdin?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`${executable} 执行超时。`)));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? -1
      };
      if (!allowFailure && result.exitCode !== 0) {
        reject(new Error(result.stderr.trim() || `${executable} 执行失败。`));
      } else {
        resolve(result);
      }
    }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}
