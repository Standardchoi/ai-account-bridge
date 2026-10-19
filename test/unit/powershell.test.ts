import { describe, expect, it } from 'vitest';
import { runPowerShell } from '../../src/main/infra/powershell.js';

describe.skipIf(process.platform !== 'win32')('runPowerShell timeout', () => {
  it('kills the process and rejects if it does not close in time', async () => {
    const start = Date.now();
    await expect(runPowerShell('Start-Sleep -Seconds 5', '', 500)).rejects.toThrow('timed out');
    expect(Date.now() - start).toBeLessThan(4000);
  });

  it('still resolves normally when the process finishes quickly', async () => {
    await expect(runPowerShell('Write-Output hi')).resolves.toContain('hi');
  });
});
