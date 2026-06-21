/**
 * 사용자 처리 사항(Action Items) 신호 + 해결표시.
 *   GET  /api/action-items            — 사람만 처리할 escalation 모음(프로젝트별·상태 포함, read-only)
 *   POST /api/action-items/resolve    — { id, resolved } 해결/해제 표시
 *
 * ★(B) 사용자 몫만(외부 API 키·시크릿·승인·입력). (A) 에이전트 고칠 이슈는 칸반/오케스트레이터 몫.
 */
import { envelope } from '../../core/observability';
import { getActionItems, setActionItemResolved, USER_ACTION_KINDS } from '../dorothy/action-items';
import { RouteApp, RouteContext } from './types';

export function registerActionItemsRoutes(app_: RouteApp, _ctx: RouteContext): void {
  app_.get('/api/action-items', (req, sendJson) => {
    const items = getActionItems();
    const open = items.filter((i) => !i.resolved);
    sendJson(envelope(
      { items, kinds: USER_ACTION_KINDS, openCount: open.length },
      { sources: ['escalations.jsonl', 'action-items-resolved.json'] },
    ));
  });

  app_.post('/api/action-items/resolve', (req, sendJson) => {
    const { id, resolved } = req.body as { id?: string; resolved?: boolean };
    if (!id || typeof id !== 'string') { sendJson({ ok: false, message: 'id 필요' }, 400); return; }
    const r = setActionItemResolved(id, resolved !== false, new Date().toISOString());
    sendJson(r);
  });
}
