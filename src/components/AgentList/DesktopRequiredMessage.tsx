'use client';

import { MonitorDown } from 'lucide-react';

export function DesktopRequiredMessage() {
  return (
    <div className="flex items-center justify-center h-[60vh]">
      <div className="text-center max-w-md">
        <div className="w-20 h-20 rounded-none bg-accent-purple/20 flex items-center justify-center mx-auto mb-6">
          <MonitorDown className="w-10 h-10 text-accent-purple" />
        </div>
        <h2 className="text-2xl font-bold mb-3">데스크톱 앱이 필요합니다</h2>
        <p className="text-text-secondary mb-6">
          에이전트 컨트롤 센터는 터미널 명령 실행과 Claude Code 에이전트 관리를 위해 데스크톱 애플리케이션이 필요합니다.
        </p>
        <div className="space-y-3">
          <div className="p-4 rounded-none bg-bg-tertiary border border-border-primary">
            <p className="text-sm font-medium mb-2">데스크톱 앱 실행 방법:</p>
            <code className="block p-2 rounded bg-[#0d0e12] text-accent-blue text-xs font-mono">
              npm run electron:dev
            </code>
          </div>
          <p className="text-xs text-text-muted">
            또는 Mac 앱 빌드: <code className="text-accent-purple">npm run electron:build</code>
          </p>
        </div>
      </div>
    </div>
  );
}
