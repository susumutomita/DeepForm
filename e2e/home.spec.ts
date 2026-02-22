import { test, expect } from '@playwright/test';

test.describe('ホームページ', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('タイトルが表示されるべき', async ({ page }) => {
    await expect(page).toHaveTitle(/DeepForm/);
  });

  test('ヒーローセクションが表示されるべき', async ({ page }) => {
    const hero = page.locator('.hero');
    await expect(hero).toBeVisible();
    await expect(hero.locator('h1')).toBeVisible();
  });

  test('ヘッダーロゴが表示されるべき', async ({ page }) => {
    const logo = page.locator('.logo');
    await expect(logo).toBeVisible();
    await expect(logo).toContainText('DeepForm');
  });

  test('テーマ入力欄と開始ボタンが表示されるべき', async ({ page }) => {
    await expect(page.locator('#theme-input')).toBeVisible();
    await expect(page.locator('#btn-start')).toBeVisible();
  });

  test('How it works セクションが表示されるべき', async ({ page }) => {
    const section = page.locator('#how-it-works');
    await expect(section).toBeVisible();
    await expect(section.locator('.flow-card')).toHaveCount(5);
  });

  test('フッターが表示されるべき', async ({ page }) => {
    const footer = page.locator('.footer');
    await expect(footer).toBeVisible();
    await expect(footer).toContainText('DeepForm');
  });
});

test.describe('ダークモード切替', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('テーマ切替ボタンが表示されるべき', async ({ page }) => {
    const btn = page.locator('#theme-toggle');
    await expect(btn).toBeVisible();
  });

  test('クリックでダークモードに切り替わるべき', async ({ page }) => {
    const btn = page.locator('#theme-toggle');

    // Initially no data-theme (system default)
    const html = page.locator('html');
    const initialTheme = await html.getAttribute('data-theme');

    // Click to toggle
    await btn.click();
    const newTheme = await html.getAttribute('data-theme');

    // Theme should have changed
    if (!initialTheme || initialTheme === 'light') {
      expect(newTheme).toBe('dark');
    } else {
      expect(newTheme).toBe('light');
    }
  });

  test('ダークモードで再クリックするとライトモードに戻るべき', async ({ page }) => {
    const btn = page.locator('#theme-toggle');
    const html = page.locator('html');

    // Click twice to toggle back
    await btn.click();
    const afterFirst = await html.getAttribute('data-theme');
    await btn.click();
    const afterSecond = await html.getAttribute('data-theme');

    // Should toggle between light and dark
    expect(afterFirst).not.toBe(afterSecond);
  });

  test('ダークモードの設定が localStorage に保存されるべき', async ({ page }) => {
    const btn = page.locator('#theme-toggle');
    await btn.click();

    const stored = await page.evaluate(() => localStorage.getItem('deepform-theme'));
    expect(stored).toBeTruthy();
    expect(['light', 'dark']).toContain(stored);
  });
});

test.describe('言語切替', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('言語切替ボタンが 4 つ表示されるべき', async ({ page }) => {
    const langBtns = page.locator('.lang-btn');
    await expect(langBtns).toHaveCount(4);
  });

  test('EN ボタンで英語に切り替わるべき', async ({ page }) => {
    await page.locator('.lang-btn[data-lang="en"]').click();

    // html lang attribute should change
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    // Hero CTA should be in English
    await expect(page.locator('#btn-start')).toContainText('Talk to AI');
  });

  test('ES ボタンでスペイン語に切り替わるべき', async ({ page }) => {
    await page.locator('.lang-btn[data-lang="es"]').click();

    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page.locator('#btn-start')).toContainText('Hablar con IA');
  });

  test('JA ボタンで日本語に戻るべき', async ({ page }) => {
    // First switch to EN
    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    // Then switch back to JA
    await page.locator('.lang-btn[data-lang="ja"]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  });

  test('言語設定が localStorage に保存されるべき', async ({ page }) => {
    await page.locator('.lang-btn[data-lang="en"]').click();

    const stored = await page.evaluate(() => localStorage.getItem('deepform-lang'));
    expect(stored).toBe('en');
  });

  test('選択中の言語ボタンに active クラスが付くべき', async ({ page }) => {
    await page.locator('.lang-btn[data-lang="en"]').click();

    await expect(page.locator('.lang-btn[data-lang="en"]')).toHaveClass(/active/);
    await expect(page.locator('.lang-btn[data-lang="ja"]')).not.toHaveClass(/active/);
  });
});

test.describe('認証要求の表示', () => {
  test('未ログイン時にセッション作成するとトースト警告が表示されるべき', async ({ page }) => {
    await page.goto('/');

    // Enter a theme
    await page.locator('#theme-input').fill('テストテーマ');

    // Click start - should show auth required toast
    await page.locator('#btn-start').click();

    // Wait for the toast to appear
    const toast = page.locator('#toast');
    await expect(toast).not.toHaveClass(/hidden/, { timeout: 5000 });
  });
});

test.describe('ポリシーモーダル', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('プライバシーポリシーリンクをクリックするとモーダルが開くべき', async ({ page }) => {
    await page.locator('a[onclick*="openPolicy(\'privacy\')"]').click();

    const modal = page.locator('#policy-modal');
    await expect(modal).toBeVisible();
    await expect(modal).not.toHaveClass(/hidden/);
  });

  test('利用規約リンクをクリックするとモーダルが開くべき', async ({ page }) => {
    await page.locator('a[onclick*="openPolicy(\'terms\')"]').click();

    const modal = page.locator('#policy-modal');
    await expect(modal).toBeVisible();
  });

  test('セキュリティポリシーリンクをクリックするとモーダルが開くべき', async ({ page }) => {
    await page.locator('a[onclick*="openPolicy(\'security\')"]').click();

    const modal = page.locator('#policy-modal');
    await expect(modal).toBeVisible();
  });

  test('閉じるボタンでモーダルが閉じるべき', async ({ page }) => {
    // Open the modal
    await page.locator('a[onclick*="openPolicy(\'privacy\')"]').click();
    const modal = page.locator('#policy-modal');
    await expect(modal).toBeVisible();

    // Close with the X button
    await page.locator('.modal-close').click();
    await expect(modal).toHaveClass(/hidden/);
  });

  test('オーバーレイクリックでモーダルが閉じるべき', async ({ page }) => {
    await page.locator('a[onclick*="openPolicy(\'privacy\')"]').click();
    const modal = page.locator('#policy-modal');
    await expect(modal).toBeVisible();

    // Click on the overlay (outside the modal content)
    await modal.click({ position: { x: 5, y: 5 } });
    await expect(modal).toHaveClass(/hidden/);
  });

  test('モーダルが開いている間は body スクロールが無効になるべき', async ({ page }) => {
    await page.locator('a[onclick*="openPolicy(\'privacy\')"]').click();

    const overflow = await page.evaluate(() => document.body.style.overflow);
    expect(overflow).toBe('hidden');

    // Close and verify scroll restored
    await page.locator('.modal-close').click();
    const overflowAfter = await page.evaluate(() => document.body.style.overflow);
    expect(overflowAfter).toBe('');
  });
});
