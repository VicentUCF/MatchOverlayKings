import { expect, test } from '@playwright/test';

test('shows only live matches on the public home page', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: /partidos en directo/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /mandos/i })).toHaveCount(0);
});

test('lists all courts on the admin page', async ({ page }) => {
  await page.goto('/admin');
  await page.getByRole('button', { name: /entrar/i }).click();

  await expect(page.getByRole('heading', { name: /todas las pistas/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /mandos/i }).first()).toHaveAttribute('href', '/control/pista-1');
  await expect(page.getByRole('link', { name: /obs/i }).first()).toHaveAttribute('href', '/overlay/pista-1/scoreboard');
});

test('updates the OBS overlay when the control adds a point', async ({ browser }, testInfo) => {
  const eventId = testInfo.project.name === 'mobile' ? 'pista-2' : 'pista-1';
  const control = await browser.newPage();
  const overlay = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  await control.goto(`/control/${eventId}`);
  await overlay.goto(`/overlay/${eventId}/scoreboard`);

  await expect(control.getByText('KPL Live Control')).toBeVisible();
  await control.getByRole('button', { name: /iniciar partido/i }).click();
  await expect(control.getByRole('button', { name: /\+ punto local/i })).toBeVisible();
  await control.getByRole('button', { name: /\+ punto local/i }).click();

  await expect(overlay.locator('.point-number').first()).toContainText(/15|30|40|0/);
  await control.getByRole('button', { name: /configurar siguiente/i }).click();
  await control.getByRole('button', { name: /nueva partida/i }).click();
  await expect(overlay.locator('.point-number').first()).toHaveText('0');

  await control.close();
  await overlay.close();
});
