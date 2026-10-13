import { expect, test, type Locator } from "@playwright/test";

async function expectRustVirtualObsidian(page: import("@playwright/test").Page): Promise<void> {
	await expect(page.locator("html")).toHaveAttribute("data-virtual-obsidian-engine", "rust");
}

function intersects(
	first: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>,
	second: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>,
) {
	return !(
		first.x + first.width <= second.x ||
		second.x + second.width <= first.x ||
		first.y + first.height <= second.y ||
		second.y + second.height <= first.y
	);
}

test("mobile player leaves Obsidian chrome usable", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("./");
	await expectRustVirtualObsidian(page);

	const root = page.locator(".sonora-app");
	const player = page.locator(".sonora-player");
	const nav = page.locator(".sonora-sidebar");
	const chrome = page.getByRole("button", { name: "Obsidian mobile menu" });
	await expect(root).toBeVisible();
	await expect(player).toBeVisible();
	await expect(nav).toBeVisible();
	await expect(chrome).toBeVisible();

	const dimensions = await root.evaluate((element) => ({
		clientWidth: element.clientWidth,
		scrollWidth: element.scrollWidth,
	}));
	expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);

	const chromeBox = await chrome.boundingBox();
	const playerBox = await player.boundingBox();
	const navBox = await nav.boundingBox();
	expect(chromeBox).not.toBeNull();
	expect(playerBox).not.toBeNull();
	expect(navBox).not.toBeNull();
	expect(intersects(chromeBox!, playerBox!)).toBe(false);
	expect(intersects(chromeBox!, navBox!)).toBe(false);

	for (const control of await page
		.locator(".sonora-player button:visible, .sonora-sidebar nav button:visible")
		.all()) {
		const box = await control.boundingBox();
		const label =
			(await control.getAttribute("aria-label")) ??
			(await control.textContent())?.trim() ??
			(await control.getAttribute("class")) ??
			"unnamed control";
		expect(box?.width ?? 0, `${label} width`).toBeGreaterThanOrEqual(44);
		expect(box?.height ?? 0, `${label} height`).toBeGreaterThanOrEqual(44);
	}

	await expect
		.poll(async () => {
			const lyricsBox = await page.locator(".sonora-lyrics-lines").boundingBox();
			const currentLineBox = await page.locator(".sonora-lyrics-lines .is-current").boundingBox();
			if (!lyricsBox || !currentLineBox) return false;
			return (
				currentLineBox.y >= lyricsBox.y - 1 &&
				currentLineBox.y + currentLineBox.height <= lyricsBox.y + lyricsBox.height + 1
			);
		})
		.toBe(true);

	const runtimeProcess = (globalThis as { process?: { platform?: string } }).process;
	if (runtimeProcess?.platform === "darwin") {
		await expect(page.locator(".visual-obsidian-view")).toHaveScreenshot(
			"mobile-player-chrome.png",
			{
				animations: "disabled",
			},
		);
	}
});

for (const scenario of [
	{ name: "desktop", viewport: { width: 1280, height: 768 } },
	{ name: "mobile", viewport: { width: 390, height: 844 } },
] as const) {
	test(`${scenario.name} microphone denial provides an in-context recovery path`, async ({
		page,
	}) => {
		await page.setViewportSize(scenario.viewport);
		await page.goto("./?scenario=recording-denied");
		const alert = page.getByRole("alert");
		await expect(alert).toContainText("Microphone access is blocked");
		await expect(alert).toContainText("device settings");
		for (const control of await alert.getByRole("button").all()) {
			const box = await control.boundingBox();
			expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
		}
		if ((globalThis as { process?: { platform?: string } }).process?.platform === "darwin") {
			await expect(page.locator(".visual-obsidian-view")).toHaveScreenshot(
				`recording-denied-${scenario.name}.png`,
				{ animations: "disabled" },
			);
		}
	});
}

