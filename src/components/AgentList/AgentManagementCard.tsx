'use client';

import { Play, Square, Pencil, Trash2, AlertTriangle, Crown, Clock, BookmarkPlus } from 'lucide-react';
import type { AgentStatus } from '@/types/electron';
import {
  STATUS_COLORS,
  CHARACTER_FACES,
  isSuperAgentCheck,
} from '@/app/agents/constants';
import { AGENT_STATUS_KO } from '@/lib/koreanLabels';

function formatTimeAgo(isoDate: string | undefined | null): string {
  if (typeof isoDate !== 'string' || !isoDate) return '최근 활동 없음';
  const t = new Date(isoDate).getTime();
  if (Number.isNaN(t)) return '최근 활동 없음';
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}

const CLAUDE_MODEL_RE = /opus|sonnet|haiku|claude/i;
const MAX_SKILL_BADGES = 3;

/** 사용자 친화 provider 라벨 + codex+opus 불일치 경고. */
function providerInfo(agent: AgentStatus): { label: string; model: string; mismatch: boolean } {
  const provider = (agent.provider || 'claude').toLowerCase();
  const model = (agent.model || '').trim();
  const isClaude = provider === 'claude';
  const label = isClaude ? 'Claude · 개발 작업' : provider === 'codex' ? 'Codex · 계획/검증' : provider;
  const mismatch = provider === 'codex' && CLAUDE_MODEL_RE.test(model);
  return { label, model: model || '기본 모델', mismatch };
}

interface AgentManagementCardProps {
  agent: AgentStatus;
  onClick: () => void;
  onEdit: () => void;
  onStart: () => void;
  onStop: () => void;
  onRemove: () => void;
  onSaveAsTemplate?: () => void;
}

export function AgentManagementCard({ agent, onClick, onEdit, onStart, onStop, onRemove, onSaveAsTemplate }: AgentManagementCardProps) {
  // Phase 6-X — undefined-safe field access. Slug/file-based agents may lack
  // skills / status / lastActivity; never assume their shape.
  const statusConfig = STATUS_COLORS[agent.status] ?? STATUS_COLORS.idle;
  const statusLabel = AGENT_STATUS_KO[agent.status] ?? (agent.status || '유휴');
  const skills = Array.isArray(agent.skills) ? agent.skills : [];
  const shownSkills = skills.slice(0, MAX_SKILL_BADGES);
  const extraSkills = Math.max(0, skills.length - MAX_SKILL_BADGES);
  const prov = providerInfo(agent);
  const isSuper = isSuperAgentCheck(agent);
  const isRunning = agent.status === 'running' || agent.status === 'waiting';
  const isError = agent.status === 'error';

  // Show the user's last prompt, not terminal output
  const lastPrompt = agent.currentTask || null;

  return (
    <div
      onClick={onClick}
      className={`
        group relative cursor-pointer transition-all border border-border bg-card hover:bg-accent/10
        ${isSuper ? 'border-l-[3px] border-l-amber-500/60' : ''}
        ${isRunning && !isSuper ? 'border-l-[3px] border-l-primary/60' : ''}
        ${isError ? 'border-l-[3px] border-l-red-500/60' : ''}
      `}
    >
      <div className="p-3">
        {/* Row 1: Avatar + Name + Status (top-right) */}
        <div className="flex items-center gap-2.5">
          <div className={`w-8 h-8 flex items-center justify-center shrink-0 text-base ${
            isSuper ? 'bg-gradient-to-br from-amber-500/30 to-yellow-600/20' : statusConfig.bg
          }`}>
            {isSuper ? '👑' : agent.character ? (CHARACTER_FACES[agent.character] || '🤖') : '🤖'}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              {isSuper && <Crown className="w-3 h-3 text-amber-600 shrink-0" />}
              <span className="font-medium text-sm truncate text-foreground">
                {agent.name || 'Unnamed Agent'}
              </span>
            </div>
          </div>

          {/* Status pill — top right */}
          <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0 ${
            isSuper && isRunning
              ? 'bg-amber-500/20 text-amber-400'
              : `${statusConfig.bg} ${statusConfig.text}`
          }`}>
            {statusLabel}
          </span>
        </div>

        {/* Row 2a: Provider (사용자 친화) */}
        <div className="flex items-center gap-1.5 mt-2">
          <span className="text-[11px] text-foreground/80">{prov.label} · {prov.model}</span>
          {prov.mismatch && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 inline-flex items-center gap-0.5" title="codex 에이전트에 Claude 모델이 지정됨">
              <AlertTriangle className="w-2.5 h-2.5" /> 모델 설정 확인 필요
            </span>
          )}
        </div>

        {/* Row 2: Project path */}
        <p className="text-[11px] text-muted-foreground mt-1 truncate font-mono" title={agent.projectPath}>
          {agent.projectPath}
        </p>

        {/* Row 3: Last user prompt */}
        {agent.pathMissing ? (
          <p className="text-xs text-amber-500 flex items-center gap-1 mt-1.5">
            <AlertTriangle className="w-3 h-3 shrink-0" />
            Path not found
          </p>
        ) : lastPrompt ? (
          <p className="text-xs text-muted-foreground/80 mt-1.5 line-clamp-2 leading-relaxed">
            {lastPrompt}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground/40 mt-1.5 italic">현재 작업 없음</p>
        )}

        {/* Skills — 최대 3개 + N */}
        {skills.length === 0 ? (
          <p className="text-[10px] text-muted-foreground/40 mt-2">스킬 없음</p>
        ) : (
          <div className="flex flex-wrap gap-1 mt-2" title={skills.join(', ')}>
            {shownSkills.map((skill) => (
              <span
                key={skill}
                className="px-1.5 py-0.5 rounded bg-accent-purple/15 text-accent-purple text-[10px] truncate max-w-[110px]"
                title={skill}
              >
                {skill}
              </span>
            ))}
            {extraSkills > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-[10px]" title={skills.join(', ')}>
                +{extraSkills}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Footer: timestamp + actions */}
      <div className="px-3 py-2 border-t border-border/40 flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {formatTimeAgo(agent.lastActivity)}
        </span>

        <div className="flex items-center gap-0.5 [&_button]:cursor-pointer" onClick={(e) => e.stopPropagation()}>
          {isRunning ? (
            <button
              onClick={onStop}
              className="p-1.5 hover:bg-red-500/10 rounded transition-colors"
              title="중지"
            >
              <Square className="w-3.5 h-3.5 text-red-400" />
            </button>
          ) : (
            <button
              onClick={onStart}
              disabled={agent.pathMissing}
              className="p-1.5 hover:bg-primary/10 rounded transition-colors disabled:opacity-30"
              title="시작"
            >
              <Play className="w-3.5 h-3.5 text-primary" />
            </button>
          )}
          <button
            onClick={onEdit}
            className="p-1.5 hover:bg-accent rounded transition-colors"
            title="편집"
          >
            <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
          {onSaveAsTemplate && (
            <button
              onClick={onSaveAsTemplate}
              className="p-1.5 hover:bg-primary/10 rounded transition-colors"
              title="템플릿으로 저장"
            >
              <BookmarkPlus className="w-3.5 h-3.5 text-muted-foreground hover:text-primary" />
            </button>
          )}
          <button
            onClick={onRemove}
            className="p-1.5 hover:bg-red-500/10 rounded transition-colors"
            title="삭제"
          >
            <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-red-400" />
          </button>
        </div>
      </div>
    </div>
  );
}
