import type { IconDescriptor, IconName } from "@party-stack/icons";
import type { IconName as BlueprintIconName } from "@blueprintjs/icons";

export const BlueprintIconNames = {
    activity: "pulse",
    add: "plus",
    airplane: "airplane",
    alarm: "time",
    alert: "issue",
    archive: "archive",
    "arrow-down": "arrow-down",
    "arrow-left": "arrow-left",
    "arrow-right": "arrow-right",
    "arrow-up": "arrow-up",
    attachment: "paperclip",
    award: "badge",
    bank: "bank-account",
    barcode: "barcode",
    bell: "notifications",
    book: "book",
    bookmark: "bookmark",
    briefcase: "briefcase",
    bug: "bug",
    building: "office",
    calculator: "calculator",
    calendar: "calendar",
    camera: "camera",
    "chart-bar": "vertical-bar-chart-asc",
    "chart-line": "timeline-line-chart",
    "chart-pie": "pie-chart",
    chat: "chat",
    check: "tick",
    "check-circle": "tick-circle",
    "chevron-down": "chevron-down",
    "chevron-left": "chevron-left",
    "chevron-right": "chevron-right",
    "chevron-up": "chevron-up",
    circle: "circle",
    clipboard: "clipboard",
    clock: "time",
    cloud: "cloud",
    code: "code",
    compass: "compass",
    copy: "duplicate",
    "credit-card": "credit-card",
    cube: "cube",
    database: "database",
    delete: "trash",
    document: "document",
    download: "download",
    edit: "edit",
    email: "envelope",
    error: "error",
    eye: "eye-open",
    "eye-off": "eye-off",
    filter: "filter",
    flag: "flag",
    folder: "folder-close",
    globe: "globe-network",
    grid: "grid-view",
    heart: "heart",
    help: "help",
    history: "history",
    home: "home",
    image: "media",
    info: "info-sign",
    key: "key",
    layers: "layers",
    lightbulb: "lightbulb",
    link: "link",
    list: "list",
    location: "map-marker",
    lock: "lock",
    "lock-open": "unlock",
    map: "map",
    menu: "menu",
    microphone: "microphone",
    minus: "minus",
    "minus-circle": "remove",
    moon: "moon",
    "more-horizontal": "more",
    "more-vertical": "more",
    notification: "notifications",
    package: "box",
    pause: "pause",
    people: "people",
    person: "person",
    phone: "phone",
    pin: "pin",
    play: "play",
    "play-circle": undefined,
    "plus-circle": "add",
    printer: "print",
    project: "projects",
    refresh: "refresh",
    rocket: "rocket-slant",
    save: "floppy-disk",
    search: "search",
    send: "send-to",
    settings: "cog",
    share: "share",
    shield: "shield",
    "shopping-bag": undefined,
    "shopping-cart": "shopping-cart",
    star: "star",
    stop: "stop",
    sun: "flash",
    tag: "tag",
    ticket: undefined,
    tools: "build",
    upload: "upload",
    video: "mobile-video",
    warning: "warning-sign",
    window: "application",
    wrench: "wrench",
    x: "cross",
    "x-circle": "cross-circle",
} as const satisfies Record<IconName, BlueprintIconName | undefined>;

export function getBlueprintIconName(name: IconName): BlueprintIconName | undefined {
    return BlueprintIconNames[name];
}

const universalNamesByBlueprint = new Map<BlueprintIconName, IconName[]>();
for (const [name, blueprintName] of Object.entries(BlueprintIconNames)) {
    if (!blueprintName) {
        continue;
    }
    const names = universalNamesByBlueprint.get(blueprintName) ?? [];
    names.push(name as IconName);
    universalNamesByBlueprint.set(blueprintName, names);
}

export interface BlueprintIconMeta extends Record<string, unknown> {
    blueprint: {
        name: string;
    };
}

export function fromBlueprintIconName(name: string): IconDescriptor | undefined {
    const universalNames = universalNamesByBlueprint.get(name as BlueprintIconName);
    const canonicalName = universalNames?.[0];
    if (!canonicalName || universalNames.length !== 1) {
        return undefined;
    }
    return {
        name: canonicalName,
        meta: {
            blueprint: { name },
        } satisfies BlueprintIconMeta,
    };
}

export function toBlueprintIconName(icon: IconDescriptor): string | undefined {
    const source = icon.meta?.blueprint;
    return typeof source === "object" &&
        source !== null &&
        "name" in source &&
        typeof source.name === "string"
        ? source.name
        : icon.name
          ? getBlueprintIconName(icon.name)
          : undefined;
}

export type { BlueprintIconName };
