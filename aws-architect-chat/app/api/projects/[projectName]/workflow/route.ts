import { NextResponse } from 'next/server';
import { appendProjectWorkflow, readProjectWorkflow, sanitizeProjectName, type WorkflowEntry } from '@/lib/persistence';

export const runtime = 'nodejs';
export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ projectName: string }>;
}

export async function GET(_req: Request, context: RouteContext) {
  const { projectName } = await context.params;
  const normalizedName = sanitizeProjectName(projectName);
  const workflow = await readProjectWorkflow(normalizedName);
  return NextResponse.json({ projectName: normalizedName, workflow });
}

export async function POST(req: Request, context: RouteContext) {
  const { projectName } = await context.params;
  const normalizedName = sanitizeProjectName(projectName);
  const body = (await req.json().catch(() => ({}))) as { entry?: WorkflowEntry; entries?: WorkflowEntry[] };

  const incomingEntries = Array.isArray(body.entries) ? body.entries : body.entry ? [body.entry] : [];

  if (incomingEntries.length === 0) {
    return NextResponse.json({ error: 'No workflow entries provided.' }, { status: 400 });
  }

  const merged = await appendProjectWorkflow(normalizedName, incomingEntries);
  return NextResponse.json({ projectName: normalizedName, workflow: merged });
}