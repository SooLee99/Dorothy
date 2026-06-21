import SkillCandidatesDashboard from '@/components/SkillCandidates';
import DomainTabs, { QUALITY_DOMAIN } from '@/components/DomainTabs';

export default function SkillCandidatesPage() {
  return (
    <>
      <DomainTabs tabs={QUALITY_DOMAIN} title="품질·개선" />
      <SkillCandidatesDashboard />
    </>
  );
}
