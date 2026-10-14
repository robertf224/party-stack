// Auto-generated file - do not edit manually

import { defineOntology, o } from "@party-stack/ontology";
export default defineOntology({
    types: [],
    objectTypes: [
        {
            name: "Task",
            displayName: "Task",
            pluralDisplayName: "Tasks",
            primaryKey: "Id",
            title: "Subject",
            properties: [
                {
                    name: "Id",
                    displayName: "Activity ID",
                    type: o.string({}),
                },
                {
                    name: "Subject",
                    displayName: "Subject",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "ActivityDate",
                    displayName: "Due Date Only",
                    type: o.optional({
                        type: o.date({}),
                    }),
                },
                {
                    name: "Status",
                    displayName: "Status",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                {
                                    value: "Not Started",
                                    label: "Not Started",
                                },
                                {
                                    value: "In Progress",
                                    label: "In Progress",
                                },
                                {
                                    value: "Completed",
                                    label: "Completed",
                                },
                                {
                                    value: "Waiting on someone else",
                                    label: "Waiting on someone else",
                                },
                                {
                                    value: "Deferred",
                                    label: "Deferred",
                                },
                            ],
                        }),
                    }),
                },
                {
                    name: "Priority",
                    displayName: "Priority",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                {
                                    value: "High",
                                    label: "High",
                                },
                                {
                                    value: "Normal",
                                    label: "Normal",
                                },
                                {
                                    value: "Low",
                                    label: "Low",
                                },
                            ],
                        }),
                    }),
                },
                {
                    name: "OwnerId",
                    displayName: "Assigned To ID",
                    type: o.string({}),
                },
                {
                    name: "Description",
                    displayName: "Description",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "IsClosed",
                    displayName: "Closed",
                    type: o.boolean({}),
                },
                {
                    name: "CreatedDate",
                    displayName: "Created Date",
                    type: o.timestamp({}),
                },
                {
                    name: "CreatedById",
                    displayName: "Created By ID",
                    type: o.objectReference({
                        objectType: "User",
                    }),
                },
                {
                    name: "LastModifiedDate",
                    displayName: "Last Modified Date",
                    type: o.timestamp({}),
                },
                {
                    name: "LastModifiedById",
                    displayName: "Last Modified By ID",
                    type: o.objectReference({
                        objectType: "User",
                    }),
                },
            ],
        },
        {
            name: "User",
            displayName: "User",
            pluralDisplayName: "Users",
            primaryKey: "Id",
            title: "Name",
            properties: [
                {
                    name: "Id",
                    displayName: "User ID",
                    type: o.string({}),
                },
                {
                    name: "Username",
                    displayName: "Username",
                    type: o.string({}),
                },
                {
                    name: "Name",
                    displayName: "Full Name",
                    type: o.string({}),
                },
                {
                    name: "Email",
                    displayName: "Email",
                    type: o.string({}),
                },
            ],
        },
    ],
    linkTypes: [
        {
            id: "salesforce:link:Task.CreatedById",
            source: {
                objectType: "Task",
                name: "tasks",
                displayName: "Tasks",
            },
            target: {
                objectType: "User",
                name: "CreatedBy",
                displayName: "Created By ID",
            },
            foreignKey: "CreatedById",
            cardinality: "many",
        },
        {
            id: "salesforce:link:Task.LastModifiedById",
            source: {
                objectType: "Task",
                name: "tasks",
                displayName: "Tasks",
            },
            target: {
                objectType: "User",
                name: "LastModifiedBy",
                displayName: "Last Modified By ID",
            },
            foreignKey: "LastModifiedById",
            cardinality: "many",
        },
    ],
    actionTypes: [
        {
            meta: {
                salesforce: {
                    kind: "standard",
                    apiName: "confirmSalesMeeting",
                },
            },
            name: "confirmSalesMeeting",
            displayName: "Confirm Sales Meeting",
            parameters: [
                {
                    name: "meetingRequestId",
                    displayName: "Meeting Request ID",
                    type: o.string({}),
                    description:
                        "The ID of the meeting request associated with a Get Available Meeting Times request.",
                },
                {
                    name: "meetingTime",
                    displayName: "Meeting Time",
                    type: o.string({}),
                    description:
                        "The meeting time in epoch milliseconds corresponding to the selected start time.",
                },
            ],
            logic: [],
            description: "Confirms a meeting time that’s part of a request to Get Meeting Time Slots.",
        },
        {
            meta: {
                salesforce: {
                    kind: "crud",
                    objectType: "Task",
                    operation: "create",
                },
            },
            name: "createTask",
            displayName: "Create Task",
            parameters: [
                {
                    name: "WhoId",
                    displayName: "Name ID",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "WhatId",
                    displayName: "Related To ID",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "Subject",
                    displayName: "Subject",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "ActivityDate",
                    displayName: "Due Date Only",
                    type: o.optional({
                        type: o.date({}),
                    }),
                },
                {
                    name: "Status",
                    displayName: "Status",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "Not Started",
                                        label: "Not Started",
                                    },
                                    {
                                        value: "In Progress",
                                        label: "In Progress",
                                    },
                                    {
                                        value: "Completed",
                                        label: "Completed",
                                    },
                                    {
                                        value: "Waiting on someone else",
                                        label: "Waiting on someone else",
                                    },
                                    {
                                        value: "Deferred",
                                        label: "Deferred",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "Priority",
                    displayName: "Priority",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "High",
                                        label: "High",
                                    },
                                    {
                                        value: "Normal",
                                        label: "Normal",
                                    },
                                    {
                                        value: "Low",
                                        label: "Low",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "OwnerId",
                    displayName: "Assigned To ID",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "Description",
                    displayName: "Description",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "CallDurationInSeconds",
                    displayName: "Call Duration",
                    type: o.optional({
                        type: o.integer({}),
                    }),
                },
                {
                    name: "CallType",
                    displayName: "Call Type",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "Internal",
                                        label: "Internal",
                                    },
                                    {
                                        value: "Inbound",
                                        label: "Inbound",
                                    },
                                    {
                                        value: "Outbound",
                                        label: "Outbound",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "CallDisposition",
                    displayName: "Call Result",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "CallObject",
                    displayName: "Call Object Identifier",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "ReminderDateTime",
                    displayName: "Reminder Date/Time",
                    type: o.optional({
                        type: o.timestamp({}),
                    }),
                },
                {
                    name: "IsReminderSet",
                    displayName: "Reminder Set",
                    type: o.optional({
                        type: o.boolean({}),
                    }),
                },
                {
                    name: "IsRecurrence",
                    displayName: "Create Recurring Series of Tasks",
                    type: o.optional({
                        type: o.boolean({}),
                    }),
                },
                {
                    name: "RecurrenceStartDateOnly",
                    displayName: "Recurrence Start",
                    type: o.optional({
                        type: o.date({}),
                    }),
                },
                {
                    name: "RecurrenceEndDateOnly",
                    displayName: "Recurrence End",
                    type: o.optional({
                        type: o.date({}),
                    }),
                },
                {
                    name: "RecurrenceTimeZoneSidKey",
                    displayName: "Recurrence Time Zone",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "Pacific/Kiritimati",
                                        label: "(GMT+14:00) Line Islands Time (Pacific/Kiritimati)",
                                    },
                                    {
                                        value: "Pacific/Apia",
                                        label: "(GMT+13:00) Apia Standard Time (Pacific/Apia)",
                                    },
                                    {
                                        value: "Pacific/Fakaofo",
                                        label: "(GMT+13:00) Tokelau Time (Pacific/Fakaofo)",
                                    },
                                    {
                                        value: "Pacific/Kanton",
                                        label: "(GMT+13:00) Phoenix Islands Time (Pacific/Kanton)",
                                    },
                                    {
                                        value: "Pacific/Tongatapu",
                                        label: "(GMT+13:00) Tonga Standard Time (Pacific/Tongatapu)",
                                    },
                                    {
                                        value: "Pacific/Chatham",
                                        label: "(GMT+12:45) Chatham Standard Time (Pacific/Chatham)",
                                    },
                                    {
                                        value: "Antarctica/McMurdo",
                                        label: "(GMT+12:00) New Zealand Standard Time (Antarctica/McMurdo)",
                                    },
                                    {
                                        value: "Asia/Anadyr",
                                        label: "(GMT+12:00) Anadyr Standard Time (Asia/Anadyr)",
                                    },
                                    {
                                        value: "Asia/Kamchatka",
                                        label: "(GMT+12:00) Petropavlovsk-Kamchatski Standard Time (Asia/Kamchatka)",
                                    },
                                    {
                                        value: "Pacific/Auckland",
                                        label: "(GMT+12:00) New Zealand Standard Time (Pacific/Auckland)",
                                    },
                                    {
                                        value: "Pacific/Fiji",
                                        label: "(GMT+12:00) Fiji Standard Time (Pacific/Fiji)",
                                    },
                                    {
                                        value: "Pacific/Funafuti",
                                        label: "(GMT+12:00) Tuvalu Time (Pacific/Funafuti)",
                                    },
                                    {
                                        value: "Pacific/Kwajalein",
                                        label: "(GMT+12:00) Marshall Islands Time (Pacific/Kwajalein)",
                                    },
                                    {
                                        value: "Pacific/Majuro",
                                        label: "(GMT+12:00) Marshall Islands Time (Pacific/Majuro)",
                                    },
                                    {
                                        value: "Pacific/Nauru",
                                        label: "(GMT+12:00) Nauru Time (Pacific/Nauru)",
                                    },
                                    {
                                        value: "Pacific/Tarawa",
                                        label: "(GMT+12:00) Gilbert Islands Time (Pacific/Tarawa)",
                                    },
                                    {
                                        value: "Pacific/Wake",
                                        label: "(GMT+12:00) Wake Island Time (Pacific/Wake)",
                                    },
                                    {
                                        value: "Pacific/Wallis",
                                        label: "(GMT+12:00) Wallis & Futuna Time (Pacific/Wallis)",
                                    },
                                    {
                                        value: "Asia/Magadan",
                                        label: "(GMT+11:00) Magadan Standard Time (Asia/Magadan)",
                                    },
                                    {
                                        value: "Asia/Sakhalin",
                                        label: "(GMT+11:00) Sakhalin Standard Time (Asia/Sakhalin)",
                                    },
                                    {
                                        value: "Asia/Srednekolymsk",
                                        label: "(GMT+11:00) Magadan Standard Time (Asia/Srednekolymsk)",
                                    },
                                    {
                                        value: "Pacific/Bougainville",
                                        label: "(GMT+11:00) Bougainville Standard Time (Pacific/Bougainville)",
                                    },
                                    {
                                        value: "Pacific/Efate",
                                        label: "(GMT+11:00) Vanuatu Standard Time (Pacific/Efate)",
                                    },
                                    {
                                        value: "Pacific/Guadalcanal",
                                        label: "(GMT+11:00) Solomon Islands Time (Pacific/Guadalcanal)",
                                    },
                                    {
                                        value: "Pacific/Kosrae",
                                        label: "(GMT+11:00) Kosrae Time (Pacific/Kosrae)",
                                    },
                                    {
                                        value: "Pacific/Norfolk",
                                        label: "(GMT+11:00) Norfolk Island Standard Time (Pacific/Norfolk)",
                                    },
                                    {
                                        value: "Pacific/Noumea",
                                        label: "(GMT+11:00) New Caledonia Standard Time (Pacific/Noumea)",
                                    },
                                    {
                                        value: "Pacific/Pohnpei",
                                        label: "(GMT+11:00) Ponape Time (Pacific/Pohnpei)",
                                    },
                                    {
                                        value: "Australia/Lord_Howe",
                                        label: "(GMT+10:30) Lord Howe Standard Time (Australia/Lord_Howe)",
                                    },
                                    {
                                        value: "Antarctica/DumontDUrville",
                                        label: "(GMT+10:00) Dumont-d’Urville Time (Antarctica/DumontDUrville)",
                                    },
                                    {
                                        value: "Antarctica/Macquarie",
                                        label: "(GMT+10:00) Australian Eastern Standard Time (Antarctica/Macquarie)",
                                    },
                                    {
                                        value: "Asia/Ust-Nera",
                                        label: "(GMT+10:00) Vladivostok Standard Time (Asia/Ust-Nera)",
                                    },
                                    {
                                        value: "Asia/Vladivostok",
                                        label: "(GMT+10:00) Vladivostok Standard Time (Asia/Vladivostok)",
                                    },
                                    {
                                        value: "Australia/Brisbane",
                                        label: "(GMT+10:00) Australian Eastern Standard Time (Australia/Brisbane)",
                                    },
                                    {
                                        value: "Australia/Currie",
                                        label: "(GMT+10:00) Australian Eastern Standard Time (Australia/Currie)",
                                    },
                                    {
                                        value: "Australia/Hobart",
                                        label: "(GMT+10:00) Australian Eastern Standard Time (Australia/Hobart)",
                                    },
                                    {
                                        value: "Australia/Lindeman",
                                        label: "(GMT+10:00) Australian Eastern Standard Time (Australia/Lindeman)",
                                    },
                                    {
                                        value: "Australia/Melbourne",
                                        label: "(GMT+10:00) Australian Eastern Standard Time (Australia/Melbourne)",
                                    },
                                    {
                                        value: "Australia/Sydney",
                                        label: "(GMT+10:00) Australian Eastern Standard Time (Australia/Sydney)",
                                    },
                                    {
                                        value: "Pacific/Guam",
                                        label: "(GMT+10:00) Chamorro Standard Time (Pacific/Guam)",
                                    },
                                    {
                                        value: "Pacific/Port_Moresby",
                                        label: "(GMT+10:00) Papua New Guinea Time (Pacific/Port_Moresby)",
                                    },
                                    {
                                        value: "Pacific/Saipan",
                                        label: "(GMT+10:00) Chamorro Standard Time (Pacific/Saipan)",
                                    },
                                    {
                                        value: "Pacific/Truk",
                                        label: "(GMT+10:00) Chuuk Time (Pacific/Truk)",
                                    },
                                    {
                                        value: "Australia/Adelaide",
                                        label: "(GMT+09:30) Australian Central Standard Time (Australia/Adelaide)",
                                    },
                                    {
                                        value: "Australia/Broken_Hill",
                                        label: "(GMT+09:30) Australian Central Standard Time (Australia/Broken_Hill)",
                                    },
                                    {
                                        value: "Australia/Darwin",
                                        label: "(GMT+09:30) Australian Central Standard Time (Australia/Darwin)",
                                    },
                                    {
                                        value: "Asia/Chita",
                                        label: "(GMT+09:00) Yakutsk Standard Time (Asia/Chita)",
                                    },
                                    {
                                        value: "Asia/Dili",
                                        label: "(GMT+09:00) East Timor Time (Asia/Dili)",
                                    },
                                    {
                                        value: "Asia/Jayapura",
                                        label: "(GMT+09:00) Eastern Indonesia Time (Asia/Jayapura)",
                                    },
                                    {
                                        value: "Asia/Khandyga",
                                        label: "(GMT+09:00) Yakutsk Standard Time (Asia/Khandyga)",
                                    },
                                    {
                                        value: "Asia/Seoul",
                                        label: "(GMT+09:00) Korean Standard Time (Asia/Seoul)",
                                    },
                                    {
                                        value: "Asia/Tokyo",
                                        label: "(GMT+09:00) Japan Standard Time (Asia/Tokyo)",
                                    },
                                    {
                                        value: "Asia/Yakutsk",
                                        label: "(GMT+09:00) Yakutsk Standard Time (Asia/Yakutsk)",
                                    },
                                    {
                                        value: "Pacific/Palau",
                                        label: "(GMT+09:00) Palau Time (Pacific/Palau)",
                                    },
                                    {
                                        value: "Australia/Eucla",
                                        label: "(GMT+08:45) Australian Central Western Standard Time (Australia/Eucla)",
                                    },
                                    {
                                        value: "Antarctica/Casey",
                                        label: "(GMT+08:00) Casey Time (Antarctica/Casey)",
                                    },
                                    {
                                        value: "Asia/Brunei",
                                        label: "(GMT+08:00) Brunei Darussalam Time (Asia/Brunei)",
                                    },
                                    {
                                        value: "Asia/Choibalsan",
                                        label: "(GMT+08:00) Ulaanbaatar Standard Time (Asia/Choibalsan)",
                                    },
                                    {
                                        value: "Asia/Hong_Kong",
                                        label: "(GMT+08:00) Hong Kong Standard Time (Asia/Hong_Kong)",
                                    },
                                    {
                                        value: "Asia/Irkutsk",
                                        label: "(GMT+08:00) Irkutsk Standard Time (Asia/Irkutsk)",
                                    },
                                    {
                                        value: "Asia/Kuala_Lumpur",
                                        label: "(GMT+08:00) Malaysia Time (Asia/Kuala_Lumpur)",
                                    },
                                    {
                                        value: "Asia/Kuching",
                                        label: "(GMT+08:00) Malaysia Time (Asia/Kuching)",
                                    },
                                    {
                                        value: "Asia/Macau",
                                        label: "(GMT+08:00) China Standard Time (Asia/Macau)",
                                    },
                                    {
                                        value: "Asia/Makassar",
                                        label: "(GMT+08:00) Central Indonesia Time (Asia/Makassar)",
                                    },
                                    {
                                        value: "Asia/Manila",
                                        label: "(GMT+08:00) Philippine Standard Time (Asia/Manila)",
                                    },
                                    {
                                        value: "Asia/Shanghai",
                                        label: "(GMT+08:00) China Standard Time (Asia/Shanghai)",
                                    },
                                    {
                                        value: "Asia/Singapore",
                                        label: "(GMT+08:00) Singapore Standard Time (Asia/Singapore)",
                                    },
                                    {
                                        value: "Asia/Taipei",
                                        label: "(GMT+08:00) Taipei Standard Time (Asia/Taipei)",
                                    },
                                    {
                                        value: "Asia/Ulaanbaatar",
                                        label: "(GMT+08:00) Ulaanbaatar Standard Time (Asia/Ulaanbaatar)",
                                    },
                                    {
                                        value: "Australia/Perth",
                                        label: "(GMT+08:00) Australian Western Standard Time (Australia/Perth)",
                                    },
                                    {
                                        value: "Antarctica/Davis",
                                        label: "(GMT+07:00) Davis Time (Antarctica/Davis)",
                                    },
                                    {
                                        value: "Asia/Bangkok",
                                        label: "(GMT+07:00) Indochina Time (Asia/Bangkok)",
                                    },
                                    {
                                        value: "Asia/Barnaul",
                                        label: "(GMT+07:00) Moscow Standard Time + 4 (Asia/Barnaul)",
                                    },
                                    {
                                        value: "Asia/Ho_Chi_Minh",
                                        label: "(GMT+07:00) Indochina Time (Asia/Ho_Chi_Minh)",
                                    },
                                    {
                                        value: "Asia/Hovd",
                                        label: "(GMT+07:00) Hovd Standard Time (Asia/Hovd)",
                                    },
                                    {
                                        value: "Asia/Jakarta",
                                        label: "(GMT+07:00) Western Indonesia Time (Asia/Jakarta)",
                                    },
                                    {
                                        value: "Asia/Krasnoyarsk",
                                        label: "(GMT+07:00) Krasnoyarsk Standard Time (Asia/Krasnoyarsk)",
                                    },
                                    {
                                        value: "Asia/Novokuznetsk",
                                        label: "(GMT+07:00) Krasnoyarsk Standard Time (Asia/Novokuznetsk)",
                                    },
                                    {
                                        value: "Asia/Novosibirsk",
                                        label: "(GMT+07:00) Novosibirsk Standard Time (Asia/Novosibirsk)",
                                    },
                                    {
                                        value: "Asia/Phnom_Penh",
                                        label: "(GMT+07:00) Indochina Time (Asia/Phnom_Penh)",
                                    },
                                    {
                                        value: "Asia/Pontianak",
                                        label: "(GMT+07:00) Western Indonesia Time (Asia/Pontianak)",
                                    },
                                    {
                                        value: "Asia/Tomsk",
                                        label: "(GMT+07:00) Moscow Standard Time + 4 (Asia/Tomsk)",
                                    },
                                    {
                                        value: "Asia/Vientiane",
                                        label: "(GMT+07:00) Indochina Time (Asia/Vientiane)",
                                    },
                                    {
                                        value: "Indian/Christmas",
                                        label: "(GMT+07:00) Christmas Island Time (Indian/Christmas)",
                                    },
                                    {
                                        value: "Asia/Yangon",
                                        label: "(GMT+06:30) Myanmar Time (Asia/Yangon)",
                                    },
                                    {
                                        value: "Indian/Cocos",
                                        label: "(GMT+06:30) Cocos Islands Time (Indian/Cocos)",
                                    },
                                    {
                                        value: "Asia/Bishkek",
                                        label: "(GMT+06:00) Kyrgyzstan Time (Asia/Bishkek)",
                                    },
                                    {
                                        value: "Asia/Dhaka",
                                        label: "(GMT+06:00) Bangladesh Standard Time (Asia/Dhaka)",
                                    },
                                    {
                                        value: "Asia/Omsk",
                                        label: "(GMT+06:00) Omsk Standard Time (Asia/Omsk)",
                                    },
                                    {
                                        value: "Asia/Thimphu",
                                        label: "(GMT+06:00) Bhutan Time (Asia/Thimphu)",
                                    },
                                    {
                                        value: "Asia/Urumqi",
                                        label: "(GMT+06:00) China Standard Time (Asia/Urumqi)",
                                    },
                                    {
                                        value: "Indian/Chagos",
                                        label: "(GMT+06:00) Indian Ocean Time (Indian/Chagos)",
                                    },
                                    {
                                        value: "Asia/Kathmandu",
                                        label: "(GMT+05:45) Nepal Time (Asia/Kathmandu)",
                                    },
                                    {
                                        value: "Asia/Colombo",
                                        label: "(GMT+05:30) India Standard Time (Asia/Colombo)",
                                    },
                                    {
                                        value: "Asia/Kolkata",
                                        label: "(GMT+05:30) India Standard Time (Asia/Kolkata)",
                                    },
                                    {
                                        value: "Antarctica/Mawson",
                                        label: "(GMT+05:00) Mawson Time (Antarctica/Mawson)",
                                    },
                                    {
                                        value: "Antarctica/Vostok",
                                        label: "(GMT+05:00) Vostok Time (Antarctica/Vostok)",
                                    },
                                    {
                                        value: "Asia/Almaty",
                                        label: "(GMT+05:00) East Kazakhstan Time (Asia/Almaty)",
                                    },
                                    {
                                        value: "Asia/Aqtau",
                                        label: "(GMT+05:00) West Kazakhstan Time (Asia/Aqtau)",
                                    },
                                    {
                                        value: "Asia/Aqtobe",
                                        label: "(GMT+05:00) West Kazakhstan Time (Asia/Aqtobe)",
                                    },
                                    {
                                        value: "Asia/Ashgabat",
                                        label: "(GMT+05:00) Turkmenistan Standard Time (Asia/Ashgabat)",
                                    },
                                    {
                                        value: "Asia/Atyrau",
                                        label: "(GMT+05:00) West Kazakhstan Time (Asia/Atyrau)",
                                    },
                                    {
                                        value: "Asia/Dushanbe",
                                        label: "(GMT+05:00) Tajikistan Time (Asia/Dushanbe)",
                                    },
                                    {
                                        value: "Asia/Karachi",
                                        label: "(GMT+05:00) Pakistan Standard Time (Asia/Karachi)",
                                    },
                                    {
                                        value: "Asia/Oral",
                                        label: "(GMT+05:00) West Kazakhstan Time (Asia/Oral)",
                                    },
                                    {
                                        value: "Asia/Qostanay",
                                        label: "(GMT+05:00) East Kazakhstan Time (Asia/Qostanay)",
                                    },
                                    {
                                        value: "Asia/Qyzylorda",
                                        label: "(GMT+05:00) West Kazakhstan Time (Asia/Qyzylorda)",
                                    },
                                    {
                                        value: "Asia/Samarkand",
                                        label: "(GMT+05:00) Uzbekistan Standard Time (Asia/Samarkand)",
                                    },
                                    {
                                        value: "Asia/Tashkent",
                                        label: "(GMT+05:00) Uzbekistan Standard Time (Asia/Tashkent)",
                                    },
                                    {
                                        value: "Asia/Yekaterinburg",
                                        label: "(GMT+05:00) Yekaterinburg Standard Time (Asia/Yekaterinburg)",
                                    },
                                    {
                                        value: "Indian/Kerguelen",
                                        label: "(GMT+05:00) French Southern & Antarctic Time (Indian/Kerguelen)",
                                    },
                                    {
                                        value: "Indian/Maldives",
                                        label: "(GMT+05:00) Maldives Time (Indian/Maldives)",
                                    },
                                    {
                                        value: "Asia/Kabul",
                                        label: "(GMT+04:30) Afghanistan Time (Asia/Kabul)",
                                    },
                                    {
                                        value: "Asia/Baku",
                                        label: "(GMT+04:00) Azerbaijan Standard Time (Asia/Baku)",
                                    },
                                    {
                                        value: "Asia/Dubai",
                                        label: "(GMT+04:00) Gulf Standard Time (Asia/Dubai)",
                                    },
                                    {
                                        value: "Asia/Muscat",
                                        label: "(GMT+04:00) Gulf Standard Time (Asia/Muscat)",
                                    },
                                    {
                                        value: "Asia/Tbilisi",
                                        label: "(GMT+04:00) Georgia Standard Time (Asia/Tbilisi)",
                                    },
                                    {
                                        value: "Asia/Yerevan",
                                        label: "(GMT+04:00) Armenia Standard Time (Asia/Yerevan)",
                                    },
                                    {
                                        value: "Europe/Astrakhan",
                                        label: "(GMT+04:00) Samara Standard Time (Europe/Astrakhan)",
                                    },
                                    {
                                        value: "Europe/Samara",
                                        label: "(GMT+04:00) Samara Standard Time (Europe/Samara)",
                                    },
                                    {
                                        value: "Europe/Saratov",
                                        label: "(GMT+04:00) Moscow Standard Time + 1 (Europe/Saratov)",
                                    },
                                    {
                                        value: "Europe/Ulyanovsk",
                                        label: "(GMT+04:00) Moscow Standard Time + 1 (Europe/Ulyanovsk)",
                                    },
                                    {
                                        value: "Indian/Mahe",
                                        label: "(GMT+04:00) Seychelles Time (Indian/Mahe)",
                                    },
                                    {
                                        value: "Indian/Mauritius",
                                        label: "(GMT+04:00) Mauritius Standard Time (Indian/Mauritius)",
                                    },
                                    {
                                        value: "Indian/Reunion",
                                        label: "(GMT+04:00) Réunion Time (Indian/Reunion)",
                                    },
                                    {
                                        value: "Africa/Addis_Ababa",
                                        label: "(GMT+03:00) East Africa Time (Africa/Addis_Ababa)",
                                    },
                                    {
                                        value: "Africa/Asmera",
                                        label: "(GMT+03:00) East Africa Time (Africa/Asmera)",
                                    },
                                    {
                                        value: "Africa/Cairo",
                                        label: "(GMT+03:00) Eastern European Standard Time (Africa/Cairo)",
                                    },
                                    {
                                        value: "Africa/Dar_es_Salaam",
                                        label: "(GMT+03:00) East Africa Time (Africa/Dar_es_Salaam)",
                                    },
                                    {
                                        value: "Africa/Djibouti",
                                        label: "(GMT+03:00) East Africa Time (Africa/Djibouti)",
                                    },
                                    {
                                        value: "Africa/Kampala",
                                        label: "(GMT+03:00) East Africa Time (Africa/Kampala)",
                                    },
                                    {
                                        value: "Africa/Mogadishu",
                                        label: "(GMT+03:00) East Africa Time (Africa/Mogadishu)",
                                    },
                                    {
                                        value: "Africa/Nairobi",
                                        label: "(GMT+03:00) East Africa Time (Africa/Nairobi)",
                                    },
                                    {
                                        value: "Antarctica/Syowa",
                                        label: "(GMT+03:00) Syowa Time (Antarctica/Syowa)",
                                    },
                                    {
                                        value: "Asia/Aden",
                                        label: "(GMT+03:00) Arabian Standard Time (Asia/Aden)",
                                    },
                                    {
                                        value: "Asia/Amman",
                                        label: "(GMT+03:00) Eastern European Standard Time (Asia/Amman)",
                                    },
                                    {
                                        value: "Asia/Baghdad",
                                        label: "(GMT+03:00) Arabian Standard Time (Asia/Baghdad)",
                                    },
                                    {
                                        value: "Asia/Bahrain",
                                        label: "(GMT+03:00) Arabian Standard Time (Asia/Bahrain)",
                                    },
                                    {
                                        value: "Asia/Beirut",
                                        label: "(GMT+03:00) Eastern European Summer Time (Asia/Beirut)",
                                    },
                                    {
                                        value: "Asia/Famagusta",
                                        label: "(GMT+03:00) Eastern European Summer Time (Asia/Famagusta)",
                                    },
                                    {
                                        value: "Asia/Gaza",
                                        label: "(GMT+03:00) Eastern European Summer Time (Asia/Gaza)",
                                    },
                                    {
                                        value: "Asia/Hebron",
                                        label: "(GMT+03:00) Eastern European Summer Time (Asia/Hebron)",
                                    },
                                    {
                                        value: "Asia/Jerusalem",
                                        label: "(GMT+03:00) Israel Daylight Time (Asia/Jerusalem)",
                                    },
                                    {
                                        value: "Asia/Kuwait",
                                        label: "(GMT+03:00) Arabian Standard Time (Asia/Kuwait)",
                                    },
                                    {
                                        value: "Asia/Nicosia",
                                        label: "(GMT+03:00) Eastern European Summer Time (Asia/Nicosia)",
                                    },
                                    {
                                        value: "Asia/Qatar",
                                        label: "(GMT+03:00) Arabian Standard Time (Asia/Qatar)",
                                    },
                                    {
                                        value: "Asia/Riyadh",
                                        label: "(GMT+03:00) Arabian Standard Time (Asia/Riyadh)",
                                    },
                                    {
                                        value: "Europe/Athens",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Athens)",
                                    },
                                    {
                                        value: "Europe/Bucharest",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Bucharest)",
                                    },
                                    {
                                        value: "Europe/Chisinau",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Chisinau)",
                                    },
                                    {
                                        value: "Europe/Helsinki",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Helsinki)",
                                    },
                                    {
                                        value: "Europe/Istanbul",
                                        label: "(GMT+03:00) Eastern European Standard Time (Europe/Istanbul)",
                                    },
                                    {
                                        value: "Europe/Kirov",
                                        label: "(GMT+03:00) Moscow Standard Time (Europe/Kirov)",
                                    },
                                    {
                                        value: "Europe/Kyiv",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Kyiv)",
                                    },
                                    {
                                        value: "Europe/Mariehamn",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Mariehamn)",
                                    },
                                    {
                                        value: "Europe/Minsk",
                                        label: "(GMT+03:00) Moscow Standard Time (Europe/Minsk)",
                                    },
                                    {
                                        value: "Europe/Moscow",
                                        label: "(GMT+03:00) Moscow Standard Time (Europe/Moscow)",
                                    },
                                    {
                                        value: "Europe/Riga",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Riga)",
                                    },
                                    {
                                        value: "Europe/Sofia",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Sofia)",
                                    },
                                    {
                                        value: "Europe/Tallinn",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Tallinn)",
                                    },
                                    {
                                        value: "Europe/Uzhgorod",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Uzhgorod)",
                                    },
                                    {
                                        value: "Europe/Vilnius",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Vilnius)",
                                    },
                                    {
                                        value: "Europe/Volgograd",
                                        label: "(GMT+03:00) Volgograd Standard Time (Europe/Volgograd)",
                                    },
                                    {
                                        value: "Europe/Zaporozhye",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Zaporozhye)",
                                    },
                                    {
                                        value: "Indian/Antananarivo",
                                        label: "(GMT+03:00) East Africa Time (Indian/Antananarivo)",
                                    },
                                    {
                                        value: "Indian/Comoro",
                                        label: "(GMT+03:00) East Africa Time (Indian/Comoro)",
                                    },
                                    {
                                        value: "Indian/Mayotte",
                                        label: "(GMT+03:00) East Africa Time (Indian/Mayotte)",
                                    },
                                    {
                                        value: "Africa/Blantyre",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Blantyre)",
                                    },
                                    {
                                        value: "Africa/Bujumbura",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Bujumbura)",
                                    },
                                    {
                                        value: "Africa/Ceuta",
                                        label: "(GMT+02:00) Central European Summer Time (Africa/Ceuta)",
                                    },
                                    {
                                        value: "Africa/Gaborone",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Gaborone)",
                                    },
                                    {
                                        value: "Africa/Harare",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Harare)",
                                    },
                                    {
                                        value: "Africa/Johannesburg",
                                        label: "(GMT+02:00) South Africa Standard Time (Africa/Johannesburg)",
                                    },
                                    {
                                        value: "Africa/Juba",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Juba)",
                                    },
                                    {
                                        value: "Africa/Khartoum",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Khartoum)",
                                    },
                                    {
                                        value: "Africa/Kigali",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Kigali)",
                                    },
                                    {
                                        value: "Africa/Lubumbashi",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Lubumbashi)",
                                    },
                                    {
                                        value: "Africa/Lusaka",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Lusaka)",
                                    },
                                    {
                                        value: "Africa/Maputo",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Maputo)",
                                    },
                                    {
                                        value: "Africa/Maseru",
                                        label: "(GMT+02:00) South Africa Standard Time (Africa/Maseru)",
                                    },
                                    {
                                        value: "Africa/Mbabane",
                                        label: "(GMT+02:00) South Africa Standard Time (Africa/Mbabane)",
                                    },
                                    {
                                        value: "Africa/Tripoli",
                                        label: "(GMT+02:00) Eastern European Standard Time (Africa/Tripoli)",
                                    },
                                    {
                                        value: "Africa/Windhoek",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Windhoek)",
                                    },
                                    {
                                        value: "Antarctica/Troll",
                                        label: "(GMT+02:00) Central European Summer Time (Antarctica/Troll)",
                                    },
                                    {
                                        value: "Arctic/Longyearbyen",
                                        label: "(GMT+02:00) Central European Summer Time (Arctic/Longyearbyen)",
                                    },
                                    {
                                        value: "Europe/Amsterdam",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Amsterdam)",
                                    },
                                    {
                                        value: "Europe/Andorra",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Andorra)",
                                    },
                                    {
                                        value: "Europe/Belgrade",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Belgrade)",
                                    },
                                    {
                                        value: "Europe/Berlin",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Berlin)",
                                    },
                                    {
                                        value: "Europe/Bratislava",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Bratislava)",
                                    },
                                    {
                                        value: "Europe/Brussels",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Brussels)",
                                    },
                                    {
                                        value: "Europe/Budapest",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Budapest)",
                                    },
                                    {
                                        value: "Europe/Busingen",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Busingen)",
                                    },
                                    {
                                        value: "Europe/Copenhagen",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Copenhagen)",
                                    },
                                    {
                                        value: "Europe/Gibraltar",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Gibraltar)",
                                    },
                                    {
                                        value: "Europe/Kaliningrad",
                                        label: "(GMT+02:00) Eastern European Standard Time (Europe/Kaliningrad)",
                                    },
                                    {
                                        value: "Europe/Ljubljana",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Ljubljana)",
                                    },
                                    {
                                        value: "Europe/Luxembourg",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Luxembourg)",
                                    },
                                    {
                                        value: "Europe/Madrid",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Madrid)",
                                    },
                                    {
                                        value: "Europe/Malta",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Malta)",
                                    },
                                    {
                                        value: "Europe/Monaco",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Monaco)",
                                    },
                                    {
                                        value: "Europe/Oslo",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Oslo)",
                                    },
                                    {
                                        value: "Europe/Paris",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Paris)",
                                    },
                                    {
                                        value: "Europe/Podgorica",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Podgorica)",
                                    },
                                    {
                                        value: "Europe/Prague",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Prague)",
                                    },
                                    {
                                        value: "Europe/Rome",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Rome)",
                                    },
                                    {
                                        value: "Europe/San_Marino",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/San_Marino)",
                                    },
                                    {
                                        value: "Europe/Sarajevo",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Sarajevo)",
                                    },
                                    {
                                        value: "Europe/Skopje",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Skopje)",
                                    },
                                    {
                                        value: "Europe/Stockholm",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Stockholm)",
                                    },
                                    {
                                        value: "Europe/Tirane",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Tirane)",
                                    },
                                    {
                                        value: "Europe/Vaduz",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Vaduz)",
                                    },
                                    {
                                        value: "Europe/Vatican",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Vatican)",
                                    },
                                    {
                                        value: "Europe/Vienna",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Vienna)",
                                    },
                                    {
                                        value: "Europe/Warsaw",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Warsaw)",
                                    },
                                    {
                                        value: "Europe/Zagreb",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Zagreb)",
                                    },
                                    {
                                        value: "Europe/Zurich",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Zurich)",
                                    },
                                    {
                                        value: "Africa/Algiers",
                                        label: "(GMT+01:00) Central European Standard Time (Africa/Algiers)",
                                    },
                                    {
                                        value: "Africa/Bangui",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Bangui)",
                                    },
                                    {
                                        value: "Africa/Brazzaville",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Brazzaville)",
                                    },
                                    {
                                        value: "Africa/Casablanca",
                                        label: "(GMT+01:00) Western European Summer Time (Africa/Casablanca)",
                                    },
                                    {
                                        value: "Africa/Douala",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Douala)",
                                    },
                                    {
                                        value: "Africa/El_Aaiun",
                                        label: "(GMT+01:00) Western European Summer Time (Africa/El_Aaiun)",
                                    },
                                    {
                                        value: "Africa/Kinshasa",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Kinshasa)",
                                    },
                                    {
                                        value: "Africa/Lagos",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Lagos)",
                                    },
                                    {
                                        value: "Africa/Libreville",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Libreville)",
                                    },
                                    {
                                        value: "Africa/Luanda",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Luanda)",
                                    },
                                    {
                                        value: "Africa/Malabo",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Malabo)",
                                    },
                                    {
                                        value: "Africa/Ndjamena",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Ndjamena)",
                                    },
                                    {
                                        value: "Africa/Niamey",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Niamey)",
                                    },
                                    {
                                        value: "Africa/Porto-Novo",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Porto-Novo)",
                                    },
                                    {
                                        value: "Africa/Tunis",
                                        label: "(GMT+01:00) Central European Standard Time (Africa/Tunis)",
                                    },
                                    {
                                        value: "Atlantic/Canary",
                                        label: "(GMT+01:00) Western European Summer Time (Atlantic/Canary)",
                                    },
                                    {
                                        value: "Atlantic/Faroe",
                                        label: "(GMT+01:00) Western European Summer Time (Atlantic/Faroe)",
                                    },
                                    {
                                        value: "Atlantic/Madeira",
                                        label: "(GMT+01:00) Western European Summer Time (Atlantic/Madeira)",
                                    },
                                    {
                                        value: "Europe/Dublin",
                                        label: "(GMT+01:00) Irish Standard Time (Europe/Dublin)",
                                    },
                                    {
                                        value: "Europe/Guernsey",
                                        label: "(GMT+01:00) British Summer Time (Europe/Guernsey)",
                                    },
                                    {
                                        value: "Europe/Isle_of_Man",
                                        label: "(GMT+01:00) British Summer Time (Europe/Isle_of_Man)",
                                    },
                                    {
                                        value: "Europe/Jersey",
                                        label: "(GMT+01:00) British Summer Time (Europe/Jersey)",
                                    },
                                    {
                                        value: "Europe/Lisbon",
                                        label: "(GMT+01:00) Western European Summer Time (Europe/Lisbon)",
                                    },
                                    {
                                        value: "Europe/London",
                                        label: "(GMT+01:00) British Summer Time (Europe/London)",
                                    },
                                    {
                                        value: "Africa/Abidjan",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Abidjan)",
                                    },
                                    {
                                        value: "Africa/Accra",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Accra)",
                                    },
                                    {
                                        value: "Africa/Bamako",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Bamako)",
                                    },
                                    {
                                        value: "Africa/Banjul",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Banjul)",
                                    },
                                    {
                                        value: "Africa/Bissau",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Bissau)",
                                    },
                                    {
                                        value: "Africa/Conakry",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Conakry)",
                                    },
                                    {
                                        value: "Africa/Dakar",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Dakar)",
                                    },
                                    {
                                        value: "Africa/Freetown",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Freetown)",
                                    },
                                    {
                                        value: "Africa/Lome",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Lome)",
                                    },
                                    {
                                        value: "Africa/Monrovia",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Monrovia)",
                                    },
                                    {
                                        value: "Africa/Nouakchott",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Nouakchott)",
                                    },
                                    {
                                        value: "Africa/Ouagadougou",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Ouagadougou)",
                                    },
                                    {
                                        value: "Africa/Sao_Tome",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Sao_Tome)",
                                    },
                                    {
                                        value: "America/Danmarkshavn",
                                        label: "(GMT+00:00) Greenwich Mean Time (America/Danmarkshavn)",
                                    },
                                    {
                                        value: "Atlantic/Azores",
                                        label: "(GMT+00:00) Azores Summer Time (Atlantic/Azores)",
                                    },
                                    {
                                        value: "Atlantic/Reykjavik",
                                        label: "(GMT+00:00) Greenwich Mean Time (Atlantic/Reykjavik)",
                                    },
                                    {
                                        value: "Atlantic/St_Helena",
                                        label: "(GMT+00:00) Greenwich Mean Time (Atlantic/St_Helena)",
                                    },
                                    {
                                        value: "GMT",
                                        label: "(GMT+00:00) Greenwich Mean Time (GMT)",
                                    },
                                    {
                                        value: "America/Nuuk",
                                        label: "(GMT-01:00) West Greenland Summer Time (America/Nuuk)",
                                    },
                                    {
                                        value: "America/Scoresbysund",
                                        label: "(GMT-01:00) East Greenland Summer Time (America/Scoresbysund)",
                                    },
                                    {
                                        value: "Atlantic/Cape_Verde",
                                        label: "(GMT-01:00) Cape Verde Standard Time (Atlantic/Cape_Verde)",
                                    },
                                    {
                                        value: "America/Miquelon",
                                        label: "(GMT-02:00) St Pierre & Miquelon Daylight Time (America/Miquelon)",
                                    },
                                    {
                                        value: "America/Noronha",
                                        label: "(GMT-02:00) Fernando de Noronha Standard Time (America/Noronha)",
                                    },
                                    {
                                        value: "Atlantic/South_Georgia",
                                        label: "(GMT-02:00) South Georgia Time (Atlantic/South_Georgia)",
                                    },
                                    {
                                        value: "America/St_Johns",
                                        label: "(GMT-02:30) Newfoundland Daylight Time (America/St_Johns)",
                                    },
                                    {
                                        value: "America/Araguaina",
                                        label: "(GMT-03:00) Brasilia Standard Time (America/Araguaina)",
                                    },
                                    {
                                        value: "America/Argentina/Buenos_Aires",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Buenos_Aires)",
                                    },
                                    {
                                        value: "America/Argentina/Catamarca",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Catamarca)",
                                    },
                                    {
                                        value: "America/Argentina/Cordoba",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Cordoba)",
                                    },
                                    {
                                        value: "America/Argentina/Jujuy",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Jujuy)",
                                    },
                                    {
                                        value: "America/Argentina/La_Rioja",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/La_Rioja)",
                                    },
                                    {
                                        value: "America/Argentina/Mendoza",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Mendoza)",
                                    },
                                    {
                                        value: "America/Argentina/Rio_Gallegos",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Rio_Gallegos)",
                                    },
                                    {
                                        value: "America/Argentina/Salta",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Salta)",
                                    },
                                    {
                                        value: "America/Argentina/San_Juan",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/San_Juan)",
                                    },
                                    {
                                        value: "America/Argentina/San_Luis",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/San_Luis)",
                                    },
                                    {
                                        value: "America/Argentina/Tucuman",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Tucuman)",
                                    },
                                    {
                                        value: "America/Argentina/Ushuaia",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Ushuaia)",
                                    },
                                    {
                                        value: "America/Asuncion",
                                        label: "(GMT-03:00) Paraguay Standard Time (America/Asuncion)",
                                    },
                                    {
                                        value: "America/Bahia",
                                        label: "(GMT-03:00) Brasilia Standard Time (America/Bahia)",
                                    },
                                    {
                                        value: "America/Belem",
                                        label: "(GMT-03:00) Brasilia Standard Time (America/Belem)",
                                    },
                                    {
                                        value: "America/Cayenne",
                                        label: "(GMT-03:00) French Guiana Time (America/Cayenne)",
                                    },
                                    {
                                        value: "America/Fortaleza",
                                        label: "(GMT-03:00) Brasilia Standard Time (America/Fortaleza)",
                                    },
                                    {
                                        value: "America/Glace_Bay",
                                        label: "(GMT-03:00) Atlantic Daylight Time (America/Glace_Bay)",
                                    },
                                    {
                                        value: "America/Goose_Bay",
                                        label: "(GMT-03:00) Atlantic Daylight Time (America/Goose_Bay)",
                                    },
                                    {
                                        value: "America/Halifax",
                                        label: "(GMT-03:00) Atlantic Daylight Time (America/Halifax)",
                                    },
                                    {
                                        value: "America/Maceio",
                                        label: "(GMT-03:00) Brasilia Standard Time (America/Maceio)",
                                    },
                                    {
                                        value: "America/Moncton",
                                        label: "(GMT-03:00) Atlantic Daylight Time (America/Moncton)",
                                    },
                                    {
                                        value: "America/Montevideo",
                                        label: "(GMT-03:00) Uruguay Standard Time (America/Montevideo)",
                                    },
                                    {
                                        value: "America/Paramaribo",
                                        label: "(GMT-03:00) Suriname Time (America/Paramaribo)",
                                    },
                                    {
                                        value: "America/Punta_Arenas",
                                        label: "(GMT-03:00) Chile Standard Time (America/Punta_Arenas)",
                                    },
                                    {
                                        value: "America/Recife",
                                        label: "(GMT-03:00) Brasilia Standard Time (America/Recife)",
                                    },
                                    {
                                        value: "America/Santarem",
                                        label: "(GMT-03:00) Brasilia Standard Time (America/Santarem)",
                                    },
                                    {
                                        value: "America/Santiago",
                                        label: "(GMT-03:00) Chile Summer Time (America/Santiago)",
                                    },
                                    {
                                        value: "America/Sao_Paulo",
                                        label: "(GMT-03:00) Brasilia Standard Time (America/Sao_Paulo)",
                                    },
                                    {
                                        value: "America/Thule",
                                        label: "(GMT-03:00) Atlantic Daylight Time (America/Thule)",
                                    },
                                    {
                                        value: "Antarctica/Palmer",
                                        label: "(GMT-03:00) Chile Standard Time (Antarctica/Palmer)",
                                    },
                                    {
                                        value: "Antarctica/Rothera",
                                        label: "(GMT-03:00) Rothera Time (Antarctica/Rothera)",
                                    },
                                    {
                                        value: "Atlantic/Bermuda",
                                        label: "(GMT-03:00) Atlantic Daylight Time (Atlantic/Bermuda)",
                                    },
                                    {
                                        value: "Atlantic/Stanley",
                                        label: "(GMT-03:00) Falkland Islands Standard Time (Atlantic/Stanley)",
                                    },
                                    {
                                        value: "America/Anguilla",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Anguilla)",
                                    },
                                    {
                                        value: "America/Antigua",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Antigua)",
                                    },
                                    {
                                        value: "America/Aruba",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Aruba)",
                                    },
                                    {
                                        value: "America/Barbados",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Barbados)",
                                    },
                                    {
                                        value: "America/Blanc-Sablon",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Blanc-Sablon)",
                                    },
                                    {
                                        value: "America/Boa_Vista",
                                        label: "(GMT-04:00) Amazon Standard Time (America/Boa_Vista)",
                                    },
                                    {
                                        value: "America/Campo_Grande",
                                        label: "(GMT-04:00) Amazon Standard Time (America/Campo_Grande)",
                                    },
                                    {
                                        value: "America/Caracas",
                                        label: "(GMT-04:00) Venezuela Time (America/Caracas)",
                                    },
                                    {
                                        value: "America/Cuiaba",
                                        label: "(GMT-04:00) Amazon Standard Time (America/Cuiaba)",
                                    },
                                    {
                                        value: "America/Curacao",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Curacao)",
                                    },
                                    {
                                        value: "America/Detroit",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Detroit)",
                                    },
                                    {
                                        value: "America/Dominica",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Dominica)",
                                    },
                                    {
                                        value: "America/Grand_Turk",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Grand_Turk)",
                                    },
                                    {
                                        value: "America/Grenada",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Grenada)",
                                    },
                                    {
                                        value: "America/Guadeloupe",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Guadeloupe)",
                                    },
                                    {
                                        value: "America/Guyana",
                                        label: "(GMT-04:00) Guyana Time (America/Guyana)",
                                    },
                                    {
                                        value: "America/Indiana/Indianapolis",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Indiana/Indianapolis)",
                                    },
                                    {
                                        value: "America/Indiana/Marengo",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Indiana/Marengo)",
                                    },
                                    {
                                        value: "America/Indiana/Petersburg",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Indiana/Petersburg)",
                                    },
                                    {
                                        value: "America/Indiana/Vevay",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Indiana/Vevay)",
                                    },
                                    {
                                        value: "America/Indiana/Vincennes",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Indiana/Vincennes)",
                                    },
                                    {
                                        value: "America/Indiana/Winamac",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Indiana/Winamac)",
                                    },
                                    {
                                        value: "America/Iqaluit",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Iqaluit)",
                                    },
                                    {
                                        value: "America/Kentucky/Louisville",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Kentucky/Louisville)",
                                    },
                                    {
                                        value: "America/Kentucky/Monticello",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Kentucky/Monticello)",
                                    },
                                    {
                                        value: "America/Kralendijk",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Kralendijk)",
                                    },
                                    {
                                        value: "America/La_Paz",
                                        label: "(GMT-04:00) Bolivia Time (America/La_Paz)",
                                    },
                                    {
                                        value: "America/Lower_Princes",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Lower_Princes)",
                                    },
                                    {
                                        value: "America/Manaus",
                                        label: "(GMT-04:00) Amazon Standard Time (America/Manaus)",
                                    },
                                    {
                                        value: "America/Marigot",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Marigot)",
                                    },
                                    {
                                        value: "America/Martinique",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Martinique)",
                                    },
                                    {
                                        value: "America/Montreal",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Montreal)",
                                    },
                                    {
                                        value: "America/Montserrat",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Montserrat)",
                                    },
                                    {
                                        value: "America/Nassau",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Nassau)",
                                    },
                                    {
                                        value: "America/New_York",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/New_York)",
                                    },
                                    {
                                        value: "America/Nipigon",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Nipigon)",
                                    },
                                    {
                                        value: "America/Pangnirtung",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Pangnirtung)",
                                    },
                                    {
                                        value: "America/Port-au-Prince",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Port-au-Prince)",
                                    },
                                    {
                                        value: "America/Port_of_Spain",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Port_of_Spain)",
                                    },
                                    {
                                        value: "America/Porto_Velho",
                                        label: "(GMT-04:00) Amazon Standard Time (America/Porto_Velho)",
                                    },
                                    {
                                        value: "America/Puerto_Rico",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Puerto_Rico)",
                                    },
                                    {
                                        value: "America/Santo_Domingo",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Santo_Domingo)",
                                    },
                                    {
                                        value: "America/St_Barthelemy",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/St_Barthelemy)",
                                    },
                                    {
                                        value: "America/St_Kitts",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/St_Kitts)",
                                    },
                                    {
                                        value: "America/St_Lucia",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/St_Lucia)",
                                    },
                                    {
                                        value: "America/St_Thomas",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/St_Thomas)",
                                    },
                                    {
                                        value: "America/St_Vincent",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/St_Vincent)",
                                    },
                                    {
                                        value: "America/Thunder_Bay",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Thunder_Bay)",
                                    },
                                    {
                                        value: "America/Toronto",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Toronto)",
                                    },
                                    {
                                        value: "America/Tortola",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Tortola)",
                                    },
                                    {
                                        value: "America/Bogota",
                                        label: "(GMT-05:00) Colombia Standard Time (America/Bogota)",
                                    },
                                    {
                                        value: "America/Cancun",
                                        label: "(GMT-05:00) Eastern Standard Time (America/Cancun)",
                                    },
                                    {
                                        value: "America/Cayman",
                                        label: "(GMT-05:00) Eastern Standard Time (America/Cayman)",
                                    },
                                    {
                                        value: "America/Chicago",
                                        label: "(GMT-05:00) Central Daylight Time (America/Chicago)",
                                    },
                                    {
                                        value: "America/Coral_Harbour",
                                        label: "(GMT-05:00) Eastern Standard Time (America/Coral_Harbour)",
                                    },
                                    {
                                        value: "America/Eirunepe",
                                        label: "(GMT-05:00) Acre Standard Time (America/Eirunepe)",
                                    },
                                    {
                                        value: "America/Guayaquil",
                                        label: "(GMT-05:00) Ecuador Time (America/Guayaquil)",
                                    },
                                    {
                                        value: "America/Indiana/Knox",
                                        label: "(GMT-05:00) Central Daylight Time (America/Indiana/Knox)",
                                    },
                                    {
                                        value: "America/Indiana/Tell_City",
                                        label: "(GMT-05:00) Central Daylight Time (America/Indiana/Tell_City)",
                                    },
                                    {
                                        value: "America/Jamaica",
                                        label: "(GMT-05:00) Eastern Standard Time (America/Jamaica)",
                                    },
                                    {
                                        value: "America/Lima",
                                        label: "(GMT-05:00) Peru Standard Time (America/Lima)",
                                    },
                                    {
                                        value: "America/Matamoros",
                                        label: "(GMT-05:00) Central Daylight Time (America/Matamoros)",
                                    },
                                    {
                                        value: "America/Menominee",
                                        label: "(GMT-05:00) Central Daylight Time (America/Menominee)",
                                    },
                                    {
                                        value: "America/North_Dakota/Beulah",
                                        label: "(GMT-05:00) Central Daylight Time (America/North_Dakota/Beulah)",
                                    },
                                    {
                                        value: "America/North_Dakota/Center",
                                        label: "(GMT-05:00) Central Daylight Time (America/North_Dakota/Center)",
                                    },
                                    {
                                        value: "America/North_Dakota/New_Salem",
                                        label: "(GMT-05:00) Central Daylight Time (America/North_Dakota/New_Salem)",
                                    },
                                    {
                                        value: "America/Ojinaga",
                                        label: "(GMT-05:00) Central Daylight Time (America/Ojinaga)",
                                    },
                                    {
                                        value: "America/Panama",
                                        label: "(GMT-05:00) Eastern Standard Time (America/Panama)",
                                    },
                                    {
                                        value: "America/Rainy_River",
                                        label: "(GMT-05:00) Central Daylight Time (America/Rainy_River)",
                                    },
                                    {
                                        value: "America/Rankin_Inlet",
                                        label: "(GMT-05:00) Central Daylight Time (America/Rankin_Inlet)",
                                    },
                                    {
                                        value: "America/Resolute",
                                        label: "(GMT-05:00) Central Daylight Time (America/Resolute)",
                                    },
                                    {
                                        value: "America/Rio_Branco",
                                        label: "(GMT-05:00) Acre Standard Time (America/Rio_Branco)",
                                    },
                                    {
                                        value: "America/Winnipeg",
                                        label: "(GMT-05:00) Central Daylight Time (America/Winnipeg)",
                                    },
                                    {
                                        value: "Pacific/Easter",
                                        label: "(GMT-05:00) Easter Island Summer Time (Pacific/Easter)",
                                    },
                                    {
                                        value: "America/Bahia_Banderas",
                                        label: "(GMT-06:00) Central Standard Time (America/Bahia_Banderas)",
                                    },
                                    {
                                        value: "America/Belize",
                                        label: "(GMT-06:00) Central Standard Time (America/Belize)",
                                    },
                                    {
                                        value: "America/Boise",
                                        label: "(GMT-06:00) Mountain Daylight Time (America/Boise)",
                                    },
                                    {
                                        value: "America/Cambridge_Bay",
                                        label: "(GMT-06:00) Mountain Daylight Time (America/Cambridge_Bay)",
                                    },
                                    {
                                        value: "America/Chihuahua",
                                        label: "(GMT-06:00) Central Standard Time (America/Chihuahua)",
                                    },
                                    {
                                        value: "America/Costa_Rica",
                                        label: "(GMT-06:00) Central Standard Time (America/Costa_Rica)",
                                    },
                                    {
                                        value: "America/Denver",
                                        label: "(GMT-06:00) Mountain Daylight Time (America/Denver)",
                                    },
                                    {
                                        value: "America/Edmonton",
                                        label: "(GMT-06:00) Mountain Daylight Time (America/Edmonton)",
                                    },
                                    {
                                        value: "America/El_Salvador",
                                        label: "(GMT-06:00) Central Standard Time (America/El_Salvador)",
                                    },
                                    {
                                        value: "America/Guatemala",
                                        label: "(GMT-06:00) Central Standard Time (America/Guatemala)",
                                    },
                                    {
                                        value: "America/Inuvik",
                                        label: "(GMT-06:00) Mountain Daylight Time (America/Inuvik)",
                                    },
                                    {
                                        value: "America/Managua",
                                        label: "(GMT-06:00) Central Standard Time (America/Managua)",
                                    },
                                    {
                                        value: "America/Merida",
                                        label: "(GMT-06:00) Central Standard Time (America/Merida)",
                                    },
                                    {
                                        value: "America/Mexico_City",
                                        label: "(GMT-06:00) Central Standard Time (America/Mexico_City)",
                                    },
                                    {
                                        value: "America/Monterrey",
                                        label: "(GMT-06:00) Central Standard Time (America/Monterrey)",
                                    },
                                    {
                                        value: "America/Regina",
                                        label: "(GMT-06:00) Central Standard Time (America/Regina)",
                                    },
                                    {
                                        value: "America/Swift_Current",
                                        label: "(GMT-06:00) Central Standard Time (America/Swift_Current)",
                                    },
                                    {
                                        value: "America/Tegucigalpa",
                                        label: "(GMT-06:00) Central Standard Time (America/Tegucigalpa)",
                                    },
                                    {
                                        value: "America/Yellowknife",
                                        label: "(GMT-06:00) Mountain Daylight Time (America/Yellowknife)",
                                    },
                                    {
                                        value: "Pacific/Galapagos",
                                        label: "(GMT-06:00) Galapagos Time (Pacific/Galapagos)",
                                    },
                                    {
                                        value: "America/Creston",
                                        label: "(GMT-07:00) Mountain Standard Time (America/Creston)",
                                    },
                                    {
                                        value: "America/Dawson",
                                        label: "(GMT-07:00) Yukon Time (America/Dawson)",
                                    },
                                    {
                                        value: "America/Dawson_Creek",
                                        label: "(GMT-07:00) Mountain Standard Time (America/Dawson_Creek)",
                                    },
                                    {
                                        value: "America/Fort_Nelson",
                                        label: "(GMT-07:00) Mountain Standard Time (America/Fort_Nelson)",
                                    },
                                    {
                                        value: "America/Hermosillo",
                                        label: "(GMT-07:00) Mexican Pacific Standard Time (America/Hermosillo)",
                                    },
                                    {
                                        value: "America/Los_Angeles",
                                        label: "(GMT-07:00) Pacific Daylight Time (America/Los_Angeles)",
                                    },
                                    {
                                        value: "America/Mazatlan",
                                        label: "(GMT-07:00) Mexican Pacific Standard Time (America/Mazatlan)",
                                    },
                                    {
                                        value: "America/Phoenix",
                                        label: "(GMT-07:00) Mountain Standard Time (America/Phoenix)",
                                    },
                                    {
                                        value: "America/Santa_Isabel",
                                        label: "(GMT-07:00) Northwest Mexico Daylight Time (America/Santa_Isabel)",
                                    },
                                    {
                                        value: "America/Tijuana",
                                        label: "(GMT-07:00) Pacific Daylight Time (America/Tijuana)",
                                    },
                                    {
                                        value: "America/Vancouver",
                                        label: "(GMT-07:00) Pacific Daylight Time (America/Vancouver)",
                                    },
                                    {
                                        value: "America/Whitehorse",
                                        label: "(GMT-07:00) Yukon Time (America/Whitehorse)",
                                    },
                                    {
                                        value: "America/Anchorage",
                                        label: "(GMT-08:00) Alaska Daylight Time (America/Anchorage)",
                                    },
                                    {
                                        value: "America/Juneau",
                                        label: "(GMT-08:00) Alaska Daylight Time (America/Juneau)",
                                    },
                                    {
                                        value: "America/Metlakatla",
                                        label: "(GMT-08:00) Alaska Daylight Time (America/Metlakatla)",
                                    },
                                    {
                                        value: "America/Nome",
                                        label: "(GMT-08:00) Alaska Daylight Time (America/Nome)",
                                    },
                                    {
                                        value: "America/Sitka",
                                        label: "(GMT-08:00) Alaska Daylight Time (America/Sitka)",
                                    },
                                    {
                                        value: "America/Yakutat",
                                        label: "(GMT-08:00) Alaska Daylight Time (America/Yakutat)",
                                    },
                                    {
                                        value: "Pacific/Pitcairn",
                                        label: "(GMT-08:00) Pitcairn Time (Pacific/Pitcairn)",
                                    },
                                    {
                                        value: "America/Adak",
                                        label: "(GMT-09:00) Hawaii-Aleutian Daylight Time (America/Adak)",
                                    },
                                    {
                                        value: "Pacific/Gambier",
                                        label: "(GMT-09:00) Gambier Time (Pacific/Gambier)",
                                    },
                                    {
                                        value: "Pacific/Marquesas",
                                        label: "(GMT-09:30) Marquesas Time (Pacific/Marquesas)",
                                    },
                                    {
                                        value: "Pacific/Honolulu",
                                        label: "(GMT-10:00) Hawaii-Aleutian Standard Time (Pacific/Honolulu)",
                                    },
                                    {
                                        value: "Pacific/Johnston",
                                        label: "(GMT-10:00) Hawaii-Aleutian Standard Time (Pacific/Johnston)",
                                    },
                                    {
                                        value: "Pacific/Rarotonga",
                                        label: "(GMT-10:00) Cook Islands Standard Time (Pacific/Rarotonga)",
                                    },
                                    {
                                        value: "Pacific/Tahiti",
                                        label: "(GMT-10:00) Tahiti Time (Pacific/Tahiti)",
                                    },
                                    {
                                        value: "Pacific/Midway",
                                        label: "(GMT-11:00) Samoa Standard Time (Pacific/Midway)",
                                    },
                                    {
                                        value: "Pacific/Niue",
                                        label: "(GMT-11:00) Niue Time (Pacific/Niue)",
                                    },
                                    {
                                        value: "Pacific/Pago_Pago",
                                        label: "(GMT-11:00) Samoa Standard Time (Pacific/Pago_Pago)",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "RecurrenceType",
                    displayName: "Recurrence Type",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "RecursDaily",
                                        label: "Recurs Daily",
                                    },
                                    {
                                        value: "RecursEveryWeekday",
                                        label: "Recurs Every Weekday",
                                    },
                                    {
                                        value: "RecursMonthly",
                                        label: "Recurs Monthly",
                                    },
                                    {
                                        value: "RecursMonthlyNth",
                                        label: "Recurs Monthly Nth",
                                    },
                                    {
                                        value: "RecursWeekly",
                                        label: "Recurs Weekly",
                                    },
                                    {
                                        value: "RecursYearly",
                                        label: "Recurs Yearly",
                                    },
                                    {
                                        value: "RecursYearlyNth",
                                        label: "Recurs Yearly Nth",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "RecurrenceInterval",
                    displayName: "Recurrence Interval",
                    type: o.optional({
                        type: o.integer({}),
                    }),
                },
                {
                    name: "RecurrenceDayOfWeekMask",
                    displayName: "Recurrence Day of Week Mask",
                    type: o.optional({
                        type: o.integer({}),
                    }),
                },
                {
                    name: "RecurrenceDayOfMonth",
                    displayName: "Recurrence Day of Month",
                    type: o.optional({
                        type: o.integer({}),
                    }),
                },
                {
                    name: "RecurrenceInstance",
                    displayName: "Recurrence Instance",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "First",
                                        label: "1st",
                                    },
                                    {
                                        value: "Second",
                                        label: "2nd",
                                    },
                                    {
                                        value: "Third",
                                        label: "3rd",
                                    },
                                    {
                                        value: "Fourth",
                                        label: "4th",
                                    },
                                    {
                                        value: "Last",
                                        label: "last",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "RecurrenceMonthOfYear",
                    displayName: "Recurrence Month of Year",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "January",
                                        label: "January",
                                    },
                                    {
                                        value: "February",
                                        label: "February",
                                    },
                                    {
                                        value: "March",
                                        label: "March",
                                    },
                                    {
                                        value: "April",
                                        label: "April",
                                    },
                                    {
                                        value: "May",
                                        label: "May",
                                    },
                                    {
                                        value: "June",
                                        label: "June",
                                    },
                                    {
                                        value: "July",
                                        label: "July",
                                    },
                                    {
                                        value: "August",
                                        label: "August",
                                    },
                                    {
                                        value: "September",
                                        label: "September",
                                    },
                                    {
                                        value: "October",
                                        label: "October",
                                    },
                                    {
                                        value: "November",
                                        label: "November",
                                    },
                                    {
                                        value: "December",
                                        label: "December",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "RecurrenceRegeneratedType",
                    displayName: "Repeat This Task",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "RecurrenceRegenerateAfterDueDate",
                                        label: "After due date",
                                    },
                                    {
                                        value: "RecurrenceRegenerateAfterToday",
                                        label: "After date completed",
                                    },
                                    {
                                        value: "RecurrenceRegenerated",
                                        label: "(Task Closed)",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "TaskSubtype",
                    displayName: "Task Subtype",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "Task",
                                        label: "Task",
                                    },
                                    {
                                        value: "Email",
                                        label: "Email",
                                    },
                                    {
                                        value: "ListEmail",
                                        label: "List Email",
                                    },
                                    {
                                        value: "Cadence",
                                        label: "Cadence",
                                    },
                                    {
                                        value: "Call",
                                        label: "Call",
                                    },
                                    {
                                        value: "LinkedIn",
                                        label: "LinkedIn",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "Event_Type__c",
                    displayName: "Event Type",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "FTX",
                                        label: "FTX",
                                    },
                                    {
                                        value: "Deployment",
                                        label: "Deployment",
                                    },
                                    {
                                        value: "Customer Demo",
                                        label: "Customer Demo",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "Customer_POC__c",
                    displayName: "Customer POC",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "Mission__c",
                    displayName: "Mission",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Task",
                    values: [
                        {
                            property: ["WhoId"],
                            value: o.Expression.inputReference({
                                name: "WhoId",
                            }),
                        },
                        {
                            property: ["WhatId"],
                            value: o.Expression.inputReference({
                                name: "WhatId",
                            }),
                        },
                        {
                            property: ["Subject"],
                            value: o.Expression.inputReference({
                                name: "Subject",
                            }),
                        },
                        {
                            property: ["ActivityDate"],
                            value: o.Expression.inputReference({
                                name: "ActivityDate",
                            }),
                        },
                        {
                            property: ["Status"],
                            value: o.Expression.inputReference({
                                name: "Status",
                            }),
                        },
                        {
                            property: ["Priority"],
                            value: o.Expression.inputReference({
                                name: "Priority",
                            }),
                        },
                        {
                            property: ["OwnerId"],
                            value: o.Expression.inputReference({
                                name: "OwnerId",
                            }),
                        },
                        {
                            property: ["Description"],
                            value: o.Expression.inputReference({
                                name: "Description",
                            }),
                        },
                        {
                            property: ["CallDurationInSeconds"],
                            value: o.Expression.inputReference({
                                name: "CallDurationInSeconds",
                            }),
                        },
                        {
                            property: ["CallType"],
                            value: o.Expression.inputReference({
                                name: "CallType",
                            }),
                        },
                        {
                            property: ["CallDisposition"],
                            value: o.Expression.inputReference({
                                name: "CallDisposition",
                            }),
                        },
                        {
                            property: ["CallObject"],
                            value: o.Expression.inputReference({
                                name: "CallObject",
                            }),
                        },
                        {
                            property: ["ReminderDateTime"],
                            value: o.Expression.inputReference({
                                name: "ReminderDateTime",
                            }),
                        },
                        {
                            property: ["IsReminderSet"],
                            value: o.Expression.inputReference({
                                name: "IsReminderSet",
                            }),
                        },
                        {
                            property: ["IsRecurrence"],
                            value: o.Expression.inputReference({
                                name: "IsRecurrence",
                            }),
                        },
                        {
                            property: ["RecurrenceStartDateOnly"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceStartDateOnly",
                            }),
                        },
                        {
                            property: ["RecurrenceEndDateOnly"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceEndDateOnly",
                            }),
                        },
                        {
                            property: ["RecurrenceTimeZoneSidKey"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceTimeZoneSidKey",
                            }),
                        },
                        {
                            property: ["RecurrenceType"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceType",
                            }),
                        },
                        {
                            property: ["RecurrenceInterval"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceInterval",
                            }),
                        },
                        {
                            property: ["RecurrenceDayOfWeekMask"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceDayOfWeekMask",
                            }),
                        },
                        {
                            property: ["RecurrenceDayOfMonth"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceDayOfMonth",
                            }),
                        },
                        {
                            property: ["RecurrenceInstance"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceInstance",
                            }),
                        },
                        {
                            property: ["RecurrenceMonthOfYear"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceMonthOfYear",
                            }),
                        },
                        {
                            property: ["RecurrenceRegeneratedType"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceRegeneratedType",
                            }),
                        },
                        {
                            property: ["TaskSubtype"],
                            value: o.Expression.inputReference({
                                name: "TaskSubtype",
                            }),
                        },
                        {
                            property: ["Event_Type__c"],
                            value: o.Expression.inputReference({
                                name: "Event_Type__c",
                            }),
                        },
                        {
                            property: ["Customer_POC__c"],
                            value: o.Expression.inputReference({
                                name: "Customer_POC__c",
                            }),
                        },
                        {
                            property: ["Mission__c"],
                            value: o.Expression.inputReference({
                                name: "Mission__c",
                            }),
                        },
                    ],
                }),
            ],
        },
        {
            meta: {
                salesforce: {
                    kind: "crud",
                    objectType: "Task",
                    operation: "delete",
                },
            },
            name: "deleteTask",
            displayName: "Delete Task",
            parameters: [
                {
                    name: "recordId",
                    displayName: "Task ID",
                    type: o.objectReference({
                        objectType: "Task",
                    }),
                },
            ],
            logic: [
                o.ActionLogicStep.deleteObject({
                    object: {
                        name: "recordId",
                    },
                }),
            ],
        },
        {
            meta: {
                salesforce: {
                    kind: "flow",
                    apiName: "sales_sfa_flows__CreateSalesLead",
                },
            },
            name: "sales_sfa_flows__CreateSalesLead",
            displayName: "Create Sales Lead Record",
            parameters: [
                {
                    name: "leadRecord",
                    displayName: "leadRecord",
                    type: o.optional({
                        type: o.struct({
                            fields: [
                                {
                                    name: "Id",
                                    displayName: "Lead ID",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "IsDeleted",
                                    displayName: "Deleted",
                                    type: o.optional({
                                        type: o.boolean({}),
                                    }),
                                },
                                {
                                    name: "MasterRecordId",
                                    displayName: "Master Record ID",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "LastName",
                                    displayName: "Last Name",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "FirstName",
                                    displayName: "First Name",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "Salutation",
                                    displayName: "Salutation",
                                    type: o.optional({
                                        type: o.string({
                                            constraint: o.StringConstraint.enum({
                                                options: [
                                                    {
                                                        value: "Mr.",
                                                        label: "Mr.",
                                                    },
                                                    {
                                                        value: "Ms.",
                                                        label: "Ms.",
                                                    },
                                                    {
                                                        value: "Mrs.",
                                                        label: "Mrs.",
                                                    },
                                                    {
                                                        value: "Dr.",
                                                        label: "Dr.",
                                                    },
                                                    {
                                                        value: "Prof.",
                                                        label: "Prof.",
                                                    },
                                                    {
                                                        value: "Mx.",
                                                        label: "Mx.",
                                                    },
                                                ],
                                            }),
                                        }),
                                    }),
                                },
                                {
                                    name: "Name",
                                    displayName: "Full Name",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "Title",
                                    displayName: "Title",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "Company",
                                    displayName: "Company",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "Street",
                                    displayName: "Street",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "City",
                                    displayName: "City",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "State",
                                    displayName: "State/Province",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "PostalCode",
                                    displayName: "Zip/Postal Code",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "Country",
                                    displayName: "Country",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "Latitude",
                                    displayName: "Latitude",
                                    type: o.optional({
                                        type: o.double({}),
                                    }),
                                },
                                {
                                    name: "Longitude",
                                    displayName: "Longitude",
                                    type: o.optional({
                                        type: o.double({}),
                                    }),
                                },
                                {
                                    name: "GeocodeAccuracy",
                                    displayName: "Geocode Accuracy",
                                    type: o.optional({
                                        type: o.string({
                                            constraint: o.StringConstraint.enum({
                                                options: [
                                                    {
                                                        value: "Address",
                                                        label: "Address",
                                                    },
                                                    {
                                                        value: "NearAddress",
                                                        label: "Near Address",
                                                    },
                                                    {
                                                        value: "Block",
                                                        label: "Block",
                                                    },
                                                    {
                                                        value: "Street",
                                                        label: "Street",
                                                    },
                                                    {
                                                        value: "ExtendedZip",
                                                        label: "Extended Zip",
                                                    },
                                                    {
                                                        value: "Zip",
                                                        label: "Zip",
                                                    },
                                                    {
                                                        value: "Neighborhood",
                                                        label: "Neighborhood",
                                                    },
                                                    {
                                                        value: "City",
                                                        label: "City",
                                                    },
                                                    {
                                                        value: "County",
                                                        label: "County",
                                                    },
                                                    {
                                                        value: "State",
                                                        label: "State",
                                                    },
                                                    {
                                                        value: "Unknown",
                                                        label: "Unknown",
                                                    },
                                                ],
                                            }),
                                        }),
                                    }),
                                },
                                {
                                    name: "Phone",
                                    displayName: "Phone",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "Email",
                                    displayName: "Email",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "Website",
                                    displayName: "Website",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "PhotoUrl",
                                    displayName: "Photo URL",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "Description",
                                    displayName: "Description",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "LeadSource",
                                    displayName: "Lead Source",
                                    type: o.optional({
                                        type: o.string({
                                            constraint: o.StringConstraint.enum({
                                                options: [
                                                    {
                                                        value: "Advertisement",
                                                        label: "Advertisement",
                                                    },
                                                    {
                                                        value: "Employee Referral",
                                                        label: "Employee Referral",
                                                    },
                                                    {
                                                        value: "External Referral",
                                                        label: "External Referral",
                                                    },
                                                    {
                                                        value: "Partner",
                                                        label: "Partner",
                                                    },
                                                    {
                                                        value: "Public Relations",
                                                        label: "Public Relations",
                                                    },
                                                    {
                                                        value: "Seminar - Internal",
                                                        label: "Seminar - Internal",
                                                    },
                                                    {
                                                        value: "Seminar - Partner",
                                                        label: "Seminar - Partner",
                                                    },
                                                    {
                                                        value: "Trade Show",
                                                        label: "Trade Show",
                                                    },
                                                    {
                                                        value: "Web",
                                                        label: "Web",
                                                    },
                                                    {
                                                        value: "Word of mouth",
                                                        label: "Word of mouth",
                                                    },
                                                    {
                                                        value: "Other",
                                                        label: "Other",
                                                    },
                                                ],
                                            }),
                                        }),
                                    }),
                                },
                                {
                                    name: "Status",
                                    displayName: "Status",
                                    type: o.optional({
                                        type: o.string({
                                            constraint: o.StringConstraint.enum({
                                                options: [
                                                    {
                                                        value: "New",
                                                        label: "New",
                                                    },
                                                    {
                                                        value: "Contacted",
                                                        label: "Contacted",
                                                    },
                                                    {
                                                        value: "Nurturing",
                                                        label: "Nurturing",
                                                    },
                                                    {
                                                        value: "Qualified",
                                                        label: "Qualified",
                                                    },
                                                    {
                                                        value: "Unqualified",
                                                        label: "Unqualified",
                                                    },
                                                ],
                                            }),
                                        }),
                                    }),
                                },
                                {
                                    name: "Industry",
                                    displayName: "Industry",
                                    type: o.optional({
                                        type: o.string({
                                            constraint: o.StringConstraint.enum({
                                                options: [
                                                    {
                                                        value: "Agriculture",
                                                        label: "Agriculture",
                                                    },
                                                    {
                                                        value: "Apparel",
                                                        label: "Apparel",
                                                    },
                                                    {
                                                        value: "Banking",
                                                        label: "Banking",
                                                    },
                                                    {
                                                        value: "Biotechnology",
                                                        label: "Biotechnology",
                                                    },
                                                    {
                                                        value: "Chemicals",
                                                        label: "Chemicals",
                                                    },
                                                    {
                                                        value: "Communications",
                                                        label: "Communications",
                                                    },
                                                    {
                                                        value: "Construction",
                                                        label: "Construction",
                                                    },
                                                    {
                                                        value: "Consulting",
                                                        label: "Consulting",
                                                    },
                                                    {
                                                        value: "Education",
                                                        label: "Education",
                                                    },
                                                    {
                                                        value: "Electronics",
                                                        label: "Electronics",
                                                    },
                                                    {
                                                        value: "Energy",
                                                        label: "Energy",
                                                    },
                                                    {
                                                        value: "Engineering",
                                                        label: "Engineering",
                                                    },
                                                    {
                                                        value: "Entertainment",
                                                        label: "Entertainment",
                                                    },
                                                    {
                                                        value: "Environmental",
                                                        label: "Environmental",
                                                    },
                                                    {
                                                        value: "Finance",
                                                        label: "Finance",
                                                    },
                                                    {
                                                        value: "Food & Beverage",
                                                        label: "Food & Beverage",
                                                    },
                                                    {
                                                        value: "Government",
                                                        label: "Government",
                                                    },
                                                    {
                                                        value: "Healthcare",
                                                        label: "Healthcare",
                                                    },
                                                    {
                                                        value: "Hospitality",
                                                        label: "Hospitality",
                                                    },
                                                    {
                                                        value: "Insurance",
                                                        label: "Insurance",
                                                    },
                                                    {
                                                        value: "Machinery",
                                                        label: "Machinery",
                                                    },
                                                    {
                                                        value: "Manufacturing",
                                                        label: "Manufacturing",
                                                    },
                                                    {
                                                        value: "Media",
                                                        label: "Media",
                                                    },
                                                    {
                                                        value: "Not For Profit",
                                                        label: "Not For Profit",
                                                    },
                                                    {
                                                        value: "Other",
                                                        label: "Other",
                                                    },
                                                    {
                                                        value: "Recreation",
                                                        label: "Recreation",
                                                    },
                                                    {
                                                        value: "Retail",
                                                        label: "Retail",
                                                    },
                                                    {
                                                        value: "Shipping",
                                                        label: "Shipping",
                                                    },
                                                    {
                                                        value: "Technology",
                                                        label: "Technology",
                                                    },
                                                    {
                                                        value: "Telecommunications",
                                                        label: "Telecommunications",
                                                    },
                                                    {
                                                        value: "Transportation",
                                                        label: "Transportation",
                                                    },
                                                    {
                                                        value: "Utilities",
                                                        label: "Utilities",
                                                    },
                                                ],
                                            }),
                                        }),
                                    }),
                                },
                                {
                                    name: "Rating",
                                    displayName: "Rating",
                                    type: o.optional({
                                        type: o.string({
                                            constraint: o.StringConstraint.enum({
                                                options: [
                                                    {
                                                        value: "Hot",
                                                        label: "Hot",
                                                    },
                                                    {
                                                        value: "Warm",
                                                        label: "Warm",
                                                    },
                                                    {
                                                        value: "Cold",
                                                        label: "Cold",
                                                    },
                                                ],
                                            }),
                                        }),
                                    }),
                                },
                                {
                                    name: "AnnualRevenue",
                                    displayName: "Annual Revenue",
                                    type: o.optional({
                                        type: o.double({}),
                                    }),
                                },
                                {
                                    name: "NumberOfEmployees",
                                    displayName: "Employees",
                                    type: o.optional({
                                        type: o.integer({}),
                                    }),
                                },
                                {
                                    name: "OwnerId",
                                    displayName: "Owner ID",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "HasOptedOutOfEmail",
                                    displayName: "Email Opt Out",
                                    type: o.optional({
                                        type: o.boolean({}),
                                    }),
                                },
                                {
                                    name: "IsConverted",
                                    displayName: "Converted",
                                    type: o.optional({
                                        type: o.boolean({}),
                                    }),
                                },
                                {
                                    name: "ConvertedDate",
                                    displayName: "Converted Date",
                                    type: o.optional({
                                        type: o.date({}),
                                    }),
                                },
                                {
                                    name: "ConvertedAccountId",
                                    displayName: "Converted Account ID",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "ConvertedContactId",
                                    displayName: "Converted Contact ID",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "ConvertedOpportunityId",
                                    displayName: "Converted Opportunity ID",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "IsUnreadByOwner",
                                    displayName: "Unread By Owner",
                                    type: o.optional({
                                        type: o.boolean({}),
                                    }),
                                },
                                {
                                    name: "CreatedDate",
                                    displayName: "Created Date",
                                    type: o.optional({
                                        type: o.timestamp({}),
                                    }),
                                },
                                {
                                    name: "CreatedById",
                                    displayName: "Created By ID",
                                    type: o.optional({
                                        type: o.objectReference({
                                            objectType: "User",
                                        }),
                                    }),
                                },
                                {
                                    name: "LastModifiedDate",
                                    displayName: "Last Modified Date",
                                    type: o.optional({
                                        type: o.timestamp({}),
                                    }),
                                },
                                {
                                    name: "LastModifiedById",
                                    displayName: "Last Modified By ID",
                                    type: o.optional({
                                        type: o.objectReference({
                                            objectType: "User",
                                        }),
                                    }),
                                },
                                {
                                    name: "SystemModstamp",
                                    displayName: "System Modstamp",
                                    type: o.optional({
                                        type: o.timestamp({}),
                                    }),
                                },
                                {
                                    name: "LastActivityDate",
                                    displayName: "Last Activity",
                                    type: o.optional({
                                        type: o.date({}),
                                    }),
                                },
                                {
                                    name: "LastViewedDate",
                                    displayName: "Last Viewed Date",
                                    type: o.optional({
                                        type: o.timestamp({}),
                                    }),
                                },
                                {
                                    name: "LastReferencedDate",
                                    displayName: "Last Referenced Date",
                                    type: o.optional({
                                        type: o.timestamp({}),
                                    }),
                                },
                                {
                                    name: "Jigsaw",
                                    displayName: "Data.com Key",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "JigsawContactId",
                                    displayName: "Jigsaw Contact ID",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "EmailBouncedReason",
                                    displayName: "Email Bounced Reason",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "EmailBouncedDate",
                                    displayName: "Email Bounced Date",
                                    type: o.optional({
                                        type: o.timestamp({}),
                                    }),
                                },
                                {
                                    name: "IndividualId",
                                    displayName: "Individual ID",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "ActionCadenceId",
                                    displayName: "Cadence ID",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "ActionCadenceAssigneeId",
                                    displayName: "Cadence Assignee ID",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "ActionCadenceState",
                                    displayName: "Cadence State",
                                    type: o.optional({
                                        type: o.string({
                                            constraint: o.StringConstraint.enum({
                                                options: [
                                                    {
                                                        value: "Running",
                                                        label: "Running",
                                                    },
                                                    {
                                                        value: "Complete",
                                                        label: "Complete",
                                                    },
                                                    {
                                                        value: "Initializing",
                                                        label: "Initializing",
                                                    },
                                                    {
                                                        value: "Paused",
                                                        label: "Paused",
                                                    },
                                                    {
                                                        value: "Processing",
                                                        label: "Processing",
                                                    },
                                                    {
                                                        value: "Error",
                                                        label: "Error",
                                                    },
                                                ],
                                            }),
                                        }),
                                    }),
                                },
                                {
                                    name: "ScheduledResumeDateTime",
                                    displayName: "Cadence Resume Time",
                                    type: o.optional({
                                        type: o.timestamp({}),
                                    }),
                                },
                                {
                                    name: "ActiveTrackerCount",
                                    displayName: "Total Cadences",
                                    type: o.optional({
                                        type: o.integer({}),
                                    }),
                                },
                                {
                                    name: "FirstCallDateTime",
                                    displayName: "First Call Date",
                                    type: o.optional({
                                        type: o.timestamp({}),
                                    }),
                                },
                                {
                                    name: "FirstEmailDateTime",
                                    displayName: "First Email Date",
                                    type: o.optional({
                                        type: o.timestamp({}),
                                    }),
                                },
                                {
                                    name: "ActivityMetricId",
                                    displayName: "Activity Metric ID",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                                {
                                    name: "ActivityMetricRollupId",
                                    displayName: "Activity Metric Rollup ID",
                                    type: o.optional({
                                        type: o.string({}),
                                    }),
                                },
                            ],
                        }),
                    }),
                    description: "Stores the lead record details to retrieve or create.",
                },
            ],
            logic: [],
            description:
                "Searches for an existing lead record. If one isn’t found, creates a new lead record.",
        },
        {
            meta: {
                salesforce: {
                    kind: "crud",
                    objectType: "Task",
                    operation: "update",
                },
            },
            name: "updateTask",
            displayName: "Update Task",
            parameters: [
                {
                    name: "recordId",
                    displayName: "Task ID",
                    type: o.objectReference({
                        objectType: "Task",
                    }),
                },
                {
                    name: "WhoId",
                    displayName: "Name ID",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "WhatId",
                    displayName: "Related To ID",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "Subject",
                    displayName: "Subject",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "ActivityDate",
                    displayName: "Due Date Only",
                    type: o.optional({
                        type: o.date({}),
                    }),
                },
                {
                    name: "Status",
                    displayName: "Status",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "Not Started",
                                        label: "Not Started",
                                    },
                                    {
                                        value: "In Progress",
                                        label: "In Progress",
                                    },
                                    {
                                        value: "Completed",
                                        label: "Completed",
                                    },
                                    {
                                        value: "Waiting on someone else",
                                        label: "Waiting on someone else",
                                    },
                                    {
                                        value: "Deferred",
                                        label: "Deferred",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "Priority",
                    displayName: "Priority",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "High",
                                        label: "High",
                                    },
                                    {
                                        value: "Normal",
                                        label: "Normal",
                                    },
                                    {
                                        value: "Low",
                                        label: "Low",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "OwnerId",
                    displayName: "Assigned To ID",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "Description",
                    displayName: "Description",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "CallDurationInSeconds",
                    displayName: "Call Duration",
                    type: o.optional({
                        type: o.integer({}),
                    }),
                },
                {
                    name: "CallType",
                    displayName: "Call Type",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "Internal",
                                        label: "Internal",
                                    },
                                    {
                                        value: "Inbound",
                                        label: "Inbound",
                                    },
                                    {
                                        value: "Outbound",
                                        label: "Outbound",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "CallDisposition",
                    displayName: "Call Result",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "CallObject",
                    displayName: "Call Object Identifier",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "ReminderDateTime",
                    displayName: "Reminder Date/Time",
                    type: o.optional({
                        type: o.timestamp({}),
                    }),
                },
                {
                    name: "IsReminderSet",
                    displayName: "Reminder Set",
                    type: o.optional({
                        type: o.boolean({}),
                    }),
                },
                {
                    name: "RecurrenceStartDateOnly",
                    displayName: "Recurrence Start",
                    type: o.optional({
                        type: o.date({}),
                    }),
                },
                {
                    name: "RecurrenceEndDateOnly",
                    displayName: "Recurrence End",
                    type: o.optional({
                        type: o.date({}),
                    }),
                },
                {
                    name: "RecurrenceTimeZoneSidKey",
                    displayName: "Recurrence Time Zone",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "Pacific/Kiritimati",
                                        label: "(GMT+14:00) Line Islands Time (Pacific/Kiritimati)",
                                    },
                                    {
                                        value: "Pacific/Apia",
                                        label: "(GMT+13:00) Apia Standard Time (Pacific/Apia)",
                                    },
                                    {
                                        value: "Pacific/Fakaofo",
                                        label: "(GMT+13:00) Tokelau Time (Pacific/Fakaofo)",
                                    },
                                    {
                                        value: "Pacific/Kanton",
                                        label: "(GMT+13:00) Phoenix Islands Time (Pacific/Kanton)",
                                    },
                                    {
                                        value: "Pacific/Tongatapu",
                                        label: "(GMT+13:00) Tonga Standard Time (Pacific/Tongatapu)",
                                    },
                                    {
                                        value: "Pacific/Chatham",
                                        label: "(GMT+12:45) Chatham Standard Time (Pacific/Chatham)",
                                    },
                                    {
                                        value: "Antarctica/McMurdo",
                                        label: "(GMT+12:00) New Zealand Standard Time (Antarctica/McMurdo)",
                                    },
                                    {
                                        value: "Asia/Anadyr",
                                        label: "(GMT+12:00) Anadyr Standard Time (Asia/Anadyr)",
                                    },
                                    {
                                        value: "Asia/Kamchatka",
                                        label: "(GMT+12:00) Petropavlovsk-Kamchatski Standard Time (Asia/Kamchatka)",
                                    },
                                    {
                                        value: "Pacific/Auckland",
                                        label: "(GMT+12:00) New Zealand Standard Time (Pacific/Auckland)",
                                    },
                                    {
                                        value: "Pacific/Fiji",
                                        label: "(GMT+12:00) Fiji Standard Time (Pacific/Fiji)",
                                    },
                                    {
                                        value: "Pacific/Funafuti",
                                        label: "(GMT+12:00) Tuvalu Time (Pacific/Funafuti)",
                                    },
                                    {
                                        value: "Pacific/Kwajalein",
                                        label: "(GMT+12:00) Marshall Islands Time (Pacific/Kwajalein)",
                                    },
                                    {
                                        value: "Pacific/Majuro",
                                        label: "(GMT+12:00) Marshall Islands Time (Pacific/Majuro)",
                                    },
                                    {
                                        value: "Pacific/Nauru",
                                        label: "(GMT+12:00) Nauru Time (Pacific/Nauru)",
                                    },
                                    {
                                        value: "Pacific/Tarawa",
                                        label: "(GMT+12:00) Gilbert Islands Time (Pacific/Tarawa)",
                                    },
                                    {
                                        value: "Pacific/Wake",
                                        label: "(GMT+12:00) Wake Island Time (Pacific/Wake)",
                                    },
                                    {
                                        value: "Pacific/Wallis",
                                        label: "(GMT+12:00) Wallis & Futuna Time (Pacific/Wallis)",
                                    },
                                    {
                                        value: "Asia/Magadan",
                                        label: "(GMT+11:00) Magadan Standard Time (Asia/Magadan)",
                                    },
                                    {
                                        value: "Asia/Sakhalin",
                                        label: "(GMT+11:00) Sakhalin Standard Time (Asia/Sakhalin)",
                                    },
                                    {
                                        value: "Asia/Srednekolymsk",
                                        label: "(GMT+11:00) Magadan Standard Time (Asia/Srednekolymsk)",
                                    },
                                    {
                                        value: "Pacific/Bougainville",
                                        label: "(GMT+11:00) Bougainville Standard Time (Pacific/Bougainville)",
                                    },
                                    {
                                        value: "Pacific/Efate",
                                        label: "(GMT+11:00) Vanuatu Standard Time (Pacific/Efate)",
                                    },
                                    {
                                        value: "Pacific/Guadalcanal",
                                        label: "(GMT+11:00) Solomon Islands Time (Pacific/Guadalcanal)",
                                    },
                                    {
                                        value: "Pacific/Kosrae",
                                        label: "(GMT+11:00) Kosrae Time (Pacific/Kosrae)",
                                    },
                                    {
                                        value: "Pacific/Norfolk",
                                        label: "(GMT+11:00) Norfolk Island Standard Time (Pacific/Norfolk)",
                                    },
                                    {
                                        value: "Pacific/Noumea",
                                        label: "(GMT+11:00) New Caledonia Standard Time (Pacific/Noumea)",
                                    },
                                    {
                                        value: "Pacific/Pohnpei",
                                        label: "(GMT+11:00) Ponape Time (Pacific/Pohnpei)",
                                    },
                                    {
                                        value: "Australia/Lord_Howe",
                                        label: "(GMT+10:30) Lord Howe Standard Time (Australia/Lord_Howe)",
                                    },
                                    {
                                        value: "Antarctica/DumontDUrville",
                                        label: "(GMT+10:00) Dumont-d’Urville Time (Antarctica/DumontDUrville)",
                                    },
                                    {
                                        value: "Antarctica/Macquarie",
                                        label: "(GMT+10:00) Australian Eastern Standard Time (Antarctica/Macquarie)",
                                    },
                                    {
                                        value: "Asia/Ust-Nera",
                                        label: "(GMT+10:00) Vladivostok Standard Time (Asia/Ust-Nera)",
                                    },
                                    {
                                        value: "Asia/Vladivostok",
                                        label: "(GMT+10:00) Vladivostok Standard Time (Asia/Vladivostok)",
                                    },
                                    {
                                        value: "Australia/Brisbane",
                                        label: "(GMT+10:00) Australian Eastern Standard Time (Australia/Brisbane)",
                                    },
                                    {
                                        value: "Australia/Currie",
                                        label: "(GMT+10:00) Australian Eastern Standard Time (Australia/Currie)",
                                    },
                                    {
                                        value: "Australia/Hobart",
                                        label: "(GMT+10:00) Australian Eastern Standard Time (Australia/Hobart)",
                                    },
                                    {
                                        value: "Australia/Lindeman",
                                        label: "(GMT+10:00) Australian Eastern Standard Time (Australia/Lindeman)",
                                    },
                                    {
                                        value: "Australia/Melbourne",
                                        label: "(GMT+10:00) Australian Eastern Standard Time (Australia/Melbourne)",
                                    },
                                    {
                                        value: "Australia/Sydney",
                                        label: "(GMT+10:00) Australian Eastern Standard Time (Australia/Sydney)",
                                    },
                                    {
                                        value: "Pacific/Guam",
                                        label: "(GMT+10:00) Chamorro Standard Time (Pacific/Guam)",
                                    },
                                    {
                                        value: "Pacific/Port_Moresby",
                                        label: "(GMT+10:00) Papua New Guinea Time (Pacific/Port_Moresby)",
                                    },
                                    {
                                        value: "Pacific/Saipan",
                                        label: "(GMT+10:00) Chamorro Standard Time (Pacific/Saipan)",
                                    },
                                    {
                                        value: "Pacific/Truk",
                                        label: "(GMT+10:00) Chuuk Time (Pacific/Truk)",
                                    },
                                    {
                                        value: "Australia/Adelaide",
                                        label: "(GMT+09:30) Australian Central Standard Time (Australia/Adelaide)",
                                    },
                                    {
                                        value: "Australia/Broken_Hill",
                                        label: "(GMT+09:30) Australian Central Standard Time (Australia/Broken_Hill)",
                                    },
                                    {
                                        value: "Australia/Darwin",
                                        label: "(GMT+09:30) Australian Central Standard Time (Australia/Darwin)",
                                    },
                                    {
                                        value: "Asia/Chita",
                                        label: "(GMT+09:00) Yakutsk Standard Time (Asia/Chita)",
                                    },
                                    {
                                        value: "Asia/Dili",
                                        label: "(GMT+09:00) East Timor Time (Asia/Dili)",
                                    },
                                    {
                                        value: "Asia/Jayapura",
                                        label: "(GMT+09:00) Eastern Indonesia Time (Asia/Jayapura)",
                                    },
                                    {
                                        value: "Asia/Khandyga",
                                        label: "(GMT+09:00) Yakutsk Standard Time (Asia/Khandyga)",
                                    },
                                    {
                                        value: "Asia/Seoul",
                                        label: "(GMT+09:00) Korean Standard Time (Asia/Seoul)",
                                    },
                                    {
                                        value: "Asia/Tokyo",
                                        label: "(GMT+09:00) Japan Standard Time (Asia/Tokyo)",
                                    },
                                    {
                                        value: "Asia/Yakutsk",
                                        label: "(GMT+09:00) Yakutsk Standard Time (Asia/Yakutsk)",
                                    },
                                    {
                                        value: "Pacific/Palau",
                                        label: "(GMT+09:00) Palau Time (Pacific/Palau)",
                                    },
                                    {
                                        value: "Australia/Eucla",
                                        label: "(GMT+08:45) Australian Central Western Standard Time (Australia/Eucla)",
                                    },
                                    {
                                        value: "Antarctica/Casey",
                                        label: "(GMT+08:00) Casey Time (Antarctica/Casey)",
                                    },
                                    {
                                        value: "Asia/Brunei",
                                        label: "(GMT+08:00) Brunei Darussalam Time (Asia/Brunei)",
                                    },
                                    {
                                        value: "Asia/Choibalsan",
                                        label: "(GMT+08:00) Ulaanbaatar Standard Time (Asia/Choibalsan)",
                                    },
                                    {
                                        value: "Asia/Hong_Kong",
                                        label: "(GMT+08:00) Hong Kong Standard Time (Asia/Hong_Kong)",
                                    },
                                    {
                                        value: "Asia/Irkutsk",
                                        label: "(GMT+08:00) Irkutsk Standard Time (Asia/Irkutsk)",
                                    },
                                    {
                                        value: "Asia/Kuala_Lumpur",
                                        label: "(GMT+08:00) Malaysia Time (Asia/Kuala_Lumpur)",
                                    },
                                    {
                                        value: "Asia/Kuching",
                                        label: "(GMT+08:00) Malaysia Time (Asia/Kuching)",
                                    },
                                    {
                                        value: "Asia/Macau",
                                        label: "(GMT+08:00) China Standard Time (Asia/Macau)",
                                    },
                                    {
                                        value: "Asia/Makassar",
                                        label: "(GMT+08:00) Central Indonesia Time (Asia/Makassar)",
                                    },
                                    {
                                        value: "Asia/Manila",
                                        label: "(GMT+08:00) Philippine Standard Time (Asia/Manila)",
                                    },
                                    {
                                        value: "Asia/Shanghai",
                                        label: "(GMT+08:00) China Standard Time (Asia/Shanghai)",
                                    },
                                    {
                                        value: "Asia/Singapore",
                                        label: "(GMT+08:00) Singapore Standard Time (Asia/Singapore)",
                                    },
                                    {
                                        value: "Asia/Taipei",
                                        label: "(GMT+08:00) Taipei Standard Time (Asia/Taipei)",
                                    },
                                    {
                                        value: "Asia/Ulaanbaatar",
                                        label: "(GMT+08:00) Ulaanbaatar Standard Time (Asia/Ulaanbaatar)",
                                    },
                                    {
                                        value: "Australia/Perth",
                                        label: "(GMT+08:00) Australian Western Standard Time (Australia/Perth)",
                                    },
                                    {
                                        value: "Antarctica/Davis",
                                        label: "(GMT+07:00) Davis Time (Antarctica/Davis)",
                                    },
                                    {
                                        value: "Asia/Bangkok",
                                        label: "(GMT+07:00) Indochina Time (Asia/Bangkok)",
                                    },
                                    {
                                        value: "Asia/Barnaul",
                                        label: "(GMT+07:00) Moscow Standard Time + 4 (Asia/Barnaul)",
                                    },
                                    {
                                        value: "Asia/Ho_Chi_Minh",
                                        label: "(GMT+07:00) Indochina Time (Asia/Ho_Chi_Minh)",
                                    },
                                    {
                                        value: "Asia/Hovd",
                                        label: "(GMT+07:00) Hovd Standard Time (Asia/Hovd)",
                                    },
                                    {
                                        value: "Asia/Jakarta",
                                        label: "(GMT+07:00) Western Indonesia Time (Asia/Jakarta)",
                                    },
                                    {
                                        value: "Asia/Krasnoyarsk",
                                        label: "(GMT+07:00) Krasnoyarsk Standard Time (Asia/Krasnoyarsk)",
                                    },
                                    {
                                        value: "Asia/Novokuznetsk",
                                        label: "(GMT+07:00) Krasnoyarsk Standard Time (Asia/Novokuznetsk)",
                                    },
                                    {
                                        value: "Asia/Novosibirsk",
                                        label: "(GMT+07:00) Novosibirsk Standard Time (Asia/Novosibirsk)",
                                    },
                                    {
                                        value: "Asia/Phnom_Penh",
                                        label: "(GMT+07:00) Indochina Time (Asia/Phnom_Penh)",
                                    },
                                    {
                                        value: "Asia/Pontianak",
                                        label: "(GMT+07:00) Western Indonesia Time (Asia/Pontianak)",
                                    },
                                    {
                                        value: "Asia/Tomsk",
                                        label: "(GMT+07:00) Moscow Standard Time + 4 (Asia/Tomsk)",
                                    },
                                    {
                                        value: "Asia/Vientiane",
                                        label: "(GMT+07:00) Indochina Time (Asia/Vientiane)",
                                    },
                                    {
                                        value: "Indian/Christmas",
                                        label: "(GMT+07:00) Christmas Island Time (Indian/Christmas)",
                                    },
                                    {
                                        value: "Asia/Yangon",
                                        label: "(GMT+06:30) Myanmar Time (Asia/Yangon)",
                                    },
                                    {
                                        value: "Indian/Cocos",
                                        label: "(GMT+06:30) Cocos Islands Time (Indian/Cocos)",
                                    },
                                    {
                                        value: "Asia/Bishkek",
                                        label: "(GMT+06:00) Kyrgyzstan Time (Asia/Bishkek)",
                                    },
                                    {
                                        value: "Asia/Dhaka",
                                        label: "(GMT+06:00) Bangladesh Standard Time (Asia/Dhaka)",
                                    },
                                    {
                                        value: "Asia/Omsk",
                                        label: "(GMT+06:00) Omsk Standard Time (Asia/Omsk)",
                                    },
                                    {
                                        value: "Asia/Thimphu",
                                        label: "(GMT+06:00) Bhutan Time (Asia/Thimphu)",
                                    },
                                    {
                                        value: "Asia/Urumqi",
                                        label: "(GMT+06:00) China Standard Time (Asia/Urumqi)",
                                    },
                                    {
                                        value: "Indian/Chagos",
                                        label: "(GMT+06:00) Indian Ocean Time (Indian/Chagos)",
                                    },
                                    {
                                        value: "Asia/Kathmandu",
                                        label: "(GMT+05:45) Nepal Time (Asia/Kathmandu)",
                                    },
                                    {
                                        value: "Asia/Colombo",
                                        label: "(GMT+05:30) India Standard Time (Asia/Colombo)",
                                    },
                                    {
                                        value: "Asia/Kolkata",
                                        label: "(GMT+05:30) India Standard Time (Asia/Kolkata)",
                                    },
                                    {
                                        value: "Antarctica/Mawson",
                                        label: "(GMT+05:00) Mawson Time (Antarctica/Mawson)",
                                    },
                                    {
                                        value: "Antarctica/Vostok",
                                        label: "(GMT+05:00) Vostok Time (Antarctica/Vostok)",
                                    },
                                    {
                                        value: "Asia/Almaty",
                                        label: "(GMT+05:00) East Kazakhstan Time (Asia/Almaty)",
                                    },
                                    {
                                        value: "Asia/Aqtau",
                                        label: "(GMT+05:00) West Kazakhstan Time (Asia/Aqtau)",
                                    },
                                    {
                                        value: "Asia/Aqtobe",
                                        label: "(GMT+05:00) West Kazakhstan Time (Asia/Aqtobe)",
                                    },
                                    {
                                        value: "Asia/Ashgabat",
                                        label: "(GMT+05:00) Turkmenistan Standard Time (Asia/Ashgabat)",
                                    },
                                    {
                                        value: "Asia/Atyrau",
                                        label: "(GMT+05:00) West Kazakhstan Time (Asia/Atyrau)",
                                    },
                                    {
                                        value: "Asia/Dushanbe",
                                        label: "(GMT+05:00) Tajikistan Time (Asia/Dushanbe)",
                                    },
                                    {
                                        value: "Asia/Karachi",
                                        label: "(GMT+05:00) Pakistan Standard Time (Asia/Karachi)",
                                    },
                                    {
                                        value: "Asia/Oral",
                                        label: "(GMT+05:00) West Kazakhstan Time (Asia/Oral)",
                                    },
                                    {
                                        value: "Asia/Qostanay",
                                        label: "(GMT+05:00) East Kazakhstan Time (Asia/Qostanay)",
                                    },
                                    {
                                        value: "Asia/Qyzylorda",
                                        label: "(GMT+05:00) West Kazakhstan Time (Asia/Qyzylorda)",
                                    },
                                    {
                                        value: "Asia/Samarkand",
                                        label: "(GMT+05:00) Uzbekistan Standard Time (Asia/Samarkand)",
                                    },
                                    {
                                        value: "Asia/Tashkent",
                                        label: "(GMT+05:00) Uzbekistan Standard Time (Asia/Tashkent)",
                                    },
                                    {
                                        value: "Asia/Yekaterinburg",
                                        label: "(GMT+05:00) Yekaterinburg Standard Time (Asia/Yekaterinburg)",
                                    },
                                    {
                                        value: "Indian/Kerguelen",
                                        label: "(GMT+05:00) French Southern & Antarctic Time (Indian/Kerguelen)",
                                    },
                                    {
                                        value: "Indian/Maldives",
                                        label: "(GMT+05:00) Maldives Time (Indian/Maldives)",
                                    },
                                    {
                                        value: "Asia/Kabul",
                                        label: "(GMT+04:30) Afghanistan Time (Asia/Kabul)",
                                    },
                                    {
                                        value: "Asia/Baku",
                                        label: "(GMT+04:00) Azerbaijan Standard Time (Asia/Baku)",
                                    },
                                    {
                                        value: "Asia/Dubai",
                                        label: "(GMT+04:00) Gulf Standard Time (Asia/Dubai)",
                                    },
                                    {
                                        value: "Asia/Muscat",
                                        label: "(GMT+04:00) Gulf Standard Time (Asia/Muscat)",
                                    },
                                    {
                                        value: "Asia/Tbilisi",
                                        label: "(GMT+04:00) Georgia Standard Time (Asia/Tbilisi)",
                                    },
                                    {
                                        value: "Asia/Yerevan",
                                        label: "(GMT+04:00) Armenia Standard Time (Asia/Yerevan)",
                                    },
                                    {
                                        value: "Europe/Astrakhan",
                                        label: "(GMT+04:00) Samara Standard Time (Europe/Astrakhan)",
                                    },
                                    {
                                        value: "Europe/Samara",
                                        label: "(GMT+04:00) Samara Standard Time (Europe/Samara)",
                                    },
                                    {
                                        value: "Europe/Saratov",
                                        label: "(GMT+04:00) Moscow Standard Time + 1 (Europe/Saratov)",
                                    },
                                    {
                                        value: "Europe/Ulyanovsk",
                                        label: "(GMT+04:00) Moscow Standard Time + 1 (Europe/Ulyanovsk)",
                                    },
                                    {
                                        value: "Indian/Mahe",
                                        label: "(GMT+04:00) Seychelles Time (Indian/Mahe)",
                                    },
                                    {
                                        value: "Indian/Mauritius",
                                        label: "(GMT+04:00) Mauritius Standard Time (Indian/Mauritius)",
                                    },
                                    {
                                        value: "Indian/Reunion",
                                        label: "(GMT+04:00) Réunion Time (Indian/Reunion)",
                                    },
                                    {
                                        value: "Africa/Addis_Ababa",
                                        label: "(GMT+03:00) East Africa Time (Africa/Addis_Ababa)",
                                    },
                                    {
                                        value: "Africa/Asmera",
                                        label: "(GMT+03:00) East Africa Time (Africa/Asmera)",
                                    },
                                    {
                                        value: "Africa/Cairo",
                                        label: "(GMT+03:00) Eastern European Standard Time (Africa/Cairo)",
                                    },
                                    {
                                        value: "Africa/Dar_es_Salaam",
                                        label: "(GMT+03:00) East Africa Time (Africa/Dar_es_Salaam)",
                                    },
                                    {
                                        value: "Africa/Djibouti",
                                        label: "(GMT+03:00) East Africa Time (Africa/Djibouti)",
                                    },
                                    {
                                        value: "Africa/Kampala",
                                        label: "(GMT+03:00) East Africa Time (Africa/Kampala)",
                                    },
                                    {
                                        value: "Africa/Mogadishu",
                                        label: "(GMT+03:00) East Africa Time (Africa/Mogadishu)",
                                    },
                                    {
                                        value: "Africa/Nairobi",
                                        label: "(GMT+03:00) East Africa Time (Africa/Nairobi)",
                                    },
                                    {
                                        value: "Antarctica/Syowa",
                                        label: "(GMT+03:00) Syowa Time (Antarctica/Syowa)",
                                    },
                                    {
                                        value: "Asia/Aden",
                                        label: "(GMT+03:00) Arabian Standard Time (Asia/Aden)",
                                    },
                                    {
                                        value: "Asia/Amman",
                                        label: "(GMT+03:00) Eastern European Standard Time (Asia/Amman)",
                                    },
                                    {
                                        value: "Asia/Baghdad",
                                        label: "(GMT+03:00) Arabian Standard Time (Asia/Baghdad)",
                                    },
                                    {
                                        value: "Asia/Bahrain",
                                        label: "(GMT+03:00) Arabian Standard Time (Asia/Bahrain)",
                                    },
                                    {
                                        value: "Asia/Beirut",
                                        label: "(GMT+03:00) Eastern European Summer Time (Asia/Beirut)",
                                    },
                                    {
                                        value: "Asia/Famagusta",
                                        label: "(GMT+03:00) Eastern European Summer Time (Asia/Famagusta)",
                                    },
                                    {
                                        value: "Asia/Gaza",
                                        label: "(GMT+03:00) Eastern European Summer Time (Asia/Gaza)",
                                    },
                                    {
                                        value: "Asia/Hebron",
                                        label: "(GMT+03:00) Eastern European Summer Time (Asia/Hebron)",
                                    },
                                    {
                                        value: "Asia/Jerusalem",
                                        label: "(GMT+03:00) Israel Daylight Time (Asia/Jerusalem)",
                                    },
                                    {
                                        value: "Asia/Kuwait",
                                        label: "(GMT+03:00) Arabian Standard Time (Asia/Kuwait)",
                                    },
                                    {
                                        value: "Asia/Nicosia",
                                        label: "(GMT+03:00) Eastern European Summer Time (Asia/Nicosia)",
                                    },
                                    {
                                        value: "Asia/Qatar",
                                        label: "(GMT+03:00) Arabian Standard Time (Asia/Qatar)",
                                    },
                                    {
                                        value: "Asia/Riyadh",
                                        label: "(GMT+03:00) Arabian Standard Time (Asia/Riyadh)",
                                    },
                                    {
                                        value: "Europe/Athens",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Athens)",
                                    },
                                    {
                                        value: "Europe/Bucharest",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Bucharest)",
                                    },
                                    {
                                        value: "Europe/Chisinau",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Chisinau)",
                                    },
                                    {
                                        value: "Europe/Helsinki",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Helsinki)",
                                    },
                                    {
                                        value: "Europe/Istanbul",
                                        label: "(GMT+03:00) Eastern European Standard Time (Europe/Istanbul)",
                                    },
                                    {
                                        value: "Europe/Kirov",
                                        label: "(GMT+03:00) Moscow Standard Time (Europe/Kirov)",
                                    },
                                    {
                                        value: "Europe/Kyiv",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Kyiv)",
                                    },
                                    {
                                        value: "Europe/Mariehamn",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Mariehamn)",
                                    },
                                    {
                                        value: "Europe/Minsk",
                                        label: "(GMT+03:00) Moscow Standard Time (Europe/Minsk)",
                                    },
                                    {
                                        value: "Europe/Moscow",
                                        label: "(GMT+03:00) Moscow Standard Time (Europe/Moscow)",
                                    },
                                    {
                                        value: "Europe/Riga",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Riga)",
                                    },
                                    {
                                        value: "Europe/Sofia",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Sofia)",
                                    },
                                    {
                                        value: "Europe/Tallinn",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Tallinn)",
                                    },
                                    {
                                        value: "Europe/Uzhgorod",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Uzhgorod)",
                                    },
                                    {
                                        value: "Europe/Vilnius",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Vilnius)",
                                    },
                                    {
                                        value: "Europe/Volgograd",
                                        label: "(GMT+03:00) Volgograd Standard Time (Europe/Volgograd)",
                                    },
                                    {
                                        value: "Europe/Zaporozhye",
                                        label: "(GMT+03:00) Eastern European Summer Time (Europe/Zaporozhye)",
                                    },
                                    {
                                        value: "Indian/Antananarivo",
                                        label: "(GMT+03:00) East Africa Time (Indian/Antananarivo)",
                                    },
                                    {
                                        value: "Indian/Comoro",
                                        label: "(GMT+03:00) East Africa Time (Indian/Comoro)",
                                    },
                                    {
                                        value: "Indian/Mayotte",
                                        label: "(GMT+03:00) East Africa Time (Indian/Mayotte)",
                                    },
                                    {
                                        value: "Africa/Blantyre",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Blantyre)",
                                    },
                                    {
                                        value: "Africa/Bujumbura",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Bujumbura)",
                                    },
                                    {
                                        value: "Africa/Ceuta",
                                        label: "(GMT+02:00) Central European Summer Time (Africa/Ceuta)",
                                    },
                                    {
                                        value: "Africa/Gaborone",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Gaborone)",
                                    },
                                    {
                                        value: "Africa/Harare",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Harare)",
                                    },
                                    {
                                        value: "Africa/Johannesburg",
                                        label: "(GMT+02:00) South Africa Standard Time (Africa/Johannesburg)",
                                    },
                                    {
                                        value: "Africa/Juba",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Juba)",
                                    },
                                    {
                                        value: "Africa/Khartoum",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Khartoum)",
                                    },
                                    {
                                        value: "Africa/Kigali",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Kigali)",
                                    },
                                    {
                                        value: "Africa/Lubumbashi",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Lubumbashi)",
                                    },
                                    {
                                        value: "Africa/Lusaka",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Lusaka)",
                                    },
                                    {
                                        value: "Africa/Maputo",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Maputo)",
                                    },
                                    {
                                        value: "Africa/Maseru",
                                        label: "(GMT+02:00) South Africa Standard Time (Africa/Maseru)",
                                    },
                                    {
                                        value: "Africa/Mbabane",
                                        label: "(GMT+02:00) South Africa Standard Time (Africa/Mbabane)",
                                    },
                                    {
                                        value: "Africa/Tripoli",
                                        label: "(GMT+02:00) Eastern European Standard Time (Africa/Tripoli)",
                                    },
                                    {
                                        value: "Africa/Windhoek",
                                        label: "(GMT+02:00) Central Africa Time (Africa/Windhoek)",
                                    },
                                    {
                                        value: "Antarctica/Troll",
                                        label: "(GMT+02:00) Central European Summer Time (Antarctica/Troll)",
                                    },
                                    {
                                        value: "Arctic/Longyearbyen",
                                        label: "(GMT+02:00) Central European Summer Time (Arctic/Longyearbyen)",
                                    },
                                    {
                                        value: "Europe/Amsterdam",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Amsterdam)",
                                    },
                                    {
                                        value: "Europe/Andorra",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Andorra)",
                                    },
                                    {
                                        value: "Europe/Belgrade",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Belgrade)",
                                    },
                                    {
                                        value: "Europe/Berlin",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Berlin)",
                                    },
                                    {
                                        value: "Europe/Bratislava",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Bratislava)",
                                    },
                                    {
                                        value: "Europe/Brussels",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Brussels)",
                                    },
                                    {
                                        value: "Europe/Budapest",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Budapest)",
                                    },
                                    {
                                        value: "Europe/Busingen",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Busingen)",
                                    },
                                    {
                                        value: "Europe/Copenhagen",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Copenhagen)",
                                    },
                                    {
                                        value: "Europe/Gibraltar",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Gibraltar)",
                                    },
                                    {
                                        value: "Europe/Kaliningrad",
                                        label: "(GMT+02:00) Eastern European Standard Time (Europe/Kaliningrad)",
                                    },
                                    {
                                        value: "Europe/Ljubljana",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Ljubljana)",
                                    },
                                    {
                                        value: "Europe/Luxembourg",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Luxembourg)",
                                    },
                                    {
                                        value: "Europe/Madrid",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Madrid)",
                                    },
                                    {
                                        value: "Europe/Malta",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Malta)",
                                    },
                                    {
                                        value: "Europe/Monaco",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Monaco)",
                                    },
                                    {
                                        value: "Europe/Oslo",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Oslo)",
                                    },
                                    {
                                        value: "Europe/Paris",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Paris)",
                                    },
                                    {
                                        value: "Europe/Podgorica",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Podgorica)",
                                    },
                                    {
                                        value: "Europe/Prague",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Prague)",
                                    },
                                    {
                                        value: "Europe/Rome",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Rome)",
                                    },
                                    {
                                        value: "Europe/San_Marino",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/San_Marino)",
                                    },
                                    {
                                        value: "Europe/Sarajevo",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Sarajevo)",
                                    },
                                    {
                                        value: "Europe/Skopje",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Skopje)",
                                    },
                                    {
                                        value: "Europe/Stockholm",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Stockholm)",
                                    },
                                    {
                                        value: "Europe/Tirane",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Tirane)",
                                    },
                                    {
                                        value: "Europe/Vaduz",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Vaduz)",
                                    },
                                    {
                                        value: "Europe/Vatican",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Vatican)",
                                    },
                                    {
                                        value: "Europe/Vienna",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Vienna)",
                                    },
                                    {
                                        value: "Europe/Warsaw",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Warsaw)",
                                    },
                                    {
                                        value: "Europe/Zagreb",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Zagreb)",
                                    },
                                    {
                                        value: "Europe/Zurich",
                                        label: "(GMT+02:00) Central European Summer Time (Europe/Zurich)",
                                    },
                                    {
                                        value: "Africa/Algiers",
                                        label: "(GMT+01:00) Central European Standard Time (Africa/Algiers)",
                                    },
                                    {
                                        value: "Africa/Bangui",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Bangui)",
                                    },
                                    {
                                        value: "Africa/Brazzaville",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Brazzaville)",
                                    },
                                    {
                                        value: "Africa/Casablanca",
                                        label: "(GMT+01:00) Western European Summer Time (Africa/Casablanca)",
                                    },
                                    {
                                        value: "Africa/Douala",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Douala)",
                                    },
                                    {
                                        value: "Africa/El_Aaiun",
                                        label: "(GMT+01:00) Western European Summer Time (Africa/El_Aaiun)",
                                    },
                                    {
                                        value: "Africa/Kinshasa",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Kinshasa)",
                                    },
                                    {
                                        value: "Africa/Lagos",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Lagos)",
                                    },
                                    {
                                        value: "Africa/Libreville",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Libreville)",
                                    },
                                    {
                                        value: "Africa/Luanda",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Luanda)",
                                    },
                                    {
                                        value: "Africa/Malabo",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Malabo)",
                                    },
                                    {
                                        value: "Africa/Ndjamena",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Ndjamena)",
                                    },
                                    {
                                        value: "Africa/Niamey",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Niamey)",
                                    },
                                    {
                                        value: "Africa/Porto-Novo",
                                        label: "(GMT+01:00) West Africa Standard Time (Africa/Porto-Novo)",
                                    },
                                    {
                                        value: "Africa/Tunis",
                                        label: "(GMT+01:00) Central European Standard Time (Africa/Tunis)",
                                    },
                                    {
                                        value: "Atlantic/Canary",
                                        label: "(GMT+01:00) Western European Summer Time (Atlantic/Canary)",
                                    },
                                    {
                                        value: "Atlantic/Faroe",
                                        label: "(GMT+01:00) Western European Summer Time (Atlantic/Faroe)",
                                    },
                                    {
                                        value: "Atlantic/Madeira",
                                        label: "(GMT+01:00) Western European Summer Time (Atlantic/Madeira)",
                                    },
                                    {
                                        value: "Europe/Dublin",
                                        label: "(GMT+01:00) Irish Standard Time (Europe/Dublin)",
                                    },
                                    {
                                        value: "Europe/Guernsey",
                                        label: "(GMT+01:00) British Summer Time (Europe/Guernsey)",
                                    },
                                    {
                                        value: "Europe/Isle_of_Man",
                                        label: "(GMT+01:00) British Summer Time (Europe/Isle_of_Man)",
                                    },
                                    {
                                        value: "Europe/Jersey",
                                        label: "(GMT+01:00) British Summer Time (Europe/Jersey)",
                                    },
                                    {
                                        value: "Europe/Lisbon",
                                        label: "(GMT+01:00) Western European Summer Time (Europe/Lisbon)",
                                    },
                                    {
                                        value: "Europe/London",
                                        label: "(GMT+01:00) British Summer Time (Europe/London)",
                                    },
                                    {
                                        value: "Africa/Abidjan",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Abidjan)",
                                    },
                                    {
                                        value: "Africa/Accra",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Accra)",
                                    },
                                    {
                                        value: "Africa/Bamako",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Bamako)",
                                    },
                                    {
                                        value: "Africa/Banjul",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Banjul)",
                                    },
                                    {
                                        value: "Africa/Bissau",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Bissau)",
                                    },
                                    {
                                        value: "Africa/Conakry",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Conakry)",
                                    },
                                    {
                                        value: "Africa/Dakar",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Dakar)",
                                    },
                                    {
                                        value: "Africa/Freetown",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Freetown)",
                                    },
                                    {
                                        value: "Africa/Lome",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Lome)",
                                    },
                                    {
                                        value: "Africa/Monrovia",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Monrovia)",
                                    },
                                    {
                                        value: "Africa/Nouakchott",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Nouakchott)",
                                    },
                                    {
                                        value: "Africa/Ouagadougou",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Ouagadougou)",
                                    },
                                    {
                                        value: "Africa/Sao_Tome",
                                        label: "(GMT+00:00) Greenwich Mean Time (Africa/Sao_Tome)",
                                    },
                                    {
                                        value: "America/Danmarkshavn",
                                        label: "(GMT+00:00) Greenwich Mean Time (America/Danmarkshavn)",
                                    },
                                    {
                                        value: "Atlantic/Azores",
                                        label: "(GMT+00:00) Azores Summer Time (Atlantic/Azores)",
                                    },
                                    {
                                        value: "Atlantic/Reykjavik",
                                        label: "(GMT+00:00) Greenwich Mean Time (Atlantic/Reykjavik)",
                                    },
                                    {
                                        value: "Atlantic/St_Helena",
                                        label: "(GMT+00:00) Greenwich Mean Time (Atlantic/St_Helena)",
                                    },
                                    {
                                        value: "GMT",
                                        label: "(GMT+00:00) Greenwich Mean Time (GMT)",
                                    },
                                    {
                                        value: "America/Nuuk",
                                        label: "(GMT-01:00) West Greenland Summer Time (America/Nuuk)",
                                    },
                                    {
                                        value: "America/Scoresbysund",
                                        label: "(GMT-01:00) East Greenland Summer Time (America/Scoresbysund)",
                                    },
                                    {
                                        value: "Atlantic/Cape_Verde",
                                        label: "(GMT-01:00) Cape Verde Standard Time (Atlantic/Cape_Verde)",
                                    },
                                    {
                                        value: "America/Miquelon",
                                        label: "(GMT-02:00) St Pierre & Miquelon Daylight Time (America/Miquelon)",
                                    },
                                    {
                                        value: "America/Noronha",
                                        label: "(GMT-02:00) Fernando de Noronha Standard Time (America/Noronha)",
                                    },
                                    {
                                        value: "Atlantic/South_Georgia",
                                        label: "(GMT-02:00) South Georgia Time (Atlantic/South_Georgia)",
                                    },
                                    {
                                        value: "America/St_Johns",
                                        label: "(GMT-02:30) Newfoundland Daylight Time (America/St_Johns)",
                                    },
                                    {
                                        value: "America/Araguaina",
                                        label: "(GMT-03:00) Brasilia Standard Time (America/Araguaina)",
                                    },
                                    {
                                        value: "America/Argentina/Buenos_Aires",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Buenos_Aires)",
                                    },
                                    {
                                        value: "America/Argentina/Catamarca",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Catamarca)",
                                    },
                                    {
                                        value: "America/Argentina/Cordoba",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Cordoba)",
                                    },
                                    {
                                        value: "America/Argentina/Jujuy",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Jujuy)",
                                    },
                                    {
                                        value: "America/Argentina/La_Rioja",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/La_Rioja)",
                                    },
                                    {
                                        value: "America/Argentina/Mendoza",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Mendoza)",
                                    },
                                    {
                                        value: "America/Argentina/Rio_Gallegos",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Rio_Gallegos)",
                                    },
                                    {
                                        value: "America/Argentina/Salta",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Salta)",
                                    },
                                    {
                                        value: "America/Argentina/San_Juan",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/San_Juan)",
                                    },
                                    {
                                        value: "America/Argentina/San_Luis",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/San_Luis)",
                                    },
                                    {
                                        value: "America/Argentina/Tucuman",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Tucuman)",
                                    },
                                    {
                                        value: "America/Argentina/Ushuaia",
                                        label: "(GMT-03:00) Argentina Standard Time (America/Argentina/Ushuaia)",
                                    },
                                    {
                                        value: "America/Asuncion",
                                        label: "(GMT-03:00) Paraguay Standard Time (America/Asuncion)",
                                    },
                                    {
                                        value: "America/Bahia",
                                        label: "(GMT-03:00) Brasilia Standard Time (America/Bahia)",
                                    },
                                    {
                                        value: "America/Belem",
                                        label: "(GMT-03:00) Brasilia Standard Time (America/Belem)",
                                    },
                                    {
                                        value: "America/Cayenne",
                                        label: "(GMT-03:00) French Guiana Time (America/Cayenne)",
                                    },
                                    {
                                        value: "America/Fortaleza",
                                        label: "(GMT-03:00) Brasilia Standard Time (America/Fortaleza)",
                                    },
                                    {
                                        value: "America/Glace_Bay",
                                        label: "(GMT-03:00) Atlantic Daylight Time (America/Glace_Bay)",
                                    },
                                    {
                                        value: "America/Goose_Bay",
                                        label: "(GMT-03:00) Atlantic Daylight Time (America/Goose_Bay)",
                                    },
                                    {
                                        value: "America/Halifax",
                                        label: "(GMT-03:00) Atlantic Daylight Time (America/Halifax)",
                                    },
                                    {
                                        value: "America/Maceio",
                                        label: "(GMT-03:00) Brasilia Standard Time (America/Maceio)",
                                    },
                                    {
                                        value: "America/Moncton",
                                        label: "(GMT-03:00) Atlantic Daylight Time (America/Moncton)",
                                    },
                                    {
                                        value: "America/Montevideo",
                                        label: "(GMT-03:00) Uruguay Standard Time (America/Montevideo)",
                                    },
                                    {
                                        value: "America/Paramaribo",
                                        label: "(GMT-03:00) Suriname Time (America/Paramaribo)",
                                    },
                                    {
                                        value: "America/Punta_Arenas",
                                        label: "(GMT-03:00) Chile Standard Time (America/Punta_Arenas)",
                                    },
                                    {
                                        value: "America/Recife",
                                        label: "(GMT-03:00) Brasilia Standard Time (America/Recife)",
                                    },
                                    {
                                        value: "America/Santarem",
                                        label: "(GMT-03:00) Brasilia Standard Time (America/Santarem)",
                                    },
                                    {
                                        value: "America/Santiago",
                                        label: "(GMT-03:00) Chile Summer Time (America/Santiago)",
                                    },
                                    {
                                        value: "America/Sao_Paulo",
                                        label: "(GMT-03:00) Brasilia Standard Time (America/Sao_Paulo)",
                                    },
                                    {
                                        value: "America/Thule",
                                        label: "(GMT-03:00) Atlantic Daylight Time (America/Thule)",
                                    },
                                    {
                                        value: "Antarctica/Palmer",
                                        label: "(GMT-03:00) Chile Standard Time (Antarctica/Palmer)",
                                    },
                                    {
                                        value: "Antarctica/Rothera",
                                        label: "(GMT-03:00) Rothera Time (Antarctica/Rothera)",
                                    },
                                    {
                                        value: "Atlantic/Bermuda",
                                        label: "(GMT-03:00) Atlantic Daylight Time (Atlantic/Bermuda)",
                                    },
                                    {
                                        value: "Atlantic/Stanley",
                                        label: "(GMT-03:00) Falkland Islands Standard Time (Atlantic/Stanley)",
                                    },
                                    {
                                        value: "America/Anguilla",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Anguilla)",
                                    },
                                    {
                                        value: "America/Antigua",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Antigua)",
                                    },
                                    {
                                        value: "America/Aruba",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Aruba)",
                                    },
                                    {
                                        value: "America/Barbados",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Barbados)",
                                    },
                                    {
                                        value: "America/Blanc-Sablon",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Blanc-Sablon)",
                                    },
                                    {
                                        value: "America/Boa_Vista",
                                        label: "(GMT-04:00) Amazon Standard Time (America/Boa_Vista)",
                                    },
                                    {
                                        value: "America/Campo_Grande",
                                        label: "(GMT-04:00) Amazon Standard Time (America/Campo_Grande)",
                                    },
                                    {
                                        value: "America/Caracas",
                                        label: "(GMT-04:00) Venezuela Time (America/Caracas)",
                                    },
                                    {
                                        value: "America/Cuiaba",
                                        label: "(GMT-04:00) Amazon Standard Time (America/Cuiaba)",
                                    },
                                    {
                                        value: "America/Curacao",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Curacao)",
                                    },
                                    {
                                        value: "America/Detroit",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Detroit)",
                                    },
                                    {
                                        value: "America/Dominica",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Dominica)",
                                    },
                                    {
                                        value: "America/Grand_Turk",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Grand_Turk)",
                                    },
                                    {
                                        value: "America/Grenada",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Grenada)",
                                    },
                                    {
                                        value: "America/Guadeloupe",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Guadeloupe)",
                                    },
                                    {
                                        value: "America/Guyana",
                                        label: "(GMT-04:00) Guyana Time (America/Guyana)",
                                    },
                                    {
                                        value: "America/Indiana/Indianapolis",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Indiana/Indianapolis)",
                                    },
                                    {
                                        value: "America/Indiana/Marengo",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Indiana/Marengo)",
                                    },
                                    {
                                        value: "America/Indiana/Petersburg",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Indiana/Petersburg)",
                                    },
                                    {
                                        value: "America/Indiana/Vevay",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Indiana/Vevay)",
                                    },
                                    {
                                        value: "America/Indiana/Vincennes",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Indiana/Vincennes)",
                                    },
                                    {
                                        value: "America/Indiana/Winamac",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Indiana/Winamac)",
                                    },
                                    {
                                        value: "America/Iqaluit",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Iqaluit)",
                                    },
                                    {
                                        value: "America/Kentucky/Louisville",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Kentucky/Louisville)",
                                    },
                                    {
                                        value: "America/Kentucky/Monticello",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Kentucky/Monticello)",
                                    },
                                    {
                                        value: "America/Kralendijk",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Kralendijk)",
                                    },
                                    {
                                        value: "America/La_Paz",
                                        label: "(GMT-04:00) Bolivia Time (America/La_Paz)",
                                    },
                                    {
                                        value: "America/Lower_Princes",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Lower_Princes)",
                                    },
                                    {
                                        value: "America/Manaus",
                                        label: "(GMT-04:00) Amazon Standard Time (America/Manaus)",
                                    },
                                    {
                                        value: "America/Marigot",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Marigot)",
                                    },
                                    {
                                        value: "America/Martinique",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Martinique)",
                                    },
                                    {
                                        value: "America/Montreal",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Montreal)",
                                    },
                                    {
                                        value: "America/Montserrat",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Montserrat)",
                                    },
                                    {
                                        value: "America/Nassau",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Nassau)",
                                    },
                                    {
                                        value: "America/New_York",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/New_York)",
                                    },
                                    {
                                        value: "America/Nipigon",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Nipigon)",
                                    },
                                    {
                                        value: "America/Pangnirtung",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Pangnirtung)",
                                    },
                                    {
                                        value: "America/Port-au-Prince",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Port-au-Prince)",
                                    },
                                    {
                                        value: "America/Port_of_Spain",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Port_of_Spain)",
                                    },
                                    {
                                        value: "America/Porto_Velho",
                                        label: "(GMT-04:00) Amazon Standard Time (America/Porto_Velho)",
                                    },
                                    {
                                        value: "America/Puerto_Rico",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Puerto_Rico)",
                                    },
                                    {
                                        value: "America/Santo_Domingo",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Santo_Domingo)",
                                    },
                                    {
                                        value: "America/St_Barthelemy",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/St_Barthelemy)",
                                    },
                                    {
                                        value: "America/St_Kitts",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/St_Kitts)",
                                    },
                                    {
                                        value: "America/St_Lucia",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/St_Lucia)",
                                    },
                                    {
                                        value: "America/St_Thomas",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/St_Thomas)",
                                    },
                                    {
                                        value: "America/St_Vincent",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/St_Vincent)",
                                    },
                                    {
                                        value: "America/Thunder_Bay",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Thunder_Bay)",
                                    },
                                    {
                                        value: "America/Toronto",
                                        label: "(GMT-04:00) Eastern Daylight Time (America/Toronto)",
                                    },
                                    {
                                        value: "America/Tortola",
                                        label: "(GMT-04:00) Atlantic Standard Time (America/Tortola)",
                                    },
                                    {
                                        value: "America/Bogota",
                                        label: "(GMT-05:00) Colombia Standard Time (America/Bogota)",
                                    },
                                    {
                                        value: "America/Cancun",
                                        label: "(GMT-05:00) Eastern Standard Time (America/Cancun)",
                                    },
                                    {
                                        value: "America/Cayman",
                                        label: "(GMT-05:00) Eastern Standard Time (America/Cayman)",
                                    },
                                    {
                                        value: "America/Chicago",
                                        label: "(GMT-05:00) Central Daylight Time (America/Chicago)",
                                    },
                                    {
                                        value: "America/Coral_Harbour",
                                        label: "(GMT-05:00) Eastern Standard Time (America/Coral_Harbour)",
                                    },
                                    {
                                        value: "America/Eirunepe",
                                        label: "(GMT-05:00) Acre Standard Time (America/Eirunepe)",
                                    },
                                    {
                                        value: "America/Guayaquil",
                                        label: "(GMT-05:00) Ecuador Time (America/Guayaquil)",
                                    },
                                    {
                                        value: "America/Indiana/Knox",
                                        label: "(GMT-05:00) Central Daylight Time (America/Indiana/Knox)",
                                    },
                                    {
                                        value: "America/Indiana/Tell_City",
                                        label: "(GMT-05:00) Central Daylight Time (America/Indiana/Tell_City)",
                                    },
                                    {
                                        value: "America/Jamaica",
                                        label: "(GMT-05:00) Eastern Standard Time (America/Jamaica)",
                                    },
                                    {
                                        value: "America/Lima",
                                        label: "(GMT-05:00) Peru Standard Time (America/Lima)",
                                    },
                                    {
                                        value: "America/Matamoros",
                                        label: "(GMT-05:00) Central Daylight Time (America/Matamoros)",
                                    },
                                    {
                                        value: "America/Menominee",
                                        label: "(GMT-05:00) Central Daylight Time (America/Menominee)",
                                    },
                                    {
                                        value: "America/North_Dakota/Beulah",
                                        label: "(GMT-05:00) Central Daylight Time (America/North_Dakota/Beulah)",
                                    },
                                    {
                                        value: "America/North_Dakota/Center",
                                        label: "(GMT-05:00) Central Daylight Time (America/North_Dakota/Center)",
                                    },
                                    {
                                        value: "America/North_Dakota/New_Salem",
                                        label: "(GMT-05:00) Central Daylight Time (America/North_Dakota/New_Salem)",
                                    },
                                    {
                                        value: "America/Ojinaga",
                                        label: "(GMT-05:00) Central Daylight Time (America/Ojinaga)",
                                    },
                                    {
                                        value: "America/Panama",
                                        label: "(GMT-05:00) Eastern Standard Time (America/Panama)",
                                    },
                                    {
                                        value: "America/Rainy_River",
                                        label: "(GMT-05:00) Central Daylight Time (America/Rainy_River)",
                                    },
                                    {
                                        value: "America/Rankin_Inlet",
                                        label: "(GMT-05:00) Central Daylight Time (America/Rankin_Inlet)",
                                    },
                                    {
                                        value: "America/Resolute",
                                        label: "(GMT-05:00) Central Daylight Time (America/Resolute)",
                                    },
                                    {
                                        value: "America/Rio_Branco",
                                        label: "(GMT-05:00) Acre Standard Time (America/Rio_Branco)",
                                    },
                                    {
                                        value: "America/Winnipeg",
                                        label: "(GMT-05:00) Central Daylight Time (America/Winnipeg)",
                                    },
                                    {
                                        value: "Pacific/Easter",
                                        label: "(GMT-05:00) Easter Island Summer Time (Pacific/Easter)",
                                    },
                                    {
                                        value: "America/Bahia_Banderas",
                                        label: "(GMT-06:00) Central Standard Time (America/Bahia_Banderas)",
                                    },
                                    {
                                        value: "America/Belize",
                                        label: "(GMT-06:00) Central Standard Time (America/Belize)",
                                    },
                                    {
                                        value: "America/Boise",
                                        label: "(GMT-06:00) Mountain Daylight Time (America/Boise)",
                                    },
                                    {
                                        value: "America/Cambridge_Bay",
                                        label: "(GMT-06:00) Mountain Daylight Time (America/Cambridge_Bay)",
                                    },
                                    {
                                        value: "America/Chihuahua",
                                        label: "(GMT-06:00) Central Standard Time (America/Chihuahua)",
                                    },
                                    {
                                        value: "America/Costa_Rica",
                                        label: "(GMT-06:00) Central Standard Time (America/Costa_Rica)",
                                    },
                                    {
                                        value: "America/Denver",
                                        label: "(GMT-06:00) Mountain Daylight Time (America/Denver)",
                                    },
                                    {
                                        value: "America/Edmonton",
                                        label: "(GMT-06:00) Mountain Daylight Time (America/Edmonton)",
                                    },
                                    {
                                        value: "America/El_Salvador",
                                        label: "(GMT-06:00) Central Standard Time (America/El_Salvador)",
                                    },
                                    {
                                        value: "America/Guatemala",
                                        label: "(GMT-06:00) Central Standard Time (America/Guatemala)",
                                    },
                                    {
                                        value: "America/Inuvik",
                                        label: "(GMT-06:00) Mountain Daylight Time (America/Inuvik)",
                                    },
                                    {
                                        value: "America/Managua",
                                        label: "(GMT-06:00) Central Standard Time (America/Managua)",
                                    },
                                    {
                                        value: "America/Merida",
                                        label: "(GMT-06:00) Central Standard Time (America/Merida)",
                                    },
                                    {
                                        value: "America/Mexico_City",
                                        label: "(GMT-06:00) Central Standard Time (America/Mexico_City)",
                                    },
                                    {
                                        value: "America/Monterrey",
                                        label: "(GMT-06:00) Central Standard Time (America/Monterrey)",
                                    },
                                    {
                                        value: "America/Regina",
                                        label: "(GMT-06:00) Central Standard Time (America/Regina)",
                                    },
                                    {
                                        value: "America/Swift_Current",
                                        label: "(GMT-06:00) Central Standard Time (America/Swift_Current)",
                                    },
                                    {
                                        value: "America/Tegucigalpa",
                                        label: "(GMT-06:00) Central Standard Time (America/Tegucigalpa)",
                                    },
                                    {
                                        value: "America/Yellowknife",
                                        label: "(GMT-06:00) Mountain Daylight Time (America/Yellowknife)",
                                    },
                                    {
                                        value: "Pacific/Galapagos",
                                        label: "(GMT-06:00) Galapagos Time (Pacific/Galapagos)",
                                    },
                                    {
                                        value: "America/Creston",
                                        label: "(GMT-07:00) Mountain Standard Time (America/Creston)",
                                    },
                                    {
                                        value: "America/Dawson",
                                        label: "(GMT-07:00) Yukon Time (America/Dawson)",
                                    },
                                    {
                                        value: "America/Dawson_Creek",
                                        label: "(GMT-07:00) Mountain Standard Time (America/Dawson_Creek)",
                                    },
                                    {
                                        value: "America/Fort_Nelson",
                                        label: "(GMT-07:00) Mountain Standard Time (America/Fort_Nelson)",
                                    },
                                    {
                                        value: "America/Hermosillo",
                                        label: "(GMT-07:00) Mexican Pacific Standard Time (America/Hermosillo)",
                                    },
                                    {
                                        value: "America/Los_Angeles",
                                        label: "(GMT-07:00) Pacific Daylight Time (America/Los_Angeles)",
                                    },
                                    {
                                        value: "America/Mazatlan",
                                        label: "(GMT-07:00) Mexican Pacific Standard Time (America/Mazatlan)",
                                    },
                                    {
                                        value: "America/Phoenix",
                                        label: "(GMT-07:00) Mountain Standard Time (America/Phoenix)",
                                    },
                                    {
                                        value: "America/Santa_Isabel",
                                        label: "(GMT-07:00) Northwest Mexico Daylight Time (America/Santa_Isabel)",
                                    },
                                    {
                                        value: "America/Tijuana",
                                        label: "(GMT-07:00) Pacific Daylight Time (America/Tijuana)",
                                    },
                                    {
                                        value: "America/Vancouver",
                                        label: "(GMT-07:00) Pacific Daylight Time (America/Vancouver)",
                                    },
                                    {
                                        value: "America/Whitehorse",
                                        label: "(GMT-07:00) Yukon Time (America/Whitehorse)",
                                    },
                                    {
                                        value: "America/Anchorage",
                                        label: "(GMT-08:00) Alaska Daylight Time (America/Anchorage)",
                                    },
                                    {
                                        value: "America/Juneau",
                                        label: "(GMT-08:00) Alaska Daylight Time (America/Juneau)",
                                    },
                                    {
                                        value: "America/Metlakatla",
                                        label: "(GMT-08:00) Alaska Daylight Time (America/Metlakatla)",
                                    },
                                    {
                                        value: "America/Nome",
                                        label: "(GMT-08:00) Alaska Daylight Time (America/Nome)",
                                    },
                                    {
                                        value: "America/Sitka",
                                        label: "(GMT-08:00) Alaska Daylight Time (America/Sitka)",
                                    },
                                    {
                                        value: "America/Yakutat",
                                        label: "(GMT-08:00) Alaska Daylight Time (America/Yakutat)",
                                    },
                                    {
                                        value: "Pacific/Pitcairn",
                                        label: "(GMT-08:00) Pitcairn Time (Pacific/Pitcairn)",
                                    },
                                    {
                                        value: "America/Adak",
                                        label: "(GMT-09:00) Hawaii-Aleutian Daylight Time (America/Adak)",
                                    },
                                    {
                                        value: "Pacific/Gambier",
                                        label: "(GMT-09:00) Gambier Time (Pacific/Gambier)",
                                    },
                                    {
                                        value: "Pacific/Marquesas",
                                        label: "(GMT-09:30) Marquesas Time (Pacific/Marquesas)",
                                    },
                                    {
                                        value: "Pacific/Honolulu",
                                        label: "(GMT-10:00) Hawaii-Aleutian Standard Time (Pacific/Honolulu)",
                                    },
                                    {
                                        value: "Pacific/Johnston",
                                        label: "(GMT-10:00) Hawaii-Aleutian Standard Time (Pacific/Johnston)",
                                    },
                                    {
                                        value: "Pacific/Rarotonga",
                                        label: "(GMT-10:00) Cook Islands Standard Time (Pacific/Rarotonga)",
                                    },
                                    {
                                        value: "Pacific/Tahiti",
                                        label: "(GMT-10:00) Tahiti Time (Pacific/Tahiti)",
                                    },
                                    {
                                        value: "Pacific/Midway",
                                        label: "(GMT-11:00) Samoa Standard Time (Pacific/Midway)",
                                    },
                                    {
                                        value: "Pacific/Niue",
                                        label: "(GMT-11:00) Niue Time (Pacific/Niue)",
                                    },
                                    {
                                        value: "Pacific/Pago_Pago",
                                        label: "(GMT-11:00) Samoa Standard Time (Pacific/Pago_Pago)",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "RecurrenceType",
                    displayName: "Recurrence Type",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "RecursDaily",
                                        label: "Recurs Daily",
                                    },
                                    {
                                        value: "RecursEveryWeekday",
                                        label: "Recurs Every Weekday",
                                    },
                                    {
                                        value: "RecursMonthly",
                                        label: "Recurs Monthly",
                                    },
                                    {
                                        value: "RecursMonthlyNth",
                                        label: "Recurs Monthly Nth",
                                    },
                                    {
                                        value: "RecursWeekly",
                                        label: "Recurs Weekly",
                                    },
                                    {
                                        value: "RecursYearly",
                                        label: "Recurs Yearly",
                                    },
                                    {
                                        value: "RecursYearlyNth",
                                        label: "Recurs Yearly Nth",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "RecurrenceInterval",
                    displayName: "Recurrence Interval",
                    type: o.optional({
                        type: o.integer({}),
                    }),
                },
                {
                    name: "RecurrenceDayOfWeekMask",
                    displayName: "Recurrence Day of Week Mask",
                    type: o.optional({
                        type: o.integer({}),
                    }),
                },
                {
                    name: "RecurrenceDayOfMonth",
                    displayName: "Recurrence Day of Month",
                    type: o.optional({
                        type: o.integer({}),
                    }),
                },
                {
                    name: "RecurrenceInstance",
                    displayName: "Recurrence Instance",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "First",
                                        label: "1st",
                                    },
                                    {
                                        value: "Second",
                                        label: "2nd",
                                    },
                                    {
                                        value: "Third",
                                        label: "3rd",
                                    },
                                    {
                                        value: "Fourth",
                                        label: "4th",
                                    },
                                    {
                                        value: "Last",
                                        label: "last",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "RecurrenceMonthOfYear",
                    displayName: "Recurrence Month of Year",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "January",
                                        label: "January",
                                    },
                                    {
                                        value: "February",
                                        label: "February",
                                    },
                                    {
                                        value: "March",
                                        label: "March",
                                    },
                                    {
                                        value: "April",
                                        label: "April",
                                    },
                                    {
                                        value: "May",
                                        label: "May",
                                    },
                                    {
                                        value: "June",
                                        label: "June",
                                    },
                                    {
                                        value: "July",
                                        label: "July",
                                    },
                                    {
                                        value: "August",
                                        label: "August",
                                    },
                                    {
                                        value: "September",
                                        label: "September",
                                    },
                                    {
                                        value: "October",
                                        label: "October",
                                    },
                                    {
                                        value: "November",
                                        label: "November",
                                    },
                                    {
                                        value: "December",
                                        label: "December",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "RecurrenceRegeneratedType",
                    displayName: "Repeat This Task",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "RecurrenceRegenerateAfterDueDate",
                                        label: "After due date",
                                    },
                                    {
                                        value: "RecurrenceRegenerateAfterToday",
                                        label: "After date completed",
                                    },
                                    {
                                        value: "RecurrenceRegenerated",
                                        label: "(Task Closed)",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "Event_Type__c",
                    displayName: "Event Type",
                    type: o.optional({
                        type: o.string({
                            constraint: o.StringConstraint.enum({
                                options: [
                                    {
                                        value: "FTX",
                                        label: "FTX",
                                    },
                                    {
                                        value: "Deployment",
                                        label: "Deployment",
                                    },
                                    {
                                        value: "Customer Demo",
                                        label: "Customer Demo",
                                    },
                                ],
                            }),
                        }),
                    }),
                },
                {
                    name: "Customer_POC__c",
                    displayName: "Customer POC",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
                {
                    name: "Mission__c",
                    displayName: "Mission",
                    type: o.optional({
                        type: o.string({}),
                    }),
                },
            ],
            logic: [
                o.ActionLogicStep.updateObject({
                    object: {
                        name: "recordId",
                    },
                    values: [
                        {
                            property: ["WhoId"],
                            value: o.Expression.inputReference({
                                name: "WhoId",
                            }),
                        },
                        {
                            property: ["WhatId"],
                            value: o.Expression.inputReference({
                                name: "WhatId",
                            }),
                        },
                        {
                            property: ["Subject"],
                            value: o.Expression.inputReference({
                                name: "Subject",
                            }),
                        },
                        {
                            property: ["ActivityDate"],
                            value: o.Expression.inputReference({
                                name: "ActivityDate",
                            }),
                        },
                        {
                            property: ["Status"],
                            value: o.Expression.inputReference({
                                name: "Status",
                            }),
                        },
                        {
                            property: ["Priority"],
                            value: o.Expression.inputReference({
                                name: "Priority",
                            }),
                        },
                        {
                            property: ["OwnerId"],
                            value: o.Expression.inputReference({
                                name: "OwnerId",
                            }),
                        },
                        {
                            property: ["Description"],
                            value: o.Expression.inputReference({
                                name: "Description",
                            }),
                        },
                        {
                            property: ["CallDurationInSeconds"],
                            value: o.Expression.inputReference({
                                name: "CallDurationInSeconds",
                            }),
                        },
                        {
                            property: ["CallType"],
                            value: o.Expression.inputReference({
                                name: "CallType",
                            }),
                        },
                        {
                            property: ["CallDisposition"],
                            value: o.Expression.inputReference({
                                name: "CallDisposition",
                            }),
                        },
                        {
                            property: ["CallObject"],
                            value: o.Expression.inputReference({
                                name: "CallObject",
                            }),
                        },
                        {
                            property: ["ReminderDateTime"],
                            value: o.Expression.inputReference({
                                name: "ReminderDateTime",
                            }),
                        },
                        {
                            property: ["IsReminderSet"],
                            value: o.Expression.inputReference({
                                name: "IsReminderSet",
                            }),
                        },
                        {
                            property: ["RecurrenceStartDateOnly"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceStartDateOnly",
                            }),
                        },
                        {
                            property: ["RecurrenceEndDateOnly"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceEndDateOnly",
                            }),
                        },
                        {
                            property: ["RecurrenceTimeZoneSidKey"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceTimeZoneSidKey",
                            }),
                        },
                        {
                            property: ["RecurrenceType"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceType",
                            }),
                        },
                        {
                            property: ["RecurrenceInterval"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceInterval",
                            }),
                        },
                        {
                            property: ["RecurrenceDayOfWeekMask"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceDayOfWeekMask",
                            }),
                        },
                        {
                            property: ["RecurrenceDayOfMonth"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceDayOfMonth",
                            }),
                        },
                        {
                            property: ["RecurrenceInstance"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceInstance",
                            }),
                        },
                        {
                            property: ["RecurrenceMonthOfYear"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceMonthOfYear",
                            }),
                        },
                        {
                            property: ["RecurrenceRegeneratedType"],
                            value: o.Expression.inputReference({
                                name: "RecurrenceRegeneratedType",
                            }),
                        },
                        {
                            property: ["Event_Type__c"],
                            value: o.Expression.inputReference({
                                name: "Event_Type__c",
                            }),
                        },
                        {
                            property: ["Customer_POC__c"],
                            value: o.Expression.inputReference({
                                name: "Customer_POC__c",
                            }),
                        },
                        {
                            property: ["Mission__c"],
                            value: o.Expression.inputReference({
                                name: "Mission__c",
                            }),
                        },
                    ],
                }),
            ],
        },
    ],
    queryFunctionTypes: [
        {
            name: "getAvailableMeetingTimes",
            displayName: "Get Available Meeting Times",
            parameters: [
                {
                    name: "meetingOwnerId",
                    displayName: "Meeting Owner ID",
                    type: o.optional({
                        type: o.string({}),
                    }),
                    description:
                        "Optional. The ID of the Salesforce Inbox user who owns the meeting. If no owner is specified, the ID of the current user is used.",
                },
                {
                    name: "attendeeEmailAddresses",
                    displayName: "Attendee Email Addresses",
                    type: o.list({
                        elementType: o.string({}),
                    }),
                    description:
                        "A list of the meeting attendees’ email addresses, excluding the meeting owner.",
                },
                {
                    name: "metadataTargetId",
                    displayName: "Metadata Target ID",
                    type: o.optional({
                        type: o.string({}),
                    }),
                    description:
                        "Optional. The target record ID associated with a lead, contact, or person account. This ID typically belongs to the attendee and is used to connect the meeting with the Action Cadence Step Tracker used by the agent to engage with the target.",
                },
                {
                    name: "metadataOrchestrationId",
                    displayName: "Metadata Orchestration ID",
                    type: o.optional({
                        type: o.string({}),
                    }),
                    description:
                        "Optional. The ID of the this action’s orchestration. The ID can be an Action Cadence Step Tracker or other orchestration. The ID associates the meeting with the Action Cadence Step Tracker used by the agent to engage with the target.",
                },
                {
                    name: "startDate",
                    displayName: "Start Date",
                    type: o.optional({
                        type: o.string({}),
                    }),
                    description:
                        "The start date in ISO date-time format for when to begin looking for available meeting time slots.",
                },
                {
                    name: "endDate",
                    displayName: "End Date",
                    type: o.optional({
                        type: o.string({}),
                    }),
                    description:
                        "The end date in ISO date-time format for when to stop looking for available meeting time slots.",
                },
                {
                    name: "timeZone",
                    displayName: "Time Zone",
                    type: o.optional({
                        type: o.string({}),
                    }),
                    description:
                        "Optional. The TimeZoneSidKey used to look up available meeting time slots. When not specified, the value is the same TimeZoneSidKey as the Meeting Owner.",
                },
                {
                    name: "numberOfTimeSlots",
                    displayName: "Max Number of Time Slots",
                    type: o.optional({
                        type: o.string({}),
                    }),
                    description:
                        "Optional. The maximum number of meeting time slots to look for. When no number is set, the default value is 3.",
                },
                {
                    name: "limitPerDay",
                    displayName: "Limit Per Day",
                    type: o.optional({
                        type: o.string({}),
                    }),
                    description:
                        "Optional. The maximum number of meeting time slots to find for a given date. When no number is set, value defaults to 1.",
                },
                {
                    name: "meetingName",
                    displayName: "Meeting Name",
                    type: o.optional({
                        type: o.string({}),
                    }),
                    description:
                        "Optional. The name of the scheduled meeting. When no name is entered, the default value is “Meeting with attendee”.",
                },
                {
                    name: "meetingDescription",
                    displayName: "Meeting Description",
                    type: o.optional({
                        type: o.string({}),
                    }),
                    description: "Optional. A description of the scheduled meeting.",
                },
            ],
            returnType: o.struct({
                fields: [
                    {
                        name: "timeSlots",
                        displayName: "Time Slots",
                        type: o.optional({
                            type: o.string({}),
                        }),
                        description:
                            "The list of available time slots for booking a meeting from the Salesforce Inbox user’s calendar.",
                    },
                    {
                        name: "epochTimes",
                        displayName: "Epoch Times",
                        type: o.optional({
                            type: o.string({}),
                        }),
                        description:
                            "The epoch time values in milliseconds corresponding to the available time slots.",
                    },
                    {
                        name: "meetingRequestId",
                        displayName: "Meeting Request ID",
                        type: o.optional({
                            type: o.string({}),
                        }),
                        description:
                            "The ID of the meeting request associated with the group of generated time slots.",
                    },
                    {
                        name: "outputErrorMessage",
                        displayName: "Error Message",
                        type: o.optional({
                            type: o.string({}),
                        }),
                        description: "The error message returned by the Get Available Meeting Times action.",
                    },
                    {
                        name: "outputErrorCode",
                        displayName: "Error Code",
                        type: o.optional({
                            type: o.string({}),
                        }),
                        description: "The error code returned by the Get Available Meeting Times action.",
                    },
                ],
            }),
            description: "Retrieve the time slots available for booking a sales meeting.",
        },
    ],
});
