'use client';

/** 구조화 프롬프트 렌더 — parsePrompt 블록을 섹션/목록/체크리스트로(날것 텍스트 X). */
import { CheckSquare, Square } from 'lucide-react';
import { parsePrompt } from '@/lib/parsePrompt';

export default function StructuredPrompt({ body }: { body: string }) {
  const blocks = parsePrompt(body);
  if (!body?.trim()) return <p className="text-xs text-muted-foreground">(설명/프롬프트 없음)</p>;
  return (
    <div className="space-y-3 text-sm">
      {blocks.map((b, i) => {
        if (b.type === 'heading') return <h4 key={i} className="text-xs font-semibold uppercase tracking-wide text-primary mt-1">{b.text}</h4>;
        if (b.type === 'para') return <p key={i} className="text-[13px] leading-relaxed text-foreground/90 whitespace-pre-wrap break-words">{b.text}</p>;
        if (b.type === 'bullets') return (
          <ul key={i} className="space-y-1">
            {b.items.map((it, j) => <li key={j} className="flex gap-2 text-[13px] text-foreground/90"><span className="text-muted-foreground shrink-0 mt-0.5">•</span><span className="break-words">{it}</span></li>)}
          </ul>
        );
        if (b.type === 'numbered') return (
          <ol key={i} className="space-y-1">
            {b.items.map((it, j) => <li key={j} className="flex gap-2 text-[13px] text-foreground/90"><span className="text-muted-foreground shrink-0 tabular-nums">{j + 1}.</span><span className="break-words">{it}</span></li>)}
          </ol>
        );
        if (b.type === 'checklist') return (
          <ul key={i} className="space-y-1">
            {b.items.map((it, j) => (
              <li key={j} className="flex gap-2 text-[13px] text-foreground/90">
                {it.checked ? <CheckSquare className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" /> : <Square className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />}
                <span className={`break-words ${it.checked ? 'line-through text-muted-foreground' : ''}`}>{it.text}</span>
              </li>
            ))}
          </ul>
        );
        return null;
      })}
    </div>
  );
}