test("mobile menus remain visible and dark playback control keeps contrast", async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 844 });
	await page.goto("./");

	await page.locator(".sonora-mobile-add summary").click();
	const view = await page.locator(".visual-obsidian-view").boundingBox();
	const actions = page.locator(".sonora-mobile-add > div");
	const actionsBox = await actions.boundingBox();
	expect(view).not.toBeNull();
	expect(actionsBox).not.toBeNull();
	expect(actionsBox!.x).toBeGreaterThanOrEqual(view!.x);
	expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(view!.x + view!.width);
	await expect(actions.getByRole("button")).toHaveCount(3);

	await page.locator(".sonora-view").evaluate((element) => element.classList.add("theme-dark"));
	const colors = await page.locator(".sonora-player-play").evaluate((element) => {
		const style = getComputedStyle(element);
		return { foreground: style.color, background: style.backgroundColor };
	});
	expect(colors.foreground).not.toBe(colors.background);
	expect(colors.background).not.toBe("rgba(0, 0, 0, 0)");
});

test("narrow mobile keeps chapter navigation and completion reachable", async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 844 });
	await page.goto("./");

	const previous = page.getByRole("button", { name: "Previous chapter" });
	const next = page.getByRole("button", { name: "Next chapter" });
	await expect(previous).toBeVisible();
	await expect(next).toBeVisible();
	await next.click();
	await expect(page.locator(".sonora-player-track strong")).toHaveText("Open questions");

	await page.getByRole("button", { name: "More playback controls", exact: true }).click();
	const upNext = page.getByRole("button", { name: /Up next: Spanish travel vocabulary/ });
	await expect(upNext).toBeVisible();
	const complete = page.getByRole("button", { name: "Mark listened" });
	await expect(complete).toBeVisible();
	await complete.click();
	await expect(complete).toBeDisabled();
});

