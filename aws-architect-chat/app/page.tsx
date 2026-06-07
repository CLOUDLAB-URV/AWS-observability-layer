import Header from '@/components/Header';
import ChatInterface from '@/components/ChatInterface';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AWS Architect AI - Expert Cloud Design Assistant',
  description: 'Design production-ready AWS architectures with our AI-powered Cloud Architect. Get D2 diagrams and best practices instantly.',
  keywords: 'AWS, Cloud Architecture, D2 Diagrams, Serverless, AI, Next.js, Cloud Architect',
  openGraph: {
    title: 'AWS Architect AI - Expert Cloud Design Assistant',
    description: 'Design production-ready AWS architectures with our AI-powered Cloud Architect.',
    type: 'website',
  },
};

export default function Home() {
  return (
    <main className="min-h-[100dvh] overflow-x-hidden bg-white selection:bg-orange-100 selection:text-orange-900">
      <Header />
      {/* The ChatInterface is isolated as a Client Component */}
      <ChatInterface />
    </main>
  );
}
