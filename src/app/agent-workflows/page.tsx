import AgentWorkflowDiagrams from '@/components/AgentWorkflowDiagrams';
import LiveAgentProgress from '@/components/AgentWorkflowDiagrams/LiveAgentProgress';

export default function AgentWorkflowsPage() {
  return (
    <div className="pt-4 lg:pt-6">
      {/* Phase 6-AN+ — 에이전트별 현재 진행 단계(라이브) + 실제 소통 피드 */}
      <LiveAgentProgress />
      {/* 정적 워크플로우 다이어그램(역할↔단계 매핑) */}
      <AgentWorkflowDiagrams />
    </div>
  );
}
