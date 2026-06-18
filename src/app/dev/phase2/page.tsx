'use client';

/**
 * PR-2-U0 — Phase 2 컴포넌트 데모/스토리(데이터 없이 전 상태 렌더 + 라이브 1회 시연).
 * 라우트: /dev/phase2. read-only.
 */
import { useState } from 'react';
import { EvidenceChip } from '@/components/phase2/EvidenceChip';
import { ProjectCard, type ProjectCardData } from '@/components/phase2/ProjectCard';
import { ReadonlyTerminal } from '@/components/phase2/ReadonlyTerminal';
import type { OutputResp } from '@/components/phase2/lib';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-foreground border-b border-border pb-1">{title}</h2>
      <div className="flex flex-wrap gap-3">{children}</div>
    </section>
  );
}

// ── ReadonlyTerminal 데모용 mock fetcher들 ──
const nowIso = () => new Date().toISOString();
const mockRecent: OutputResp = {
  meta: { serverNow: nowIso() },
  data: { sessionId: 'sess-recent', lines: [{ idx: 0, text: 'PASS  7 passed (1.2s)' }, { idx: 1, text: '> building...' }], lastOutputAt: { observed: true, ts: nowIso() }, output: { observed: true, byteCount: 2048, lineCount: 2 }, readOnly: true, tailOnly: true },
};
const mockSilent: OutputResp = {
  meta: { serverNow: nowIso() },
  data: { sessionId: 'sess-silent', lines: [{ idx: 0, text: 'idle, waiting for input' }], lastOutputAt: { observed: true, ts: new Date(Date.now() - 120_000).toISOString() }, output: { observed: true, byteCount: 512, lineCount: 1 }, readOnly: true, tailOnly: true },
};
const mockUnknown: OutputResp = {
  meta: { serverNow: nowIso() },
  data: { sessionId: 'sess-unknown', lines: [], lastOutputAt: { observed: false, reason: 'probe-pending' }, output: { observed: false, reason: 'probe-pending' }, readOnly: true, tailOnly: true },
};

const proj = (over: Partial<ProjectCardData>): ProjectCardData => ({ projectId: 'demo', name: 'demo', ...over });

export default function Phase2DemoPage() {
  const [liveId, setLiveId] = useState('');
  return (
    <div className="p-8 space-y-10 max-w-3xl mx-auto">
      <div>
        <h1 className="text-lg font-bold text-foreground">Phase 2 컴포넌트 데모 (PR-2-U0)</h1>
        <p className="text-xs text-muted-foreground mt-1">데이터 없이 전 상태 렌더 + ReadonlyTerminal 라이브 시연. read-only.</p>
      </div>

      <Section title="EvidenceChip (G1 — verified일 때만 초록)">
        <EvidenceChip evidence={{ observed: true, verified: true, basis: { observed: true, value: 'CI green' } }} />
        <EvidenceChip evidence={{ observed: true, verified: true, basis: { observed: true, value: '테스트 exit 0' } }} />
        <EvidenceChip evidence={{ observed: true, verified: false, basis: { observed: false, reason: 'source-missing' } }} />
        <EvidenceChip evidence={{ observed: false, reason: 'source-missing' }} />
        <EvidenceChip />
      </Section>

      <Section title="ProjectCard (G2 프로브 / G3 git)">
        <div className="w-72"><ProjectCard project={proj({ name: 'triplan', capsule: { frontendPort: 3000, backendPort: 8080, envNamespace: 'TRIPLAN' }, fe: { observed: true, up: false, port: 3000, reason: 'probe-unreachable' }, be: { observed: true, up: true, port: 8080, latencyMs: 16 }, git: { observed: true, branch: 'feature/triplan-mvp', ahead: 2, behind: 0, dirty: 0, lastCommit: { hash: '848b58e', msg: 'feat', at: nowIso() }, checkedAt: nowIso() } })} /></div>
        <div className="w-72"><ProjectCard project={proj({ name: 'all-up', fe: { observed: true, up: true, port: 5173, latencyMs: 41 }, be: { observed: true, up: true, port: 3000, latencyMs: 12 }, git: { observed: true, branch: 'main', ahead: 0, behind: 1, dirty: 3, lastCommit: { hash: 'a3f9c1', msg: 'fix', at: nowIso() }, checkedAt: nowIso() } })} /></div>
        <div className="w-72"><ProjectCard project={proj({ name: 'all-unknown', fe: { observed: false, reason: 'source-missing' }, be: { observed: false, reason: 'source-missing' }, git: { observed: false, reason: 'source-missing' } })} /></div>
      </Section>

      <Section title="ReadonlyTerminal (sessionId=null / recent / silent / unknown)">
        <div className="w-full"><ReadonlyTerminal sessionId={null} /></div>
        <div className="w-full"><ReadonlyTerminal sessionId="sess-recent" fetcher={async () => mockRecent} /></div>
        <div className="w-full"><ReadonlyTerminal sessionId="sess-silent" fetcher={async () => mockSilent} /></div>
        <div className="w-full"><ReadonlyTerminal sessionId="sess-unknown" fetcher={async () => mockUnknown} /></div>
      </Section>

      <Section title="ReadonlyTerminal — 라이브 시연 (실제 /sessions/{id}/output)">
        <div className="w-full space-y-2">
          <input
            value={liveId}
            onChange={(e) => setLiveId(e.target.value)}
            placeholder="sessionId 또는 baseline agentId(예: orchestrator) 입력 후 표시"
            className="w-full px-3 py-1.5 text-sm bg-secondary/30 border border-border rounded"
          />
          <ReadonlyTerminal sessionId={liveId || null} />
        </div>
      </Section>
    </div>
  );
}
