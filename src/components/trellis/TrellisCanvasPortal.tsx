import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GitProject } from "../../types/domain";
import { TrellisWorkspace } from "./TrellisWorkspace";

const EDITOR_EMPTY_SELECTOR = ".editor-detail-panel.empty";
const ACTIVE_PROJECT_SELECTOR = ".project-rail-item.active";

export function TrellisCanvasPortal() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [project, setProject] = useState<GitProject>();
  const syncFrameRef = useRef<number>();
  const projectRequestRef = useRef(0);

  useEffect(() => {
    let disposed = false;

    const sync = () => {
      if (syncFrameRef.current !== undefined) return;
      syncFrameRef.current = window.requestAnimationFrame(() => {
        syncFrameRef.current = undefined;
        if (disposed) return;

        const nextTarget = document.querySelector<HTMLElement>(EDITOR_EMPTY_SELECTOR);
        setTarget((current) => (current === nextTarget ? current : nextTarget));

        if (!window.gitUI) {
          setProject(undefined);
          return;
        }

        const requestId = ++projectRequestRef.current;
        void window.gitUI.getProjects().then((projects) => {
          if (disposed || requestId !== projectRequestRef.current) return;
          setProject(resolveActiveProject(projects));
        }).catch(() => {
          if (!disposed && requestId === projectRequestRef.current) setProject(undefined);
        });
      });
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"]
    });

    return () => {
      disposed = true;
      observer.disconnect();
      if (syncFrameRef.current !== undefined) {
        window.cancelAnimationFrame(syncFrameRef.current);
        syncFrameRef.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    if (!target) return;
    target.classList.add("trellis-canvas-host");
    return () => target.classList.remove("trellis-canvas-host");
  }, [target]);

  return target ? createPortal(<TrellisWorkspace project={project} />, target) : null;
}

function resolveActiveProject(projects: GitProject[]): GitProject | undefined {
  const active = document.querySelector<HTMLElement>(ACTIVE_PROJECT_SELECTOR);
  if (!active) return undefined;

  const activePath = active.querySelector<HTMLElement>(".project-rail-name .sr-only")?.textContent?.trim();
  if (activePath) {
    const pathMatch = projects.find((candidate) => normalizePath(candidate.path) === normalizePath(activePath));
    if (pathMatch) return pathMatch;
  }

  const activeName = active.querySelector<HTMLElement>(".project-rail-name-text")?.textContent?.trim();
  if (!activeName) return undefined;
  const nameMatches = projects.filter((candidate) => candidate.name === activeName);
  if (nameMatches.length === 1) return nameMatches[0];

  return nameMatches
    .filter((candidate) => candidate.lastOpenedAt)
    .sort((left, right) => Date.parse(right.lastOpenedAt ?? "") - Date.parse(left.lastOpenedAt ?? ""))[0];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}
