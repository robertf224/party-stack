import React from "react";

// Simplified continent outlines as SVG polygon points
// Coordinate system: viewBox 0 0 360 180, x = lon+180, y = 90-lat
const CONTINENTS = [
    // North America
    "15,25 45,20 75,22 110,30 120,35 105,52 100,62 85,68 75,72 60,65 50,42 30,35",
    // South America
    "100,82 118,80 138,90 140,100 130,118 118,132 108,138 100,122 95,100",
    // Europe
    "175,38 185,30 198,28 208,32 205,42 198,48 188,48 178,44",
    // Africa
    "170,58 185,52 205,56 218,68 215,88 208,108 198,125 185,128 172,112 168,88 165,70",
    // Asia
    "212,42 228,32 255,22 282,18 310,22 325,30 330,42 318,55 300,58 282,65 265,78 248,72 232,58 218,50",
    // Australia
    "292,112 312,108 332,114 330,126 318,134 298,128 292,118",
];

export const MiniMap: React.FC<{ lat: number; lon: number }> = ({
    lat,
    lon,
}) => {
    const cx = lon + 180;
    const cy = 90 - lat;
    const coordinateLabel = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

    const mapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;

    return (
        <a
            aria-label={`Open location ${coordinateLabel} in Google Maps`}
            className="group relative inline-flex w-fit text-xs font-medium text-zinc-500 underline decoration-dotted underline-offset-4 hover:text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-300 focus:ring-offset-2 dark:text-zinc-400 dark:hover:text-zinc-100 dark:focus:ring-zinc-700"
            href={mapsUrl}
            rel="noopener noreferrer"
            target="_blank"
        >
            {coordinateLabel}
            <span className="pointer-events-none absolute bottom-full left-0 z-10 mb-2 hidden rounded-lg border border-zinc-200 bg-white p-2 shadow-lg group-hover:block group-focus:block dark:border-zinc-800 dark:bg-zinc-950">
                <svg
                    aria-hidden="true"
                    className="block rounded border border-zinc-200 dark:border-zinc-700"
                    height="60"
                    viewBox="0 0 360 180"
                    width="120"
                >
                    <rect width="360" height="180" className="fill-sky-100 dark:fill-sky-950" />
                    {CONTINENTS.map((points, i) => (
                        <polygon
                            key={i}
                            points={points}
                            className="fill-zinc-300 stroke-zinc-400 dark:fill-zinc-700 dark:stroke-zinc-600"
                            strokeWidth="0.5"
                        />
                    ))}
                    <circle cx={cx} cy={cy} r="5" className="fill-red-500" />
                </svg>
            </span>
        </a>
    );
};
