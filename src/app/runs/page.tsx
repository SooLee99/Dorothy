import RunBoard from '@/components/RunBoard';
import DomainTabs, { EXEC_DOMAIN } from '@/components/DomainTabs';

export default function RunsPage() {
  return (
    <>
      <DomainTabs tabs={EXEC_DOMAIN} title="실행·산출물" />
      <RunBoard />
    </>
  );
}
