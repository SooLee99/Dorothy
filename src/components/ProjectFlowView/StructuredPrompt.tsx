'use client';

/** 구조화 프롬프트 렌더 — parsePrompt 블록을 섹션/목록/체크리스트로(날것 텍스트 X).
 *  마크다운: 인라인 **굵게**·`코드` 렌더 + "체크리스트/검증/AC" 헤딩 하위 항목은 체크박스로. */
import { Fragment } from 'react';
import { Square } from 'lucide-react';
import { parsePrompt } from '@/lib/parsePrompt';

const CHECKLIST_HEAD = /체크리스트|checklist|검증|acceptance|\bac\b|criteria|완료\s*조건|done\s*when/i;

// 인라인 마크다운: **굵게**, `코드`(나머지는 평문). 카드·팝업 공용.
export function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={i} className="font-semibold text-foreground">{p.slice(2, -2)}</strong>;
    if (/^`[^`]+`$/.test(p)) return <code key={i} className="px-1 py-0.5 rounded bg-secondary text-[0.92em] font-mono">{p.slice(1, -1)}</code>;
    return <Fragment key={i}>{p}</Fragment>;
  });
}
/** 카드 인라인 요약 — 마크다운 기호 렌더(평문 span). */
export function InlineMd({ text }: { text: string }) {
  return <>{renderInline(text)}</>;
}

function CheckItems({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1">
      {items.map((it, j) => (
        <li key={j} className="flex gap-2 text-[13px] text-foreground/90">
          <Square className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <span className="break-words">{renderInline(it)}</span>
        </li>
      ))}
    </ul>
  );
}

export default function StructuredPrompt({ body }: { body: string }) {
  const blocks = parsePrompt(body);
  if (!body?.trim()) return <p className="text-xs text-muted-foreground">(설명/프롬프트 없음)</p>;
  let lastHeadingChecklist = false; // 직전 헤딩이 체크리스트류면 다음 목록을 체크박스로
  return (
    <div className="space-y-3 text-sm">
      {blocks.map((b, i) => {
        if (b.type === 'heading') {
          lastHeadingChecklist = CHECKLIST_HEAD.test(b.text);
          return <h4 key={i} className="text-xs font-semibold uppercase tracking-wide text-primary mt-1">{renderInline(b.text)}</h4>;
        }
        if (b.type === 'para') { lastHeadingChecklist = false; return <p key={i} className="text-[13px] leading-relaxed text-foreground/90 whitespace-pre-wrap break-words">{renderInline(b.text)}</p>; }
        if (b.type === 'checklist') return (
          <ul key={i} className="space-y-1">
            {b.items.map((it, j) => (
              <li key={j} className="flex gap-2 text-[13px] text-foreground/90">
                {it.checked ? <Square className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5 fill-emerald-500/20" /> : <Square className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />}
                <span className={`break-words ${it.checked ? 'line-through text-muted-foreground' : ''}`}>{renderInline(it.text)}</span>
              </li>
            ))}
          </ul>
        );
        if (b.type === 'bullets') {
          if (lastHeadingChecklist) return <CheckItems key={i} items={b.items} />;
          return (
            <ul key={i} className="space-y-1">
              {b.items.map((it, j) => <li key={j} className="flex gap-2 text-[13px] text-foreground/90"><span className="text-muted-foreground shrink-0 mt-0.5">•</span><span className="break-words">{renderInline(it)}</span></li>)}
            </ul>
          );
        }
        if (b.type === 'numbered') {
          if (lastHeadingChecklist) return <CheckItems key={i} items={b.items} />;
          return (
            <ol key={i} className="space-y-1">
              {b.items.map((it, j) => <li key={j} className="flex gap-2 text-[13px] text-foreground/90"><span className="text-muted-foreground shrink-0 tabular-nums">{j + 1}.</span><span className="break-words">{renderInline(it)}</span></li>)}
            </ol>
          );
        }
        return null;
      })}
    </div>
  );
}
