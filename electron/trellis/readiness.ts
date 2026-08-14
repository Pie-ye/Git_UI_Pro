import type { TrellisArtifacts, TrellisReadiness } from "./models";

export function computeReadiness(input: {
  hasTaskJson: boolean;
  artifacts: TrellisArtifacts;
  parseError?: string;
}): TrellisReadiness {
  const flags: string[] = [];
  if (input.parseError) {
    flags.push("task_json_error");
  }
  if (!input.hasTaskJson) {
    flags.push("missing_task_json");
    return { level: "missing_required", flags };
  }
  if (!input.artifacts.prd) {
    flags.push("missing_prd");
  }
  if (!input.artifacts.design) {
    flags.push("no_design");
  }
  if (!input.artifacts.implement) {
    flags.push("no_implement");
  }
  if (flags.includes("missing_prd") || input.parseError) {
    return { level: "partial", flags };
  }
  return { level: "ok", flags };
}
