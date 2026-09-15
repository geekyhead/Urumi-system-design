import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

export class HelmError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'HelmError';
  }

  /** Another helm operation holds the release lock (e.g. a second replica). */
  get isLocked(): boolean {
    return /another operation \(install\/upgrade\/rollback\) is in progress/i.test(this.stderr);
  }
}

export interface UpgradeInstallOptions {
  release: string;
  namespace: string;
  chart: string;
  valuesFiles: string[];
  values: Record<string, unknown>;
  timeout: string;
}

export type HelmObserver = (operation: string, result: 'success' | 'error', seconds: number) => void;

export class HelmClient {
  constructor(
    private readonly binary: string,
    private readonly observe: HelmObserver = () => {},
  ) {}

  /**
   * Idempotent install: running it twice converges to the same release. It does
   * not wait for workloads; the reconciler tracks readiness.
   */
  async upgradeInstall(opts: UpgradeInstallOptions): Promise<string> {
    const valuesPath = path.join(os.tmpdir(), `values-${opts.release}-${randomUUID()}.json`);
    await fs.writeFile(valuesPath, JSON.stringify(opts.values), { mode: 0o600 });
    try {
      return await this.run([
        'upgrade',
        '--install',
        opts.release,
        opts.chart,
        '--namespace',
        opts.namespace,
        '--timeout',
        opts.timeout,
        '--history-max',
        '5',
        ...opts.valuesFiles.flatMap((file) => ['-f', file]),
        '-f',
        valuesPath,
      ]);
    } finally {
      await fs.rm(valuesPath, { force: true });
    }
  }

  /** Uninstall; a missing release is treated as success. */
  async uninstall(release: string, namespace: string, timeout: string): Promise<void> {
    try {
      await this.run(['uninstall', release, '--namespace', namespace, '--wait', '--timeout', timeout]);
    } catch (err) {
      if (err instanceof HelmError && /not found/i.test(err.stderr)) return;
      throw err;
    }
  }

  async version(): Promise<string> {
    return (await this.run(['version', '--short'])).trim();
  }

  private async run(args: string[]): Promise<string> {
    const started = process.hrtime.bigint();
    let result: 'success' | 'error' = 'error';
    try {
      const output = await this.exec(args);
      result = 'success';
      return output;
    } finally {
      this.observe(args[0] ?? 'unknown', result, Number(process.hrtime.bigint() - started) / 1e9);
    }
  }

  private exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), COMMAND_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new HelmError(`failed to execute helm: ${err.message}`, err.message));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
        } else {
          const detail = stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${code}`;
          reject(new HelmError(`helm ${args[0]} failed: ${detail}`, stderr));
        }
      });
    });
  }
}
