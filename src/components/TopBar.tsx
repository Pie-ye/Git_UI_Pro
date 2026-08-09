import { GitBranch, Server, Settings2 } from "lucide-react";
import { PathTooltip } from "./PathTooltip";
import type { GitProject } from "../types/domain";

export type ThemeMode = "system" | "light" | "dark";

interface TopBarProps {
  project?: GitProject;
  gitVersion: string;
  gitReady?: boolean;
  onOpenRepositoryCenter?: () => void;
}

export function TopBar({
  project,
  gitVersion,
  gitReady = true,
  onOpenRepositoryCenter
}: TopBarProps) {
  const gitVersionLabel = gitVersion.replace(/^git version\s*/i, "").trim() || gitVersion;
  const remoteDestination = project?.remote
    ? `${project.remote.username ? `${project.remote.username}@` : ""}${project.remote.host}${project.remote.port ? `:${project.remote.port}` : ""}`
    : undefined;

  return (
    <header className="top-bar">
      <div className="project-heading">
        <div className="project-title-row">
          <strong>{project?.name ?? "未选择项目"}</strong>
          {project?.status?.currentBranch ? <span className="project-branch-dot">{project.status.currentBranch}</span> : null}
        </div>
      </div>

      <div className="layout-controls" aria-label="布局控制">
        {onOpenRepositoryCenter ? (
          <PathTooltip content="仓库中心" className="control-tooltip" showOnFocus={false}>
            <button type="button" className="icon-button top-bar-repository-button" aria-label="打开仓库中心" onClick={onOpenRepositoryCenter}>
              <Settings2 size={16} />
            </button>
          </PathTooltip>
        ) : null}
        <PathTooltip content={remoteDestination ? `${remoteDestination}:${project?.path}` : gitVersion} className="git-version-tooltip">
          <span className={`git-version-badge ${gitReady ? "" : "warning"}`} aria-label={remoteDestination ?? gitVersion}>
            {remoteDestination ? <Server size={13} /> : <GitBranch size={13} />}
            <span>{remoteDestination ?? gitVersionLabel}</span>
          </span>
        </PathTooltip>
      </div>
    </header>
  );
}
