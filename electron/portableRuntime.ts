import type { App } from "electron";
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PORTABLE_DATA_DIRECTORY_NAME = "Git-UI-Pro-Data";
export const PORTABLE_FALLBACK_DIRECTORY_NAME = "Git UI Pro Portable";
export const PORTABLE_UPDATE_DIRECTORY_NAME = "updates";
export const PORTABLE_UPDATE_HEALTH_TOKEN_ENV = "GIT_UI_PRO_PORTABLE_UPDATE_TOKEN";
export const PORTABLE_UPDATE_HEALTH_MARKER_ENV = "GIT_UI_PRO_PORTABLE_UPDATE_MARKER";

export type PortableRuntime = Readonly<{
  isPortable: boolean;
  executablePath: string | null;
  dataPath: string | null;
  usedFallbackDataPath: boolean;
  warning?: string;
}>;

type PortableAppPaths = Pick<App, "getPath" | "setPath">;

export function resolvePortableExecutablePath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (platform !== "win32") {
    return null;
  }
  const executableFile = environment.PORTABLE_EXECUTABLE_FILE?.trim();
  const executableDirectory = environment.PORTABLE_EXECUTABLE_DIR?.trim();
  if (!executableFile || !path.win32.isAbsolute(executableFile)) {
    return null;
  }
  const resolvedFile = path.win32.resolve(executableFile);
  if (executableDirectory && path.win32.isAbsolute(executableDirectory)) {
    const resolvedDirectory = path.win32.resolve(executableDirectory);
    if (path.win32.dirname(resolvedFile).toLocaleLowerCase() !== resolvedDirectory.toLocaleLowerCase()) {
      return null;
    }
  }
  return resolvedFile;
}

export function resolvePortableDataPath(
  executablePath: string,
  configuredPath?: string
): string {
  const override = configuredPath?.trim();
  if (override) {
    if (!path.win32.isAbsolute(override)) {
      throw new Error("Portable 数据目录必须使用绝对路径。");
    }
    return path.win32.resolve(override);
  }
  return path.win32.join(path.win32.dirname(executablePath), PORTABLE_DATA_DIRECTORY_NAME);
}

export function initializePortableRuntime(
  electronApp: PortableAppPaths,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): PortableRuntime {
  const executablePath = resolvePortableExecutablePath(environment, platform);
  if (!executablePath) {
    return Object.freeze({
      isPortable: false,
      executablePath: null,
      dataPath: null,
      usedFallbackDataPath: false
    });
  }

  const preferredPath = resolvePortableDataPath(executablePath, environment.GIT_UI_PRO_PORTABLE_DATA_DIR);
  try {
    ensureWritableDirectory(preferredPath);
    electronApp.setPath("userData", preferredPath);
    return Object.freeze({
      isPortable: true,
      executablePath,
      dataPath: preferredPath,
      usedFallbackDataPath: false
    });
  } catch (preferredError) {
    const fallbackPath = path.join(electronApp.getPath("appData"), PORTABLE_FALLBACK_DIRECTORY_NAME);
    ensureWritableDirectory(fallbackPath);
    electronApp.setPath("userData", fallbackPath);
    const preferredMessage = preferredError instanceof Error ? preferredError.message : String(preferredError);
    return Object.freeze({
      isPortable: true,
      executablePath,
      dataPath: fallbackPath,
      usedFallbackDataPath: true,
      warning: `便携数据目录不可写，已改用独立的用户数据目录：${fallbackPath}\n\n原目录：${preferredPath}\n原因：${preferredMessage}`
    });
  }
}

export function completePortableUpdateHealthCheck(
  userDataPath: string,
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  const token = environment[PORTABLE_UPDATE_HEALTH_TOKEN_ENV]?.trim();
  const markerValue = environment[PORTABLE_UPDATE_HEALTH_MARKER_ENV]?.trim();
  if (!token || !/^[a-f\d]{32}$/i.test(token) || !markerValue || !path.win32.isAbsolute(markerValue)) {
    return false;
  }

  const updateDirectory = path.resolve(userDataPath, PORTABLE_UPDATE_DIRECTORY_NAME);
  const markerPath = path.resolve(markerValue);
  const expectedName = `portable-health-${token.toLowerCase()}.ok`;
  if (
    path.dirname(markerPath).toLocaleLowerCase() !== updateDirectory.toLocaleLowerCase() ||
    path.basename(markerPath).toLocaleLowerCase() !== expectedName
  ) {
    return false;
  }

  mkdirSync(updateDirectory, { recursive: true });
  writeFileSync(markerPath, `${token.toLowerCase()}\n`, { encoding: "utf8", mode: 0o600 });
  return true;
}

function ensureWritableDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true });
  const probePath = path.join(directory, `.git-ui-pro-write-test-${process.pid}-${Date.now()}`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(probePath, "wx", 0o600);
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
    try {
      unlinkSync(probePath);
    } catch {
      // A failed cleanup must not hide the original write result.
    }
  }
}
