import fs from 'fs/promises';
import path from 'path';

export const PERSISTENCE_ROOT = path.join(process.cwd(), 'persistence');
export const PROJECT_DIAGRAM_FILE = 'diagram.d2';
export const PROJECT_EXPLANATION_FILE = 'explanation.md';
export const PROJECT_MCP_PROMPT_FILE = 'MCP_prompt.md';
export const PROJECT_WORKFLOW_FILE = 'workflow.json';
export const PROJECT_METADATA_FILE = 'metadata.json';

export type ProjectStatus = 'not_deployed' | 'deployed';

export interface ProjectMetadata {
  status: ProjectStatus;
  lastAction?: 'deploy' | 'teardown';
  updatedAt: string;
}

export interface ProjectSummary {
  name: string;
  updatedAt: string | null;
  status: ProjectStatus;
}

export interface ProjectState {
  name: string;
  d2Code: string;
  explanation: string;
  mcpPrompt: string;
  status: ProjectStatus;
}

export interface WorkflowEntry {
  ts: string;
  type: string;
  level?: 'info' | 'success' | 'warning' | 'error';
  message?: string;
  payload?: unknown;
  source?: string;
  projectName?: string;
}

function normalizeProjectName(name: string) {
  const cleaned = name
    .replace(/[\\/<>:"|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || 'Proyecto';
}

function getProjectDir(projectName: string) {
  return path.join(PERSISTENCE_ROOT, normalizeProjectName(projectName));
}

function getWorkflowPath(projectName: string) {
  return path.join(getProjectDir(projectName), PROJECT_WORKFLOW_FILE);
}

async function ensureRoot() {
  await fs.mkdir(PERSISTENCE_ROOT, { recursive: true });
}

async function readTextFileIfExists(filePath: string) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function readJsonArrayIfExists(filePath: string) {
  const raw = await readTextFileIfExists(filePath);
  if (!raw.trim()) {
    return [] as WorkflowEntry[];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WorkflowEntry[]) : [];
  } catch {
    return [];
  }
}

export async function listProjectSummaries(): Promise<ProjectSummary[]> {
  await ensureRoot();
  const entries = await fs.readdir(PERSISTENCE_ROOT, { withFileTypes: true });
  const summaries: ProjectSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const projectPath = path.join(PERSISTENCE_ROOT, entry.name);
    const diagramPath = path.join(projectPath, PROJECT_DIAGRAM_FILE);
    const explanationPath = path.join(projectPath, PROJECT_EXPLANATION_FILE);
    const mcpPath = path.join(projectPath, PROJECT_MCP_PROMPT_FILE);
    const workflowPath = path.join(projectPath, PROJECT_WORKFLOW_FILE);
    const metadataPath = path.join(projectPath, PROJECT_METADATA_FILE);

    let updatedAt: string | null = null;
    for (const candidatePath of [diagramPath, explanationPath, mcpPath, workflowPath, metadataPath]) {
      try {
        const stats = await fs.stat(candidatePath);
        updatedAt = stats.mtime.toISOString();
        break;
      } catch {
        continue;
      }
    }

    const metadata = await readProjectMetadata(entry.name);
    summaries.push({ 
      name: entry.name, 
      updatedAt, 
      status: metadata.status 
    });
  }

  return summaries.sort((left, right) => left.name.localeCompare(right.name));
}

