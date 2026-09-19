import { expect, test } from '@playwright/test';
import { addPoint, createInitialMatchState, DEFAULT_MATCH_CONFIG } from '../../../packages/shared/src/index.js';

const token = 'a'.repeat(64);

for (const revoked of [false, true]) {
  test(`visual control opens without login (revoked: ${revoked})`, async ({ page }) => {
    let state = createInitialMatchState({
      id: 'pista-1', title: 'Prueba de acceso', courtName: 'Pista 1',
      homeTeamId: 'home', awayTeamId: 'away', servingSide: 'home', status: 'live',
      lineups: { home: { player1: '', player2: '' }, away: { player1: '', player2: '' } },
      config: DEFAULT_MATCH_CONFIG,
    });
    let commands = 0;
    await page.route('**/rest/v1/**', async (route) => {
      if (!route.request().url().includes('/rpc/visual_control_command')) {
        await route.fulfill({ json: [] });
        return;
      }
      const body = route.request().postDataJSON();
      expect(body.p_token).toBe(token);
      expect(body.p_court_slug).toBe('pista-1');
      if (revoked) {
        await route.fulfill({ status: 400, json: { message: 'Enlace de control inválido o revocado.' } });
        return;
      }
      if (body.p_action === 'add_point') {
        expect(body.p_params.p_expected_version).toBe(state.version);
        state = addPoint(state, body.p_params.p_side, body.p_params.p_command_id);
        commands++;
      } else expect(body.p_action).toBe('state');
      await route.fulfill({ json: state });
    });
    await page.goto(`/control/pista-1#token=${token}`);
    if (revoked) {
      await expect(page.getByText('Enlace de control inválido o revocado.')).toBeVisible();
      expect(commands).toBe(0);
      return;
    }
    const point = page.locator('.point-button.home:visible, .mobile-point-actions button.home:visible').first();
    await expect(point).toBeEnabled();
    await point.click();
    await expect.poll(() => commands).toBe(1);
    await expect(point).toBeEnabled();
    await page.reload();
    await expect(point).toBeEnabled();
  });
}
