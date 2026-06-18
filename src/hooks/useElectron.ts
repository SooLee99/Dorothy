'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import type { AgentStatus, AgentEvent, ElectronAPI, AgentCharacter, AgentProvider } from '@/types/electron';
import { dorothyClient } from '@/lib/dorothyClient';

// Check if we're running in Electron
export const isElectron = (): boolean => {
  return typeof window !== 'undefined' && window.electronAPI !== undefined;
};

// Hook for agent management via Electron IPC
export function useElectronAgents() {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch all agents
  const fetchAgents = useCallback(async () => {
    if (!isElectron()) {
      // Web fallback: read-only display of ~/.dorothy/agents.json via API route.
      try {
        const res = await fetch('/api/dorothy/agents');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) setAgents(data as AgentStatus[]);
        }
      } catch (err) {
        console.error('Failed to fetch agents from web fallback:', err);
      }
      setIsLoading(false);
      return;
    }

    try {
      const list = await window.electronAPI!.agent.list();
      // Only update state if data has actually changed to prevent unnecessary re-renders
      setAgents(prev => {
        // Quick length check first
        if (prev.length !== list.length) return list;
        // Compare each agent's key fields
        const hasChanged = list.some((agent, i) => {
          const prevAgent = prev[i];
          return (
            prevAgent.id !== agent.id ||
            prevAgent.status !== agent.status ||
            prevAgent.currentTask !== agent.currentTask ||
            prevAgent.lastActivity !== agent.lastActivity
          );
        });
        return hasChanged ? list : prev;
      });
    } catch (error) {
      console.error('Failed to fetch agents:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Create a new agent
  const createAgent = useCallback(async (config: {
    projectPath: string;
    skills: string[];
    worktree?: { enabled: boolean; branchName: string };
    character?: AgentCharacter;
    name?: string;
    secondaryProjectPath?: string;
    permissionMode?: 'normal' | 'auto' | 'bypass';
    effort?: 'low' | 'medium' | 'high';
    provider?: AgentProvider;
    model?: string;
    localModel?: string;
    obsidianVaultPaths?: string[];
  }) => {
    if (!isElectron()) {
      // Web mode is read-only. Use the Electron app to run/control agents.
      throw new Error('이 작업은 Dorothy 데스크톱 앱(Electron)에서만 동작합니다. Cmd+Tab으로 "Electron" 창을 여시거나, 거기서 다시 시도해 주세요.');
    }
    const agent = await window.electronAPI!.agent.create(config);
    setAgents(prev => [...prev, agent]);
    // 어느 생성 경로에서 만들든 새 에이전트를 현재 선택된 회사로 자동 매핑(미분류 방지).
    // companies.json 만 갱신하며 agents.json 은 건드리지 않는다. 실패해도 생성에는 영향 없음.
    try {
      const cJson = await dorothyClient.companies.get();
      const cid = cJson?.selectedCompanyId;
      if (cid && agent?.id) {
        void dorothyClient.companies.mapAgent(agent.id, cid, config.name ?? null).catch(() => {});
      }
    } catch {
      /* 회사 매핑 실패는 무시 (web/static 모드 등 미지원) */
    }
    return agent;
  }, []);

  // Update an agent
  const updateAgent = useCallback(async (params: {
    id: string;
    skills?: string[];
    secondaryProjectPath?: string | null;
    permissionMode?: 'normal' | 'auto' | 'bypass';
    effort?: 'low' | 'medium' | 'high';
    name?: string;
    character?: AgentCharacter;
    model?: string | null;
    provider?: AgentProvider;
    localModel?: string | null;
    savedPrompt?: string | null;
    obsidianVaultPaths?: string[];
    worktree?: { enabled: boolean; branchName: string };
  }) => {
    if (!isElectron()) {
      // Web mode is read-only. Use the Electron app to run/control agents.
      throw new Error('이 작업은 Dorothy 데스크톱 앱(Electron)에서만 동작합니다. Cmd+Tab으로 "Electron" 창을 여시거나, 거기서 다시 시도해 주세요.');
    }
    const result = await window.electronAPI!.agent.update(params);
    if (result.success && result.agent) {
      setAgents(prev => prev.map(a => a.id === params.id ? result.agent! : a));
    }
    return result;
  }, []);

  // Start an agent
  const startAgent = useCallback(async (
    id: string,
    prompt: string,
    options?: { model?: string; resume?: boolean; provider?: AgentProvider; localModel?: string }
  ) => {
    if (!isElectron()) {
      // Web mode is read-only. Use the Electron app to run/control agents.
      throw new Error('이 작업은 Dorothy 데스크톱 앱(Electron)에서만 동작합니다. Cmd+Tab으로 "Electron" 창을 여시거나, 거기서 다시 시도해 주세요.');
    }
    await window.electronAPI!.agent.start({ id, prompt, options });
    await fetchAgents();
  }, [fetchAgents]);

  // Stop an agent
  const stopAgent = useCallback(async (id: string) => {
    if (!isElectron()) {
      // Web mode is read-only. Use the Electron app to run/control agents.
      throw new Error('이 작업은 Dorothy 데스크톱 앱(Electron)에서만 동작합니다. Cmd+Tab으로 "Electron" 창을 여시거나, 거기서 다시 시도해 주세요.');
    }
    await window.electronAPI!.agent.stop(id);
    await fetchAgents();
  }, [fetchAgents]);

  // Remove an agent
  const removeAgent = useCallback(async (id: string) => {
    if (!isElectron()) {
      // Web mode is read-only. Use the Electron app to run/control agents.
      throw new Error('이 작업은 Dorothy 데스크톱 앱(Electron)에서만 동작합니다. Cmd+Tab으로 "Electron" 창을 여시거나, 거기서 다시 시도해 주세요.');
    }
    await window.electronAPI!.agent.remove(id);
    setAgents(prev => prev.filter(a => a.id !== id));
  }, []);

  // Send input to an agent
  const sendInput = useCallback(async (id: string, input: string) => {
    if (!isElectron()) {
      // Web mode is read-only. Use the Electron app to run/control agents.
      throw new Error('이 작업은 Dorothy 데스크톱 앱(Electron)에서만 동작합니다. Cmd+Tab으로 "Electron" 창을 여시거나, 거기서 다시 시도해 주세요.');
    }
    await window.electronAPI!.agent.sendInput({ id, input });
  }, []);

  // Subscribe to agent events
  useEffect(() => {
    if (!isElectron()) return;

    // Output and error events are handled directly by xterm.js terminals.
    // We do NOT update React state here — doing so on every output chunk
    // causes "Maximum update depth exceeded" because high-frequency PTY
    // output triggers a re-render cascade.
    const unsubOutput = window.electronAPI!.agent.onOutput(() => {});

    const unsubError = window.electronAPI!.agent.onError(() => {});

    const unsubComplete = window.electronAPI!.agent.onComplete(() => {
      fetchAgents();
    });

    const unsubStatus = window.electronAPI!.agent.onStatus?.((event: { agentId: string; status: string; timestamp: string }) => {
      setAgents(prev => prev.map(a =>
        a.id === event.agentId
          ? { ...a, status: event.status as AgentStatus['status'], lastActivity: event.timestamp || new Date().toISOString() }
          : a
      ));
    });

    // Also subscribe to agents:tick for reliable live status updates
    // (proven to reach all windows — tray panel uses this successfully)
    const unsubTick = window.electronAPI!.agent.onTick?.((tickAgents) => {
      setAgents(prev => {
        // If agent count changed, refetch full data (tick only has partial fields)
        if (prev.length !== tickAgents.length) {
          fetchAgents();
          return prev;
        }
        // Check if any status or currentTask changed
        const hasChange = tickAgents.some(t => {
          const existing = prev.find(a => a.id === t.id);
          return existing && (existing.status !== t.status || existing.currentTask !== t.currentTask);
        });
        if (!hasChange) return prev;
        return prev.map(a => {
          const tick = tickAgents.find(t => t.id === a.id);
          if (tick && (a.status !== tick.status || a.currentTask !== tick.currentTask)) {
            return { ...a, status: tick.status as AgentStatus['status'], currentTask: tick.currentTask, lastActivity: tick.lastActivity };
          }
          return a;
        });
      });
    });

    return () => {
      unsubOutput();
      unsubError();
      unsubComplete();
      unsubStatus?.();
      unsubTick?.();
    };
  }, [fetchAgents]);

  // Initial fetch
  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  return {
    agents,
    isLoading,
    isElectron: isElectron(),
    createAgent,
    updateAgent,
    startAgent,
    stopAgent,
    removeAgent,
    sendInput,
    refresh: fetchAgents,
  };
}

// Hook for skill management via Electron IPC
export function useElectronSkills() {
  const [installedSkillsByProvider, setInstalledSkillsByProvider] = useState<Record<string, string[]>>({});
  const [isLoading, setIsLoading] = useState(true);

  // Flat list derived from all providers (backward compat)
  const installedSkills = useMemo(() => {
    const all = new Set<string>();
    for (const skills of Object.values(installedSkillsByProvider)) {
      for (const s of skills) all.add(s);
    }
    return Array.from(all);
  }, [installedSkillsByProvider]);

  const isSkillInstalledOn = useCallback((name: string, provider: string): boolean => {
    const skills = installedSkillsByProvider[provider];
    if (!skills) return false;
    return skills.some(s => s.toLowerCase() === name.toLowerCase());
  }, [installedSkillsByProvider]);

  const fetchInstalledSkills = useCallback(async () => {
    if (!isElectron()) {
      setIsLoading(false);
      return;
    }

    try {
      const byProvider = await window.electronAPI!.skill.listInstalledAll();
      setInstalledSkillsByProvider(byProvider);
    } catch (error) {
      console.error('Failed to fetch installed skills:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const installSkill = useCallback(async (repo: string) => {
    if (!isElectron()) {
      // Web mode is read-only. Use the Electron app to run/control agents.
      throw new Error('이 작업은 Dorothy 데스크톱 앱(Electron)에서만 동작합니다. Cmd+Tab으로 "Electron" 창을 여시거나, 거기서 다시 시도해 주세요.');
    }
    const result = await window.electronAPI!.skill.install(repo);
    await fetchInstalledSkills();
    return result;
  }, [fetchInstalledSkills]);

  const linkToProvider = useCallback(async (skillName: string, providerId: string) => {
    if (!isElectron()) {
      // Web mode is read-only. Use the Electron app to run/control agents.
      throw new Error('이 작업은 Dorothy 데스크톱 앱(Electron)에서만 동작합니다. Cmd+Tab으로 "Electron" 창을 여시거나, 거기서 다시 시도해 주세요.');
    }
    return window.electronAPI!.skill.linkToProvider({ skillName, providerId });
  }, []);

  useEffect(() => {
    fetchInstalledSkills();
  }, [fetchInstalledSkills]);

  return {
    installedSkills,
    installedSkillsByProvider,
    isSkillInstalledOn,
    isLoading,
    isElectron: isElectron(),
    installSkill,
    linkToProvider,
    refresh: fetchInstalledSkills,
  };
}

// Hook for file system operations via Electron IPC
export function useElectronFS() {
  const [projects, setProjects] = useState<{ path: string; name: string; lastModified: string }[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchProjects = useCallback(async () => {
    if (!isElectron()) {
      setIsLoading(false);
      return;
    }

    try {
      const list = await window.electronAPI!.fs.listProjects();
      setProjects(list);
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const openFolderDialog = useCallback(async () => {
    if (!isElectron()) {
      // Web mode is read-only. Use the Electron app to run/control agents.
      throw new Error('이 작업은 Dorothy 데스크톱 앱(Electron)에서만 동작합니다. Cmd+Tab으로 "Electron" 창을 여시거나, 거기서 다시 시도해 주세요.');
    }
    return window.electronAPI!.dialog.openFolder();
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  return {
    projects,
    isLoading,
    isElectron: isElectron(),
    openFolderDialog,
    refresh: fetchProjects,
  };
}

// Hook for shell operations via Electron IPC
export function useElectronShell() {
  const openTerminal = useCallback(async (cwd: string, command?: string) => {
    if (!isElectron()) {
      // Web mode is read-only. Use the Electron app to run/control agents.
      throw new Error('이 작업은 Dorothy 데스크톱 앱(Electron)에서만 동작합니다. Cmd+Tab으로 "Electron" 창을 여시거나, 거기서 다시 시도해 주세요.');
    }
    return window.electronAPI!.shell.openTerminal({ cwd, command });
  }, []);

  const exec = useCallback(async (command: string, cwd?: string) => {
    if (!isElectron()) {
      // Web mode is read-only. Use the Electron app to run/control agents.
      throw new Error('이 작업은 Dorothy 데스크톱 앱(Electron)에서만 동작합니다. Cmd+Tab으로 "Electron" 창을 여시거나, 거기서 다시 시도해 주세요.');
    }
    return window.electronAPI!.shell.exec({ command, cwd });
  }, []);

  return {
    isElectron: isElectron(),
    openTerminal,
    exec,
  };
}
