import PullRequestBoard from '@/components/PullRequestBoard';
import DomainTabs, { EXEC_DOMAIN } from '@/components/DomainTabs';

export default function PullRequestsPage() {
  return (
    <>
      <DomainTabs tabs={EXEC_DOMAIN} title="실행·산출물" />
      <PullRequestBoard />
    </>
  );
}
