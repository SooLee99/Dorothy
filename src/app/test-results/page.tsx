import TestResultsDashboard from '@/components/TestResultsDashboard';
import SystemStatusPanel from '@/components/SystemStatusPanel';
import DomainTabs, { EXEC_DOMAIN } from '@/components/DomainTabs';

export default function TestResultsPage() {
  return (
    <>
      <DomainTabs tabs={EXEC_DOMAIN} title="실행·산출물" />
      <SystemStatusPanel />
      <TestResultsDashboard />
    </>
  );
}
