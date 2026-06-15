'use client';

import { Copy, Download, Pencil, Play, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { AgentTemplate } from '@/types/electron';

interface TemplateCardProps {
  template: AgentTemplate;
  installedSkills: string[];
  onUse: () => void;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onReset?: () => void;
  onExport?: () => void;
  onInstallSkill?: (skillName: string) => void;
}

export function TemplateCard({ template, installedSkills, onUse, onEdit, onDuplicate, onDelete, onReset, onExport, onInstallSkill }: TemplateCardProps) {
  const installedSet = new Set(installedSkills.map(s => s.toLowerCase()));
  const missingSkills = template.skills.filter(s => !installedSet.has(s.toLowerCase()));

  const providerLabel = template.provider.charAt(0).toUpperCase() + template.provider.slice(1);
  const modelLabel = template.model ? ` · ${template.model}` : '';

  return (
    <div className="flex flex-col bg-card border border-border p-4 hover:border-primary/40 transition-colors">
      <div className="flex items-start gap-3 mb-3">
        <div className="text-3xl shrink-0 leading-none">{template.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h3 className="font-semibold text-foreground truncate">{template.displayName}</h3>
            {template.builtin && !template.overridden && (
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground bg-secondary px-1.5 py-0.5">기본 제공</span>
            )}
            {template.builtin && template.overridden && (
              <span className="text-[10px] uppercase tracking-wider text-primary bg-primary/10 px-1.5 py-0.5">맞춤 설정됨</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {providerLabel}{modelLabel}
          </p>
        </div>
      </div>

      <p className="text-sm text-muted-foreground mb-3 line-clamp-2">{template.description}</p>

      {template.skills.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {template.skills.map(skill => {
            const installed = installedSet.has(skill.toLowerCase());
            if (installed) {
              return (
                <span
                  key={skill}
                  className="text-[10px] px-1.5 py-0.5 border bg-secondary border-border text-muted-foreground"
                  title="설치된 스킬"
                >
                  {skill}
                </span>
              );
            }
            if (onInstallSkill) {
              return (
                <button
                  key={skill}
                  onClick={(e) => { e.stopPropagation(); onInstallSkill(skill); }}
                  className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 border bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400 hover:bg-amber-500/20 hover:border-amber-500/50 transition-colors cursor-pointer"
                  title={`"${skill}" 스킬 설치`}
                >
                  <Plus className="w-2.5 h-2.5" />
                  {skill}
                </button>
              );
            }
            return (
              <span
                key={skill}
                className="text-[10px] px-1.5 py-0.5 border bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400"
                title="설치되지 않은 스킬 — 스킬 페이지에서 설치하세요"
              >
                {skill}
              </span>
            );
          })}
        </div>
      )}

      {missingSkills.length > 0 && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400 mb-3">
          아직 설치되지 않은 스킬 {missingSkills.length}개
        </p>
      )}

      <div className="mt-auto flex items-center gap-2 pt-2">
        <button
          onClick={onUse}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-foreground text-background text-xs font-medium hover:bg-foreground/90 transition-colors"
        >
          <Play className="w-3 h-3" />
          이 템플릿 사용
        </button>
        {onDuplicate && (
          <button
            onClick={onDuplicate}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            title="복제"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
        )}
        {onExport && (
          <button
            onClick={onExport}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            title="JSON으로 내보내기"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
        )}
        {onEdit && (
          <button
            onClick={onEdit}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            title="편집"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
        {onReset && (
          <button
            onClick={onReset}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            title="기본값으로 초기화"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        )}
        {onDelete && (
          <button
            onClick={onDelete}
            className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            title="삭제"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
