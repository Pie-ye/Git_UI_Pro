import { expect, test, type Page, type TestInfo } from "@playwright/test";

async function openApp(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开仓库中心" })).toBeVisible();
}

async function openFirstWorktreeFile(page: Page) {
  const fileRow = page.locator(".scm-file-row").first();
  await expect(fileRow).toBeVisible();
  await fileRow.click();
  await expect(page.locator(".editor-detail-panel:not(.empty)")).toBeVisible();
}

function parseOpaqueColor(value: string): [number, number, number] {
  const color = value.trim();
  const hex = color.match(/^#([\da-f]{6})$/i);
  if (hex) {
    return [
      Number.parseInt(hex[1].slice(0, 2), 16),
      Number.parseInt(hex[1].slice(2, 4), 16),
      Number.parseInt(hex[1].slice(4, 6), 16)
    ];
  }

  const rgb = color.match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/i);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }

  throw new Error(`无法解析颜色：${value}`);
}

function contrastRatio(foreground: string, background: string) {
  const luminance = (color: string) => {
    const channels = parseOpaqueColor(color).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

async function captureThemeSmoke(page: Page, testInfo: TestInfo, theme: "light" | "dark") {
  const styles = await page.locator(".app-shell").evaluate((element) => {
    const appStyle = getComputedStyle(element);
    const topBarStyle = getComputedStyle(document.querySelector(".top-bar")!);
    return {
      background: appStyle.getPropertyValue("--bg").trim(),
      text: appStyle.getPropertyValue("--text").trim(),
      topBarColor: topBarStyle.color,
      topBarBackground: topBarStyle.backgroundColor,
      topBarBorderRadius: topBarStyle.borderRadius,
      topBarBoxShadow: topBarStyle.boxShadow
    };
  });

  expect(contrastRatio(styles.text, styles.background)).toBeGreaterThanOrEqual(7);
  expect(styles.topBarColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(styles.topBarBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(styles.topBarBorderRadius).not.toBe("0px");
  expect(styles.topBarBoxShadow).not.toBe("none");
  await testInfo.attach(`${theme}-theme`, {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png"
  });
}

test("桌面宽度打开仓库中心不会产生横向溢出", async ({ page }) => {
  await openApp(page);
  const repositoryButton = page.getByRole("button", { name: "打开仓库中心" });
  const repositoryTooltip = page.locator('[role="tooltip"]').filter({ hasText: "仓库中心" });
  await repositoryButton.hover();
  await expect(repositoryTooltip).toBeVisible();
  await repositoryButton.click();
  await expect(repositoryTooltip).toBeHidden();

  const dialog = page.getByRole("dialog", { name: /git ui pro/i });
  await expect(dialog).toBeVisible();
  const metrics = await dialog.evaluate((element) => {
    const content = element.querySelector<HTMLElement>(".repository-center-content")!;
    const layout = element.querySelector<HTMLElement>(".repository-center-layout")!;
    const chrome = document.querySelector<HTMLElement>(".app-chrome")!;
    const rect = element.getBoundingClientRect();
    const chromeRect = chrome.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      dialogLeft: rect.left,
      dialogTop: rect.top,
      dialogRight: rect.right,
      chromeBottom: chromeRect.bottom,
      dialogClientWidth: element.clientWidth,
      dialogScrollWidth: element.scrollWidth,
      layoutClientWidth: layout.clientWidth,
      layoutScrollWidth: layout.scrollWidth,
      contentClientWidth: content.clientWidth,
      contentScrollWidth: content.scrollWidth
    };
  });

  expect(metrics.dialogLeft).toBeGreaterThanOrEqual(0);
  expect(metrics.dialogTop).toBeGreaterThanOrEqual(metrics.chromeBottom);
  expect(metrics.dialogRight).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.documentClientWidth + 1);
  expect(metrics.dialogScrollWidth).toBeLessThanOrEqual(metrics.dialogClientWidth + 1);
  expect(metrics.layoutScrollWidth).toBeLessThanOrEqual(metrics.layoutClientWidth + 1);
  expect(metrics.contentScrollWidth).toBeLessThanOrEqual(metrics.contentClientWidth + 1);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(1_200);
  await expect(repositoryTooltip).toBeHidden();
});

test("项目栏头部使用单行等尺寸图标且搜索可展开", async ({ page }) => {
  await openApp(page);

  const readTooltipVisual = (selector: ReturnType<Page["locator"]>) => selector.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      border: style.border,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
      color: style.color,
      fontSize: style.fontSize,
      padding: style.padding
    };
  });

  const metrics = await page.evaluate(() => {
    const topBar = document.querySelector<HTMLElement>(".top-bar")!;
    const search = document.querySelector<HTMLElement>(".project-rail-search")!;
    const searchInput = search.querySelector<HTMLInputElement>("input")!;
    const title = document.querySelector<HTMLElement>(".project-rail-header > strong")!;
    const headerControls = Array.from(document.querySelectorAll<HTMLElement>(".project-rail-actions .compact-icon"));
    const controlRects = headerControls.map((control) => control.getBoundingClientRect());
    const titleRect = title.getBoundingClientRect();
    return {
      topBarHeight: topBar.getBoundingClientRect().height,
      searchWidth: search.getBoundingClientRect().width,
      searchInputOpacity: getComputedStyle(searchInput).opacity,
      controlCount: controlRects.length,
      controlWidthSpread: Math.max(...controlRects.map((rect) => rect.width)) - Math.min(...controlRects.map((rect) => rect.width)),
      controlTopSpread: Math.max(...controlRects.map((rect) => rect.top)) - Math.min(...controlRects.map((rect) => rect.top)),
      titleOverlapsControls: titleRect.width > 0 && titleRect.right > controlRects[0].left
    };
  });

  expect(metrics.topBarHeight).toBeLessThanOrEqual(54);
  expect(metrics.searchWidth).toBeLessThanOrEqual(44);
  expect(metrics.searchInputOpacity).toBe("0");
  expect(metrics.controlCount).toBe(5);
  expect(metrics.controlWidthSpread).toBeLessThanOrEqual(1);
  expect(metrics.controlTopSpread).toBeLessThanOrEqual(1);
  expect(metrics.titleOverlapsControls).toBe(false);

  const searchControl = page.locator(".project-rail-search");
  const filterButton = page.getByRole("button", { name: "筛选项目：全部状态" });
  await expect(searchControl).toHaveCSS("cursor", "pointer");
  expect(await searchControl.getAttribute("title")).toBeNull();
  expect(await filterButton.getAttribute("title")).toBeNull();

  const scanButton = page.getByRole("button", { name: "扫描父目录中的 Git 项目" });
  const scanTooltip = page.locator('[role="tooltip"]').filter({ hasText: "扫描父目录中的 Git 项目" });
  await scanButton.hover();
  await expect(scanTooltip).toBeVisible();
  const referenceTooltipVisual = await readTooltipVisual(scanTooltip);

  await searchControl.hover();
  const searchTooltip = page.locator('[role="tooltip"]').filter({ hasText: "搜索项目" });
  await expect(searchTooltip).toBeVisible();
  expect(await readTooltipVisual(searchTooltip)).toEqual(referenceTooltipVisual);

  await filterButton.hover();
  const filterTooltip = page.locator('[role="tooltip"]').filter({ hasText: "筛选项目：全部状态" });
  await expect(filterTooltip).toBeVisible();
  expect(await readTooltipVisual(filterTooltip)).toEqual(referenceTooltipVisual);

  await searchControl.click();
  const searchInput = page.getByRole("textbox", { name: "搜索项目" });
  await expect(searchInput).toBeFocused();
  await expect.poll(async () => searchInput.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(80);
  const focusVisual = await searchControl.evaluate((element) => {
    const controlStyle = getComputedStyle(element);
    const inputStyle = getComputedStyle(element.querySelector("input")!);
    return {
      controlBoxShadow: controlStyle.boxShadow,
      inputBoxShadow: inputStyle.boxShadow,
      inputOutlineWidth: inputStyle.outlineWidth
    };
  });
  expect(focusVisual.controlBoxShadow).not.toContain("0px 0px 0px 3px");
  expect(focusVisual.inputBoxShadow).toBe("none");
  expect(focusVisual.inputOutlineWidth).toBe("0px");

  await page.locator(".top-bar").hover();
  await searchInput.hover();
  await expect(searchTooltip).toBeVisible();
  expect(await readTooltipVisual(searchTooltip)).toEqual(referenceTooltipVisual);

  await page.locator(".top-bar .project-heading").click();
  await expect(searchInput).not.toBeFocused();
  await expect.poll(async () => searchControl.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(44);
});

for (const viewport of [
  { width: 850, height: 900 },
  { width: 700, height: 820 }
]) {
  test(`${viewport.width}x${viewport.height} 选择工作区文件后详情区仍在视口内`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openApp(page);
    await openFirstWorktreeFile(page);

    const detail = page.locator(".editor-detail-panel:not(.empty)");
    const rect = await detail.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.width).toBeGreaterThanOrEqual(180);
    expect(rect!.height).toBeGreaterThanOrEqual(120);
    expect(rect!.x).toBeLessThan(viewport.width);
    expect(rect!.y).toBeLessThan(viewport.height);
    expect(rect!.x + rect!.width).toBeGreaterThan(0);
    expect(rect!.y + rect!.height).toBeGreaterThan(0);
    await expect(detail.getByRole("tab").first()).toBeVisible();
  });
}

test("键盘可以打开仓库中心并操作焦点和项目菜单", async ({ page }) => {
  await openApp(page);
  await expect(page.locator(".console-tab.active .console-tab-tooltip > .sr-only")).toContainText("Mock Shell");

  const repositoryButton = page.getByRole("button", { name: "打开仓库中心" });
  await repositoryButton.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: /git ui pro/i });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  await page.keyboard.press("Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(repositoryButton).toBeFocused();

  const project = page.locator(".project-rail-item").first();
  await project.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const menuItems = menu.getByRole("menuitem");
  await expect(menuItems.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menuItems.nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(project).toBeFocused();
});

test("亮色和暗色主题保持关键文字可读并完成截图 smoke", async ({ page }, testInfo) => {
  await openApp(page);
  await expect(page.locator(".app-shell")).toHaveClass(/theme-light/);
  await captureThemeSmoke(page, testInfo, "light");

  await page.getByRole("button", { name: "切换深色主题" }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/theme-dark/);
  await captureThemeSmoke(page, testInfo, "dark");
});
