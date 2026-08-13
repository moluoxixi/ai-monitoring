import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class ProcessExecutionError extends Error {}

@Injectable()
export class ProcessRunnerService {
  async run(
    executable: string,
    args: string[],
    options: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv; redact?: string[] },
  ): Promise<string> {
    try {
      const result = await execFileAsync(executable, args, {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      return result.stdout.trim();
    } catch (error) {
      const failure = error as { stderr?: string; stdout?: string; message?: string };
      let detail = (failure.stderr || failure.stdout || failure.message || 'command failed').trim().slice(-800);
      for (const value of options.redact || []) {
        if (value) detail = detail.split(value).join('<redacted>');
      }
      throw new ProcessExecutionError(detail || 'command failed');
    }
  }
}
