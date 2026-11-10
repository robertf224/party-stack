import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Orthographic projection of a tiled sphere. The silhouette is always an SVG
// circle; projected mirror geometry and every reflection are clipped inside it.
const radius = 224;
const center = 256;
const tilt = (10 * Math.PI) / 180;
const radians = (degrees) => (degrees * Math.PI) / 180;
const point = (latitude, longitude) => {
    const phi = radians(latitude);
    const lambda = radians(longitude);
    const x = Math.cos(phi) * Math.sin(lambda);
    const y = Math.sin(phi);
    const z = Math.cos(phi) * Math.cos(lambda);
    return [x, y * Math.cos(tilt) - z * Math.sin(tilt), y * Math.sin(tilt) + z * Math.cos(tilt)];
};
const edge = (a, b, fixed, latitude) => {
    const steps = Math.ceil(Math.abs(b - a) / 2);
    return Array.from({ length: steps }, (_, i) => {
        const value = a + ((b - a) * i) / steps;
        return latitude ? point(fixed, value) : point(value, fixed);
    });
};
function frontFace(polygon) {
    const result = [];
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        if (a[2] >= 0) result.push(a);
        if (a[2] >= 0 !== b[2] >= 0) {
            const t = a[2] / (a[2] - b[2]);
            const x = a[0] + t * (b[0] - a[0]);
            const y = a[1] + t * (b[1] - a[1]);
            const length = Math.hypot(x, y);
            result.push([x / length, y / length, 0]);
        }
    }
    return result;
}
const coordinates = ([x, y]) => `${(center + radius * x).toFixed(3)},${(center - radius * y).toFixed(3)}`;
const segment = (a, b) =>
    a[2] === 0 && b[2] === 0
        ? // A clipped tile follows the circular horizon, never a chord through the ball.
          `A${radius},${radius} 0 0 ${a[1] * b[0] - a[0] * b[1] > 0 ? 1 : 0} ${coordinates(b)}`
        : `L${coordinates(b)}`;
const path = (polygon) =>
    `M${coordinates(polygon[0])} ` +
    polygon
        .slice(1)
        .map((p, i) => segment(polygon[i], p))
        .join(" ") +
    " " +
    segment(polygon.at(-1), polygon[0]) +
    " Z";

