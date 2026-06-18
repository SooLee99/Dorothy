import TestResultsDashboard from '@/components/TestResultsDashboard';
import SystemStatusPanel from '@/components/SystemStatusPanel';

export default function TestResultsPage() {
  return (
    <>
      <SystemStatusPanel />
      <TestResultsDashboard />
    </>
  );
}
