import { D2 } from '@terrastruct/d2';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 30;

let renderer: D2 | null = null;

function getRenderer() {
  if (!renderer) {
    renderer = new D2();
  }
  return renderer;
}

export async function POST(req: Request) {
  try {
    const { d2Code } = (await req.json()) as { d2Code?: string };
    const source = (d2Code || '').trim();

    if (!source) {
      return NextResponse.json({ svg: '' });
    }

    const d2 = getRenderer();
    const compiled = await d2.compile(source);
    const svg = await d2.render(compiled.diagram, {
      ...compiled.renderOptions,
      center: true,
      scale: 1,
      pad: 48,
    });

    return NextResponse.json({ svg: typeof svg === 'string' ? svg : String(svg) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
