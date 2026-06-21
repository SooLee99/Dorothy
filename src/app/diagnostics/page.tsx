import DiagnosticsDashboard from '@/components/DiagnosticsDashboard';
import DomainTabs, { QUALITY_DOMAIN } from '@/components/DomainTabs';

export default function DiagnosticsPage() {
  return (
    <>
      <DomainTabs tabs={QUALITY_DOMAIN} title="품질·개선" />
      <DiagnosticsDashboard />
    </>
  );
}
