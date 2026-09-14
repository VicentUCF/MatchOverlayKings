import { describe, expect, it } from 'vitest';
import {
  createProductionSetupInventoryAdapter,
  type ProductionSetupInventoryBackend,
} from './production-setup-inventory.js';

const CLUB_ID = '10000000-0000-4000-8000-000000000001';

function courtRows(): readonly object[] {
  return ['pista-1', 'pista-2', 'pista-3', 'pista-4'].map((slug, index) => ({
    id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    club_id: CLUB_ID,
    slug,
    name: `Pista ${index + 1}`,
    display_order: index + 1,
    production_enabled: true,
  }));
}

function humanPrincipalRow(): object {
  return {
    id: '20000000-0000-4000-8000-000000000001', club_id: CLUB_ID,
    auth_user_id: '21000000-0000-4000-8000-000000000001', kind: 'human',
    display_name: 'Operador', active: true, version: 1,
    created_at: '2026-09-14T10:00:00.000Z', updated_at: '2026-09-14T10:00:00.000Z',
  };
}

describe('production setup inventory adapter', () => {
  it('loads only explicitly granted columns and never requests secret references', async () => {
    const requestedColumns: string[] = [];
    const backend: ProductionSetupInventoryBackend = {
      select: async (table, columns) => {
        requestedColumns.push(columns);
        const data = table === 'courts' ? courtRows()
          : table === 'production_principals' ? [humanPrincipalRow()]
          : [];
        return { data, error: null };
      },
    };

    const result = await createProductionSetupInventoryAdapter(backend).load(CLUB_ID);

    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(result.inventory.principals).toEqual([]);
    expect(requestedColumns).toHaveLength(7);
    expect(requestedColumns.join(',')).not.toContain('secret_ref');
  });

  it('rejects malformed inventory instead of treating it as resumable progress', async () => {
    const backend: ProductionSetupInventoryBackend = {
      select: async (table) => ({ data: table === 'courts' ? [] : [], error: null }),
    };

    await expect(createProductionSetupInventoryAdapter(backend).load(CLUB_ID))
      .resolves.toEqual({ kind: 'malformed' });
  });
});
