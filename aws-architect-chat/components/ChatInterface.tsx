'use client';

import { useCompletion } from '@ai-sdk/react';
import { Send, Terminal, Loader2, Settings2, Code2, MessageSquare, ChevronDown, FolderPlus, Trash2, Rocket, ServerCog, CircleAlert, Activity } from 'lucide-react';
import { useEffect, useMemo, useState, useRef, useCallback, useSyncExternalStore } from 'react';
import D2DiagramViewport from '@/components/D2DiagramViewport';

interface Model {
  id: string;
  name: string;
}

interface ProjectSummary {
  name: string;
  updatedAt: string | null;
}

interface ProjectState {
  name: string;
  d2Code: string;
  explanation: string;
  mcpPrompt: string;
}

interface WorkflowEntry {
  ts: string;
  type: string;
  level?: 'info' | 'success' | 'warning' | 'error';
  message?: string;
  payload?: unknown;
  source?: string;
  projectName?: string;
}

const DEFAULT_PROXY_URL = process.env.NEXT_PUBLIC_AWS_MCP_PROXY_URL || 'http://127.0.0.1:8787';
const PROXY_HEALTH_TIMEOUT_MS = 5000;
const MAX_DEPLOYMENT_LOGS = 120;

const SENTINEL = '---===D2_END===---';
const EXPLANATION_SENTINEL = '---===EXPLANATION_END===---';
const DESKTOP_MEDIA_QUERY = '(min-width: 1024px)';
const MIN_PANE_WIDTH_PERCENT = 20;
const MAX_PANE_WIDTH_PERCENT = 80;
const DEFAULT_PROJECT_NAME = 'Proyecto 1';

function serializeCompletionPayload(d2Code: string, explanation: string, mcpPrompt: string) {
  return `${d2Code || ''}\n${SENTINEL}\n${explanation || ''}\n${EXPLANATION_SENTINEL}\n${mcpPrompt || ''}`;
}

function parseApiResponse(payload: string) {
  if (!payload) {
    return { d2Code: '', explanation: '', mcpPrompt: '' };
  }

  const sentinelIndex = payload.indexOf(SENTINEL);
  if (sentinelIndex < 0) {
    return { d2Code: payload, explanation: '', mcpPrompt: '' };
  }

  const explanationStart = sentinelIndex + SENTINEL.length;
  const explanationBlock = payload.slice(explanationStart);
  const explanationSentinelIndex = explanationBlock.indexOf(EXPLANATION_SENTINEL);

  if (explanationSentinelIndex < 0) {
    return {
      d2Code: payload.slice(0, sentinelIndex),
      explanation: explanationBlock,
      mcpPrompt: '',
    };
  }

  return {
    d2Code: payload.slice(0, sentinelIndex),
    explanation: explanationBlock.slice(0, explanationSentinelIndex),
    mcpPrompt: explanationBlock.slice(explanationSentinelIndex + EXPLANATION_SENTINEL.length),
  };
}

function subscribeDesktopMediaQuery(callback: () => void) {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const mediaQuery = window.matchMedia(DESKTOP_MEDIA_QUERY);
  mediaQuery.addEventListener('change', callback);
  return () => mediaQuery.removeEventListener('change', callback);
}

function getDesktopSnapshot() {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.matchMedia(DESKTOP_MEDIA_QUERY).matches;
}

async function fetchProjects(): Promise<ProjectSummary[]> {
  const response = await fetch('/api/projects');
  if (!response.ok) {
    throw new Error('Unable to load projects.');
  }

  return (await response.json()) as ProjectSummary[];
}

async function createProject(projectName: string): Promise<ProjectState> {
  const response = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: projectName }),
  });

  if (!response.ok) {
    throw new Error('Unable to create project.');
  }

  return (await response.json()) as ProjectState;
}

