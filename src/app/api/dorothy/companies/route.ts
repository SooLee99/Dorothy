import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Company registry read/write backed by ~/.dorothy/companies.json.
// GET  -> { companies, selectedCompanyId, projects }
// POST -> { action: 'select', companyId }  | { action: 'add', company: {id,name,description?} }
// agents.json is never touched here.

interface Company {
  id: string;
  name: string;
  description?: string;
  createdAt?: string;
  defaultEngineProfileId?: string;
}
interface Project {
  id: string;
  companyId: string;
  name?: string;
  rootPath?: string;
}
interface CompaniesFile {
  version?: number;
  selectedCompanyId?: string;
  companies?: Company[];
  projects?: Project[];
  [k: string]: unknown;
}

function companiesPath() {
  return path.join(os.homedir(), '.dorothy', 'companies.json');
}

function readFileSafe(): CompaniesFile | null {
  try {
    const raw = fs.readFileSync(companiesPath(), 'utf-8');
    return JSON.parse(raw) as CompaniesFile;
  } catch {
    return null;
  }
}

// Atomic write: temp file in the same dir + rename.
function writeFileAtomic(data: CompaniesFile) {
  const file = companiesPath();
  const tmp = path.join(path.dirname(file), `.companies.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

export async function GET() {
  const d = readFileSafe();
  if (!d) {
    return NextResponse.json({ error: 'companies.json 을 읽을 수 없습니다.' }, { status: 500 });
  }
  // Slim agent→company mapping for UI filtering (no output/history leakage).
  const rawMappings = Array.isArray((d as Record<string, unknown>).agentMappings)
    ? ((d as Record<string, unknown>).agentMappings as Array<Record<string, unknown>>)
    : [];
  const agentMappings = rawMappings
    .filter((m) => m && m.agentId)
    .map((m) => ({
      agentId: m.agentId as string,
      companyId: (m.companyId as string) ?? null,
      roleId: (m.roleId as string) ?? null,
      name: (m.name as string) ?? null,
    }));

  return NextResponse.json({
    selectedCompanyId: d.selectedCompanyId ?? null,
    companies: d.companies ?? [],
    projects: d.projects ?? [],
    agentMappings,
  });
}

export async function POST(req: Request) {
  const d = readFileSafe();
  if (!d) {
    return NextResponse.json({ error: 'companies.json 을 읽을 수 없습니다.' }, { status: 500 });
  }
  let body: {
    action?: string;
    companyId?: string;
    company?: Partial<Company>;
    agentId?: string;
    roleId?: string;
    name?: string;
    subProjectId?: string;
    projectId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '잘못된 요청 본문입니다.' }, { status: 400 });
  }

  d.companies = d.companies ?? [];

  if (body.action === 'select') {
    const id = body.companyId;
    if (!id || !d.companies.some((c) => c.id === id)) {
      return NextResponse.json({ error: '존재하지 않는 회사입니다.' }, { status: 400 });
    }
    d.selectedCompanyId = id;
    writeFileAtomic(d);
    return NextResponse.json({ ok: true, selectedCompanyId: id });
  }

  if (body.action === 'add') {
    const c = body.company ?? {};
    const id = (c.id ?? '').trim();
    const name = (c.name ?? '').trim();
    if (!id || !name) {
      return NextResponse.json({ error: 'id 와 name 은 필수입니다.' }, { status: 400 });
    }
    if (d.companies.some((x) => x.id === id)) {
      return NextResponse.json({ error: `이미 존재하는 회사 id: ${id}` }, { status: 409 });
    }
    d.companies.push({
      id,
      name,
      description: (c.description ?? '').trim() || undefined,
      createdAt: new Date().toISOString().slice(0, 10),
      defaultEngineProfileId: c.defaultEngineProfileId ?? 'auto',
    });
    // First company added becomes selected if none selected.
    if (!d.selectedCompanyId) d.selectedCompanyId = id;
    writeFileAtomic(d);
    return NextResponse.json({ ok: true, company: id });
  }

  if (body.action === 'update') {
    const id = body.companyId;
    const target = d.companies.find((x) => x.id === id);
    if (!target) {
      return NextResponse.json({ error: '존재하지 않는 회사입니다.' }, { status: 400 });
    }
    const patch = body.company ?? {};
    // id 는 agentMappings/projects 가 참조하므로 변경 불가. name/description/defaultEngineProfileId 만 수정.
    if (typeof patch.name === 'string') {
      const name = patch.name.trim();
      if (!name) return NextResponse.json({ error: '이름은 비울 수 없습니다.' }, { status: 400 });
      target.name = name;
    }
    if (typeof patch.description === 'string') {
      const desc = patch.description.trim();
      target.description = desc || undefined;
    }
    if (typeof patch.defaultEngineProfileId === 'string' && patch.defaultEngineProfileId.trim()) {
      target.defaultEngineProfileId = patch.defaultEngineProfileId.trim();
    }
    writeFileAtomic(d);
    return NextResponse.json({ ok: true, company: target });
  }

  if (body.action === 'mapAgent') {
    // 새로 생성된 에이전트를 회사에 매핑(미분류 방지). 이미 있으면 companyId 갱신.
    const agentId = (body.agentId ?? '').trim();
    const companyId = (body.companyId ?? '').trim();
    if (!agentId || !companyId) {
      return NextResponse.json({ error: 'agentId 와 companyId 는 필수입니다.' }, { status: 400 });
    }
    if (!d.companies.some((c) => c.id === companyId)) {
      return NextResponse.json({ error: '존재하지 않는 회사입니다.' }, { status: 400 });
    }
    const dd = d as Record<string, unknown>;
    const mappings = Array.isArray(dd.agentMappings)
      ? (dd.agentMappings as Array<Record<string, unknown>>)
      : [];
    const existing = mappings.find((m) => m.agentId === agentId);
    if (existing) {
      existing.companyId = companyId;
      if (body.roleId) existing.roleId = body.roleId;
      if (body.name) existing.name = body.name;
    } else {
      mappings.push({
        agentId,
        name: body.name ?? null,
        companyId,
        projectId: body.projectId ?? null,
        subProjectId: body.subProjectId ?? null,
        roleId: body.roleId ?? null,
        autoMapped: true,
        _mappedAt: new Date().toISOString().slice(0, 10),
      });
    }
    dd.agentMappings = mappings;
    writeFileAtomic(d);
    return NextResponse.json({ ok: true, agentId, companyId });
  }

  return NextResponse.json({ error: '알 수 없는 action 입니다.' }, { status: 400 });
}