export async function readProjectMetadata(projectName: string): Promise<ProjectMetadata> {
  const projectPath = getProjectDir(projectName);
  const metadataPath = path.join(projectPath, PROJECT_METADATA_FILE);
  const raw = await readTextFileIfExists(metadataPath);
  
  if (!raw.trim()) {
    return {
      status: 'not_deployed',
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    return JSON.parse(raw) as ProjectMetadata;
  } catch {
    return {
      status: 'not_deployed',
      updatedAt: new Date().toISOString(),
    };
  }
}

export async function updateProjectStatus(projectName: string, status: ProjectStatus, lastAction?: 'deploy' | 'teardown') {
  const projectPath = getProjectDir(projectName);
  const metadataPath = path.join(projectPath, PROJECT_METADATA_FILE);
  const metadata: ProjectMetadata = {
    status,
    lastAction,
    updatedAt: new Date().toISOString(),
  };

  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  return metadata;
}

export async function readProjectState(projectName: string): Promise<ProjectState> {
  const normalizedName = normalizeProjectName(projectName);
  const projectPath = getProjectDir(normalizedName);
  const [d2Code, explanation, mcpPrompt, metadata] = await Promise.all([
    readTextFileIfExists(path.join(projectPath, PROJECT_DIAGRAM_FILE)),
    readTextFileIfExists(path.join(projectPath, PROJECT_EXPLANATION_FILE)),
    readTextFileIfExists(path.join(projectPath, PROJECT_MCP_PROMPT_FILE)),
    readProjectMetadata(normalizedName),
  ]);

  return {
    name: normalizedName,
    d2Code,
    explanation,
    mcpPrompt,
    status: metadata.status,
  };
}

export async function createProject(projectName: string): Promise<ProjectState> {
  await ensureRoot();

  const baseName = normalizeProjectName(projectName);
  let candidateName = baseName;
  let suffix = 2;

  while (true) {
    const candidatePath = getProjectDir(candidateName);
    try {
      await fs.access(candidatePath);
      candidateName = `${baseName}-${suffix}`;
      suffix += 1;
    } catch {
      break;
    }
  }

  const projectPath = getProjectDir(candidateName);
  await fs.mkdir(projectPath, { recursive: true });
  
  const initialMetadata: ProjectMetadata = {
    status: 'not_deployed',
    updatedAt: new Date().toISOString(),
  };

  await Promise.all([
    fs.writeFile(path.join(projectPath, PROJECT_DIAGRAM_FILE), '', 'utf8'),
    fs.writeFile(path.join(projectPath, PROJECT_EXPLANATION_FILE), '', 'utf8'),
    fs.writeFile(path.join(projectPath, PROJECT_MCP_PROMPT_FILE), '', 'utf8'),
    fs.writeFile(path.join(projectPath, PROJECT_WORKFLOW_FILE), '[]\n', 'utf8'),
    fs.writeFile(path.join(projectPath, PROJECT_METADATA_FILE), JSON.stringify(initialMetadata, null, 2), 'utf8'),
  ]);

  return {
    name: candidateName,
    d2Code: '',
    explanation: '',
    mcpPrompt: '',
    status: 'not_deployed',
  };
}

export async function saveProjectState(projectName: string, d2Code: string, explanation: string, mcpPrompt: string) {
  await ensureRoot();
  const normalizedName = normalizeProjectName(projectName);
  const projectPath = getProjectDir(normalizedName);

  await fs.mkdir(projectPath, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(projectPath, PROJECT_DIAGRAM_FILE), d2Code ?? '', 'utf8'),
    fs.writeFile(path.join(projectPath, PROJECT_EXPLANATION_FILE), explanation ?? '', 'utf8'),
    fs.writeFile(path.join(projectPath, PROJECT_MCP_PROMPT_FILE), mcpPrompt ?? '', 'utf8'),
  ]);

  return readProjectState(normalizedName);
}

export async function deleteProject(projectName: string) {
  const normalizedName = normalizeProjectName(projectName);
  await fs.rm(getProjectDir(normalizedName), { recursive: true, force: true });
}

export function sanitizeProjectName(projectName: string) {
  return normalizeProjectName(projectName);
}

export async function readProjectWorkflow(projectName: string): Promise<WorkflowEntry[]> {
  await ensureRoot();
  return readJsonArrayIfExists(getWorkflowPath(normalizeProjectName(projectName)));
}

export async function appendProjectWorkflow(projectName: string, entries: WorkflowEntry | WorkflowEntry[]) {
  await ensureRoot();

  const normalizedName = normalizeProjectName(projectName);
  const nextEntries = Array.isArray(entries) ? entries : [entries];
  const currentEntries = await readProjectWorkflow(normalizedName);
  const mergedEntries = [...currentEntries, ...nextEntries];

  const projectPath = getProjectDir(normalizedName);
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(getWorkflowPath(normalizedName), `${JSON.stringify(mergedEntries, null, 2)}\n`, 'utf8');

  return mergedEntries;
}
