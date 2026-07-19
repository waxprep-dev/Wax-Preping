/**
 * Live code interpreter — isolated subprocess execution.
 *
 * Security model:
 * - Only python3 / node allowed
 * - Temp directory per run, cleaned after
 * - Hard timeout (default 5s, max 15s)
 * - Output truncated
 * - Dangerous patterns rejected before spawn
 * - No network assumptions; process inherits limited env
 *
 * Config (env):
 * - CODE_INTERPRETER_ENABLED=true|false (default true)
 * - CODE_INTERPRETER_TIMEOUT_MS (default 5000)
 * - CODE_INTERPRETER_MAX_OUTPUT (default 8000 chars)
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../middleware/logger';

export interface CodeRunResult {
  success: boolean;
  language: 'python' | 'javascript' | 'typescript' | 'node';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  blocked: boolean;
  blockReason?: string;
  durationMs: number;
}

const BLOCKED_PATTERNS: RegExp[] = [
  /\b(rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|halt)\b/i,
  /\b(child_process|subprocess|os\.system|os\.popen|pty\.|commands\.)\b/,
  /\b(require\s*\(\s*['"]child_process['"]|import\s+child_process)\b/,
  /\b(process\.exit|process\.kill|process\.binding)\b/,
  /\b(fs\.(rm|rmdir|unlink|writeFile|appendFile|createWriteStream|chmod|chown))\b/,
  /\b(open\s*\([^)]*['"]w|os\.remove|shutil\.rmtree|pathlib\.Path\([^)]*\)\.write)\b/,
  /\b(socket\.|http\.server|SimpleHTTPRequestHandler|urllib\.request\.urlopen)\b/,
  /\b(eval\s*\(|exec\s*\(|Function\s*\(|new\s+Function)\b/,
  /\b(__import__\s*\(\s*['"]os['"]|__import__\s*\(\s*['"]sys['"])\b/,
  /\b(fetch\s*\(|axios\.|http\.get|https\.get|net\.connect)\b/,
  /\b(while\s*\(\s*true\s*\)|while\s+True\s*:)/,
];

function isEnabled(): boolean {
  const v = (process.env.CODE_INTERPRETER_ENABLED || 'true').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off';
}

function timeoutMs(): number {
  const n = Number(process.env.CODE_INTERPRETER_TIMEOUT_MS || 5000);
  if (!Number.isFinite(n)) return 5000;
  return Math.min(15_000, Math.max(500, Math.floor(n)));
}

function maxOutput(): number {
  const n = Number(process.env.CODE_INTERPRETER_MAX_OUTPUT || 8000);
  if (!Number.isFinite(n)) return 8000;
  return Math.min(50_000, Math.max(500, Math.floor(n)));
}

function normalizeLanguage(raw: string): 'python' | 'node' | null {
  const l = (raw || 'python').toLowerCase().trim();
  if (['python', 'py', 'python3'].includes(l)) return 'python';
  if (['javascript', 'js', 'node', 'typescript', 'ts'].includes(l)) return 'node';
  return null;
}

function securityScan(code: string): string | null {
  if (!code.trim()) return 'Empty code';
  if (code.length > 20_000) return 'Code exceeds 20KB limit';
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(code)) {
      return `Blocked pattern: ${re.source.slice(0, 60)}`;
    }
  }
  // Reject obvious path escapes outside temp
  if (/\.\.(\/|\\)/.test(code) && /(open|read|write|fs\.|path\.)/.test(code)) {
    return 'Path traversal patterns blocked';
  }
  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

/**
 * Execute student/tutor code in a short-lived subprocess.
 */
export async function runSandboxedCode(
  code: string,
  languageRaw = 'python'
): Promise<CodeRunResult> {
  const started = Date.now();
  const language = normalizeLanguage(languageRaw);

  if (!isEnabled()) {
    return {
      success: false,
      language: (language || 'python') as CodeRunResult['language'],
      stdout: '',
      stderr: 'Code interpreter disabled (CODE_INTERPRETER_ENABLED=false).',
      exitCode: null,
      timedOut: false,
      blocked: true,
      blockReason: 'disabled',
      durationMs: Date.now() - started,
    };
  }

  if (!language) {
    return {
      success: false,
      language: 'python',
      stdout: '',
      stderr: `Unsupported language: ${languageRaw}. Use python or javascript.`,
      exitCode: null,
      timedOut: false,
      blocked: true,
      blockReason: 'unsupported_language',
      durationMs: Date.now() - started,
    };
  }

  const block = securityScan(code);
  if (block) {
    return {
      success: false,
      language,
      stdout: '',
      stderr: block,
      exitCode: null,
      timedOut: false,
      blocked: true,
      blockReason: block,
      durationMs: Date.now() - started,
    };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wax-code-'));
  const file = path.join(dir, language === 'python' ? 'main.py' : 'main.js');
  const limit = maxOutput();
  const to = timeoutMs();

  try {
    fs.writeFileSync(file, code, { encoding: 'utf8', mode: 0o600 });

    const cmd = language === 'python' ? 'python3' : 'node';
    const args = language === 'python' ? [file] : [file];

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
    }>(resolve => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const child = spawn(cmd, args, {
        cwd: dir,
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin',
          HOME: dir,
          TMPDIR: dir,
          LANG: 'C.UTF-8',
          PYTHONIOENCODING: 'utf-8',
          NODE_OPTIONS: '--max-old-space-size=64',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, to);

      child.stdout?.on('data', (buf: Buffer) => {
        if (stdout.length < limit * 2) stdout += buf.toString('utf8');
      });
      child.stderr?.on('data', (buf: Buffer) => {
        if (stderr.length < limit * 2) stderr += buf.toString('utf8');
      });

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: truncate(stdout, limit),
          stderr: truncate(stderr, limit),
          exitCode,
          timedOut,
        });
      };

      child.on('error', err => {
        stderr += err.message;
        finish(null);
      });
      child.on('close', code => finish(code));
    });

    const ok = !result.timedOut && result.exitCode === 0;
    return {
      success: ok,
      language,
      stdout: result.stdout,
      stderr: result.stderr || (result.timedOut ? `Timed out after ${to}ms` : ''),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      blocked: false,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    logger.warn({ err }, '[CodeSandbox] execution failed');
    return {
      success: false,
      language,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: null,
      timedOut: false,
      blocked: false,
      durationMs: Date.now() - started,
    };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup */
    }
  }
}

export function formatCodeRunForTutor(result: CodeRunResult): string {
  if (result.blocked) {
    return [
      `Code interpreter blocked (${result.blockReason || 'policy'}).`,
      result.stderr,
      'Explain the intended computation without executing unsafe operations.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const lines = [
    `Language: ${result.language}`,
    `Duration: ${result.durationMs}ms`,
    `Exit: ${result.timedOut ? 'TIMEOUT' : result.exitCode}`,
    result.stdout ? `STDOUT:\n${result.stdout}` : 'STDOUT: (empty)',
    result.stderr ? `STDERR:\n${result.stderr}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}
