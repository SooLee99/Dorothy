// Dorothy 멀티회사/오토컴퍼니/하네스/승인 데이터 접근 통합 클라이언트.
// Electron(window.electronAPI.dorothy)이 있으면 IPC 를 사용하고,
// 없으면(web/dev SSR fetch) Next API 라우트(/api/dorothy/*)로 폴백한다.
// 이렇게 하면 packaged static-export(빌드시 API 라우트 제거)에서도 동작한다.

export interface CompanyMappingSlim {
  agentId: string;
  companyId: string | null;
  roleId?: string | null;
  name?: string | null;
}
export interface CompaniesPayload {
  selectedCompanyId: string | null;
  companies: { id: string; name: string; description?: string; createdAt?: string; defaultEngineProfileId?: string }[];
  projects: unknown[];
  agentMappings: CompanyMappingSlim[];
  error?: string;
}

export interface MutateResult {
  ok?: boolean;
  error?: string;
  selectedCompanyId?: string;
  [k: string]: unknown;
}

interface DorothyBridge {
  companies: {
    get: () => Promise<CompaniesPayload>;
    select: (companyId: string) => Promise<MutateResult>;
    add: (company: { id: string; name: string; description?: string }) => Promise<MutateResult>;
    update: (
      companyId: string,
      company: { name?: string; description?: string; defaultEngineProfileId?: string },
    ) => Promise<MutateResult>;
    mapAgent: (agentId: string, companyId: string, name?: string | null) => Promise<MutateResult>;
  };
  autoCompany: {
    get: () => Promise<unknown>;
    control: (action: string) => Promise<{ ok?: boolean; error?: string; message?: string }>;
  };
  teamLoop: { get: () => Promise<unknown> };
  agentActivity: { get: () => Promise<unknown> };
  doc: { read: (path: string) => Promise<{ content?: string; error?: string; bytes?: number }> };
  approvals: { get: () => Promise<unknown> };
  harness: { get: () => Promise<unknown> };
  skill: {
    link: (slug: string) => Promise<{ ok?: boolean; error?: string; message?: string }>;
    unlink: (slug: string) => Promise<{ ok?: boolean; error?: string; message?: string }>;
  };
}

export interface ControlResult {
  ok?: boolean;
  error?: string;
  message?: string;
}

function bridge(): DorothyBridge | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { electronAPI?: { dorothy?: DorothyBridge } }).electronAPI;
  return api?.dorothy ?? null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

const COMPANIES_URL = '/api/dorothy/companies/';

export const dorothyClient = {
  companies: {
    get: (): Promise<CompaniesPayload> => {
      const b = bridge();
      return b ? b.companies.get() : getJson<CompaniesPayload>(COMPANIES_URL);
    },
    select: (companyId: string): Promise<MutateResult> => {
      const b = bridge();
      return b ? b.companies.select(companyId) : postJson<MutateResult>(COMPANIES_URL, { action: 'select', companyId });
    },
    add: (company: { id: string; name: string; description?: string }): Promise<MutateResult> => {
      const b = bridge();
      return b ? b.companies.add(company) : postJson<MutateResult>(COMPANIES_URL, { action: 'add', company });
    },
    update: (
      companyId: string,
      company: { name?: string; description?: string; defaultEngineProfileId?: string },
    ): Promise<MutateResult> => {
      const b = bridge();
      return b
        ? b.companies.update(companyId, company)
        : postJson<MutateResult>(COMPANIES_URL, { action: 'update', companyId, company });
    },
    mapAgent: (agentId: string, companyId: string, name?: string | null): Promise<MutateResult> => {
      const b = bridge();
      return b
        ? b.companies.mapAgent(agentId, companyId, name)
        : postJson<MutateResult>(COMPANIES_URL, { action: 'mapAgent', agentId, companyId, name });
    },
  },
  autoCompany: {
    get: () => {
      const b = bridge();
      return b ? b.autoCompany.get() : getJson('/api/dorothy/auto-company/');
    },
    // 제어는 Electron 전용 (스크립트 실행). web/dev 폴백 없음.
    control: async (action: string): Promise<ControlResult> => {
      const b = bridge();
      if (!b) return { error: '이 작업은 Dorothy 데스크톱 앱에서만 가능합니다.' };
      return b.autoCompany.control(action);
    },
  },
  teamLoop: {
    // 패키지 앱: Electron IPC, 개발/웹: Next API 라우트 폴백.
    get: () => {
      const b = bridge();
      return b ? b.teamLoop.get() : getJson('/api/dorothy/team-loop/');
    },
  },
  agentActivity: {
    get: () => {
      const b = bridge();
      return b ? b.agentActivity.get() : getJson('/api/dorothy/agent-activity/');
    },
  },
  doc: {
    read: async (p: string): Promise<{ content?: string; error?: string; bytes?: number }> => {
      const b = bridge();
      if (b) return b.doc.read(p);
      return postJson<{ content?: string; error?: string; bytes?: number }>('/api/dorothy/doc/', { path: p });
    },
  },
  approvals: {
    get: () => {
      const b = bridge();
      return b ? b.approvals.get() : getJson('/api/dorothy/approvals/');
    },
  },
  skill: {
    link: async (slug: string): Promise<{ ok?: boolean; error?: string; message?: string }> => {
      const b = bridge();
      if (b) return b.skill.link(slug);
      return postJson('/api/dorothy/skill-link/', { action: 'link', slug });
    },
    unlink: async (slug: string): Promise<{ ok?: boolean; error?: string; message?: string }> => {
      const b = bridge();
      if (b) return b.skill.unlink(slug);
      return postJson('/api/dorothy/skill-link/', { action: 'unlink', slug });
    },
  },
  harness: {
    get: () => {
      const b = bridge();
      return b ? b.harness.get() : getJson('/api/dorothy/harness/');
    },
  },
};
