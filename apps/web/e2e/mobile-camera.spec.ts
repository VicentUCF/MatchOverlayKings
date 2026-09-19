import { expect, test } from '@playwright/test';

const cameraUrl = '/camera/pilot#endpoint=http%3A%2F%2F192.168.1.10%3A4310&session=11111111-1111-4111-8111-111111111111&token=' + 'a'.repeat(32);

test('requires landscape before preparing and responds to repeated rotations', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(cameraUrl);
  const prepare = page.getByRole('button', { name: 'Preparar cámara' });
  await expect(prepare).toBeDisabled();
  await expect(page.getByText('Coloca el móvil en horizontal')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('portrait.png'), fullPage: true });

  for (const size of [{ width: 844, height: 390 }, { width: 1024, height: 768 }, { width: 568, height: 320 }]) {
    await page.setViewportSize(size);
    await expect(prepare).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Activar modo horizontal' })).toHaveCount(0);
    const stage = await page.locator('.mobile-camera-stage').boundingBox();
    const controls = await page.locator('.mobile-camera-orientation').boundingBox();
    expect(stage!.x + stage!.width).toBeLessThanOrEqual(controls!.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`landscape-${size.width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(prepare).toBeDisabled();
  await expect(page.getByText('Coloca el móvil en horizontal')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Activar modo horizontal' })).toBeVisible();
});

test('explains how to recover when orientation locking is unavailable', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(screen.orientation, 'lock', { value: undefined }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(cameraUrl);
  await page.getByRole('button', { name: 'Activar modo horizontal' }).click();
  await expect(page.getByRole('alert')).toContainText('Activa la rotación automática');
  await expect(page.getByRole('button', { name: 'Preparar cámara' })).toBeDisabled();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Preparar cámara' })).toBeEnabled();
});

for (const rejects of [false, true]) {
  test(`requests fullscreen before locking and allows exit (lock rejection: ${rejects})`, async ({ page }) => {
    await page.addInitScript((rejectLock) => {
      let fullscreen: Element | null = null;
      Object.defineProperty(document, 'fullscreenElement', { get: () => fullscreen });
      Element.prototype.requestFullscreen = async () => {
        fullscreen = document.documentElement;
        document.dispatchEvent(new Event('fullscreenchange'));
      };
      document.exitFullscreen = async () => {
        fullscreen = null;
        document.dispatchEvent(new Event('fullscreenchange'));
      };
      Object.defineProperty(screen.orientation, 'lock', { value: async (value: string) => {
        if (!fullscreen || value !== 'landscape') throw new Error('Invalid orientation request');
        if (rejectLock) throw new Error('Unsupported');
        document.documentElement.dataset.orientationLocked = value;
      } });
    }, rejects);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(cameraUrl);
    await page.getByRole('button', { name: 'Activar modo horizontal' }).click();
    if (rejects) await expect(page.getByRole('alert')).toContainText('No se pudo activar');
    else await expect(page.locator('html')).toHaveAttribute('data-orientation-locked', 'landscape');
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.getByRole('button', { name: 'Activar modo horizontal' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Salir de pantalla completa' }).click();
    await expect(page.getByRole('button', { name: 'Salir de pantalla completa' })).toHaveCount(0);
  });
}
