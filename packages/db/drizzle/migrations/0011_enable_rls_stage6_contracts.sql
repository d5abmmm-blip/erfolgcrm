-- RLS для contracts. Запускается setup-rls.ts (вне drizzle journal).
--
-- tickets.contract_id RLS-защищён транзитивно через RLS на самой таблице tickets:
-- запрос к чужому contract_id из чужого tenant'а не вернёт строку, и SET NULL FK тоже работает
-- только в пределах своего tenant'а (FK не нарушает RLS — он работает на уровне owner).

ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_contracts ON contracts
  USING (tenant_id = current_tenant_id());
