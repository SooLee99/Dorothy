'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Trash2, Save, Bot, Clock, Plus, Minus } from 'lucide-react';
import type { KanbanTask, ChecklistItem } from '@/types/kanban';
import { COLUMN_CONFIG, getLabelColor } from '../constants';
import { ALL_OPERATION_AGENT_IDS } from '@/lib/agentProcessDisplay';
import { TaskWorkflowView } from './TaskWorkflowView';
import { TaskRunsTimeline } from './TaskRunsTimeline'; // 재설계 ③ — 타임라인(시도 이력/이벤트, hermes)
import StructuredPrompt from '@/components/ProjectFlowView/StructuredPrompt'; // 마크다운 렌더(읽기뷰)
// Phase 2 PR-2-U0/U2 — 작업 상세 탭(additive). [진행] 탭 세션 배선=U2.
import { ReadonlyTerminal } from '@/components/phase2/ReadonlyTerminal';
import { SessionPicker } from '@/components/phase2/SessionPicker';
import { TaskSignalTabs } from '@/components/phase2/TaskSignalTabs';

// Phase 2 탭 정의 — details=기존 폼 보존, progress/design/artifacts=셸, preview/timeline=비활성(Phase 3).
const PHASE2_TABS = [
  { key: 'details', label: '세부정보', disabled: false },
  { key: 'progress', label: '진행', disabled: false },
  { key: 'design', label: '설계', disabled: false },
  { key: 'artifacts', label: '산출물', disabled: false },
  { key: 'preview', label: '미리보기/API', disabled: true },
  { key: 'timeline', label: '타임라인', disabled: false }, // 재설계 ③ — 시도 이력/이벤트(hermes)
] as const;
type Phase2Tab = (typeof PHASE2_TABS)[number]['key'];

// Phase 6-AI — 배정 가능한 11개 프로세스 slug 에이전트.
const ASSIGNABLE_AGENTS: string[] = [...ALL_OPERATION_AGENT_IDS];

interface KanbanCardDetailProps {
  task: KanbanTask;
  onClose: () => void;
  onUpdate: (data: Partial<KanbanTask>) => Promise<void>;
  onDelete: () => void;
}

