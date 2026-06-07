import { NextResponse } from 'next/server';
import { deleteProject, readProjectState, saveProjectState } from '@/lib/persistence';

export const runtime = 'nodejs';
export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ projectName: string }>;
}

export async function GET(_req: Request, context: RouteContext) {
  const { projectName } = await context.params;
  const state = await readProjectState(projectName);
  return NextResponse.json(state);
}

export async function PUT(req: Request, context: RouteContext) {
  const { projectName } = await context.params;
  const body = (await req.json().catch(() => ({}))) as { d2Code?: string; explanation?: string; mcpPrompt?: string };
  const state = await saveProjectState(projectName, body.d2Code || '', body.explanation || '', body.mcpPrompt || '');
  return NextResponse.json(state);
}

export async function DELETE(_req: Request, context: RouteContext) {
  const { projectName } = await context.params;
  await deleteProject(projectName);
  return NextResponse.json({ ok: true });
}
