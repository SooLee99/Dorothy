/**
 * Phase 6-AH — Integration settings (GitHub / Slack / KakaoTalk).
 *
 * SECURITY: this shape NEVER carries raw secret values — only `*Configured`
 * booleans + non-secret config. Secret values live in the existing app-settings
 * store and are never returned to the renderer or logged.
 */

export interface GithubIntegration {
  enabled: boolean;
  webhookSecretConfigured: boolean;
  tokenConfigured: boolean;
  defaultOwner?: string;
  defaultRepo?: string;
  webhookUrl: string; // non-secret, fixed route
}

export interface SlackIntegration {
  enabled: boolean;
  webhookConfigured: boolean;
  botTokenConfigured: boolean;
  channel?: string;
}

export type KakaoStatus = 'not_configured' | 'configured' | 'pending_provider_setup';

export interface KakaoIntegration {
  enabled: boolean;
  apiKeyConfigured: boolean;
  redirectUri?: string;
  status: KakaoStatus;
}

export interface IntegrationSettings {
  github: GithubIntegration;
  slack: SlackIntegration;
  kakao: KakaoIntegration;
}

/** Non-secret, user-editable fields the integration pages may persist. */
export interface IntegrationConfigPatch {
  github?: { enabled?: boolean; defaultOwner?: string; defaultRepo?: string };
  slack?: { enabled?: boolean; channel?: string };
  kakao?: { enabled?: boolean; redirectUri?: string; status?: KakaoStatus };
}

/** Notification event types surfaced in the notifications setup page. */
export const NOTIFICATION_EVENTS: { key: string; label: string }[] = [
  { key: 'pmtick_started', label: 'PM-tick 시작' },
  { key: 'pmtick_error', label: 'PM-tick 오류' },
  { key: 'agent_failed', label: '에이전트 실패' },
  { key: 'approval_required', label: '승인 필요' },
  { key: 'report_created', label: '보고서 생성' },
  { key: 'kanban_ongoing', label: 'Kanban 진행 갱신' },
  { key: 'half_state_recovered', label: 'Half-state 복구' },
];
