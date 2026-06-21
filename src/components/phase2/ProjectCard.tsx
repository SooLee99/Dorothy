'use client';

/**
 * PR-2-U0 — ProjectCard (순수 presentational). 클릭 → onSelect(필터 배선은 U1).
 * ★G2: fe/be '응답함'은 서버 up:true 일 때만. ★G3: git 실측 + '마지막 확인 N초 전'. 부재→'확인 불가'.
 */
import { Server, Monitor, GitBranch } from 'lucide-react';
import { formatRelative } from '@/components/RunCommon/badges';
import { probeView, gitView, type ProbeLike, type GitLike } from './lib';

export interface ProjectCardData {
  projectId: string;
  name?: string;
  capsule?: { frontendPort?: number | null; backendPort?: number | null; envNamespace?: string | null };
  repos?: string[]; // U1 조인 키(repo basename)
  fe?: ProbeLike;
  be?: ProbeLike;
  git?: GitLike;
}

export type ServiceRole = 'fe' | 'be';
export type ServiceAction = 'start' | 'stop';

/** 카드 외곽이 <button> 이라 중첩 방지: 컨트롤은 role="button" span + stopPropagation. */
function ServiceControl({ up, pending, onAct }: { up: boolean; pending: boolean; onAct: (a: ServiceAction) => void }) {
  const action: ServiceAction = up ? 'stop' : 'start';
  const handle = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!pending) onAct(action);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      aria-disabled={pending}
      onClick={handle}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handle(e); }}
      className={`ml-auto text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
        pending ? 'opacity-50 cursor-default border-border text-muted-foreground'
        : up ? 'border-rose-400/50 text-rose-500 hover:bg-rose-500/10'
             : 'border-emerald-500/50 text-emerald-600 hover:bg-emerald-500/10'
      }`}
    >
      {pending ? '…' : up ? '정지' : '기동'}
    </span>
  );
}

function ProbeRow({ icon, label, probe, control }: { icon: React.ReactNode; label: string; probe?: ProbeLike; control?: React.ReactNode }) {
  const v = probeView(probe);
  const dot = v.tone === 'success' ? 'bg-emerald-500' : v.tone === 'danger' ? 'bg-rose-500' : 'bg-muted-foreground/40';
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground flex items-center gap-1 w-10">{icon}{label}</span>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      <span className={v.tone === 'unknown' ? 'text-muted-foreground' : ''}>{v.text}</span>
      {control}
    </div>
  );
}

export function ProjectCard({ project, onSelect, selected = false, onServiceAction, pendingRoles }: {
  project: ProjectCardData;
  onSelect?: (project: ProjectCardData) => void;
  selected?: boolean;
  onServiceAction?: (projectId: string, role: ServiceRole, action: ServiceAction) => void;
  pendingRoles?: Set<string>; // `${projectId}:${role}` 진행중
}) {
  const g = gitView(project.git);
  const ctrl = (role: ServiceRole, probe?: ProbeLike) => {
    if (!onServiceAction) return undefined;
    const up = probeView(probe).tone === 'success';
    return (
      <ServiceControl
        up={up}
        pending={!!pendingRoles?.has(`${project.projectId}:${role}`)}
        onAct={(a) => onServiceAction(project.projectId, role, a)}
      />
    );
  };
  return (
    <button
      type="button"
      onClick={() => onSelect?.(project)}
      aria-pressed={selected}
      className={`text-left w-full rounded-xl border bg-card p-4 transition-colors space-y-3 ${
        selected ? 'border-primary ring-1 ring-primary/40' : 'border-border hover:border-primary/50'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold text-sm text-foreground">{project.name || project.projectId}</span>
        {project.capsule?.envNamespace && (
          <span className="text-[10px] text-muted-foreground font-mono">{project.capsule.envNamespace}</span>
        )}
      </div>

      <div className="space-y-1.5">
        <ProbeRow icon={<Monitor className="w-3 h-3" />} label="FE" probe={project.fe} control={ctrl('fe', project.fe)} />
        <ProbeRow icon={<Server className="w-3 h-3" />} label="BE" probe={project.be} control={ctrl('be', project.be)} />
      </div>

      <div className="pt-2 border-t border-border/50 text-xs">
        {g.observed ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            <span className="flex items-center gap-1 text-foreground"><GitBranch className="w-3 h-3" />{g.branch}</span>
            {g.ahead != null && <span>↑{g.ahead}</span>}
            {g.behind != null && <span>↓{g.behind}</span>}
            <span className={g.dirty > 0 ? 'text-amber-600' : ''}>dirty {g.dirty}</span>
            {g.lastCommit?.hash && (
              <span className="font-mono opacity-80" title={g.lastCommit.msg}>{g.lastCommit.hash}</span>
            )}
            <span className="ml-auto opacity-70">확인 {formatRelative(g.checkedAt)}</span>
          </div>
        ) : (
          <span className="text-muted-foreground">git 확인 불가</span>
        )}
      </div>
    </button>
  );
}
