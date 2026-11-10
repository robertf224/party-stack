import { useEffect, useRef, useState } from "react";

export function HomeShader() {
    const canvas = useRef<HTMLCanvasElement>(null);
    const [ready, setReady] = useState(false);
    useEffect(() => {
        const target = canvas.current;
        if (!target || !navigator.gpu) return;
        let closed = false;
        let dispose: (() => void) | undefined;
        void import("./renderer")
            .then(({ createHomeShader }) => {
                if (!closed)
                    dispose = createHomeShader(
                        target,
                        () => setReady(true),
                        () => setReady(false)
                    );
            })
            .catch(() => {
                if (!closed) setReady(false);
            });
        return () => {
            closed = true;
            dispose?.();
        };
    }, []);
    return (
        <div className="home-visual" data-shader-ready={ready} aria-hidden="true">
            <canvas ref={canvas} className="home-canvas" />
        </div>
    );
}
