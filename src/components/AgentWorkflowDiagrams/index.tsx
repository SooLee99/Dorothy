'use client';

/**
 * Phase 6-L — Agent process / workflow diagrams.
 *
 * CSS-only flow panels (no Mermaid / new library). Nodes are cards; edges are
 * rendered as labelled connectors between cards. Nodes that carry an `agentId`
 * get a live status badge from the Agent Definition Registry (available /
 * missing / reload-required / not-spawnable) so the operator sees which agents
 * back which steps.
 */

import { useMemo } from 'react';
import Link from 'next/link';
import { Workflow, ArrowDown, ChevronRight } from 'lucide-react';
import { useDorothyAgentDefinitions } from '@/hooks/useDorothyRuns';
import type { AgentDefinition } from '@/types/dorothy';
import { processDisplayName, lookupProcessDisplay } from '@/lib/agentProcessDisplay';
import {
  getGlobalDiagram,
  getAgentDiagrams,
  type AgentProcessDiagram,
  type AgentProcessNode,
} from './processDefinitions';

function normKey(id: string | null | undefined): string {
  if (!id) return '';
  return id.toLowerCase().replace(/[\s\-./]+/g, '_').replace(/^_+|_+$/g, '');
}

type NodeStatus = 'available' | 'spawnable' | 'reload_required' | 'missing' | 'not_spawnable' | 'none';

function statusFor(def: AgentDefinition | undefined): NodeStatus {
  if (!def) return 'missing';
  if (def.isSpawnable) return 'spawnable';
  if (def.isRegistered && !def.isLiveLoaded) return 'reload_required';
  if (!def.existsOnDisk && !def.isRegistered) return 'missing';
  return 'available';
}

