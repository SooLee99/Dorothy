'use client';

/**
 * 재설계 ②-b — 한 도메인화(탭).
 *
 * 비슷한 화면(에이전트/작업/공정 등)을 ★한 도메인의 탭으로 묶는다. 단 각 탭은 ★실제 라우트라
 * 라우트·기능·②-a 프로젝트 필터가 그대로 보존된다(탭 클릭 = 그 라우트로 이동 = 딥링크).
 * 즉 "UI 통합"만 — 페이지 컴포넌트는 건드리지 않고 상단에 탭바만 얹는다.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface DomainTab {
  href: string;
  label: string;
}

// 3개 도메인 정의(단일 소스 — nav 와 페이지가 공유).
export const AGENT_DOMAIN: DomainTab[] = [
  { href: '/agents', label: '목록' },
  { href: '/agent-activity', label: '작업' },
  { href: '/agent-workflows', label: '공정' },
];
export const EXEC_DOMAIN: DomainTab[] = [
  { href: '/pr', label: '풀 리퀘스트' },
  { href: '/test-results', label: 'E2E 테스트' },
  { href: '/reports', label: '리포트' },
  { href: '/runs', label: '실행 기록' },
];
export const QUALITY_DOMAIN: DomainTab[] = [
  { href: '/diagnostics', label: '진단' },
  { href: '/improvements', label: '개선' },
  { href: '/skill-candidates', label: '스킬 후보' },
];

export default function DomainTabs({
  tabs,
  title,
  bare = false,
}: {
  tabs: DomainTab[];
  title?: string;
  /** 부모가 이미 좌우 패딩(p-6 등)을 갖는 경우 true — 자체 px 를 빼서 이중 패딩 방지. */
  bare?: boolean;
}) {
  const pathname = usePathname();
  return (
    <div className={`${bare ? '' : 'px-4 lg:px-6 pt-4'} mb-3`}>
      {title && (
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">
          {title}
        </div>
      )}
      <div className="flex gap-1 flex-wrap border-b border-border">
        {tabs.map((t) => {
          const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`px-3 py-1.5 text-sm -mb-px border-b-2 transition-colors ${
                active
                  ? 'border-primary text-primary font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
