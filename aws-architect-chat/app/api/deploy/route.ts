import fs from 'fs';
import path from 'path';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText, tool } from 'ai';
import { z } from 'zod';
import { readProjectState, sanitizeProjectName, readProjectWorkflow, updateProjectStatus } from '@/lib/persistence';

export const runtime = 'nodejs';
export const maxDuration = 120;

const DEFAULT_MODEL = 'gemini-1.5-flash';
const PROXY_URL = process.env.AWS_MCP_PROXY_URL || 'http://127.0.0.1:8787';

function readTextFileIfExists(filePath: string) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function fetchProxyTools() {
  const response = await fetch(`${PROXY_URL}/tools`);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Unable to load proxy tools: ${errorText || response.statusText}`);
  }

  const payload = (await response.json()) as { tools?: Array<{ name?: string; description?: string }> };
  return Array.isArray(payload.tools) ? payload.tools.filter((toolDefinition) => toolDefinition?.name) : [];
}

function buildToolCatalogText(tools: Array<{ name?: string; description?: string }>) {
  if (tools.length === 0) {
    return 'No AWS MCP tools were returned by the local proxy.';
  }

  return tools
    .map((toolDefinition) => `- ${toolDefinition.name}: ${toolDefinition.description || 'AWS MCP tool'}`)
    .join('\n');
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    model?: string;
    projectName?: string;
    action?: 'deploy' | 'teardown';
  };

  const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'Google API Key is missing.' }, { status: 500 });
  }

  const normalizedProjectName = typeof body.projectName === 'string' ? sanitizeProjectName(body.projectName) : '';
  if (!normalizedProjectName) {
    return Response.json({ error: 'projectName is required.' }, { status: 400 });
  }

  const action = body.action || 'deploy';

  const googleProvider = createGoogleGenerativeAI({ apiKey });
  const modelId = body.model || DEFAULT_MODEL;
  const selectedModel = googleProvider(modelId);

  const projectState = await readProjectState(normalizedProjectName);
  
  let mcpPrompt = '';
  let systemPrompt = '';

  if (action === 'teardown') {
    const teardownPromptPath = path.join(process.cwd(), 'prompts', 'aws_delete_workflow.md');
    const teardownPromptTemplate = readTextFileIfExists(teardownPromptPath);
    const workflowLogs = await readProjectWorkflow(normalizedProjectName);
    
    mcpPrompt = teardownPromptTemplate.replace('[STATE_WORKFLOW]', JSON.stringify(workflowLogs, null, 2));
    
    systemPrompt = [
      'You are an expert AWS cloud administrator specializing in resource decommissioning.',
      'Your absolute priority is to perform a 100% clean teardown of all resources identified in the provided workflow state.',
      'Follow the dependency-aware deletion sequence strictly to avoid errors.',
      'Use the provided AWS MCP proxy tool for all deletions.',
      `Project context: ${normalizedProjectName} (TEARDOWN MODE)`,
    ].join('\n\n');
    
    // Update status to not_deployed
    await updateProjectStatus(normalizedProjectName, 'not_deployed', 'teardown');
  } else {
    const promptFilePath = path.join(process.cwd(), 'persistence', normalizedProjectName, 'MCP_prompt.md');
    const fallbackPromptPath = path.join(process.cwd(), 'prompts', 'backup.md');
    mcpPrompt = projectState.mcpPrompt || readTextFileIfExists(promptFilePath) || readTextFileIfExists(fallbackPromptPath);
    
    systemPrompt = [
      'You are an expert AWS cloud architect and deployment operator.',
      'Use the provided AWS MCP proxy tool to provision, verify, and tear down the requested AWS resources.',
      'Prefer low-cost test resources such as t2.nano or the closest equivalent if the requested type is unavailable.',
      'Report progress concisely and keep the workflow suitable for real-time logging.',
      `Project context: ${normalizedProjectName}`,
    ].join('\n\n');

    // Update status to deployed
    await updateProjectStatus(normalizedProjectName, 'deployed', 'deploy');
  }

  const proxyTools = await fetchProxyTools();
  const toolCatalog = buildToolCatalogText(proxyTools);

  const awsMcp = tool({
    description: `Proxy any AWS MCP tool through the local MCP bridge. Available tools:\n${toolCatalog}`,
    inputSchema: z.object({
      toolName: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()).default({}),
    }),
    execute: async ({ toolName, arguments: toolArguments }) => {
      const response = await fetch(`${PROXY_URL}/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolName, arguments: toolArguments }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Proxy invocation failed for ${toolName}`);
      }

      return payload;
    },
  });

  const finalSystemPrompt = `${systemPrompt}\n\nAWS MCP tools exposed by the proxy:\n${toolCatalog}`;

  const result = streamText({
    model: selectedModel,
    system: finalSystemPrompt,
    prompt: mcpPrompt,
    tools: {
      aws_mcp: awsMcp,
    },
  });

  return result.toTextStreamResponse();
}
