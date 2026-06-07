import fs from 'fs/promises';
import path from 'path';

export const PERSISTENCE_ROOT = path.join(process.cwd(), 'persistence');
export const PROJECT_DIAGRAM_FILE = 'diagram.d2';
export const PROJECT_EXPLANATION_FILE = 'explanation.md';
export const PROJECT_MCP_PROMPT_FILE = 'MCP_prompt.md';

export interface ProjectSummary {
  name: string;
  updatedAt: string | null;
}

export interface ProjectState {
  name: string;
  d2Code: string;
  explanation: string;
  mcpPrompt: string;
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

    let updatedAt: string | null = null;
    for (const candidatePath of [diagramPath, explanationPath, mcpPath]) {
      try {
        const stats = await fs.stat(candidatePath);
        updatedAt = stats.mtime.toISOString();
        break;
      } catch {
        continue;
      }
    }

    summaries.push({ name: entry.name, updatedAt });
  }

  return summaries.sort((left, right) => left.name.localeCompare(right.name));
}

export async function readProjectState(projectName: string): Promise<ProjectState> {
  const normalizedName = normalizeProjectName(projectName);
  const projectPath = getProjectDir(normalizedName);
  const [d2Code, explanation, mcpPrompt] = await Promise.all([
    readTextFileIfExists(path.join(projectPath, PROJECT_DIAGRAM_FILE)),
    readTextFileIfExists(path.join(projectPath, PROJECT_EXPLANATION_FILE)),
    readTextFileIfExists(path.join(projectPath, PROJECT_MCP_PROMPT_FILE)),
  ]);

  return {
    name: normalizedName,
    d2Code,
    explanation,
    mcpPrompt,
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
  await Promise.all([
    fs.writeFile(path.join(projectPath, PROJECT_DIAGRAM_FILE), '', 'utf8'),
    fs.writeFile(path.join(projectPath, PROJECT_EXPLANATION_FILE), '', 'utf8'),
    fs.writeFile(path.join(projectPath, PROJECT_MCP_PROMPT_FILE), '', 'utf8'),
  ]);

  return {
    name: candidateName,
    d2Code: '',
    explanation: '',
    mcpPrompt: '',
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
