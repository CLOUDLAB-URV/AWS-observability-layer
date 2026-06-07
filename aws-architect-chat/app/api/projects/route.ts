import { NextResponse } from 'next/server';
import { createProject, listProjectSummaries } from '@/lib/persistence';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET() {
  const projects = await listProjectSummaries();
  return NextResponse.json(projects);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const name = body.name?.trim() || 'Proyecto';
  const project = await createProject(name);
  return NextResponse.json(project, { status: 201 });
}
