import { cn } from '@/lib/utils';
import { User, Bot } from 'lucide-react';

interface MessageBubbleProps {
  role: 'user' | 'assistant' | 'error';
  content: string;
}

export default function MessageBubble({ role, content }: MessageBubbleProps) {
  const isUser = role === 'user';
  const isError = role === 'error';
  const isAssistant = role === 'assistant';

  return (
    <div className={cn(
      "flex w-full gap-4 p-6",
      isUser ? "bg-white" : (isAssistant ? "bg-slate-50 border-y border-slate-100" : "bg-red-50 border-y border-red-100")
    )}>
      <div className="max-w-4xl mx-auto flex gap-4 w-full">
        <div className={cn(
          "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
          isUser ? "bg-slate-200" : (isError ? "bg-red-500" : "bg-orange-500")
        )}>
          {isUser ? <User className="w-5 h-5 text-slate-600" /> : <Bot className="w-5 h-5 text-white" />}
        </div>
        <div className="flex-1 space-y-4">
          <p className={cn(
            "text-sm font-semibold uppercase tracking-wider",
            isError ? "text-red-600" : "text-slate-900"
          )}>
            {isUser ? 'You' : (isError ? 'System Error' : 'AWS Cloud Architect')}
          </p>
          <div className={cn(
            "prose prose-slate max-w-none leading-relaxed whitespace-pre-wrap",
            isError ? "text-red-700 font-medium" : "text-slate-700"
          )}>
            {content}
          </div>
        </div>
      </div>
    </div>
  );
}