for (const scenario of [
	{ name: "desktop", viewport: { width: 1280, height: 768 } },
	{ name: "mobile", viewport: { width: 390, height: 844 } },
] as const) {
	test(`${scenario.name} note detail separates title navigation from one-tap playback`, async ({
		page,
	}) => {
		await page.setViewportSize(scenario.viewport);
		await page.goto("./");
		await page.locator(".sonora-row-title").first().click();
		const detail = page.getByRole("region", {
			name: "Product strategy notes for the next release",
		});
		await expect(detail).toBeVisible();
		await expect(page.getByRole("button", { name: "Play What matters next" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Your library" })).toBeHidden();
		if ((globalThis as { process?: { platform?: string } }).process?.platform === "darwin") {
			await expect(page.locator(".visual-obsidian-view")).toHaveScreenshot(
				`note-detail-${scenario.name}.png`,
				{ animations: "disabled" },
			);
		}
	});
}

for (const scenario of [
	{ name: "desktop", viewport: { width: 1280, height: 768 } },
	{ name: "mobile", viewport: { width: 390, height: 844 } },
] as const) {
	test(`${scenario.name} expanded player keeps text and next items in playback context`, async ({
		page,
	}) => {
		await page.setViewportSize(scenario.viewport);
		await page.goto("./");
		await page.locator(".sonora-player-track").click();
		await expect(page.getByRole("article", { name: "Chapter text" })).toContainText(
			"Start with the listening loop",
		);
		await expect(page.locator("dt", { hasText: "Current chapter" }).locator("..")).toContainText(
			"What matters next",
		);
		await expect(page.locator("dt", { hasText: "Next chapter" }).locator("..")).toContainText(
			"Open questions",
		);
		await expect(
			page.getByRole("region", { name: "Next in queue" }).getByRole("listitem"),
		).toHaveCount(1);
		for (const label of ["Previous chapter", "Pause", "Next chapter"]) {
			const box = await page.getByRole("button", { name: label }).last().boundingBox();
			expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
		}
		if ((globalThis as { process?: { platform?: string } }).process?.platform === "darwin") {
			await expect(page.locator(".visual-obsidian-view")).toHaveScreenshot(
				`expanded-player-${scenario.name}.png`,
				{ animations: "disabled" },
			);
		}
	});
}

test("mobile library keeps Up Next visible and moves removal into the row menu", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("./");

	const row = page.locator(".sonora-library-row").first();
	const main = row.locator(".sonora-row-main");
	const upNext = row.locator(".sonora-row-up-next");
	const more = row.locator(".sonora-row-more");
	await expect(upNext).toBeVisible();
	await expect(more).toBeVisible();
	await expect(row.locator(".sonora-row-remove")).toBeHidden();
	for (const control of [upNext, more]) {
		const box = await control.boundingBox();
		expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
	}
	expect((await main.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(250);

	await more.click();
	const menu = page.getByRole("menu");
	await expect(menu.getByRole("menuitem", { name: "Move down" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(more).toBeFocused();
	await more.click();

	const runtimeProcess = (globalThis as { process?: { platform?: string } }).process;
	if (runtimeProcess?.platform === "darwin") {
		await expect(page.locator(".visual-obsidian-view")).toHaveScreenshot("mobile-row-menu.png", {
			animations: "disabled",
		});
	}
	const moveDown = menu.getByRole("menuitem", { name: "Move down" });
	const moveDownBox = await moveDown.boundingBox();
	expect(moveDownBox?.height ?? 0).toBeGreaterThanOrEqual(44);
	await moveDown.click();
	await expect(page.locator(".sonora-library-row").first()).toContainText(
		"Spanish travel vocabulary",
	);
	await expect(page.locator('[aria-live="polite"]')).toContainText(
		"Moved Product strategy notes for the next release down.",
	);
});

for (const scenario of [
	{ name: "desktop", viewport: { width: 1280, height: 768 } },
	{ name: "mobile", viewport: { width: 390, height: 844 } },
] as const) {
	test(`${scenario.name} queue separates current, next, later, and history`, async ({ page }) => {
		await page.setViewportSize(scenario.viewport);
		await page.goto("./?scenario=queue");
		await page.getByRole("button", { name: /Queue/u }).click();
		for (const name of ["Playing now", "Next", "Later", "Listening history"])
			await expect(page.getByRole("region", { name })).toBeVisible();
		const later = page.getByRole("region", { name: "Later" });
		await expect(later.getByRole("listitem")).toHaveCount(2);
		for (const control of await later.getByRole("button").all()) {
			if (!(await control.isVisible())) continue;
			const box = await control.boundingBox();
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(scenario.name === "mobile" ? 44 : 32);
		}
		if ((globalThis as { process?: { platform?: string } }).process?.platform === "darwin")
			await expect(page.locator(".visual-obsidian-view")).toHaveScreenshot(
				`queue-${scenario.name}.png`,
				{ animations: "disabled" },
			);
	});
}

test("mobile empty library has one primary add path", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("./?scenario=empty");

	await expect(page.locator(".sonora-add-actions")).toBeHidden();
	await expect(page.locator(".sonora-start-options .is-primary")).toBeVisible();
	await expect(page.locator(".sonora-start-options .is-secondary")).toBeVisible();
	await expect(page.locator(".sonora-start-options .is-text-link")).toBeVisible();
});

test("drill filter preserves playback and explains that it is outside the filter", async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 844 });
	await page.goto("./");

	await page.getByRole("button", { name: /Language drills/ }).click();
	await expect(page.locator(".sonora-player-track small")).toHaveText(
		"Product strategy notes for the next release",
	);
	const outside = page.getByRole("status", { name: "Now playing outside current filters" });
	await expect(outside).toContainText("Outside current filters");
	await expect(outside).not.toContainText("Product strategy notes for the next release");
	await expect(page.locator(".sonora-library-row.is-active")).toHaveCount(0);
	const dimensions = await page.locator(".sonora-app").evaluate((element) => ({
		clientWidth: element.clientWidth,
		scrollWidth: element.scrollWidth,
	}));
	expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
	const showButton = outside.getByRole("button", { name: "Show in library" });
	const showButtonBox = await showButton.boundingBox();
	expect(showButtonBox?.height ?? 0).toBeGreaterThanOrEqual(44);

	await showButton.click();
	await expect(page.locator(".sonora-library-row.is-active")).toContainText(
		"Product strategy notes for the next release",
	);
});

for (const viewport of [
	{ name: "wide-mobile", width: 430, height: 932, mobile: true },
	{ name: "compact-720", width: 720, height: 900, mobile: true },
	{ name: "tablet-boundary", width: 768, height: 1024, mobile: false },
] as const) {
	test(`${viewport.name} keeps the intended responsive structure`, async ({ page }) => {
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		await page.goto("./");

		const app = page.locator(".sonora-app");
		const layout = await app.evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				columns: style.gridTemplateColumns,
				rows: style.gridTemplateRows,
				clientWidth: element.clientWidth,
				scrollWidth: element.scrollWidth,
			};
		});
		expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
		if (viewport.mobile) {
			expect(layout.columns.trim().split(/\s+/u)).toHaveLength(1);
			await expect(page.locator(".sonora-mobile-add summary")).toBeVisible();
		} else {
			expect(layout.columns.trim().split(/\s+/u)).toHaveLength(2);
			await expect(page.locator(".sonora-brand")).toBeVisible();
			const libraryHeading = await page.locator(".sonora-library-heading").boundingBox();
			expect(libraryHeading?.y ?? viewport.height).toBeLessThan(viewport.height);
			const complete = page.locator(".sonora-player-tools .sonora-complete");
			const more = page.locator(".sonora-player-tools .sonora-player-more");
			await expect(complete).toBeVisible();
			await expect(more).toBeVisible();
			const completeBox = await complete.boundingBox();
			const moreBox = await more.boundingBox();
			expect(completeBox).not.toBeNull();
			expect(moreBox).not.toBeNull();
			expect((completeBox?.x ?? 0) + (completeBox?.width ?? 0)).toBeLessThanOrEqual(
				(moreBox?.x ?? 0) + 1,
			);
		}

		const runtimeProcess = (globalThis as { process?: { platform?: string } }).process;
		if (runtimeProcess?.platform === "darwin") {
			await expect(page.locator(".visual-obsidian-view")).toHaveScreenshot(`${viewport.name}.png`, {
				animations: "disabled",
			});
		}
	});
}

