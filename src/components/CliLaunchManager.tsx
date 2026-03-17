import { useCallback, useEffect, useRef } from "react";
import { getAgentState, patchAgentState } from "@/agent/atoms";
import { isSessionEmpty, upsertSession } from "@/agent/persistence";
import {
  DEFAULT_PROJECT_ICON,
  inferProjectName,
  resolveSavedProject,
  upsertSavedProjectPreservingLearnedFacts,
  type SavedProject,
} from "@/projects";
import { useTabs, type Tab } from "@/contexts/TabsContext";
import {
  listenForCliOpenRequests,
  takePendingCliRequests,
  type CliOpenRequest,
} from "@/cli";

function canReuseInitialNewTab(tabs: Tab[]): Tab | null {
  if (tabs.length !== 1) return null;
  const [onlyTab] = tabs;
  if (onlyTab.mode !== "new") return null;
  return isSessionEmpty(getAgentState(onlyTab.id)) ? onlyTab : null;
}

export default function CliLaunchManager() {
  const {
    activeTabId,
    addTab,
    setActiveTab,
    tabs,
    updateTab,
  } = useTabs();
  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  const applyCliRequest = useCallback(
    async (request: CliOpenRequest) => {
      const cwd = request.path?.trim();
      if (!cwd) return;

      const folder = inferProjectName(cwd) || "New Tab";
      let icon = DEFAULT_PROJECT_ICON;
      let projectPath: string | undefined;
      let setupCommand: string | undefined;

      if (request.addProject) {
        const candidateProject: SavedProject = {
          path: cwd,
          name: inferProjectName(cwd),
          icon: DEFAULT_PROJECT_ICON,
        };
        const savedProjects = await upsertSavedProjectPreservingLearnedFacts(
          candidateProject,
        );
        const resolvedProject = await resolveSavedProject(
          savedProjects.find((project) => project.path === cwd) ?? candidateProject,
        );
        icon = resolvedProject.icon || DEFAULT_PROJECT_ICON;
        projectPath = resolvedProject.path;
        setupCommand = resolvedProject.setupCommand;
      }

      const reusableTab = canReuseInitialNewTab(tabsRef.current);
      const targetTabId =
        reusableTab?.id ??
        addTab({
          mode: "workspace",
          label: folder,
          icon,
          status: "idle",
        });

      patchAgentState(targetTabId, (prev) => ({
        ...prev,
        config: {
          ...prev.config,
          cwd,
          projectPath,
          setupCommand,
        },
        status: "idle",
        error: null,
        errorDetails: null,
        errorAction: null,
      }));

      const nextTab: Tab = reusableTab
        ? {
            ...reusableTab,
            mode: "workspace",
            label: folder,
            icon,
            status: "idle",
          }
        : {
            id: targetTabId,
            label: folder,
            icon,
            status: "idle",
            mode: "workspace",
          };

      if (reusableTab) {
        updateTab(reusableTab.id, {
          mode: "workspace",
          label: folder,
          icon,
          status: "idle",
        });
      }

      setActiveTab(targetTabId);
      await upsertSession(nextTab);
    },
    [addTab, setActiveTab, updateTab],
  );

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const processPending = async () => {
      const pending = await takePendingCliRequests();
      for (const request of pending) {
        if (cancelled) return;
        await applyCliRequest(request);
      }
    };

    void processPending();
    void listenForCliOpenRequests((request) => {
      void applyCliRequest(request);
    }).then((nextUnlisten) => {
      if (cancelled) {
        nextUnlisten?.();
        return;
      }
      unlisten = nextUnlisten;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyCliRequest]);

  return null;
}
