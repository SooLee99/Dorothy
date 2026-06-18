import { RouteApp, RouteContext } from './types';
import { registerHealthRoutes } from './health-routes';
import { registerHooksRoutes } from './hooks-routes';
import { registerAgentRoutes } from './agent-routes';
import { registerTelegramRoutes } from './telegram-routes';
import { registerSlackRoutes } from './slack-routes';
import { registerKanbanRoutes } from './kanban-routes';
import { registerSchedulerRoutes } from './scheduler-routes';
import { registerVaultRoutes } from './vault-routes';
import { registerRateLimitRoutes } from './rate-limit-routes';
import { registerGithubWebhookRoutes } from './github-webhook-routes';
import { registerSessionsRoutes } from './sessions-routes';
import { registerProvidersRoutes } from './providers-routes';
import { registerTasksRoutes } from './tasks-routes';
import { registerProjectsRoutes } from './projects-routes';

export function registerAllRoutes(app: RouteApp, ctx: RouteContext): void {
  registerHealthRoutes(app, ctx);
  registerHooksRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerTelegramRoutes(app, ctx);
  registerSlackRoutes(app, ctx);
  registerKanbanRoutes(app, ctx);
  registerSchedulerRoutes(app, ctx);
  registerVaultRoutes(app, ctx);
  registerRateLimitRoutes(app, ctx);
  registerGithubWebhookRoutes(app, ctx);
  registerSessionsRoutes(app, ctx); // PR-0a — B1 세션 신호(read-only)
  registerProvidersRoutes(app, ctx); // PR-0b — provider 한도 신호(read-only, dispatcher 미변경)
  registerTasksRoutes(app, ctx); // PR-2-S1 — Tasks 신호(read-only, kanban 재사용)
  registerProjectsRoutes(app, ctx); // PR-2-S2 — Projects 신호(read-only, FE/BE 프로브 + git)
}

export type { RouteApp, RouteContext, RouteRequest, SendJson, RouteHandler, RouteDefinition } from './types';
