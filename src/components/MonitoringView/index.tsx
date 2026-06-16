'use client';

/**
 * 로드맵 2번 — 모니터링(실시간 감시) 화면.
 *
 * 기존 대시보드(/)의 메인 뷰 영역(터미널/보드/3D 토글)을 그대로 옮겨온 것.
 * 대시보드는 "한눈에 보는 요약", 모니터링은 "라이브 감시"로 역할 분리.
 * 메인 뷰 3개(TerminalsView/CanvasView/AgentWorld)는 next/dynamic으로 SSR
 * 격리된 독립 컴포넌트라 라우트만 바뀔 뿐 동작은 기존과 동일하다.
 */

import { useState, Component, ReactNode } from 'react';
import { Loader2, Globe, AlertTriangle, LayoutGrid, TerminalSquare, Activity } from 'lucide-react';
import { useClaude } from '@/hooks/useClaude';
import dynamic from 'next/dynamic';

// Dynamically import CanvasView to avoid SSR issues
const CanvasView = dynamic(() => import('@/components/CanvasView'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full min-h-[600px] bg-card border border-border">
      <div className="text-center">
        <Loader2 className="w-8 h-8 animate-spin text-foreground mx-auto mb-4" />
        <p className="text-muted-foreground">Loading Board...</p>
      </div>
    </div>
  ),
});

// Error boundary for 3D world
class WorldErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error?: Error }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-full min-h-[600px] bg-card border border-border">
          <div className="text-center p-8">
            <AlertTriangle className="w-12 h-12 text-warning mx-auto mb-4" />
            <h3 className="text-lg font-medium mb-2 text-foreground">3D World Failed to Load</h3>
            <p className="text-muted-foreground text-sm mb-4">
              {this.state.error?.message || 'An error occurred loading the 3D view'}
            </p>
            <button
              onClick={() => this.setState({ hasError: false })}
              className="px-4 py-2 bg-foreground text-background hover:bg-foreground/80"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Dynamically import AgentWorld to avoid SSR issues with Three.js
const AgentWorld = dynamic(() => import('@/components/AgentWorld'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full min-h-[600px] bg-card border border-border">
      <div className="text-center">
        <Loader2 className="w-8 h-8 animate-spin text-foreground mx-auto mb-4" />
        <p className="text-muted-foreground">Loading 3D World...</p>
      </div>
    </div>
  ),
});

// Dynamically import TerminalsView to avoid SSR issues with xterm
const TerminalsView = dynamic(() => import('@/components/TerminalsView'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full min-h-[600px] bg-card border border-border">
      <div className="text-center">
        <Loader2 className="w-8 h-8 animate-spin text-foreground mx-auto mb-4" />
        <p className="text-muted-foreground">Loading Terminals...</p>
      </div>
    </div>
  ),
});

export default function MonitoringView() {
  const { data } = useClaude();
  const [viewMode, setViewMode] = useState<'world' | 'canvas' | 'terminals'>('terminals');

  const activeSessions = data?.activeSessions || [];

  return (
    <div className="space-y-4 lg:space-y-6 pt-4 lg:pt-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Activity className="w-6 h-6" /> 모니터링
          </h1>
          <p className="text-muted-foreground text-xs lg:text-sm mt-1 hidden sm:block">
            AI 에이전트를 실시간으로 감시 — 터미널·보드·3D 뷰
          </p>
        </div>
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4">
          {/* View Mode Toggle */}
          <div className="flex items-center gap-1 p-1 bg-secondary border border-border [&_button]:cursor-pointer" style={{ borderRadius: 10 }}>
            <button
              onClick={() => setViewMode('terminals')}
              className={`
                flex items-center gap-1.5 lg:gap-2 px-2 lg:px-3 py-1.5 text-xs lg:text-sm font-medium transition-all
                ${viewMode === 'terminals'
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground'
                }
              `}
              style={{ borderRadius: 7 }}
            >
              <TerminalSquare className="w-3.5 h-3.5 lg:w-4 lg:h-4" />
              <span className="hidden sm:inline">터미널</span>
              <span className="sm:hidden">터미널</span>
            </button>

            <button
              onClick={() => setViewMode('canvas')}
              className={`
                flex items-center gap-1.5 lg:gap-2 px-2 lg:px-3 py-1.5 text-xs lg:text-sm font-medium transition-all
                ${viewMode === 'canvas'
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground'
                }
              `}
              style={{ borderRadius: 7 }}
            >
              <LayoutGrid className="w-3.5 h-3.5 lg:w-4 lg:h-4" />
              보드
            </button>
            <button
              onClick={() => setViewMode('world')}
              className={`
                flex items-center gap-1.5 lg:gap-2 px-2 lg:px-3 py-1.5 text-xs lg:text-sm font-medium transition-all
                ${viewMode === 'world'
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground'
                }
              `}
              style={{ borderRadius: 7 }}
            >
              <Globe className="w-3.5 h-3.5 lg:w-4 lg:h-4" />
              <span className="hidden sm:inline">3D 뷰</span>
              <span className="sm:hidden">3D</span>
            </button>
          </div>

          <div className="text-right text-xs text-muted-foreground hidden sm:block">
            <div className="flex items-center gap-2 justify-end">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
              </span>
              <span>활성 세션 {activeSessions.length}개</span>
            </div>
          </div>
        </div>
      </div>

      {/* 3D World View */}
      {viewMode === 'world' && (
        <div
          className="border border-border bg-card overflow-hidden"
          style={{ height: 'calc(100vh - 200px)', minHeight: '400px' }}
        >
          <WorldErrorBoundary>
            <AgentWorld />
          </WorldErrorBoundary>
        </div>
      )}

      {/* Canvas View */}
      {viewMode === 'canvas' && (
        <div
          className="border border-border bg-card overflow-hidden"
          style={{ height: 'calc(100vh - 200px)', minHeight: '400px' }}
        >
          <CanvasView />
        </div>
      )}

      {/* Terminals View */}
      {viewMode === 'terminals' && (
        <div
          className="border border-border bg-card overflow-hidden"
          style={{ height: 'calc(100vh - 130px)', minHeight: '400px' }}
        >
          <TerminalsView />
        </div>
      )}
    </div>
  );
}