// Broad spherical mirror panels, matching the selected Mirror Dot E concept.
// Tonal differences define the facets; there is no dark longitude grid.
const definitions = [];
const tiles = [];
let index = 0;
const latitudes = [-90, -55, -20, 20, 55, 90];
const longitudes = [-180, -140, -100, -60, -20, 20, 60, 100, 140, 180];
for (let row = 0; row < latitudes.length - 1; row++) {
    const latitude = latitudes[row];
    const nextLatitude = latitudes[row + 1];
    for (let column = 0; column < longitudes.length - 1; column++) {
        const longitude = longitudes[column];
        const nextLongitude = longitudes[column + 1];
        const polygon = frontFace([
            ...edge(longitude, nextLongitude, latitude, true),
            ...edge(latitude, nextLatitude, nextLongitude, false),
            ...edge(nextLongitude, longitude, nextLatitude, true),
            ...edge(nextLatitude, latitude, longitude, false),
        ]);
        if (polygon.length < 3) continue;
        const normal = point((latitude + nextLatitude) / 2, (longitude + nextLongitude) / 2);
        const tile = `mirror-${index++}`;
        const bright = Math.max(0, Math.min(1, 0.55 + normal[1] * 0.2 - normal[0] * 0.12));
        const silver = (offset) =>
            "#" +
            [0, 2, 12]
                .map((channel) =>
                    Math.round(
                        Math.max(
                            0,
                            Math.min(
                                255,
                                120 +
                                    bright * 110 +
                                    offset +
                                    channel +
                                    (((row * 3 + column * 2) % 5) - 2) * 7 +
                                    (normal[0] < -0.1 && normal[1] > 0.1 && normal[2] > 0.7 ? 22 : 0)
                            )
                        )
                    )
                        .toString(16)
                        .padStart(2, "0")
                )
                .join("");
        definitions.push(`<path id="${tile}" d="${path(polygon)}"/>`);
        definitions.push(
            `<linearGradient id="tone-${tile}" x1="0" y1="0" x2=".85" y2="1"><stop stop-color="${silver(24)}"/><stop offset="1" stop-color="${silver(-12)}"/></linearGradient>`
        );
        tiles.push(`<use href="#${tile}" fill="url(#tone-${tile})"/>`);
        const spectral =
            normal[0] >= (normal[1] > 0.2 ? 0.2 : -0.05) &&
            normal[0] < (normal[1] < -0.4 ? 0.4 : 0.85) &&
            normal[1] > -0.82 &&
            normal[1] < 0.62;
        if (spectral) {
            tiles.push(`<use href="#${tile}" fill="url(#rainbow)" opacity=".86"/>`);
            tiles.push(
                `<use href="#${tile}" fill="url(#tone-${tile})" opacity="${(0.1 + (1 - bright) * 0.14).toFixed(3)}"/>`
            );
        }
    }
}
const artwork = `<defs>
    <!-- A literal circle, shared by the silhouette and the clipping boundary. -->
    <clipPath id="sphere-clip"><circle cx="256" cy="256" r="224"/></clipPath>
    <radialGradient id="silver" cx=".3" cy=".2" r=".95"><stop stop-color="#f4f5fa"/><stop offset="1" stop-color="#858a9b"/></radialGradient>
    <linearGradient id="rainbow" gradientUnits="userSpaceOnUse" x1="362" y1="94" x2="264" y2="451">
        <stop stop-color="#ff8fbb"/><stop offset=".16" stop-color="#ffbb9b"/>
        <stop offset=".32" stop-color="#ffe98a"/><stop offset=".46" stop-color="#d8f89d"/>
        <stop offset=".6" stop-color="#9bf2df"/><stop offset=".74" stop-color="#83ccff"/>
        <stop offset=".87" stop-color="#ae9bff"/><stop offset="1" stop-color="#d68bf5"/>
    </linearGradient>
    ${definitions.join("\n")}
</defs>
<circle id="silhouette" cx="256" cy="256" r="224" fill="url(#silver)"/>
<g clip-path="url(#sphere-clip)">${tiles.join("\n")}</g>`;

const directory = fileURLToPath(new URL("../assets/", import.meta.url));
const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-labelledby="title">
<title id="title">Circular silver disco ball with rainbow reflections</title>
${artwork}\n</svg>\n`;
writeFileSync(`${directory}disco-circle.svg`, logo);
writeFileSync(fileURLToPath(new URL("../../../apps/website/public/favicon.svg", import.meta.url)), logo);
const jsx = artwork
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/([a-zA-Z][\w-]*)="([^"]*)"/g, (_match, name, value) => {
        const attribute = name.replace(/-([a-z])/g, (_dash, letter) => letter.toUpperCase());
        if (name === "id") return `${attribute}={\`\${id}-${value}\`}`;
        if (name === "href") return `${attribute}={\`#\${id}-${value.slice(1)}\`}`;
        if (value.startsWith("url(#")) return `${attribute}={\`url(#\${id}-${value.slice(5, -1)})\`}`;
        return `${attribute}="${value}"`;
    });
writeFileSync(
    fileURLToPath(new URL("../src/disco-ball.tsx", import.meta.url)),
    `// Generated by scripts/disco-circle.mjs. Edit the spherical geometry there.
export function DiscoBallArtwork({ id }: { readonly id: string }) {
    return <>${jsx}</>;
}
`
);
writeFileSync(
    `${directory}disco-circle-preview.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<defs><symbol id="mark" viewBox="0 0 512 512">${artwork}</symbol></defs>
<path fill="#faf9f7" d="M0 0H640V720H0Z"/><path fill="#0d0e16" d="M640 0H1280V720H640Z"/>
<use href="#mark" x="68" y="108" width="504" height="504"/>
<use href="#mark" x="708" y="108" width="504" height="504"/>
</svg>\n`
);
console.log(`Wrote a circle with diameter ${radius * 2}, ${index} projected mirror tiles.`);
