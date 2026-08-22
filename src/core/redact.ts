import type { RedactionReport } from './model.ts';

/**
 * Secret redaction.
 *
 * This is not a nice-to-have. Auspex's entire purpose is to take a developer's working context —
 * source, configuration, environment, shell history, diffs — and hand it to a third-party AI over
 * the network. A `.env` file with a production database URL, an `AWS_SECRET_ACCESS_KEY` in a
 * launch configuration, a private key pasted into a scratch buffer: all of those are exactly the
 * kind of thing that is open in an editor, and all of them would go straight out.
 *
 * Three design decisions follow from that, and each is deliberate:
 *
 * 1. **On by default.** Turning it off is an explicit flag with an explicit warning. A safe default
 *    that must be opted out of is the only defensible arrangement when the failure mode is
 *    "credential leaked to a third party".
 * 2. **Reported, never silent.** Every capture carries a {@link RedactionReport} saying what was
 *    removed and by which rule. A consumer that sees `[redacted:api-key]` and knows why can ask the
 *    user; one that silently receives a blank has no idea anything happened.
 * 3. **Structure-aware, not just pattern-based.** Matching high-entropy strings alone is both
 *    noisy and leaky. The rules here work on three axes at once: the *name* of a key
 *    (`password`, `secret`, `token`), the *shape* of a value (a JWT, a PEM block, an AWS key id),
 *    and the *file* it lives in (`.env`, `id_rsa`, `credentials`). Any one of them firing is enough.
 *
 * **Stated limitation, because it matters**: this cannot be complete. A secret that looks like
 * ordinary text under an ordinary name will pass through, and no redactor can fix that. The right
 * mental model is a substantial reduction in exposure, not a guarantee — which is why
 * {@link SENSITIVE_FILE_PATTERNS} skips whole files whose *entire purpose* is to hold credentials,
 * rather than trusting line-level rules there.
 */

/** One redaction rule: what it looks for and what it is called in the report. */
export interface RedactionRule {
  name: string;
  pattern: RegExp;
  /**
   * Which capture group holds the secret. Group 0 (the whole match) is replaced when this is
   * absent; naming a group lets a rule keep the surrounding key visible, so
   * `api_key = "sk-live-abc"` becomes `api_key = "[redacted:api-key]"` rather than vanishing
   * entirely — the consumer still learns that an api key is configured there.
   */
  group?: number;
}

/**
 * Key names whose values are secret regardless of what the value looks like.
 *
 * Kept as a word list rather than one giant regex so it reads as what it is: a policy statement
 * about which names imply a secret.
 */
const SECRET_KEY_WORDS = [
  'password', 'passwd', 'pwd', 'secret', 'token', 'apikey', 'api_key', 'api-key',
  'access_key', 'accesskey', 'access-key', 'secret_key', 'secretkey', 'private_key', 'privatekey',
  'client_secret', 'clientsecret', 'auth', 'authorization', 'credential', 'credentials',
  'connectionstring', 'connection_string', 'conn_str', 'dsn', 'sas', 'signature',
  'session_key', 'encryption_key', 'signing_key', 'refresh_token', 'access_token', 'id_token',
  'bearer', 'passphrase', 'salt', 'seed_phrase', 'mnemonic', 'license_key',
];

/**
 * The rule set, ordered most specific first.
 *
 * Specific before general on purpose: a JWT should be reported as `jwt`, not as
 * `high-entropy-string`, because the name of the rule that fired is itself information the consumer
 * can act on.
 */
export const REDACTION_RULES: RedactionRule[] = [
  // -- Whole-block secrets. These must run first; their bodies would otherwise trip other rules.
  {
    name: 'private-key',
    pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
  },
  {
    name: 'certificate',
    pattern: /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  },

  // -- Provider-specific shapes. Recognizable on sight, so worth naming precisely.
  { name: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: 'openai-key', pattern: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'slack-token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { name: 'stripe-key', pattern: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },

  // -- Credentials embedded in URLs: postgres://user:password@host/db
  {
    name: 'url-credentials',
    pattern: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/g,
    group: 2,
  },

  // -- Structured assignments. The key stays visible; only the value goes.
  {
    name: 'secret-assignment',
    // key = "value" | key: value | key=value, in any config or source syntax.
    pattern: new RegExp(
      String.raw`(["']?\b\w*(?:${SECRET_KEY_WORDS.join('|')})\w*\b["']?\s*[:=]\s*)` +
      String.raw`(["']?)([^\s"',;}\)]{4,})(\2)`,
      'gi',
    ),
    group: 3,
  },

  // -- HTTP authorization headers, which appear constantly in code and in captured requests.
  {
    name: 'auth-header',
    pattern: /\b(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    group: 2,
  },
];

/**
 * Files whose entire contents are secret by nature, and are therefore skipped rather than scanned.
 *
 * Line-level rules are the wrong tool here. A `.env` file is a list of values whose *names* are the
 * only safe part, and a private key file is a single blob. Reading them at all and then trying to
 * scrub them is a worse bet than declining to read them and saying so.
 */
export const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /(^|[/\\])\.env(\.|$)/i,
  /(^|[/\\])\.npmrc$/i,
  /(^|[/\\])\.pypirc$/i,
  /(^|[/\\])\.netrc$/i,
  /(^|[/\\])id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|[/\\])\.pem$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|[/\\])credentials$/i,
  /(^|[/\\])\.aws[/\\]/i,
  /(^|[/\\])\.ssh[/\\]/i,
  /(^|[/\\])secrets?\.(json|ya?ml|toml|ini|xml)$/i,
  /(^|[/\\])appsettings\.(Development|Production|Local)\.json$/i,
];

