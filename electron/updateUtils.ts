type ReleaseNoteEntry = {
  version: string;
  note: string | null;
};

export type ReleaseNotesInput = string | ReleaseNoteEntry[] | null | undefined;

const MAX_RELEASE_NOTES_LENGTH = 12_000;
const MAX_ERROR_LENGTH = 600;

export function normalizeReleaseNotes(notes: ReleaseNotesInput): string {
  const value = Array.isArray(notes)
    ? notes
        .map((entry) => [entry.version ? `v${entry.version.replace(/^v/i, "")}` : "", entry.note?.trim() ?? ""].filter(Boolean).join("\n"))
        .filter(Boolean)
        .join("\n\n")
    : notes?.trim() ?? "";

  return value.replace(/\r\n/g, "\n").slice(0, MAX_RELEASE_NOTES_LENGTH);
}

export function updateErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "检查更新失败");
  return message.trim().slice(0, MAX_ERROR_LENGTH) || "检查更新失败";
}

export function githubReleaseUrl(version: string): string {
  return `https://github.com/zjx150504-lgtm/Git_UI_Pro/releases/tag/v${version.replace(/^v/i, "")}`;
}
