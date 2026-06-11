'use client';

/**
 * GithubWebhookSection — Phase 5B read-only summary of the GitHub webhook
 * policy. We deliberately do NOT expose an editable form here: the secret is
 * sensitive and the auto-transition flag mutates Run state. Editing happens
 * by hand via `~/.dorothy/app-settings.json` until Phase 5C wires a careful
 * editor.
 *
 * What this section shows:
 *   - whether `githubWebhookSecret` is configured ("configured" / "not configured" only)
 *   - dev override flag value
 *   - the auto-transition flag value (default off)
 *   - the canonical webhook URL the user should paste into GitHub
 *
 * What this section does NOT show:
 *   - the actual secret value
 *   - any webhook body
 *   - any GitHub token (tokens are not stored here at all)
 */

import { GitPullRequest, ShieldCheck, AlertTriangle, ExternalLink, CheckCircle2 } from 'lucide-react';
import type { AppSettings } from './types';

interface Props {
  // The AppSettings stored in dorothy is wider than the type checked-in here
  // because the Phase 4.5 + 5A flags are optional extensions. We accept the
  // base type and read the new keys via a typed cast.
  appSettings: AppSettings;
}

interface PhaseFlags {
  githubWebhookSecret?: string;
  dorothyDevAllowUnsignedWebhook?: boolean;
  dorothyPrCiAutoTransition?: boolean;
  // Phase 5C-B
  dorothyAutoResumeRateLimitedSessions?: boolean | string;
}

