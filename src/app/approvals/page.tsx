'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { ko } from '@/i18n';
import { dorothyClient } from '@/lib/dorothyClient';

interface ApprovalsData {
  dir: string;
  queue: string | null;
  approved: string | null;
  rejected: string | null;
  policy: string | null;
  error?: string;
}

interface ParsedRow {
  cells: string[];
}

// Parse a GitHub-style markdown table out of raw markdown.
// Returns { headers, rows } for the first table found.
function parseMarkdownTable(raw: string | null): { headers: string[]; rows: ParsedRow[] } | null {
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  const tableLines: string[] = [];
  let inTable = false;
  for (const line of lines) {
    const isRow = /^\s*\|.*\|\s*$/.test(line);
    if (isRow) {
      inTable = true;
      tableLines.push(line.trim());
    } else if (inTable) {
      break; // table ended
    }
  }
  if (tableLines.length < 2) return null;
  const splitRow = (l: string) =>
    l
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  const headers = splitRow(tableLines[0]);
  // tableLines[1] is the separator (---). Skip it.
  const rows = tableLines.slice(2).map((l) => ({ cells: splitRow(l) }));
  return { headers, rows };
}

export default function ApprovalsPage() {
  const [data, setData] = useState<ApprovalsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      const json = (await dorothyClient.approvals.get()) as ApprovalsData;
      setData(json);
    } catch (e) {
      setData({ dir: '', queue: null, approved: null, rejected: null, policy: null, error: String(e) });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    load();
  };

  const queueTable = parseMarkdownTable(data?.queue ?? null);

  return (
    <div className="space-y-4 lg:space-y-6 pt-4 lg:pt-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold tracking-tight flex items-center gap-2">
            <ShieldCheck className="w-6 h-6" /> {ko.nav.approvals}
          </h1>
          <p className="text-muted-foreground text-xs lg:text-sm mt-1">
            approval-manager가 관리하는 승인 대기 큐 (읽기 전용)
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-2 text-sm bg-secondary hover:bg-secondary/80 transition-colors rounded-md"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          {ko.button.refresh}
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" /> 불러오는 중...
        </div>
      ) : data?.error ? (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-500 text-sm">
          {data.error}
        </div>
      ) : (
        <>
          {/* Queue table */}
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-border font-medium text-sm">승인 대기 큐</div>
            {queueTable && queueTable.rows.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-secondary/40">
                      {queueTable.headers.map((h, i) => (
                        <th key={i} className="text-left px-4 py-2 font-medium text-muted-foreground whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {queueTable.rows.map((row, ri) => (
                      <tr key={ri} className="border-b border-border last:border-0 hover:bg-secondary/30">
                        {row.cells.map((c, ci) => (
                          <td key={ci} className="px-4 py-2 align-top">
                            {c || '-'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-4 py-8 text-center text-muted-foreground text-sm">대기 중인 승인 항목이 없습니다.</div>
            )}
          </div>

          {/* Decisions */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-card border border-border rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-border font-medium text-sm flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-green-500" /> 승인된 결정
              </div>
              <pre className="p-4 text-xs whitespace-pre-wrap break-words text-muted-foreground max-h-[400px] overflow-auto">
                {data?.approved ?? '없음'}
              </pre>
            </div>
            <div className="bg-card border border-border rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-border font-medium text-sm flex items-center gap-2">
                <XCircle className="w-4 h-4 text-red-500" /> 반려된 결정
              </div>
              <pre className="p-4 text-xs whitespace-pre-wrap break-words text-muted-foreground max-h-[400px] overflow-auto">
                {data?.rejected ?? '없음'}
              </pre>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