async function loadProject(projectName: string): Promise<ProjectState> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectName)}`);
  if (!response.ok) {
    throw new Error('Unable to load project state.');
  }

  return (await response.json()) as ProjectState;
}

async function saveProjectState(projectName: string, d2Code: string, explanation: string, mcpPrompt: string): Promise<ProjectState> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectName)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ d2Code, explanation, mcpPrompt }),
  });

  if (!response.ok) {
    throw new Error('Unable to save project state.');
  }

  return (await response.json()) as ProjectState;
}

async function deleteProject(projectName: string): Promise<void> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectName)}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error('Unable to delete project.');
  }
}

async function appendWorkflowEntry(projectName: string, entry: WorkflowEntry): Promise<void> {
  if (!projectName) {
    return;
  }

  await fetch(`/api/projects/${encodeURIComponent(projectName)}/workflow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry }),
  });
}

function formatWorkflowEntry(entry: WorkflowEntry) {
  const timestamp = entry.ts ? new Date(entry.ts).toLocaleTimeString() : new Date().toLocaleTimeString();
  const message = entry.message || (typeof entry.payload === 'string' ? entry.payload : '');
  const payloadText = message || (entry.payload ? JSON.stringify(entry.payload, null, 2) : '');

  return `[${timestamp}] ${entry.type}${payloadText ? `\n${payloadText}` : ''}`;
}

function createWorkflowEntry(type: string, message: string, level: WorkflowEntry['level'] = 'info', payload?: unknown): WorkflowEntry {
  return {
    ts: new Date().toISOString(),
    type,
    message,
    level,
    payload,
  };
}

