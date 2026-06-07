import { Cloud } from 'lucide-react';

export default function Header() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-white/80 backdrop-blur-md border-b border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cloud className="w-8 h-8 text-orange-500" />
          <span className="font-bold text-xl tracking-tight text-slate-900">
            AWS<span className="text-orange-500">Architect</span> AI
          </span>
        </div>
        <nav className="hidden md:flex items-center gap-6">
          <a href="#" className="text-sm font-medium text-slate-600 hover:text-orange-500 transition-colors">Documentation</a>
          <a href="#" className="text-sm font-medium text-slate-600 hover:text-orange-500 transition-colors">AWS Best Practices</a>
        </nav>
      </div>
    </header>
  );
}