const STATUS_BADGE: Record<NodeStatus, { label: string; cls: string }> = {
  available:       { label: '실행 가능',    cls: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30' },
  spawnable:       { label: '실행 가능',    cls: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30' },
  reload_required: { label: '재로드 필요', cls: 'bg-amber-500/10 text-amber-500 border-amber-500/30' },
  not_spawnable:   { label: '실행 불가',    cls: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30' },
  missing:         { label: '없음',        cls: 'bg-rose-500/10 text-rose-500 border-rose-500/30' },
  none:            { label: '',               cls: '' },
};

function NodeCard({ node, def }: { node: AgentProcessNode; def?: AgentDefinition }) {
  const status = node.agentId ? statusFor(def) : 'none';
  const badge = STATUS_BADGE[status];
  const inner = (
    <div className="border border-border bg-card rounded-md px-3 py-2 min-w-[160px] max-w-[220px]">
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium text-foreground truncate">
          {node.agentId ? processDisplayName(node.agentId, node.label) : node.label}
        </span>
      </div>
      {node.agentId && (
        <div className="flex items-center gap-1 mt-1">
          <code className="text-[10px] text-muted-foreground font-mono truncate">{node.agentId}</code>
          {badge.label && (
            <span className={`ml-auto px-1.5 py-px text-[9px] border rounded shrink-0 ${badge.cls}`}>{badge.label}</span>
          )}
        </div>
      )}
      {node.description && (
        <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">{node.description}</p>
      )}
      {def?.modelCompatibility && !def.modelCompatibility.ok && (
        <p className="text-[10px] text-rose-500 mt-1">모델 차단</p>
      )}
    </div>
  );
  // Agent-backed nodes link to /agents; pure-process nodes are static.
  return node.agentId ? (
    <Link href="/agents" className="block hover:opacity-90">{inner}</Link>
  ) : inner;
}

function DiagramPanel({ diagram, defByKey }: { diagram: AgentProcessDiagram; defByKey: Map<string, AgentDefinition> }) {
  // Render as a vertical flow with fan-out edges listed beneath. We keep it
  // simple + dependency-free: nodes in order, arrow between consecutive, plus
  // an explicit edge list for non-linear connections.
  const nodeById = new Map(diagram.nodes.map(n => [n.id, n] as const));
  const linearIds = diagram.nodes.map(n => n.id);
  const extraEdges = diagram.edges.filter((e, i) => {
    // an edge is "linear" if it connects consecutive nodes in array order
    const fi = linearIds.indexOf(e.from);
    const ti = linearIds.indexOf(e.to);
    return !(ti === fi + 1);
  });

  return (
    <section className="border border-border bg-card/30 rounded-md p-3">
      <div className="flex items-center gap-2 mb-3">
        <Workflow className="w-4 h-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">
          {diagram.scope === 'agent' && diagram.agentId ? processDisplayName(diagram.agentId, diagram.title) : diagram.title}
        </h3>
        {diagram.agentId && <code className="text-[10px] text-muted-foreground font-mono">{diagram.agentId}</code>}
      </div>
      {diagram.scope === 'agent' && diagram.agentId && (() => {
        const p = lookupProcessDisplay(diagram.agentId);
        if (!p) return null;
        return (
          <div className="mb-2 text-[10px] text-muted-foreground space-y-0.5">
            {p.inputKo.length > 0 && <div>입력: {p.inputKo.join(', ')}</div>}
            {p.outputKo.length > 0 && <div>출력: {p.outputKo.join(', ')}</div>}
            {p.nextAgents.length > 0 && <div>다음: {p.nextAgents.map(a => processDisplayName(a)).join(', ')}</div>}
          </div>
        );
      })()}
      <div className="flex flex-col items-start gap-1">
        {diagram.nodes.map((node, i) => (
          <div key={node.id} className="flex flex-col items-start gap-1">
            <NodeCard node={node} def={node.agentId ? defByKey.get(normKey(node.agentId)) : undefined} />
            {i < diagram.nodes.length - 1 && (
              <ArrowDown className="w-3.5 h-3.5 text-muted-foreground/60 ml-6" />
            )}
          </div>
        ))}
      </div>
      {extraEdges.length > 0 && (
        <div className="mt-3 border-t border-border pt-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">연결</div>
          <ul className="space-y-0.5">
            {extraEdges.map((e, i) => (
              <li key={i} className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <span className="text-foreground">{nodeById.get(e.from)?.label ?? e.from}</span>
                <ChevronRight className="w-3 h-3" />
                <span className="text-foreground">{nodeById.get(e.to)?.label ?? e.to}</span>
                {e.label && <span className="text-muted-foreground/70">({e.label})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default function AgentWorkflowDiagrams() {
  const { definitions, dbUnavailable } = useDorothyAgentDefinitions();
  const defByKey = useMemo(() => {
    const m = new Map<string, AgentDefinition>();
    for (const d of definitions) m.set(normKey(d.id), d);
    return m;
  }, [definitions]);

  const global = getGlobalDiagram();
  const agentDiagrams = getAgentDiagrams();

  return (
    <div className="p-4 lg:p-6 space-y-6 max-w-[1400px] mx-auto">
      <div>
        <h1 className="text-xl lg:text-2xl font-bold text-foreground flex items-center gap-2">
          <Workflow className="w-6 h-6" /> 에이전트 워크플로
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          전체 개발 프로세스와 각 에이전트의 개별 워크플로입니다. 상태 배지는 라이브 에이전트 등록 정보에서 가져옵니다.
        </p>
      </div>

      {dbUnavailable && (
        <p className="text-[11px] text-yellow-500">dorothy.db 사용 불가 — 상태 배지는 파일/등록 스캔으로 대체됩니다.</p>
      )}

      <DiagramPanel diagram={global} defByKey={defByKey} />

      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">에이전트별 프로세스</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {agentDiagrams.map(d => (
            <DiagramPanel key={d.id} diagram={d} defByKey={defByKey} />
          ))}
        </div>
      </div>
    </div>
  );
}
