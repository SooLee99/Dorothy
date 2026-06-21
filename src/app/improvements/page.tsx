import ImprovementSignalsBoard from '@/components/ImprovementSignals';
import DomainTabs, { QUALITY_DOMAIN } from '@/components/DomainTabs';

export default function ImprovementsPage() {
  return (
    <>
      <DomainTabs tabs={QUALITY_DOMAIN} title="품질·개선" />
      <ImprovementSignalsBoard />
    </>
  );
}