export function GithubWebhookSection({ appSettings }: Props) {
  const flags = appSettings as AppSettings & PhaseFlags;
  const secretConfigured = !!(flags.githubWebhookSecret && flags.githubWebhookSecret.trim().length > 0);
  const devAllow = !!flags.dorothyDevAllowUnsignedWebhook;
  const autoTransition = !!flags.dorothyPrCiAutoTransition;
  // Phase 5C-B — auto-resume mode display.
  const rawResume = flags.dorothyAutoResumeRateLimitedSessions;
  const resumeMode: 'live' | 'dry-run' | 'off' =
    rawResume === true || rawResume === 'true' || rawResume === 'on' || rawResume === 'live' ? 'live'
    : rawResume === false || rawResume === 'false' || rawResume === 'off' ? 'off'
    : 'dry-run';

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-2">
        <GitPullRequest className="w-5 h-5 text-foreground" />
        <h2 className="text-lg font-semibold text-foreground">GitHub Webhook</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Dorothy receives GitHub <code className="font-mono">pull_request</code>,{' '}
        <code className="font-mono">workflow_run</code>, <code className="font-mono">check_run</code>,{' '}
        and <code className="font-mono">check_suite</code> events on a local endpoint and mirrors them into{' '}
        <code className="font-mono">dorothy.db</code>. This section is read-only — edit{' '}
        <code className="font-mono">~/.dorothy/app-settings.json</code> by hand to change the values below.
      </p>

      {/* Webhook URL */}
      <div className="p-4 bg-card border border-border">
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Webhook URL</div>
        <code className="block text-sm font-mono text-foreground break-all">
          http://127.0.0.1:31415/api/github/webhook
        </code>
        <p className="text-xs text-muted-foreground mt-2">
          GitHub itself cannot reach <code className="font-mono">127.0.0.1</code> directly.
          Use{' '}
          <a
            href="https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/testing-webhooks"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline hover:text-foreground"
          >
            ngrok / cloudflared <ExternalLink className="w-3 h-3" />
          </a>{' '}
          (or any reverse tunnel) to expose this endpoint publicly, then point a GitHub App or
          repository webhook at the public URL.
        </p>
      </div>

      {/* Phase 5C-A — surface the raw-body HMAC posture. */}
      <Row
        title="Raw body HMAC"
        icon={<ShieldCheck className="w-4 h-4 text-emerald-500" />}
        status="enabled"
        statusTone="emerald"
        body={
          <>
            Signature verification reads the exact request bytes Dorothy received from GitHub
            (no JSON re-serialization). This avoids spurious 401s when GitHub canonicalizes the
            payload differently than <code className="font-mono">JSON.stringify</code>.
          </>
        }
      />

      {/* Secret state */}
      <Row
        title="Webhook secret"
        icon={secretConfigured ? <ShieldCheck className="w-4 h-4 text-emerald-500" /> : <AlertTriangle className="w-4 h-4 text-amber-500" />}
        status={secretConfigured ? 'configured' : 'not configured'}
        statusTone={secretConfigured ? 'emerald' : 'amber'}
        body={
          secretConfigured ? (
            <>HMAC-SHA256 signature is verified for every delivery. The secret itself is never displayed.</>
          ) : (
            <>
              No <code className="font-mono">githubWebhookSecret</code> set in{' '}
              <code className="font-mono">app-settings.json</code>. Without it, deliveries are rejected with{' '}
              <code className="font-mono">401</code> unless the developer override below is on.
            </>
          )
        }
      />

      {/* Dev override */}
      <Row
        title="Allow unsigned webhooks (dev override)"
        icon={devAllow ? <AlertTriangle className="w-4 h-4 text-amber-500" /> : <ShieldCheck className="w-4 h-4 text-emerald-500" />}
        status={devAllow ? 'enabled' : 'disabled'}
        statusTone={devAllow ? 'amber' : 'emerald'}
        body={
          <>
            Key: <code className="font-mono">dorothyDevAllowUnsignedWebhook</code>. When enabled,
            Dorothy accepts deliveries without a verified signature — intended for local{' '}
            <code className="font-mono">curl</code> testing only. Default <strong>off</strong>.
          </>
        }
      />

      {/* Auto Resume Scheduler — Phase 5C-B */}
      <Row
        title="Auto Resume rate-limited sessions"
        icon={resumeMode === 'live' ? <AlertTriangle className="w-4 h-4 text-amber-500" /> : <ShieldCheck className="w-4 h-4 text-emerald-500" />}
        status={resumeMode === 'live' ? 'live (auto-dispatch)' : resumeMode === 'off' ? 'disabled' : 'dry-run (default)'}
        statusTone={resumeMode === 'live' ? 'amber' : 'emerald'}
        body={
          <>
            Key: <code className="font-mono">dorothyAutoResumeRateLimitedSessions</code>. When set to{' '}
            <code className="font-mono">true</code> or <code className="font-mono">&quot;live&quot;</code>,
            Dorothy waits for <code className="font-mono">resumeAt</code> and then calls the same
            <code className="font-mono mx-1">/api/agents/:id/start</code> path the orchestrator uses.
            Before resuming, the worker is required to read the latest Handoff and only
            continue pending/blocked steps — completed steps are never re-run. Default{' '}
            <strong>dry-run</strong>. Manual <em>Resume Now</em> on <code className="font-mono">/sessions</code>{' '}
            works regardless of this mode.
          </>
        }
      />

      {/* PR/CI auto transition */}
      <Row
        title="PR / CI auto Run transition"
        icon={autoTransition ? <AlertTriangle className="w-4 h-4 text-amber-500" /> : <ShieldCheck className="w-4 h-4 text-emerald-500" />}
        status={autoTransition ? 'enabled' : 'disabled (default)'}
        statusTone={autoTransition ? 'amber' : 'emerald'}
        body={
          <>
            Key: <code className="font-mono">dorothyPrCiAutoTransition</code>. When enabled, a{' '}
            <code className="font-mono">merged</code> PR may move a linked Run from{' '}
            <code className="font-mono">reporting</code> to <code className="font-mono">completed</code>, and a{' '}
            <code className="font-mono">failed</code> CI run may move it from{' '}
            <code className="font-mono">reporting</code> to <code className="font-mono">needs_fix</code>.
            No other transitions are automatic. Default <strong>off</strong> — the dashboard mirrors PR/CI
            data without touching Run state.
          </>
        }
      />

      {/* Phase 5C-A — recommended setup checklist. */}
      <div className="p-4 bg-card border border-border">
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
          Recommended setup
        </div>
        <ol className="space-y-2 text-sm">
          <Step
            done={secretConfigured}
            n={1}
            title="Set githubWebhookSecret"
            body={
              <>Add a strong random secret to <code className="font-mono">app-settings.json</code> and
              paste the same value into your GitHub webhook configuration.</>
            }
          />
          <Step
            done={!devAllow}
            n={2}
            title="Disable dorothyDevAllowUnsignedWebhook"
            body={<>Turn off the developer override once a secret is configured.</>}
          />
          <Step
            done={!autoTransition}
            n={3}
            title="Keep dorothyPrCiAutoTransition off for a 1-week dry-run"
            body={
              <>Watch <code className="font-mono">/pr</code> and <code className="font-mono">/reports</code>{' '}
              fill in correctly before letting webhook events move Run state automatically.</>
            }
          />
          <Step
            done={null}
            n={4}
            title="Verify /pr receives pull_request events"
            body={
              <>Open a draft PR on a configured repository; it should show up on{' '}
              <code className="font-mono">/pr</code> within seconds.</>
            }
          />
          <Step
            done={null}
            n={5}
            title="Verify /reports receives CI artifacts"
            body={
              <>Trigger a GitHub Actions workflow; the run's success/failure summary should land on{' '}
              <code className="font-mono">/reports</code> as a <code className="font-mono">test</code> or{' '}
              <code className="font-mono">review</code> artifact.</>
            }
          />
        </ol>
      </div>

      <div className="p-3 border border-border bg-muted/30 text-xs text-muted-foreground">
        Editing these values requires a manual edit of <code className="font-mono">~/.dorothy/app-settings.json</code> and
        an app restart for now. A guarded editor lands in Phase 5C-B. GitHub tokens are{' '}
        <strong>not</strong> stored by Dorothy — the receiver only validates signatures, it never
        calls GitHub back.
      </div>
    </div>
  );
}

function Step({
  done,
  n,
  title,
  body,
}: {
  /** true=passed, false=still needed, null=verification step we can't auto-detect */
  done: boolean | null;
  n: number;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <div className="mt-0.5 shrink-0">
        {done === true ? (
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
        ) : done === false ? (
          <AlertTriangle className="w-4 h-4 text-amber-500" />
        ) : (
          <span className="inline-flex w-4 h-4 items-center justify-center text-[10px] font-medium border border-border text-muted-foreground">
            {n}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground font-medium">{title}</div>
        <div className="text-xs text-muted-foreground leading-relaxed mt-0.5">{body}</div>
      </div>
    </li>
  );
}

function Row({
  title,
  icon,
  status,
  statusTone,
  body,
}: {
  title: string;
  icon: React.ReactNode;
  status: string;
  statusTone: 'emerald' | 'amber';
  body: React.ReactNode;
}) {
  const toneCls = statusTone === 'emerald'
    ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
    : 'bg-amber-500/10 text-amber-500 border-amber-500/30';
  return (
    <div className="p-4 bg-card border border-border">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        </div>
        <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border ${toneCls}`}>
          {status}
        </span>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{body}</p>
    </div>
  );
}
