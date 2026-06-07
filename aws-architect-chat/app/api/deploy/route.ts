import fs from 'fs';
import path from 'path';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText, tool, jsonSchema, CoreTool, CoreMessage } from 'ai';
import { 
  readProjectState, 
  sanitizeProjectName, 
  readProjectWorkflow, 
  updateProjectStatus, 
  readProjectDeployContext, 
  saveProjectDeployContext, 
  clearProjectDeployContext 
} from '@/lib/persistence';

export const runtime = 'nodejs';
export const maxDuration = 120;

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

  const payload = (await response.json()) as { tools?: Array<{ name?: string; description?: string; inputSchema?: any }> };
  return Array.isArray(payload.tools) ? payload.tools.filter((t) => t?.name) : [];
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    model?: string;
    projectName?: string;
    action?: 'deploy' | 'teardown';
    continue?: boolean; // New flag to signal continuation of existing context
  };

  const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'Google API Key is missing.' }, { status: 500 });
  }

  const normalizedProjectName = typeof body.projectName === 'string' ? sanitizeProjectName(body.projectName) : '';
  if (!normalizedProjectName) {
    return Response.json({ error: 'projectName is required.' }, { status: 400 });
  }

  if (!body.model) {
    return Response.json({ error: 'A model must be selected from the Model Engine.' }, { status: 400 });
  }

  const action = body.action || 'deploy';

  const googleProvider = createGoogleGenerativeAI({ apiKey });
  const selectedModel = googleProvider(body.model);

  const projectState = await readProjectState(normalizedProjectName);
  
  let mcpPrompt = '';
  let systemPrompt = '';

  // Setup prompts
  if (action === 'teardown') {
    const teardownPromptPath = path.join(process.cwd(), 'prompts', 'aws_delete_workflow.md');
    const teardownPromptTemplate = readTextFileIfExists(teardownPromptPath);
    const workflowLogs = await readProjectWorkflow(normalizedProjectName);
    
    mcpPrompt = teardownPromptTemplate.replace('[STATE_WORKFLOW]', JSON.stringify(workflowLogs, null, 2));
    
    systemPrompt = [
      'You are an expert AWS cloud administrator specializing in resource decommissioning.',
      'Your absolute priority is to perform a 100% clean teardown of all resources identified in the provided workflow state.',
      'Follow the dependency-aware deletion sequence strictly to avoid errors.',
      'Use the provided tools to execute AWS actions.',
      'This is a multi-step autonomous workflow. Do not stop until all identified resources are deleted.',
      `Project context: ${normalizedProjectName} (TEARDOWN MODE)`,
    ].join('\n\n');
  } else {
    const promptFilePath = path.join(process.cwd(), 'persistence', normalizedProjectName, 'MCP_prompt.md');
    const fallbackPromptPath = path.join(process.cwd(), 'prompts', 'backup.md');
    mcpPrompt = projectState.mcpPrompt || readTextFileIfExists(promptFilePath) || readTextFileIfExists(fallbackPromptPath);
    
    systemPrompt = [
      'You are an expert AWS cloud architect and autonomous deployment operator.',
      'CRITICAL AGENT INSTRUCTIONS:',
      '1. You are running in an automated, multi-step continuous loop.',
      '2. You MUST complete the ENTIRE deployment plan before stopping. Do NOT stop after creating just one resource.',
      '3. Execute tools sequentially: call a tool, parse its response to get IDs (like VpcId), and immediately use those IDs in your NEXT tool call.',
      '4. Maintain your own internal state by reading the tool outputs in the conversation history.',
      '5. Do NOT ask for user confirmation. Do NOT output conversational text between steps. Tool results are your confirmation.',
      '6. ONLY when the ENTIRE architecture is fully deployed and verified, you MUST output the exact phrase "---DEPLOYMENT_COMPLETE---".',
      '7. Use the provided tools to provision and verify the requested AWS resources.',
      'Prefer low-cost test resources such as t2.nano or the closest equivalent if the requested type is unavailable.',
      'Report progress only when major milestones are reached or at the very end.',
      `Project context: ${normalizedProjectName}`,
    ].join('\n\n');
  }

  try {
    // Context Management (Option B)
    let messages: CoreMessage[] = [];
    
    if (body.continue) {
      // Load existing context
      messages = await readProjectDeployContext(normalizedProjectName) as CoreMessage[];
      if (messages.length === 0) {
        // Fallback to start if no context found
        messages = [{ role: 'user', content: mcpPrompt }];
      } else {
        // Add a strong nudge to continue
        messages.push({ 
          role: 'user', 
          content: 'You stopped before finishing. Look at the deployment plan and the resources you already created (check IDs in previous tool results). CONTINUE with the NEXT steps now. Do not stop or talk until the entire architecture is finished and you can say "---DEPLOYMENT_COMPLETE---".' 
        });
      }
    } else {
      // Start fresh
      await clearProjectDeployContext(normalizedProjectName);
      messages = [{ role: 'user', content: mcpPrompt }];
    }

    const proxyTools = await fetchProxyTools();
    const dynamicTools: Record<string, CoreTool> = {};
    
    for (const toolDef of proxyTools) {
      if (!toolDef.name) continue;

      dynamicTools[toolDef.name] = tool({
        description: toolDef.description || `AWS MCP Tool: ${toolDef.name}`,
        parameters: jsonSchema(toolDef.inputSchema || {}),
        execute: async (args) => {
          const response = await fetch(`${PROXY_URL}/invoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toolName: toolDef.name, arguments: args }),
          });

          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(payload.error || `Proxy invocation failed for ${toolDef.name}`);
          }
          return payload;
        },
      });
    }

    if (Object.keys(dynamicTools).length === 0) {
      return Response.json({ error: 'No AWS MCP tools were returned by the local proxy.' }, { status: 500 });
    }

    const result = streamText({
      model: selectedModel,
      system: systemPrompt,
      messages: messages,
      tools: dynamicTools,
      maxSteps: 20,
      onFinish: async (event) => {
        // Save the updated context
        const updatedMessages = [...messages, ...event.response.messages];
        await saveProjectDeployContext(normalizedProjectName, updatedMessages);

        if (action === 'teardown') {
          // Only mark as not deployed if we think we finished
          // For now we keep it simple, but we could check if there are pending resources
          await updateProjectStatus(normalizedProjectName, 'not_deployed', 'teardown');
        } else {
          await updateProjectStatus(normalizedProjectName, 'deployed', 'deploy');
        }
      },
    });

    return result.toTextStreamResponse();
  } catch (error: any) {
    return Response.json({ error: error.message || 'Failed to initialize deployment workflow.' }, { status: 500 });
  }
}
