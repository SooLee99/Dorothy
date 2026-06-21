import { NextResponse } from 'next/server';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadTasks } from '@/lib/kanban-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Phase 6-AK — Resume Brief (READ-ONLY). Collects git status / dirty files /
 * package files / kanban counts / last reports for a project capsule and returns
 * a brief + recommended next agent/action. NEVER dispatches, starts, or sends
 * PTY input. Secrets are masked out of any text.
 */

function mask(s: string): string {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]')
    .replace(/((?:token|secret|api[_-]?key|password|access_token|private_key)["']?\s*[:=]\s*["']?)[^\s"',]+/gi, '$1[REDACTED]')
    .replace(/\b(sk-|ghp_|gho_|xox[baprs]-)[A-Za-z0-9._\-]+/g, '$1[REDACTED]');
}

function kanbanCounts(projectId: string) {
  try {
    // ★단일 소스 hermes SQLite 에서 읽음(과거 kanban-tasks.json 폐기).
    const tasks = loadTasks();
    const match = (t: { projectId?: string; projectPath?: string }) => {
      const hay = `${t.projectId ?? ''} ${t.projectPath ?? ''}`.toLowerCase();
      return hay.includes(projectId.toLowerCase());
    };
    const mine = tasks.filter(match);
    return {
      ongoing: mine.filter((t: { column?: string }) => t.column === 'ongoing').length,
      backlog: mine.filter((t: { column?: string }) => t.column === 'backlog').length,
      blocked: mine.filter((t: { labels?: string[] }) => (t.labels || []).includes('blocked') || (t.labels || []).includes('approval-required')).length,
    };
  } catch {
    return { ongoing: 0, backlog: 0, blocked: 0 };
  }
}

export async function POST(req: Request) {
  let body: { projectId?: string; projectName?: string; rootPath?: string; status?: string; reportsPath?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const projectId = (body.projectId || '').trim();
  const rootPath = (body.rootPath || '').trim();
  if (!projectId) return NextResponse.json({ ok: false, error: 'projectId required' }, { status: 400 });

  const notes: string[] = [];
  const rootPathExists = !!rootPath && fs.existsSync(rootPath);
  let gitStatus: string | undefined;
  let dirtyFileCount = 0;
  let hasPackageJson = false;
  let hasBuildGradle = false;
  let packageManager: string | undefined;

  if (rootPathExists) {
    hasPackageJson = fs.existsSync(path.join(rootPath, 'package.json'))
      || fs.existsSync(path.join(rootPath, 'frontend', 'package.json'));
    hasBuildGradle = fs.existsSync(path.join(rootPath, 'build.gradle'))
      || fs.existsSync(path.join(rootPath, 'build.gradle.kts'))
      || fs.existsSync(path.join(rootPath, 'backend', 'build.gradle'));
    if (hasPackageJson && hasBuildGradle) packageManager = 'mixed';
    else if (hasBuildGradle) packageManager = 'gradle';
    else if (fs.existsSync(path.join(rootPath, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
    else if (fs.existsSync(path.join(rootPath, 'yarn.lock'))) packageManager = 'yarn';
    else if (hasPackageJson) packageManager = 'npm';
    try {
      if (fs.existsSync(path.join(rootPath, '.git'))) {
        const out = execFileSync('git', ['-C', rootPath, 'status', '--porcelain'], { encoding: 'utf-8', timeout: 5000 });
        const lines = out.split('\n').filter(Boolean);
        dirtyFileCount = lines.length;
        gitStatus = mask(lines.slice(0, 20).join('\n'));
      } else {
        notes.push('git 저장소 아님(.git 없음) — scaffold 전 상태');
      }
    } catch {
      notes.push('git status 수집 실패(무시)');
    }
  } else {
    notes.push('rootPath 미존재 — 아직 scaffold되지 않은 신규 프로젝트');
  }

  // last reports
  const reportsPath = body.reportsPath || path.join(os.homedir(), '.dorothy', 'reports', 'projects', projectId);
  let lastReports: string[] = [];
  try {
    if (fs.existsSync(reportsPath)) {
      lastReports = fs.readdirSync(reportsPath).filter(Boolean).slice(-5);
    }
  } catch { /* ignore */ }

  const k = kanbanCounts(projectId);

  // recommend next agent/action
  let recommendedNextAgent = 'intake-planner';
  let recommendedAction = 'MVP 범위·요구사항 정리부터 시작';
  if (!rootPathExists) {
    recommendedNextAgent = 'architect-plan';
    recommendedAction = 'scaffold 전 기술 구조·범위 검증(/deep-analysis) 후 confirm';
  } else if (k.blocked > 0) {
    recommendedNextAgent = 'plan-validator';
    recommendedAction = `차단/승인필요 ${k.blocked}건 검토 후 게이트 처리`;
  } else if (dirtyFileCount > 0) {
    recommendedNextAgent = 'qa-reviewer';
    recommendedAction = `dirty ${dirtyFileCount}개 — 검증/테스트 후 정리`;
  } else if (k.ongoing > 0) {
    recommendedNextAgent = 'orchestrator';
    recommendedAction = `진행 중 ${k.ongoing}건 — 오케스트레이터가 수거·조율`;
  }

  return NextResponse.json({
    ok: true,
    brief: {
      projectId,
      projectName: body.projectName || projectId,
      status: body.status || 'paused',
      rootPathExists,
      gitStatus,
      dirtyFileCount,
      hasPackageJson,
      hasBuildGradle,
      packageManager,
      ongoingTaskCount: k.ongoing,
      backlogTaskCount: k.backlog,
      blockedTaskCount: k.blocked,
      lastReports,
      recommendedNextAgent,
      recommendedAction,
      generatedAt: new Date().toISOString(),
      notes,
    },
  });
}
