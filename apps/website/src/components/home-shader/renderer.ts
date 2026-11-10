import shader from "./scene.wgsl?raw";
import type { Gpu } from "vgpu";

/** Decorative GPU work; its caller owns the complete lifetime. */
export function createHomeShader(canvas: HTMLCanvasElement, onReady: () => void, onFailure: () => void) {
    let disposed = false;
    let gpu: Gpu | undefined;
    let animationFrame = 0;
    let visible = true;
    let light = [0, 0];
    let pending = false;
    let inFlight = false;
    let wake = () => {};
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const observe = new IntersectionObserver(([entry]) => {
        visible = entry?.isIntersecting ?? false;
        if (visible) wake();
    });
    observe.observe(canvas);
    const move = (event: PointerEvent) => {
        if (event.pointerType === "touch") return;
        const rect = canvas.getBoundingClientRect();
        light = [
            Math.max(-0.5, Math.min(0.5, (event.clientX - rect.left) / rect.width - 0.5)),
            Math.max(-0.5, Math.min(0.5, 0.5 - (event.clientY - rect.top) / rect.height)),
        ];
        if (reduced.matches) wake();
    };
    const refresh = () => wake();
    window.addEventListener("pointermove", move);
    window.addEventListener("resize", refresh);
    document.addEventListener("visibilitychange", refresh);
    reduced.addEventListener("change", refresh);
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        cancelAnimationFrame(animationFrame);
        observe.disconnect();
        window.removeEventListener("pointermove", move);
        window.removeEventListener("resize", refresh);
        document.removeEventListener("visibilitychange", refresh);
        reduced.removeEventListener("change", refresh);
        gpu?.dispose();
    };
    const fail = () => {
        dispose();
        onFailure();
    };
    const initialize = async () => {
        const { init, surface, effect, frame, clock } = await import("vgpu");
        if (disposed) return;
        const acquired = await init({ label: "party-stack-home", powerPreference: "low-power" });
        if (disposed) {
            acquired.dispose();
            return;
        }
        gpu = acquired;
        gpu.onError(fail);
        const output = surface(gpu, canvas, { dpr: [1, 2], alphaMode: "opaque" });
        const scene = effect(gpu, shader, { label: "party-stack-disco" });
        await scene.compile({ colors: [output.format], sampleCount: output.sampleCount });
        if (disposed) return;
        const time = clock(gpu);
        let ready = false;
        let lastDraw = -Infinity;
        const draw = (now: number) => {
            animationFrame = 0;
            if (disposed || !visible || document.hidden) return;
            if (now - lastDraw < 1000 / 30) {
                wake();
                return;
            }
            lastDraw = now;
            pending = false;
            inFlight = true;
            try {
                frame(acquired, (next) => {
                    scene.set({
                        params: {
                            resolution: output.size,
                            time: reduced.matches ? 0 : time.time,
                            viewportWidth: canvas.clientWidth,
                            light,
                        },
                    });
                    next.pass(output, scene);
                });
                void acquired.gpu.queue.onSubmittedWorkDone().then(
                    () => {
                        inFlight = false;
                        if (disposed) return;
                        if (!ready) {
                            ready = true;
                            onReady();
                        }
                        if (!reduced.matches || pending) wake();
                    },
                    () => {
                        if (!disposed) fail();
                    }
                );
            } catch {
                fail();
            }
        };
        wake = () => {
            if (disposed) return;
            pending = true;
            if (!inFlight && !animationFrame) animationFrame = requestAnimationFrame(draw);
        };
        wake();
    };
    void initialize().catch(() => {
        if (!disposed) fail();
    });
    return dispose;
}
