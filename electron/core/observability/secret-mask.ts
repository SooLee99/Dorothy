/**
 * PR-0-common — 보수적 secret 마스킹(과마스킹 허용).
 *
 * ★§1.2 출구(recon 축 E): 이 프로세스가 secret '실제 값 집합'을 마스킹 함수에 주입하는
 *   설계상 경로가 없다(maskLine 은 appSettings 미접근). 따라서 마스킹 (1) '알려진 값 매칭'은
 *   ★기본 비활성 — knownValues 를 명시 전달할 때만 동작(테스트/미래용). 실사용 호출은
 *   knownValues 없이 → (2)env 대입 라인 + (3)토큰 패턴만 + 과마스킹 강화.
 *
 * 기존 electron/core/terminal-output-mask.ts:maskLine 의 3패턴을 흡수하고
 * Telegram/Slack/JWT/AWS/GitHub PAT 패턴을 추가한다. 기존 maskLine 은 회귀 방지를 위해
 * 그대로 두고(스냅샷 경로), 신규 /sessions·/output 경로가 이 강화판을 쓴다.
 *
 * 순수 모듈.
 */

/** (3) 토큰 패턴 — prefix 보존 그룹이 있으면 prefix 만 남기고 redact, 없으면 통째 redact. */
const TOKEN_PATTERNS: RegExp[] = [
  /(Bearer\s+)[A-Za-z0-9._\-]+/gi,                                  // Bearer <token>
  /\b(sk-ant-|sk-|github_pat_|ghp_|gho_|ghu_|ghs_|xox[baprs]-|glpat-)[A-Za-z0-9._\-]+/g, // prefix tokens (긴 prefix 우선)
  /\bAKIA[0-9A-Z]{16}\b/g,                                          // AWS access key id
  /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g,        // JWT (eyJ...)
  /\b\d{6,}:[A-Za-z0-9_\-]{30,}\b/g,                                // Telegram bot token (123456:ABC-DEF...)
];

/** (2) env/JSON 대입 라인 — KEY 가 secret류면 VAL 을 redact. */
const ENV_ASSIGN =
  /((?:authorization|api[_-]?key|apikey|token|secret|password|passwd|client_secret|access_token|refresh_token|private_key|cred(?:ential)?s?|auth)["']?\s*[:=]\s*["']?)[^\s"',]+/gi;

function redactToken(_m: string, ...rest: unknown[]): string {
  // 캡처그룹이 있으면 rest[0] 은 prefix(string), 없으면 offset(number).
  const p1 = typeof rest[0] === 'string' ? rest[0] : '';
  return p1 ? `${p1}[REDACTED]` : '[REDACTED]';
}

/**
 * 한 줄에서 secret 을 redact. 과마스킹 허용(거짓양성 > 누출).
 * @param line       원본 라인
 * @param knownValues (선택) 알려진 secret 값 집합 — 주어지면 (1)정확일치 매칭도 수행.
 *                    ★실사용에서는 전달하지 않는다(값 접근 경로 없음, §1.2 출구).
 */
export function maskSecrets(line: string, knownValues?: Iterable<string>): string {
  if (typeof line !== 'string') return '';
  let out = line;

  // (1) 알려진 값 매칭 — knownValues 가 명시될 때만(기본 비활성).
  if (knownValues) {
    for (const v of knownValues) {
      if (typeof v === 'string' && v.length >= 6) {
        out = out.split(v).join('[REDACTED]');
      }
    }
  }

  // (3) 토큰 패턴 — env(2)보다 먼저. "Authorization: Bearer <tok>" 처럼 env 키가
  //     값의 첫 단어(Bearer)만 잡아 뒤 토큰을 남기는 충돌을 막는다(과마스킹 허용).
  for (const re of TOKEN_PATTERNS) out = out.replace(re, redactToken);

  // (2) env 대입 라인
  out = out.replace(ENV_ASSIGN, '$1[REDACTED]');

  return out;
}

/** 마스킹 (1) 값매칭이 현재 활성인지(=knownValues 소스가 배선됐는지). 항상 false(§1.2 출구). */
export const VALUE_MATCHING_ENABLED = false as const;