export default function ChatInterface() {
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState('gemini-1.5-flash');
  const [isFetchingModels, setIsFetchingModels] = useState(true);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [isProjectMenuOpen, setIsProjectMenuOpen] = useState(false);
  const [isProjectActionPending, setIsProjectActionPending] = useState(false);
  const [projectStatus, setProjectStatus] = useState('');
  const [d2Draft, setD2Draft] = useState('');
  const [isD2Dirty, setIsD2Dirty] = useState(false);
  const [activeD2View, setActiveD2View] = useState<'code' | 'diagram'>('diagram');
  const [codePaneWidthPercent, setCodePaneWidthPercent] = useState(52);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deploymentStatus, setDeploymentStatus] = useState('');
  const [deploymentError, setDeploymentError] = useState('');
  const [deploymentLogs, setDeploymentLogs] = useState<WorkflowEntry[]>([]);

  const splitContainerRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const d2TextareaRef = useRef<HTMLTextAreaElement>(null);
  const deploymentEventSourceRef = useRef<EventSource | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(52);
  const containerWidthRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastSavedSignatureRef = useRef('');
  const deploymentRunRef = useRef(0);

  const { complete, completion, isLoading, input, handleInputChange, setInput, setCompletion } = useCompletion({
    api: '/api/chat',
    streamProtocol: 'text',
  });

  const parsedResponse = useMemo(() => parseApiResponse(completion), [completion]);
  const d2Code = isD2Dirty ? d2Draft : parsedResponse.d2Code;
  const explanation = parsedResponse.explanation;
  const mcpPrompt = parsedResponse.mcpPrompt;
  const isDesktop = useSyncExternalStore(subscribeDesktopMediaQuery, getDesktopSnapshot, () => false);
  const proxyHealthUrl = `${DEFAULT_PROXY_URL}/health`;
  const proxyEventsUrl = `${DEFAULT_PROXY_URL}/events?projectName=${encodeURIComponent(selectedProject || '')}`;

  const currentSignature = `${selectedProject}\n${d2Code}\n${explanation}\n${mcpPrompt}`;

  const closeProjectMenu = useCallback(() => setIsProjectMenuOpen(false), []);

  const closeDeploymentStream = useCallback(() => {
    if (deploymentEventSourceRef.current) {
      deploymentEventSourceRef.current.close();
      deploymentEventSourceRef.current = null;
    }
  }, []);

  const persistDeploymentLog = useCallback(
    async (entry: WorkflowEntry) => {
      if (!selectedProject) {
        return;
      }

      try {
        await appendWorkflowEntry(selectedProject, {
          ...entry,
          projectName: selectedProject,
        });
      } catch (error) {
        console.error('Failed to persist deployment log:', error);
      }
    },
    [selectedProject],
  );

  const pushDeploymentLog = useCallback(
    (entry: WorkflowEntry) => {
      setDeploymentLogs((currentLogs) => {
        const nextLogs = [...currentLogs, entry];
        return nextLogs.slice(-MAX_DEPLOYMENT_LOGS);
      });
      void persistDeploymentLog(entry);
    },
    [persistDeploymentLog],
  );

  const validateProxy = useCallback(async () => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), PROXY_HEALTH_TIMEOUT_MS);

    try {
      const response = await fetch(proxyHealthUrl, { signal: controller.signal });
      if (!response.ok) {
        throw new Error('Local AWS deployment proxy is unavailable. Start the proxy before deploying.');
      }

      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean };
      if (!payload.ok) {
        throw new Error('Local AWS deployment proxy is not ready. Start the proxy before deploying.');
      }
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError'
        ? 'Local AWS deployment proxy did not respond in time. Start the proxy before deploying.'
        : error instanceof Error
          ? error.message
          : 'Local AWS deployment proxy is not reachable. Start the proxy before deploying.';
      throw new Error(message);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }, [proxyHealthUrl]);

  const handleDeploymentEvent = useCallback(
    (eventName: string, data: string) => {
      try {
        const parsed = JSON.parse(data) as WorkflowEntry & { type?: string };
        const entry: WorkflowEntry = {
          ts: parsed.ts || new Date().toISOString(),
          type: parsed.type || eventName,
          level: parsed.level,
          message: parsed.message,
          payload: parsed.payload,
          source: parsed.source,
          projectName: parsed.projectName || selectedProject,
        };

        if (!entry.message && entry.payload && typeof entry.payload === 'object') {
          entry.message = JSON.stringify(entry.payload, null, 2);
        }

        setDeploymentStatus(entry.message || entry.type);
        if (entry.level === 'error') {
          setDeploymentError(entry.message || 'Deployment reported an error.');
        }

        pushDeploymentLog(entry);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const fallbackEntry = createWorkflowEntry(eventName, message, 'warning', data);
        pushDeploymentLog(fallbackEntry);
      }
    },
    [pushDeploymentLog, selectedProject],
  );

  const handleDeploymentConnect = useCallback(() => {
    if (!selectedProject) {
      return;
    }

    closeDeploymentStream();

    const source = new EventSource(proxyEventsUrl);
    deploymentEventSourceRef.current = source;

    source.addEventListener('status', (event) => {
      const messageEvent = event as MessageEvent;
      handleDeploymentEvent('status', messageEvent.data);
    });

    source.addEventListener('log', (event) => {
      const messageEvent = event as MessageEvent;
      handleDeploymentEvent('log', messageEvent.data);
    });

    source.addEventListener('mcp', (event) => {
      const messageEvent = event as MessageEvent;
      handleDeploymentEvent('mcp', messageEvent.data);
    });

    source.onerror = () => {
      if (deploymentRunRef.current > 0) {
        setDeploymentError('The deployment log stream disconnected. Reconnect the local proxy and retry.');
      }
    };
  }, [closeDeploymentStream, handleDeploymentEvent, proxyEventsUrl, selectedProject]);

  const handleDeployToAws = useCallback(async () => {
    if (!selectedProject) {
      setDeploymentError('Select a project before deploying to AWS.');
      return;
    }

    deploymentRunRef.current += 1;
    const currentRun = deploymentRunRef.current;

    setDeploymentLogs([]);
    setDeploymentError('');
    setDeploymentStatus('Checking local proxy...');
    setIsDeploying(true);

    try {
      await validateProxy();
      setDeploymentStatus('Connecting to deployment stream...');
      handleDeploymentConnect();

      pushDeploymentLog(createWorkflowEntry('deployment-started', `Deploying project ${selectedProject} to AWS`, 'info', { projectName: selectedProject }));

      const response = await fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName: selectedProject,
          model: selectedModel,
        }),
      });

      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(responseText || 'Deployment request failed.');
      }

      if (responseText.trim()) {
        pushDeploymentLog(createWorkflowEntry('llm-summary', responseText.trim(), 'success'));
      }

      if (currentRun === deploymentRunRef.current) {
        setDeploymentStatus('Deployment finished.');
        pushDeploymentLog(createWorkflowEntry('deployment-finished', `Deployment finished for ${selectedProject}`, 'success'));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Deployment failed.';
      setDeploymentError(message);
      setDeploymentStatus('Deployment failed.');
      pushDeploymentLog(createWorkflowEntry('deployment-error', message, 'error'));
    } finally {
      if (currentRun === deploymentRunRef.current) {
        setIsDeploying(false);
        closeDeploymentStream();
      }
    }
  }, [closeDeploymentStream, handleDeploymentConnect, pushDeploymentLog, selectedModel, selectedProject, validateProxy]);

  const refreshProjectList = useCallback(async () => {
    const nextProjects = await fetchProjects();
    setProjects(nextProjects);
    return nextProjects;
  }, []);

  const persistActiveProject = useCallback(
    async (projectName: string, projectD2Code: string, projectExplanation: string, projectMcpPrompt: string) => {
      if (!projectName) {
        return null;
      }

      const savedState = await saveProjectState(projectName, projectD2Code, projectExplanation, projectMcpPrompt);
      lastSavedSignatureRef.current = `${projectName}\n${projectD2Code}\n${projectExplanation}\n${projectMcpPrompt}`;
      setProjectStatus(`Saved ${savedState.name}`);
      return savedState;
    },
    [],
  );

  const loadProjectIntoEditor = useCallback(
    async (projectName: string) => {
      setIsProjectActionPending(true);
      setProjectStatus(`Loading ${projectName}...`);

      try {
        const projectState = await loadProject(projectName);
        setSelectedProject(projectState.name);
        setCompletion(serializeCompletionPayload(projectState.d2Code, projectState.explanation, projectState.mcpPrompt));
        setD2Draft('');
        setIsD2Dirty(false);
        setInput('');
        setActiveD2View('diagram');
        lastSavedSignatureRef.current = `${projectState.name}\n${projectState.d2Code}\n${projectState.explanation}\n${projectState.mcpPrompt}`;
        setProjectStatus(`Loaded ${projectState.name}`);
      } finally {
        setIsProjectActionPending(false);
      }
    },
    [setCompletion, setInput],
  );

  const ensureInitialProject = useCallback(async () => {
    const nextProjects = await refreshProjectList();

    if (nextProjects.length === 0) {
      const created = await createProject(DEFAULT_PROJECT_NAME);
      await refreshProjectList();
      await loadProjectIntoEditor(created.name);
      return;
    }

    if (!selectedProject) {
      await loadProjectIntoEditor(nextProjects[0].name);
    }
  }, [loadProjectIntoEditor, refreshProjectList, selectedProject]);

  useEffect(() => {
    let isActive = true;

    void (async () => {
      try {
        await ensureInitialProject();
      } catch (error) {
        console.error(error);
        if (isActive) {
          setProjectStatus('Failed to initialize projects');
        }
      } finally {
        if (isActive) {
          setIsLoadingProjects(false);
        }
      }
    })();

    return () => {
      isActive = false;
    };
  }, [ensureInitialProject]);

  useEffect(() => () => closeDeploymentStream(), [closeDeploymentStream]);

  useEffect(() => {
    if (isLoadingProjects || isProjectActionPending || !selectedProject) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (currentSignature === lastSavedSignatureRef.current) {
        return;
      }

      persistActiveProject(selectedProject, d2Code, explanation, mcpPrompt).catch((error) => {
        console.error('Failed to persist project state:', error);
      });
    }, 700);

    return () => window.clearTimeout(timeoutId);
  }, [currentSignature, d2Code, explanation, isLoadingProjects, isProjectActionPending, persistActiveProject, selectedProject, mcpPrompt]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!projectMenuRef.current || projectMenuRef.current.contains(event.target as Node)) {
        return;
      }

      closeProjectMenu();
    };

    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [closeProjectMenu]);

  const handleCreateProject = useCallback(async () => {
    const nextName = window.prompt('Nombre del nuevo proyecto', 'Proyecto nuevo')?.trim();
    if (!nextName) {
      return;
    }

    setIsProjectActionPending(true);
    setProjectStatus(`Creating ${nextName}...`);

    try {
      const created = await createProject(nextName);
      await refreshProjectList();
      await loadProjectIntoEditor(created.name);
      closeProjectMenu();
    } catch (error) {
      console.error('Failed to create project:', error);
      setProjectStatus('Failed to create project');
    } finally {
      setIsProjectActionPending(false);
    }
  }, [closeProjectMenu, loadProjectIntoEditor, refreshProjectList]);

  const handleDeleteProject = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    const confirmed = window.confirm(`Delete project "${selectedProject}"?`);
    if (!confirmed) {
      return;
    }

    setIsProjectActionPending(true);
    setProjectStatus(`Deleting ${selectedProject}...`);

    try {
      await persistActiveProject(selectedProject, d2Code, explanation, mcpPrompt);
      await deleteProject(selectedProject);
      const nextProjects = await refreshProjectList();

      if (nextProjects.length === 0) {
        const created = await createProject(DEFAULT_PROJECT_NAME);
        await refreshProjectList();
        await loadProjectIntoEditor(created.name);
      } else {
        await loadProjectIntoEditor(nextProjects[0].name);
      }

      closeProjectMenu();
    } catch (error) {
      console.error('Failed to delete project:', error);
      setProjectStatus('Failed to delete project');
    } finally {
      setIsProjectActionPending(false);
    }
  }, [closeProjectMenu, d2Code, explanation, loadProjectIntoEditor, mcpPrompt, persistActiveProject, refreshProjectList, selectedProject]);

  const adjustTextareaHeight = useCallback(() => {
    const textarea = d2TextareaRef.current;
    if (!textarea) return;

    if (isDesktop) {
      textarea.style.height = '100%';
      return;
    }

    textarea.style.height = 'auto';
    textarea.style.height = `${Math.max(textarea.scrollHeight, 280)}px`;
  }, [isDesktop]);

  useEffect(() => {
    adjustTextareaHeight();
  }, [adjustTextareaHeight, d2Code]);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (!isDraggingRef.current || !containerWidthRef.current || !isDesktop) return;

      const deltaX = event.clientX - dragStartXRef.current;
      const deltaPercent = (deltaX / containerWidthRef.current) * 100;
      const nextWidth = Math.min(
        MAX_PANE_WIDTH_PERCENT,
        Math.max(MIN_PANE_WIDTH_PERCENT, dragStartWidthRef.current + deltaPercent),
      );

      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }

      rafRef.current = requestAnimationFrame(() => {
        setCodePaneWidthPercent(nextWidth);
      });
    };

    const onMouseUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [isDesktop]);

  const handleDividerMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isDesktop || !splitContainerRef.current) return;
    const bounds = splitContainerRef.current.getBoundingClientRect();

    isDraggingRef.current = true;
    dragStartXRef.current = event.clientX;
    dragStartWidthRef.current = codePaneWidthPercent;
    containerWidthRef.current = bounds.width;

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };

  useEffect(() => {
    async function fetchModels() {
      try {
        const res = await fetch('/api/models');
        const data = await res.json();
        if (Array.isArray(data)) {
          setAvailableModels(data);
          if (data.some(m => m.id === 'gemini-1.5-flash')) setSelectedModel('gemini-1.5-flash');
          else if (data.length > 0) setSelectedModel(data[0].id);
        }
      } catch (err) {
        console.error('Error fetching models:', err);
      } finally {
        setIsFetchingModels(false);
      }
    }
    fetchModels();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isLoading) {
      setIsD2Dirty(false);
      setD2Draft('');
      const latestD2State = d2Code;
      const latestExplanationState = explanation;

      if (selectedProject) {
        await persistActiveProject(selectedProject, latestD2State, latestExplanationState, mcpPrompt);
      }

      const completionResult = await complete(input.trim(), {
        body: {
          model: selectedModel,
          projectName: selectedProject,
          d2State: latestD2State,
          explanationState: latestExplanationState,
          mcpState: mcpPrompt,
        },
      });

      if (selectedProject && completionResult) {
        const parsedResult = parseApiResponse(completionResult);
        const nextMcpPrompt = parsedResult.mcpPrompt || mcpPrompt;
        await persistActiveProject(selectedProject, parsedResult.d2Code, parsedResult.explanation, nextMcpPrompt);
      }

      setInput('');
    }
  };

  return (
    <div className={`flex min-h-[100dvh] flex-col pt-16 transition-colors duration-300 ${isDeploying ? 'bg-gradient-to-br from-orange-50 via-white to-amber-50' : 'bg-white'}`}>

      {/* Model Selector */}
      <div className="bg-white border-b border-slate-200 py-2 px-4 shrink-0 z-20">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
          <div className="relative min-w-0" ref={projectMenuRef}>
            <button
              type="button"
              onClick={() => setIsProjectMenuOpen((currentValue) => !currentValue)}
              disabled={isLoadingProjects || isProjectActionPending}
              className="inline-flex max-w-full items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left shadow-sm transition-colors hover:border-orange-300 hover:bg-orange-50 disabled:opacity-50"
            >
              <FolderPlus className="h-4 w-4 text-orange-600" />
              <span className="min-w-0 truncate text-sm font-semibold text-slate-800">
                {selectedProject || 'Select project'}
              </span>
              <ChevronDown className="h-4 w-4 text-slate-400" />
            </button>

            {isProjectMenuOpen && (
              <div className="absolute left-0 top-full z-30 mt-2 w-80 rounded-2xl border border-slate-200 bg-white p-2 shadow-2xl">
                <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Projects</div>
                <div className="max-h-64 overflow-y-auto">
                  {projects.map((project) => (
                    <button
                      key={project.name}
                      type="button"
                      onClick={() => {
                        closeProjectMenu();
                        loadProjectIntoEditor(project.name).catch((error) => {
                          console.error('Failed to open project:', error);
                          setProjectStatus('Failed to open project');
                        });
                      }}
                      className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left transition-colors hover:bg-slate-50 ${
                        project.name === selectedProject ? 'bg-orange-50' : ''
                      }`}
                    >
                      <span className="truncate text-sm font-medium text-slate-800">{project.name}</span>
                      {project.updatedAt ? (
                        <span className="ml-4 shrink-0 text-[10px] text-slate-400">{new Date(project.updatedAt).toLocaleDateString()}</span>
                      ) : null}
                    </button>
                  ))}

                  {projects.length === 0 && (
                    <div className="px-3 py-4 text-sm text-slate-500">No projects yet.</div>
                  )}
                </div>

                <div className="mt-2 border-t border-slate-100 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      closeProjectMenu();
                      handleCreateProject().catch((error) => console.error(error));
                    }}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900"
                  >
                    <FolderPlus className="h-4 w-4 text-emerald-600" />
                    New project
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      closeProjectMenu();
                      handleDeleteProject().catch((error) => console.error(error));
                    }}
                    disabled={!selectedProject || projects.length === 0}
                    className="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40"
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete project
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="flex min-w-0 items-center gap-3">
            <div className="hidden min-w-0 items-center gap-2 text-xs text-slate-400 md:flex">
              <span className="truncate">{projectStatus || (isDeploying ? 'Deploying to AWS...' : 'Local persistence enabled')}</span>
            </div>
            <button
              type="button"
              onClick={() => handleDeployToAws().catch((error) => console.error(error))}
              disabled={!selectedProject || isLoadingProjects || isProjectActionPending || isDeploying}
              className="inline-flex items-center gap-2 rounded-xl border border-orange-200 bg-orange-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-orange-500/20 transition-transform hover:-translate-y-0.5 hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isDeploying ? <Activity className="h-4 w-4 animate-pulse" /> : <Rocket className="h-4 w-4" />}
              Deploy to AWS
            </button>
            <div className="flex items-center gap-2 text-slate-500">
              <Settings2 className="w-4 h-4" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Model Engine</span>
            </div>
            <select 
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={isLoading || isFetchingModels}
              className="bg-transparent text-xs font-semibold text-slate-900 outline-none cursor-pointer disabled:opacity-50"
            >
              {isFetchingModels ? <option>Loading...</option> : availableModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div
        ref={splitContainerRef}
        className="flex flex-1 flex-col lg:flex-row lg:min-h-0 overflow-visible lg:overflow-hidden pb-28 lg:pb-0"
      >
        {/* D2 Pane */}
        <div
          className={`flex flex-col border-b lg:border-b-0 lg:min-h-0 ${isDeploying ? 'border-orange-200 bg-gradient-to-b from-orange-50 to-slate-50' : 'border-slate-200 bg-slate-50'}`}
          style={isDesktop ? { width: `${codePaneWidthPercent}%`, minWidth: `${MIN_PANE_WIDTH_PERCENT}%` } : undefined}
        >
          <div className={`flex items-center justify-between px-6 py-4 shrink-0 ${isDeploying ? 'bg-orange-50 border-b border-orange-100' : 'bg-slate-50 border-b border-slate-200'}`}>
            <div className="flex items-center gap-2">
              <Code2 className="w-4 h-4 text-orange-600" />
              <span className="text-[11px] font-bold text-slate-700 uppercase tracking-widest">D2 Infrastructure Code</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="rounded-md border border-slate-200 bg-white p-0.5">
                <button
                  type="button"
                  onClick={() => setActiveD2View('code')}
                  className={`rounded px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors ${
                    activeD2View === 'code' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Code
                </button>
                <button
                  type="button"
                  onClick={() => setActiveD2View('diagram')}
                  className={`rounded px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors ${
                    activeD2View === 'diagram' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Diagram
                </button>
              </div>
              <div className="px-2 py-0.5 rounded-md bg-orange-100 text-orange-700 text-[9px] font-black uppercase">Editable</div>
            </div>
          </div>

          {activeD2View === 'code' ? (
            <textarea
              ref={d2TextareaRef}
              value={d2Code}
              onChange={(e) => {
                setIsD2Dirty(true);
                setD2Draft(e.target.value);
              }}
              wrap="off"
              className="w-full min-h-[280px] lg:min-h-0 lg:flex-1 px-6 py-6 lg:px-8 lg:py-8 font-mono text-[13px] leading-6 text-slate-700 outline-none resize-none bg-slate-50 selection:bg-orange-200 whitespace-pre"
              style={{
                overflowX: 'auto',
                overflowY: isDesktop ? 'auto' : 'hidden',
              }}
              placeholder="# D2 code will appear here..."
              spellCheck={false}
            />
          ) : (
            <div className="min-h-[320px] lg:min-h-0 lg:flex-1">
              <D2DiagramViewport d2Code={d2Code} isDeploying={isDeploying} />
            </div>
          )}
        </div>

        {/* Desktop resizer only */}
        {isDesktop && (
          <div
            onMouseDown={handleDividerMouseDown}
            className="hidden lg:flex w-2 shrink-0 cursor-col-resize items-stretch justify-center bg-slate-100 hover:bg-orange-200 transition-colors"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panels"
          >
            <div className="w-px bg-slate-300" />
          </div>
        )}

        {/* Explanation Pane */}
        <div
          className={`flex flex-col lg:min-h-0 ${isDeploying ? 'bg-gradient-to-b from-white to-orange-50' : 'bg-white'}`}
          style={isDesktop ? { width: `${100 - codePaneWidthPercent}%`, minWidth: `${MIN_PANE_WIDTH_PERCENT}%` } : undefined}
        >
          <div className={`flex items-center gap-2 px-6 py-4 shrink-0 ${isDeploying ? 'bg-orange-50 border-b border-orange-100' : 'bg-white border-b border-slate-100'}`}>
            <MessageSquare className="w-4 h-4 text-orange-500" />
            <span className="text-[11px] font-bold text-slate-800 uppercase tracking-widest">Architectural Explanation</span>
          </div>
          
          <div className="flex-1 min-h-[200px] lg:min-h-0 overflow-visible lg:overflow-y-auto p-6 space-y-6 pb-8 lg:pb-24">
            {explanation ? (
              <div className="max-w-none text-[15px] leading-7 text-slate-700 whitespace-pre-wrap break-words [overflow-wrap:anywhere] animate-in fade-in duration-500">
                {explanation}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center min-h-40 text-center space-y-2">
                <Terminal className="w-6 h-6 text-slate-200" />
                <p className="text-[10px] font-medium text-slate-300 uppercase tracking-tight">Define your AWS requirements to begin</p>
              </div>
            )}
            
            {isLoading && !explanation && (
              <div className="flex items-center gap-2 text-orange-500/60 px-2">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span className="text-[10px] font-bold uppercase tracking-tighter">Architecting Solution...</span>
              </div>
            )}

            <div className={`rounded-3xl border shadow-[0_20px_60px_rgba(15,23,42,0.12)] ${isDeploying ? 'border-orange-200 bg-slate-950 text-orange-50' : 'border-slate-200 bg-slate-950 text-slate-100'}`}>
              <div className={`flex items-center justify-between border-b px-4 py-3 text-[10px] font-bold uppercase tracking-[0.28em] ${isDeploying ? 'border-orange-500/20 text-orange-200' : 'border-white/10 text-slate-300'}`}>
                <span className="flex items-center gap-2">
                  <ServerCog className={`h-4 w-4 ${isDeploying ? 'text-orange-300' : 'text-orange-400'}`} />
                  Deployment Terminal
                </span>
                <span className="max-w-[45%] truncate text-right">{deploymentStatus || (isDeploying ? 'Streaming logs...' : 'Idle')}</span>
              </div>
              <div className="max-h-64 overflow-y-auto px-4 py-3 font-mono text-[12px] leading-6">
                {deploymentError ? (
                  <div className="mb-3 flex items-start gap-2 rounded-2xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-200">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{deploymentError}</span>
                  </div>
                ) : null}

                {deploymentLogs.length > 0 ? (
                  deploymentLogs.slice(-MAX_DEPLOYMENT_LOGS).map((entry, index) => (
                    <pre
                      key={`${entry.ts}-${entry.type}-${index}`}
                      className={`whitespace-pre-wrap break-words rounded-xl px-3 py-2 ${entry.level === 'error' ? 'text-red-200' : entry.level === 'success' ? 'text-emerald-200' : entry.level === 'warning' ? 'text-amber-200' : 'text-slate-100'}`}
                    >
                      {formatWorkflowEntry(entry)}
                    </pre>
                  ))
                ) : (
                  <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-slate-400">
                    Deploy to AWS to stream live MCP output here.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Input area: fixed to viewport bottom on mobile/tablet, anchored pane-bottom on desktop. */}
          <div className="p-4 bg-white/95 backdrop-blur-sm border-t border-slate-100 shrink-0 fixed left-0 right-0 bottom-0 z-40 lg:sticky lg:bottom-0 lg:left-auto lg:right-auto lg:z-10">
            <form onSubmit={handleSubmit} className="relative max-w-2xl mx-auto">
              <input
                value={input}
                onChange={handleInputChange}
                placeholder="Ask for an AWS design or modification..."
                className="w-full pl-4 pr-12 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl text-sm text-slate-700 outline-none focus:border-orange-300 focus:ring-4 focus:ring-orange-500/5 transition-all shadow-sm"
              />
              <button
                type="submit"
                disabled={!input.trim() || isLoading}
                className="absolute right-2 top-2 p-2 bg-slate-900 text-white rounded-xl hover:bg-orange-500 disabled:opacity-30 disabled:bg-slate-300 transition-all shadow-md"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