export function KanbanCardDetail({ task, onClose, onUpdate, onDelete }: KanbanCardDetailProps) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [editDesc, setEditDesc] = useState(false); // 기본=마크다운 렌더 읽기뷰, 토글 시 편집
  const [priority, setPriority] = useState(task.priority);
  const [requiredSkills, setRequiredSkills] = useState<string[]>(task.requiredSkills);
  const [skillInput, setSkillInput] = useState('');
  const [labels, setLabels] = useState<string[]>(task.labels);
  const [labelInput, setLabelInput] = useState('');
  // Phase 6-AI — Labels와 별도로 담당 에이전트 선택.
  const [assignedAgentId, setAssignedAgentId] = useState<string>(task.assignedAgentId ?? '');
  // Phase 6-BJ — 워크플로우 체크리스트
  const [checklist, setChecklist] = useState<ChecklistItem[]>(task.checklist ?? []);
  const [checkInput, setCheckInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  // Phase 2 PR-2-U0 — 탭 상태. 기본 'details'(기존 동작 보존).
  const [activeTab, setActiveTab] = useState<Phase2Tab>('details');
  // Phase 2 PR-2-U2 — [진행] 탭에서 사용자가 고른 세션(agentId). ★자동연결 금지 → 기본 null(picker).
  const [pickedSession, setPickedSession] = useState<string | null>(null);

  const columnConfig = COLUMN_CONFIG[task.column];

  const hasChanges =
    title !== task.title ||
    description !== task.description ||
    priority !== task.priority ||
    (assignedAgentId || null) !== (task.assignedAgentId ?? null) ||
    JSON.stringify(requiredSkills) !== JSON.stringify(task.requiredSkills) ||
    JSON.stringify(labels) !== JSON.stringify(task.labels) ||
    JSON.stringify(checklist) !== JSON.stringify(task.checklist ?? []);

  const toggleCheck = (id: string) => setChecklist(cl => cl.map(i => i.id === id ? { ...i, done: !i.done } : i));
  const addCheck = () => { const t = checkInput.trim(); if (t) { setChecklist(cl => [...cl, { id: `m-${Date.now()}`, text: t, done: false }]); setCheckInput(''); } };
  const removeCheck = (id: string) => setChecklist(cl => cl.filter(i => i.id !== id));

  const handleAddSkill = () => {
    if (skillInput.trim() && !requiredSkills.includes(skillInput.trim())) {
      setRequiredSkills([...requiredSkills, skillInput.trim()]);
      setSkillInput('');
    }
  };

  const handleRemoveSkill = (skill: string) => {
    setRequiredSkills(requiredSkills.filter((s) => s !== skill));
  };

  const handleAddLabel = () => {
    if (labelInput.trim() && !labels.includes(labelInput.trim())) {
      setLabels([...labels, labelInput.trim()]);
      setLabelInput('');
    }
  };

  const handleRemoveLabel = (label: string) => {
    setLabels(labels.filter((l) => l !== label));
  };

  const handleSave = async () => {
    if (!title.trim()) return;

    setIsSaving(true);
    try {
      await onUpdate({
        title: title.trim(),
        description: description.trim(),
        priority,
        requiredSkills,
        labels,
        assignedAgentId: assignedAgentId || null,
        checklist,
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50"
      />

      {/* Modal */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-xl"
      >
        <div className="bg-card border border-border rounded-2xl shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border">
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${columnConfig.accentColor}`} />
              <span className="text-sm font-medium text-muted-foreground">
                {columnConfig.title}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={onDelete}
                className="p-2 rounded-lg hover:bg-red-500/10 transition-colors text-muted-foreground hover:text-red-500"
                title="Delete task"
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <button
                onClick={onClose}
                className="p-2 rounded-lg hover:bg-secondary transition-colors"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
          </div>

          {/* Phase 2 PR-2-U0 — 탭 바(additive). 기본 details 는 기존 폼 그대로. */}
          <div className="flex gap-1 px-4 pt-2 border-b border-border overflow-x-auto">
            {PHASE2_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                disabled={t.disabled}
                onClick={() => !t.disabled && setActiveTab(t.key)}
                title={t.disabled ? '준비 안 됨 (Phase 3)' : undefined}
                className={`px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors whitespace-nowrap ${
                  t.disabled
                    ? 'text-muted-foreground/40 cursor-not-allowed'
                    : activeTab === t.key
                      ? 'text-foreground border-b-2 border-primary'
                      : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="p-6 space-y-5 max-h-[60vh] overflow-y-auto">
            {activeTab === 'details' && (<>
            {/* Phase 6-AT+ — 업무 프로세스 단계 + 현재 수행 상황(라이브 연동) */}
            <TaskWorkflowView task={{ title: task.title, description: task.description, column: task.column, progress: task.progress, assignedAgentId: assignedAgentId || task.assignedAgentId, labels: task.labels, priority: task.priority, stageHistory: task.stageHistory }} />

            {/* Phase 6-BJ — 워크플로우 체크리스트 */}
            <div className="rounded-lg border border-border bg-secondary/30 p-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-foreground">워크플로우 체크리스트</span>
                <span className="text-[10px] text-muted-foreground">{checklist.filter(i => i.done).length}/{checklist.length} 완료</span>
              </div>
              <ul className="space-y-1">
                {checklist.map(item => (
                  <li key={item.id} className="flex items-center gap-2 group">
                    <input type="checkbox" checked={item.done} onChange={() => toggleCheck(item.id)} className="shrink-0" />
                    <span className={`text-[12px] flex-1 ${item.done ? 'line-through text-muted-foreground' : 'text-foreground'}`}>{item.text}</span>
                    {item.auto && <span className="text-[9px] px-1 rounded bg-secondary text-muted-foreground shrink-0">자동</span>}
                    {!item.auto && <button onClick={() => removeCheck(item.id)} className="text-rose-400 opacity-0 group-hover:opacity-100 text-[10px] shrink-0">삭제</button>}
                  </li>
                ))}
              </ul>
              <div className="flex gap-1.5 mt-2">
                <input value={checkInput} onChange={e => setCheckInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addCheck(); }} placeholder="체크리스트 항목 추가" className="flex-1 px-2 py-1 text-[11px] bg-background border border-border rounded" />
                <button onClick={addCheck} className="px-2 py-1 text-[11px] border border-border rounded text-muted-foreground hover:text-foreground">추가</button>
              </div>
              <p className="text-[9px] text-muted-foreground/70 mt-1.5">※ "자동" 항목은 워크플로우 단계/상태에서 파생(매 틱 갱신). "라이브 반영"은 커밋+서버 재기동 시 체크됨. 변경 후 저장하세요.</p>
            </div>
            {/* Title */}
            <div>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title..."
                className="w-full text-lg font-semibold bg-transparent border-none focus:outline-none focus:ring-0 p-0 placeholder:text-muted-foreground/50"
              />
            </div>

            {/* Description — 기본 마크다운 렌더(읽기), '편집'으로 textarea 전환 */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">설명</span>
                <button type="button" onClick={() => setEditDesc((v) => !v)} className="text-[11px] text-primary hover:underline">
                  {editDesc ? '✓ 보기' : '✎ 편집'}
                </button>
              </div>
              {editDesc ? (
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="설명 (마크다운 지원: ## 섹션, - 목록, - [ ] 체크리스트)"
                  rows={10}
                  className="w-full text-sm font-mono bg-secondary/30 border border-border/50 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-primary/20 resize-y placeholder:text-muted-foreground/50"
                />
              ) : description.trim() ? (
                <div className="bg-secondary/20 border border-border/50 rounded-xl px-4 py-3">
                  <StructuredPrompt body={description} />
                </div>
              ) : (
                <button type="button" onClick={() => setEditDesc(true)} className="w-full text-left text-sm text-muted-foreground/50 bg-secondary/30 border border-border/50 rounded-xl px-4 py-3">설명 추가…</button>
              )}
            </div>

            {/* Priority */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Priority
              </label>
              <div className="flex gap-2">
                {(['low', 'medium', 'high'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={`
                      flex-1 px-3 py-2 text-sm rounded-lg border-2 transition-all font-medium
                      ${priority === p
                        ? p === 'high'
                          ? 'bg-red-500/10 border-red-500/50 text-red-500'
                          : p === 'medium'
                          ? 'bg-amber-500/10 border-amber-500/50 text-amber-500'
                          : 'bg-zinc-500/10 border-zinc-500/50 text-zinc-500'
                        : 'bg-transparent border-border/50 text-muted-foreground hover:border-border'
                      }
                    `}
                  >
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Phase 6-AI — 담당 에이전트 선택 (Labels와 별도) */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                담당 에이전트
              </label>
              <select
                value={assignedAgentId}
                onChange={(e) => setAssignedAgentId(e.target.value)}
                className="w-full px-3 py-2 bg-secondary/30 border border-border/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option value="">미배정</option>
                {ASSIGNABLE_AGENTS.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
                {assignedAgentId && !ASSIGNABLE_AGENTS.includes(assignedAgentId) && (
                  <option value={assignedAgentId}>{assignedAgentId} (기타/레거시)</option>
                )}
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">Labels와 별개로 작업 담당 에이전트를 지정합니다. 미배정은 오케스트레이터가 배정합니다.</p>
            </div>

            {/* Labels */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Labels
              </label>
              <div className="flex gap-2 mb-3">
                <input
                  type="text"
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddLabel();
                    }
                  }}
                  placeholder="Add label..."
                  className="flex-1 px-3 py-2 bg-secondary/30 border border-border/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <button
                  type="button"
                  onClick={handleAddLabel}
                  className="px-3 py-2 bg-secondary/50 border border-border/50 rounded-lg hover:bg-secondary transition-colors"
                >
                  <Plus className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {labels.map((label) => {
                  const colors = getLabelColor(label);
                  return (
                    <span
                      key={label}
                      className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${colors.bg} ${colors.text}`}
                    >
                      {label}
                      <button
                        type="button"
                        onClick={() => handleRemoveLabel(label)}
                        className="hover:opacity-70"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  );
                })}
                {labels.length === 0 && (
                  <span className="text-xs text-muted-foreground/50">No labels</span>
                )}
              </div>
            </div>

            {/* Skills */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Required Skills
              </label>
              <div className="flex gap-2 mb-3">
                <input
                  type="text"
                  value={skillInput}
                  onChange={(e) => setSkillInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddSkill();
                    }
                  }}
                  placeholder="Add skill..."
                  className="flex-1 px-3 py-2 bg-secondary/30 border border-border/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <button
                  type="button"
                  onClick={handleAddSkill}
                  className="px-3 py-2 bg-secondary/50 border border-border/50 rounded-lg hover:bg-secondary transition-colors"
                >
                  <Plus className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {requiredSkills.map((skill) => (
                  <span
                    key={skill}
                    className="flex items-center gap-1.5 px-3 py-1 bg-blue-500/10 text-blue-500 rounded-full text-xs font-medium"
                  >
                    {skill}
                    <button
                      type="button"
                      onClick={() => handleRemoveSkill(skill)}
                      className="hover:opacity-70"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                {requiredSkills.length === 0 && (
                  <span className="text-xs text-muted-foreground/50">No skills required</span>
                )}
              </div>
            </div>

            {/* Meta info */}
            <div className="flex items-center gap-4 pt-4 border-t border-border/50 text-xs text-muted-foreground">
              {task.assignedAgentId && (
                <div className="flex items-center gap-1.5 text-green-500">
                  <Bot className="w-3.5 h-3.5" />
                  <span>Agent assigned</span>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                <span>Created {new Date(task.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
            </>)}

            {/* Phase 2 PR-2-U2 — [진행]: task↔session 매핑은 0a observed:false 라 ★확정 매핑 불가가 정상.
                거짓 자동연결 금지 → 안내 + /sessions picker 로 사용자가 선택 → ReadonlyTerminal. */}
            {activeTab === 'progress' && (
              pickedSession ? (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setPickedSession(null)}
                    className="text-xs text-primary hover:underline"
                  >
                    ← 다른 세션 선택
                  </button>
                  <ReadonlyTerminal sessionId={pickedSession} />
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="rounded-lg border border-border bg-secondary/20 p-3 text-xs text-muted-foreground">
                    이 작업의 라이브 세션을 ★확정 매핑할 수 없습니다(정상 — task↔session 링크 없음).
                    아래 세션 목록에서 직접 선택하세요.
                  </div>
                  <SessionPicker onPick={setPickedSession} />
                </div>
              )
            )}
            {/* Phase 2 PR-2-U3 — [설계]: tasks/{id}.design 배선. 대부분 observed:false → '확인 불가'/빈 상태(§0.6). */}
            {activeTab === 'design' && <TaskSignalTabs taskId={task.id} tab="design" />}
            {/* [산출물]: tasks/{id}.artifacts + ★done 배지(EvidenceChip, verified만 초록=G1). */}
            {activeTab === 'artifacts' && <TaskSignalTabs taskId={task.id} tab="artifacts" />}
            {/* 재설계 ③ — [타임라인]: 시도 이력(runs)+이벤트+코멘트(hermes kanban show). 죽은 /runs 데이터 surfacing. */}
            {activeTab === 'timeline' && <TaskRunsTimeline taskId={task.id} />}
            {/* [미리보기/API] — Phase 3, 비활성 placeholder(내용 0). */}
            {activeTab === 'preview' && (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground/60">
                준비 안 됨 (Phase 3)
              </div>
            )}
          </div>

          {/* Footer — 편집/저장은 '세부정보' 탭에서만(기존 동작 보존). */}
          {activeTab === 'details' && (
          <div className="flex justify-end gap-3 px-6 py-4 border-t border-border bg-secondary/20">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!hasChanges || !title.trim() || isSaving}
              className="flex items-center gap-2 px-5 py-2 bg-primary text-primary-foreground text-sm rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
            >
              <Save className="w-4 h-4" />
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
          )}
        </div>
      </motion.div>
    </>
  );
}
