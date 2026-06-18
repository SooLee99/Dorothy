import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Read-only: lists triplan .claude/agents/*.md + .claude/skills/*/SKILL.md
// (name + description from YAML frontmatter) plus companies.json teamGraph.
const TRIPLAN_CLAUDE = '/Users/soo/workspace/source-code/triplan/.claude';

interface HarnessEntry {
  file: string;
  name: string | null;
  description: string | null;
}

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

// Extract a single scalar field from the leading `---` frontmatter block.
// Handles quoted and unquoted values on one line.
function frontmatterField(raw: string | null, field: string): string | null {
  if (!raw) return null;
  const fmMatch = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const block = fmMatch ? fmMatch[1] : raw;
  const re = new RegExp(`^${field}\\s*:\\s*(.+)$`, 'm');
  const m = block.match(re);
  if (!m) return null;
  let val = m[1].trim();
  // Strip wrapping quotes.
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
  }
  return val;
}

function parseEntry(file: string): HarnessEntry {
  const raw = safeRead(file);
  return {
    file,
    name: frontmatterField(raw, 'name'),
    description: frontmatterField(raw, 'description'),
  };
}

export async function GET() {
  try {
    const agents: HarnessEntry[] = [];
    const skills: HarnessEntry[] = [];

    const agentsDir = path.join(TRIPLAN_CLAUDE, 'agents');
    try {
      if (fs.existsSync(agentsDir)) {
        for (const f of fs.readdirSync(agentsDir)) {
          if (f.endsWith('.md')) agents.push(parseEntry(path.join(agentsDir, f)));
        }
      }
    } catch {
      /* ignore */
    }

    const skillsDir = path.join(TRIPLAN_CLAUDE, 'skills');
    try {
      if (fs.existsSync(skillsDir)) {
        for (const d of fs.readdirSync(skillsDir)) {
          const skillFile = path.join(skillsDir, d, 'SKILL.md');
          if (fs.existsSync(skillFile)) skills.push(parseEntry(skillFile));
        }
      }
    } catch {
      /* ignore */
    }

    let teamGraph: unknown = null;
    try {
      const companiesFile = path.join(os.homedir(), '.dorothy', 'companies.json');
      if (fs.existsSync(companiesFile)) {
        const data = JSON.parse(fs.readFileSync(companiesFile, 'utf-8'));
        teamGraph = data?.teamGraph ?? null;
      }
    } catch {
      /* ignore */
    }

    return NextResponse.json({ agents, skills, teamGraph });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
