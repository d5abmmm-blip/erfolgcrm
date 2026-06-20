/**
 * Тесты HMAC-токенов и конфигурации полной копии базы (раздел «Резервные копии»).
 * Чистые функции — БД и seed не нужны.
 */
import { describe, it, expect } from 'vitest';
import {
  fullDumpFileName,
  makeFullDumpToken,
  resolveBackupExecConfig,
  verifyFullDumpToken,
} from '../modules/backup/service';

describe('backup full-dump token', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';

  it('свежий токен проходит проверку', () => {
    const { exp, sig } = makeFullDumpToken(tenantId);
    expect(verifyFullDumpToken({ tenantId, exp, sig })).toBe(true);
  });

  it('токен другого tenant не проходит (подпись покрывает tenantId)', () => {
    const { exp, sig } = makeFullDumpToken(tenantId);
    expect(verifyFullDumpToken({ tenantId: 'другой-tenant', exp, sig })).toBe(false);
  });

  it('истёкший токен не проходит', () => {
    const { sig } = makeFullDumpToken(tenantId);
    const expiredExp = Math.floor(Date.now() / 1000) - 10;
    expect(verifyFullDumpToken({ tenantId, exp: expiredExp, sig })).toBe(false);
  });

  it('подделанная подпись не проходит', () => {
    const { exp } = makeFullDumpToken(tenantId);
    expect(verifyFullDumpToken({ tenantId, exp, sig: 'deadbeef' })).toBe(false);
  });

  it('пустые аргументы не валят проверку (false, без исключения)', () => {
    expect(verifyFullDumpToken({ tenantId: '', exp: 0, sig: '' })).toBe(false);
  });
});

describe('backup config & file name', () => {
  it('имя файла дампа детерминировано по дате', () => {
    const cfg = resolveBackupExecConfig();
    const name = fullDumpFileName(cfg, new Date('2026-06-17T15:30:00'));
    expect(name).toBe(`${cfg.database}-backup-2026-06-17-1530.dump`);
  });

  it('вне production по умолчанию режим docker с owner-пользователем', () => {
    const cfg = resolveBackupExecConfig();
    // В тестовой среде NODE_ENV !== 'production'.
    expect(cfg.mode).toBe('docker');
    expect(cfg.container).toContain('erfolgcrm-postgres');
    expect(cfg.user).toBe('erfolg');
  });
});
