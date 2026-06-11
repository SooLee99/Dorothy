'use client';

/**
 * Phase 6-AH — 화면별 기능 설명 배너. 현재 경로에 맞는 한 줄 설명을 콘텐츠 상단에
 * 표시한다. 설명이 없는 경로(예: 루트 대시보드)는 아무것도 렌더하지 않는다.
 */

import { usePathname } from 'next/navigation';
import { Info } from 'lucide-react';
import { screenDescriptionFor } from '@/lib/screenDescriptions';

export default function ScreenDescription() {
  const pathname = usePathname();
  const info = screenDescriptionFor(pathname);
  if (!info) return null;
  return (
    <div className="mb-3 flex items-start gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
      <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-cyan-400" />
      <p>
        <span className="font-medium text-foreground">{info.title}</span>
        <span className="mx-1.5 opacity-40">·</span>
        {info.description}
      </p>
    </div>
  );
}
