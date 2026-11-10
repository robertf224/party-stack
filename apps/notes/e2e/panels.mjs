// Read-only visual checks; sidebar open/closed state is ephemeral to this tab.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
try {
    await page.goto(process.argv[2]);
    await page.waitForFunction(
        () => document.querySelector(".boot-workspace")?.style.visibility === "visible"
    );
    const firstNote = page
        .locator(".note-preview")
        .filter({ hasNot: page.locator(".preview-title svg") })
        .first();
    if (await firstNote.count()) {
        await firstNote.click();
        await page.getByRole("textbox", { name: "Note content", exact: true }).waitFor();
    }
    const editorNode = await page.locator(".note-main").elementHandle();
    const geometry = await page.evaluate(() => {
        const bounds = (selector) => document.querySelector(selector).getBoundingClientRect();
        const center = (selector) => {
            const rect = bounds(selector);
            return rect.y + rect.height / 2;
        };
        const main = bounds(".note-main");
        return {
            radius: getComputedStyle(document.querySelector(".notes-app")).borderRadius,
            main: { top: main.top, right: main.right },
            headers: [center(".brand"), center(".list-heading"), center(".workspace-toolbar")],
            overflow: getComputedStyle(document.querySelector(".note-list-scroll")).overflowY,
            horizontalOverflow: getComputedStyle(document.querySelector(".note-list-scroll")).overflowX,
            scrollWidth: document.querySelector(".note-list-scroll").scrollWidth,
            viewportWidth: document.querySelector(".note-list-scroll").clientWidth,
            scrollTop: bounds(".note-list-scroll").top,
            headingBottom: bounds(".list-heading").bottom,
            fixedHeadingBottom:
                document.querySelector(".list-date-heading")?.getBoundingClientRect().bottom ??
                bounds(".list-heading").bottom,
            scrollbarTop: document.querySelector(".note-list-scrollbar")?.getBoundingClientRect().top,
            inset: {
                right: parseFloat(getComputedStyle(document.querySelector(".notes-app"), "::before").width),
                blur: getComputedStyle(document.querySelector(".notes-app"), "::before").backdropFilter,
                headerBlur: getComputedStyle(document.querySelector(".list-heading")).backdropFilter,
            },
        };
    });
    assert.equal(geometry.radius, "0px");
    assert.equal(geometry.main.top, 0);
    assert.equal(geometry.main.right, 1440);
    console.log("Panel geometry:", geometry);
    assert(Math.max(...geometry.headers) - Math.min(...geometry.headers) <= 1.1);
    assert.equal(geometry.overflow, "auto");
    assert.equal(geometry.horizontalOverflow, "hidden");
    assert.equal(geometry.scrollWidth, geometry.viewportWidth, "notes must fit the panel width");
    assert.equal(geometry.scrollTop, 0, "notes must be able to scroll behind the heading");
    if (geometry.scrollbarTop !== undefined)
        assert.equal(
            geometry.scrollbarTop,
            geometry.fixedHeadingBottom,
            "scrollbar must start below the heading"
        );
    assert.equal(
        geometry.inset.right,
        await page
            .locator(".note-list")
            .evaluate(
                (el) => el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).borderRightWidth)
            )
    );
    assert.match(geometry.inset.blur, /blur\(24px\)/);
    assert.equal(geometry.inset.headerBlur, "none", "the heading and inset must share one backdrop");
    const headingTop = await page.locator(".list-heading").evaluate((el) => el.getBoundingClientRect().top);
    await page.locator(".note-list-scroll").evaluate((el) => {
        el.scrollTop = 120;
    });
    assert.equal(
        await page.locator(".list-heading").evaluate((el) => el.getBoundingClientRect().top),
        headingTop
    );
    assert(
        await page.evaluate(() => {
            const heading = document.querySelector(".list-heading").getBoundingClientRect();
            return [...document.querySelectorAll(".note-preview")].some((el) => {
                const row = el.getBoundingClientRect();
                return row.top < heading.bottom && row.bottom > heading.top;
            });
        }),
        "scrolling must place real notes beneath the frosted header"
    );
    await page.screenshot({ path: "/tmp/party-notes-header-blurred.png" });
    await page.locator(".note-list-scroll").evaluate((el) => {
        el.scrollTop = 0;
    });
    await page.screenshot({ path: "/tmp/party-notes-panels-ready.png" });
    await page.evaluate(() => {
        const start = document.startViewTransition.bind(document);
        document.startViewTransition = (...args) => {
            window.panelPaused = false;
            const transition = start(...args);
            window.panelTransition = transition;
            void transition.ready
                .then(() => {
                    for (const animation of document.getAnimations()) {
                        if (!animation.effect.pseudoElement?.startsWith("::view-transition")) continue;
                        animation.pause();
                        animation.currentTime = 160;
                    }
                    window.panelPaused = true;
                })
                .catch(() => {});
            return transition;
        };
    });
    for (const direction of ["close", "open"]) {
        const positions = () =>
            page.evaluate(() => ({
                list: document.querySelector(".note-list").getBoundingClientRect().left,
                editor: document.querySelector(".note-main").getBoundingClientRect().left,
            }));
        const before = await positions();
        await page.evaluate(() => {
            window.panelPaused = false;
        });
        await page
            .getByRole("button", {
                name: direction === "close" ? "Hide folders" : "Show folders",
                exact: true,
            })
            .click();
        await page.waitForFunction(() => window.panelPaused === true);
        const after = await positions();
        const stack = await page.evaluate(() => {
            const group = (name) =>
                getComputedStyle(document.documentElement, `::view-transition-group(${name})`);
            const pane = (name) => {
                const style = group(name);
                return {
                    x: new DOMMatrixReadOnly(style.transform).e,
                    width: parseFloat(style.width),
                    duration: style.animationDuration,
                    easing: style.animationTimingFunction,
                    zIndex: style.zIndex,
                    oldOpacity: getComputedStyle(document.documentElement, `::view-transition-old(${name})`)
                        .opacity,
                };
            };
            return {
                folders: group("notes-folders-panel").zIndex,
                list: pane("notes-list-pane"),
                editor: pane("notes-editor-pane"),
                button: group("notes-folders-toggle").zIndex,
            };
        });
        console.log(`${direction} midpoint:`, { before, after, ...stack });
        assert.equal(stack.folders, "1");
        assert.equal(stack.list.zIndex, "2");
        assert.equal(stack.editor.zIndex, "2");
        assert.equal(stack.button, "3");
        assert.equal(stack.editor.duration, stack.list.duration);
        assert.equal(stack.editor.easing, stack.list.easing);
        assert.equal(stack.editor.oldOpacity, "0");
        const progress = (pane) => (stack[pane].x - before[pane]) / (after[pane] - before[pane]);
        assert(progress("editor") > 0 && progress("editor") < 1, "editor must move during the transition");
        assert(Math.abs(progress("editor") - progress("list")) < 0.001, "list and editor must move together");
        assert(
            Math.abs(stack.list.x + stack.list.width - stack.editor.x) < 1.1,
            "panels must stay adjacent during the slide"
        );
        assert(
            await editorNode.evaluate((el) => el.isConnected),
            "sidebar toggles must keep the editor mounted"
        );
        for (const time of [0, 80, 160, 280]) {
            const snapshots = await page.evaluate((time) => {
                for (const animation of document.getAnimations()) {
                    if (animation.effect.pseudoElement?.startsWith("::view-transition"))
                        animation.currentTime = time;
                }
                const snapshot = (selector) => {
                    const el = document.querySelector(selector);
                    if (!el || !el.getBoundingClientRect().width) return null;
                    const name = getComputedStyle(el).viewTransitionName;
                    const group = getComputedStyle(
                        document.documentElement,
                        `::view-transition-group(${name})`
                    );
                    const picture = getComputedStyle(
                        document.documentElement,
                        `::view-transition-new(${name})`
                    );
                    return {
                        name,
                        scale: new DOMMatrixReadOnly(group.transform).a,
                        fit: picture.objectFit,
                        width: parseFloat(group.width),
                    };
                };
                return {
                    format: snapshot(".toolbar-middle"),
                    document: snapshot(".note-document"),
                    date: snapshot(".note-date"),
                    devtools: getComputedStyle(
                        document.querySelector('[aria-label="Open TanStack Devtools"]')
                    ).viewTransitionName,
                };
            }, time);
            for (const snapshot of [snapshots.format, snapshots.document, snapshots.date].filter(Boolean)) {
                assert.notEqual(
                    snapshot.name,
                    "none",
                    "cached and portaled content must participate in the slide"
                );
                assert.equal(snapshot.scale, 1, "content must translate without scaling");
                assert.equal(snapshot.fit, "none", "content snapshots must retain their natural size");
            }
            if (snapshots.format)
                assert.equal(
                    snapshots.format.width,
                    await page.locator(".toolbar-middle").evaluate((el) => el.getBoundingClientRect().width)
                );
            assert.equal(snapshots.devtools, "notes-devtools-trigger");
        }
        await page.screenshot({ path: `/tmp/party-notes-panels-${direction}.png` });
        await page.evaluate(async () => {
            window.panelTransition.skipTransition();
            await window.panelTransition.finished;
        });
    }
    console.log(
        "PASS: square corners, aligned headers, auto overflow, and synchronized list/editor slides in both directions without remounting"
    );
} finally {
    await browser.close();
}
