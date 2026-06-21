import ReportsDashboard from '@/components/ReportsDashboard';
import DomainTabs, { EXEC_DOMAIN } from '@/components/DomainTabs';

export default function ReportsPage() {
  return (
    <>
      <DomainTabs tabs={EXEC_DOMAIN} title="실행·산출물" />
      <ReportsDashboard />
    </>
  );
}
