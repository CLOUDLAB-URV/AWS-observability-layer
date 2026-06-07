import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText } from 'ai';
import fs from 'fs';
import path from 'path';
import { readProjectState, sanitizeProjectName } from '@/lib/persistence';

export const maxDuration = 30;

export async function POST(req: Request) {
  const { prompt: userInput, model, d2State, explanationState, mcpState, projectName } = await req.json();

  const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  if (!apiKey) {
    throw new Error('Google API Key is missing.');
  }

  const googleProvider = createGoogleGenerativeAI({ apiKey });
  const modelId = model || 'gemini-1.5-flash';
  const selectedModel = googleProvider(modelId);

  // Read System Prompt from design.md
  const promptPath = path.join(process.cwd(), 'prompts', 'design.md');
  let systemPrompt = fs.readFileSync(promptPath, 'utf8');

  const normalizedProjectName = typeof projectName === 'string' ? sanitizeProjectName(projectName) : '';
  let currentD2State = typeof d2State === 'string' ? d2State : '';
  let currentExplanationState = typeof explanationState === 'string' ? explanationState : '';
  let currentMcpState = typeof mcpState === 'string' ? mcpState : '';

  if (normalizedProjectName) {
    try {
      const persisted = await readProjectState(normalizedProjectName);
      currentD2State = persisted.d2Code || currentD2State;
      currentExplanationState = persisted.explanation || currentExplanationState;
      currentMcpState = persisted.mcpPrompt || currentMcpState;
    } catch {
      // Fall back to the in-flight body state if the project does not exist yet.
    }
  }

  // Inject D2 State
  systemPrompt = systemPrompt.replace('[D2_CURRENT_STATE]', currentD2State || '');
  systemPrompt = systemPrompt.replace('[EXPLANATION_CURRENT_STATE]', currentExplanationState || '');
  systemPrompt = systemPrompt.replace('[MCP_CURRENT_STATE]', currentMcpState || '');

  // Stateless call: only current input + system prompt
  const result = streamText({
    model: selectedModel,
    system: systemPrompt,
    prompt: userInput,
  });

  return result.toTextStreamResponse();
}