test("chapter heading search opens the matched chapter", async ({ page }) => {
	await page.setViewportSize({ width: 1024, height: 768 });
	await page.goto("./?scenario=desktop");

	await page
		.getByRole("searchbox", { name: "Search titles and chapter headings" })
		.fill("Open questions");
	await page
		.getByRole("button", {
			name: "Open Product strategy notes for the next release at Open questions",
		})
		.click();
	await expect(page.locator(".sonora-player-track strong")).toHaveText("Open questions");
});

test("desktop drag and drop persists queue order by item identity", async ({ page }) => {
	await page.setViewportSize({ width: 1024, height: 768 });
	await page.goto("./?scenario=desktop");
	const rows = page.locator(".sonora-library-row");
	await rows.nth(0).dragTo(rows.nth(1));
	await expect(rows.first()).toContainText("Spanish travel vocabulary");
	await expect(page.locator('[aria-live="polite"]')).toContainText(
		"Moved Product strategy notes for the next release down.",
	);
});

test("desktop library preserves hierarchy with long Japanese labels", async ({ page }) => {
	await page.setViewportSize({ width: 1024, height: 768 });
	await page.goto("./?scenario=long-ja");

	await expect(page.getByRole("navigation", { name: "ライブラリ" })).toBeVisible();
	await expect(page.getByRole("button", { name: /すべて/ })).toBeVisible();
	await expect(
		page.getByRole("searchbox", { name: "タイトルとチャプター見出しを検索" }),
	).toBeVisible();
	const dimensions = await page.locator(".sonora-app").evaluate((element) => ({
		clientWidth: element.clientWidth,
		scrollWidth: element.scrollWidth,
	}));
	expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);

	const runtimeProcess = (globalThis as { process?: { platform?: string } }).process;
	if (runtimeProcess?.platform === "darwin") {
		await expect(page.locator(".visual-obsidian-view")).toHaveScreenshot(
			"desktop-long-japanese.png",
			{ animations: "disabled" },
		);
	}
});

