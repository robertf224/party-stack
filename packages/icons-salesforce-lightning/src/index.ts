import type { IconDescriptor, IconName } from "@party-stack/icons";

export type SalesforceLightningIconName =
    `${"action" | "custom" | "doctype" | "standard" | "utility"}/${string}`;

export const SalesforceLightningIconNames = {
    activity: undefined,
    add: "utility/add",
    airplane: "utility/plane",
    alarm: "custom/custom25",
    alert: "utility/warning",
    archive: "utility/archive",
    "arrow-down": "utility/arrowdown",
    "arrow-left": "utility/back",
    "arrow-right": "utility/forward",
    "arrow-up": "utility/arrowup",
    attachment: "utility/attach",
    award: "utility/ribbon",
    bank: "custom/custom16",
    barcode: "utility/scan",
    bell: "utility/notification",
    book: "utility/knowledge_base",
    bookmark: "utility/bookmark",
    briefcase: "utility/case",
    bug: "utility/bug",
    building: "utility/company",
    calculator: undefined,
    calendar: "utility/event",
    camera: "utility/photo",
    "chart-bar": "utility/metrics",
    "chart-line": "utility/line_chart",
    "chart-pie": "utility/chart",
    chat: "utility/chat",
    check: "utility/check",
    "check-circle": "utility/success",
    "chevron-down": "utility/chevrondown",
    "chevron-left": "utility/chevronleft",
    "chevron-right": "utility/chevronright",
    "chevron-up": "utility/chevronup",
    circle: "utility/circle",
    clipboard: "utility/copy_to_clipboard",
    clock: "utility/clock",
    cloud: undefined,
    code: "utility/slack_code",
    compass: "custom/custom64",
    copy: "utility/copy",
    "credit-card": "utility/card_details",
    cube: "custom/custom57",
    database: "utility/database",
    delete: "utility/delete",
    document: "utility/file",
    download: "utility/download",
    edit: "utility/edit",
    email: "utility/email",
    error: "utility/error",
    eye: "utility/preview",
    "eye-off": "utility/hide",
    filter: "utility/filterList",
    flag: "utility/priority",
    folder: "utility/open_folder",
    globe: "utility/world",
    grid: "utility/apps",
    heart: "utility/heart",
    help: "utility/help",
    history: "utility/replay",
    home: "utility/home",
    image: "utility/image",
    info: "utility/info",
    key: "utility/key",
    layers: "utility/layers",
    lightbulb: "utility/light_bulb",
    link: "utility/link",
    list: "utility/list",
    location: "utility/checkin",
    lock: "utility/lock",
    "lock-open": "utility/unlock",
    map: "utility/location",
    menu: "utility/rows",
    microphone: "utility/unmuted",
    minus: "utility/dash",
    "minus-circle": "utility/ban",
    moon: "custom/custom10",
    "more-horizontal": "utility/threedots",
    "more-vertical": "utility/threedots_vertical",
    notification: "utility/notification",
    package: "custom/custom57",
    pause: "utility/pause",
    people: "utility/people",
    person: "utility/user",
    phone: "utility/call",
    pin: "utility/pin",
    play: "utility/play",
    "play-circle": undefined,
    "plus-circle": "utility/new",
    printer: "utility/print",
    project: "utility/kanban",
    refresh: "utility/refresh",
    rocket: undefined,
    save: "utility/save",
    search: "utility/search",
    send: "utility/send",
    settings: "utility/settings",
    share: "utility/share",
    shield: "utility/shield",
    "shopping-bag": "utility/shopping_bag",
    "shopping-cart": "utility/cart",
    star: "utility/favorite",
    stop: "utility/stop",
    sun: "custom/custom3",
    tag: "utility/price_book_entries",
    ticket: "custom/custom45",
    tools: "custom/custom19",
    upload: "utility/upload",
    video: "utility/video",
    warning: "utility/warning",
    window: "utility/tabset",
    wrench: "custom/custom19",
    x: "utility/close",
    "x-circle": "utility/clear",
} as const satisfies Record<IconName, SalesforceLightningIconName | undefined>;

const UniversalNamesBySalesforceLightning = new Map<SalesforceLightningIconName, IconName[]>();
for (const [name, salesforceName] of Object.entries(SalesforceLightningIconNames)) {
    if (!salesforceName) {
        continue;
    }
    const names = UniversalNamesBySalesforceLightning.get(salesforceName) ?? [];
    names.push(name as IconName);
    UniversalNamesBySalesforceLightning.set(salesforceName, names);
}

const StandardObjectIconConcepts: Readonly<Record<string, IconName>> = {
    account: "building",
    case: "ticket",
    contact: "person",
    lead: "person",
    opportunity: "award",
    user: "person",
};

function normalizeSalesforceName(value: string): string {
    return value
        .replace(/__c$/, "")
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[\s-]+/g, "_")
        .toLowerCase();
}

export function getSalesforceLightningIconName(name: IconName): SalesforceLightningIconName | undefined {
    return SalesforceLightningIconNames[name];
}

export function getSalesforceObjectIconName(
    apiName: string,
    custom = false
): SalesforceLightningIconName | undefined {
    return custom ? undefined : `standard/${normalizeSalesforceName(apiName)}`;
}

export function getSalesforceActionIconName(apiName: string): SalesforceLightningIconName {
    return `action/${normalizeSalesforceName(apiName)}`;
}

export interface SalesforceLightningIconMeta extends Record<string, unknown> {
    salesforce: {
        name: string;
    };
}

export function fromSalesforceLightningIconName(name: string): IconDescriptor | undefined {
    const typedName = name as SalesforceLightningIconName;
    const standardConcept = name.startsWith("standard/")
        ? StandardObjectIconConcepts[name.slice("standard/".length)]
        : undefined;
    const universalNames = UniversalNamesBySalesforceLightning.get(typedName);
    const canonicalName = universalNames?.length === 1 ? universalNames[0] : standardConcept;
    if (!canonicalName) {
        return undefined;
    }
    return {
        name: canonicalName,
        meta: {
            salesforce: { name },
        } satisfies SalesforceLightningIconMeta,
    };
}

export function toSalesforceLightningIconName(icon: IconDescriptor): string | undefined {
    const source = icon.meta?.salesforce;
    return typeof source === "object" &&
        source !== null &&
        "name" in source &&
        typeof source.name === "string"
        ? source.name
        : icon.name
          ? getSalesforceLightningIconName(icon.name)
          : undefined;
}