/** Accumulates counts across a whole capture so one report covers everything. */
export class Redactor {
  private readonly counts = new Map<string, number>();
  private readonly skipped = new Set<string>();

  readonly enabled: boolean;

  // A plain assignment rather than a parameter property: Node runs this file by stripping type
  // annotations, and a parameter property is syntax that would have to be *generated* rather than
  // erased. Keeping every file erasable is what lets Auspex run with no build step at all.
  constructor(enabled: boolean = true) {
    this.enabled = enabled;
  }

  /** Whether a file should be skipped entirely rather than read and scrubbed. */
  isSensitiveFile(path: string): boolean {
    if (!this.enabled) return false;
    const normalized = path.replace(/\\/g, '/');
    return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  /** Records that a file was skipped, so the report can say so. */
  noteSkipped(path: string): void {
    this.skipped.add(path);
  }

  /**
   * Scrubs a string, replacing every match with `[redacted:<rule>]`.
   *
   * The marker names the rule deliberately: it tells the consumer what kind of thing was there,
   * which is often exactly what it needed to know, without telling it the value.
   */
  redact(text: string): string {
    if (!this.enabled || !text) return text;

    let output = text;
    for (const rule of REDACTION_RULES) {
      // A fresh regex per pass: these are global and therefore stateful, and a shared `lastIndex`
      // across calls would make redaction depend on what was scrubbed before it.
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      output = output.replace(pattern, (...args: unknown[]) => {
        const match = args[0] as string;
        const groups = args.slice(1, -2) as Array<string | undefined>;

        // Never redact something already redacted. Without this an OpenAI key inside an
        // `api_key = "..."` assignment is caught twice -- first by the specific rule, then by the
        // generic one, which double-counts it in the report and, worse, overwrites the specific
        // rule's name with the vague one. The specific name is the useful one.
        if (match.includes('[redacted:')) return match;

        this.counts.set(rule.name, (this.counts.get(rule.name) ?? 0) + 1);

        if (rule.group === undefined) {
          return `[redacted:${rule.name}]`;
        }
        // Rebuild the match with only the secret group replaced, so the surrounding structure
        // (the key, the quotes, the scheme) survives and stays informative.
        let rebuilt = '';
        let consumed = 0;
        for (let i = 0; i < groups.length; i++) {
          const value = groups[i];
          if (value === undefined) continue;
          if (i + 1 === rule.group) {
            rebuilt += `[redacted:${rule.name}]`;
          } else {
            rebuilt += value;
          }
          consumed += value.length;
        }
        return consumed > 0 ? rebuilt : `[redacted:${rule.name}]`;
      });
    }
    return output;
  }

  /**
   * Scrubs an arbitrary object in place-safe fashion, walking strings, arrays and plain objects.
   *
   * Applies the key-name policy as well as the value patterns: a key literally called `password`
   * has its value replaced whatever the value looks like, because the name is the evidence.
   */
  redactValue<T>(value: T, keyHint?: string): T {
    if (!this.enabled) return value;

    if (typeof value === 'string') {
      if (keyHint && this.isSecretKeyName(keyHint) && value.length > 0) {
        this.counts.set('secret-key-name', (this.counts.get('secret-key-name') ?? 0) + 1);
        return '[redacted:secret-key-name]' as unknown as T;
      }
      return this.redact(value) as unknown as T;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item, keyHint)) as unknown as T;
    }
    if (value && typeof value === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        output[key] = this.redactValue(item, key);
      }
      return output as unknown as T;
    }
    return value;
  }

  private isSecretKeyName(key: string): boolean {
    const normalized = key.toLowerCase().replace(/[^a-z_]/g, '');
    return SECRET_KEY_WORDS.some((word) => normalized.includes(word.replace(/[^a-z_]/g, '')));
  }

  /** The report to attach to a snapshot. Returns undefined when nothing was touched. */
  report(): RedactionReport | undefined {
    if (this.counts.size === 0 && this.skipped.size === 0) return undefined;
    let count = 0;
    const byRule: Record<string, number> = {};
    for (const [rule, n] of this.counts) {
      byRule[rule] = n;
      count += n;
    }
    return { count, byRule, skippedFiles: [...this.skipped].sort() };
  }
}