test("mobile Continue Listening matches playback state with long Japanese labels", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("./?scenario=long-ja");

	const title = "次のリリースで大切にしたいプロダクト戦略とモバイル再生体験の検討メモ";
	const chapter = "移動中でも迷わず操作できる情報設計";
	const pause = page.getByRole("button", {
		name: `${title}の${chapter}を一時停止`,
	});
	await expect(pause).toBeVisible();
	await expect(pause.locator(".lucide-pause")).toBeVisible();

	const dimensions = await page.locator(".sonora-continue").evaluate((element) => ({
		clientWidth: element.clientWidth,
		scrollWidth: element.scrollWidth,
	}));
	expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);

	await pause.click();
	const resume = page.getByRole("button", {
		name: `${title}の${chapter}から再生`,
	});
	await expect(resume.locator(".lucide-play")).toBeVisible();

	if ((globalThis as { process?: { platform?: string } }).process?.platform === "darwin") {
		await expect(page.locator(".visual-obsidian-view")).toHaveScreenshot(
			"mobile-continue-listening-long-japanese.png",
			{ animations: "disabled" },
		);
	}
});

test("desktop empty library gives a clear starting action", async ({ page }) => {
	await page.setViewportSize({ width: 1024, height: 768 });
	await page.goto("./?scenario=empty");

	await expect(
		page.getByRole("heading", { name: "Listen to what you already wrote" }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: /Choose a note to listen to/ })).toBeVisible();

	const runtimeProcess = (globalThis as { process?: { platform?: string } }).process;
	if (runtimeProcess?.platform === "darwin") {
		await expect(page.locator(".visual-obsidian-view")).toHaveScreenshot("desktop-empty.png", {
			animations: "disabled",
		});
	}
});

test("desktop filtered-empty state explains recovery", async ({ page }) => {
	await page.setViewportSize({ width: 1024, height: 768 });
	await page.goto("./?scenario=desktop");

	await page
		.getByRole("searchbox", { name: "Search titles and chapter headings" })
		.fill("no matching title or heading");
	await expect(page.getByText("No items match the current filters.")).toBeVisible();
	await expect(page.getByRole("button", { name: "Show all" })).toBeVisible();

	const runtimeProcess = (globalThis as { process?: { platform?: string } }).process;
	if (runtimeProcess?.platform === "darwin") {
		await expect(page.locator(".visual-obsidian-view")).toHaveScreenshot(
			"desktop-filter-empty.png",
			{ animations: "disabled" },
		);
	}
});

test("tablet touch exposes Up Next without hover", async ({ browser, baseURL }) => {
	expect(baseURL).toBeTruthy();
	const context = await browser.newContext({
		baseURL,
		viewport: { width: 768, height: 1024 },
		hasTouch: true,
	});
	const page = await context.newPage();
	try {
		await page.goto("./");
		await page.getByRole("button", { name: "Clear Up Next" }).click();
		const action = page.getByRole("button", {
			name: "Play Spanish travel vocabulary next",
		});
		await expect(action).toBeVisible();
		await expect(action.locator("span")).toHaveText("Up next");
		const metrics = await action.evaluate((element) => {
			const style = getComputedStyle(element);
			const box = element.getBoundingClientRect();
			return { height: box.height, opacity: style.opacity, width: box.width };
		});
		expect(metrics.height).toBeGreaterThanOrEqual(44);
		expect(metrics.width).toBeGreaterThanOrEqual(88);
		expect(metrics.opacity).toBe("1");
		const firstRow = page.locator(".sonora-library-row").first();
		await expect(firstRow.locator(".sonora-row-remove")).toBeHidden();
		const rowMore = firstRow.locator(".sonora-row-more");
		await expect(rowMore).toBeVisible();
		await rowMore.click();
		await expect(page.getByRole("menu")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(rowMore).toBeFocused();
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

		const runtimeProcess = (globalThis as { process?: { platform?: string } }).process;
		if (runtimeProcess?.platform === "darwin") {
			await expect(page.locator(".visual-obsidian-view")).toHaveScreenshot(
				"tablet-touch-up-next.png",
				{ animations: "disabled" },
			);
		}
	} finally {
		await context.close();
	}
});
