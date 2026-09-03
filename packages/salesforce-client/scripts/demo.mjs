import { createServer } from "node:http";
import open from "open";
import { createTaskManagerDemoRuntime } from "../../../apps/salesforce-task-manager/lib/demo-runtime.js";

function dashboardHtml() {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Party Stack × Salesforce</title>
    <style>
        :root {
            color-scheme: light;
            --ink: #13233a;
            --muted: #65748b;
            --line: #dfe6ef;
            --panel: rgba(255,255,255,.92);
            --blue: #0176d3;
            --navy: #071a31;
            --green: #1f9d65;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            color: var(--ink);
            background:
                radial-gradient(circle at 85% -10%, rgba(27, 150, 255, .28), transparent 35rem),
                linear-gradient(180deg, #edf6ff 0, #f7f9fc 28rem);
            font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        header {
            color: white;
            background: linear-gradient(125deg, var(--navy), #073f70 72%, #087cc1);
            box-shadow: 0 12px 35px rgba(7, 26, 49, .18);
        }
        .header-inner, main { width: min(1180px, calc(100% - 40px)); margin: 0 auto; }
        .header-inner { padding: 36px 0 72px; }
        .eyebrow {
            display: flex;
            align-items: center;
            gap: 10px;
            color: #b8dcfa;
            font-size: 12px;
            font-weight: 750;
            letter-spacing: .12em;
            text-transform: uppercase;
        }
        .mark {
            display: grid;
            width: 30px;
            height: 30px;
            place-items: center;
            color: white;
            border: 1px solid rgba(255,255,255,.35);
            border-radius: 9px;
            background: rgba(255,255,255,.12);
            font-size: 17px;
        }
        h1 { margin: 22px 0 10px; font-size: clamp(34px, 5vw, 54px); line-height: 1.04; letter-spacing: -.04em; }
        .subtitle { max-width: 680px; margin: 0; color: #d4e9f9; font-size: 17px; }
        main { margin-top: -40px; padding-bottom: 64px; }
        .toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            margin-bottom: 18px;
            padding: 16px 18px;
            border: 1px solid rgba(255,255,255,.72);
            border-radius: 16px;
            background: rgba(255,255,255,.88);
            box-shadow: 0 14px 40px rgba(20, 53, 87, .12);
            backdrop-filter: blur(14px);
        }
        .connection { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .dot { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 5px rgba(31,157,101,.12); }
        .connection-copy { min-width: 0; }
        .connection-copy strong, .connection-copy span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .connection-copy span { color: var(--muted); font-size: 12px; }
        .toolbar-actions { display: flex; align-items: center; gap: 10px; }
        .realtime {
            display: inline-flex;
            align-items: center;
            gap: 7px;
            padding: 8px 10px;
            border: 1px solid #d6e2ec;
            border-radius: 999px;
            color: #52677b;
            background: white;
            font-size: 11px;
            font-weight: 700;
        }
        .realtime-dot { width: 7px; height: 7px; border-radius: 50%; background: #9aa8b5; }
        .realtime.connected { color: #155d42; border-color: #b8e2d2; background: #effaf6; }
        .realtime.connected .realtime-dot { background: var(--green); box-shadow: 0 0 0 4px rgba(31,157,101,.1); }
        .realtime.error { margin: 0; color: #8f2020; border-color: #efc6c6; background: #fff5f5; }
        .realtime.error .realtime-dot { background: #d44b4b; }
        button {
            appearance: none;
            padding: 10px 15px;
            color: white;
            border: 0;
            border-radius: 10px;
            background: var(--blue);
            box-shadow: 0 5px 14px rgba(1,118,211,.22);
            font: inherit;
            font-weight: 700;
            cursor: pointer;
        }
        button:disabled { opacity: .55; cursor: wait; }
        button.secondary { color: #21405e; border: 1px solid #cfdbe7; background: white; box-shadow: none; }
        button.danger { color: #a12626; border: 1px solid #efc6c6; background: #fff7f7; box-shadow: none; }
        button.mini { padding: 6px 9px; border-radius: 8px; font-size: 11px; }
        .row-actions { display: flex; gap: 6px; }
        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin: 18px 0; }
        .stat, .panel {
            border: 1px solid var(--line);
            background: var(--panel);
            box-shadow: 0 8px 28px rgba(28, 55, 86, .07);
        }
        .stat { padding: 20px; border-radius: 15px; }
        .stat-label { color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
        .stat-value { margin-top: 7px; font-size: 30px; font-weight: 780; letter-spacing: -.03em; }
        .task-manager { margin-bottom: 18px; }
        .board-wrap { overflow-x: auto; padding: 18px; background: #f7f9fc; }
        .board {
            display: grid;
            grid-auto-flow: column;
            grid-auto-columns: minmax(230px, 1fr);
            gap: 13px;
            min-width: max-content;
        }
        .task-column {
            width: min(270px, 72vw);
            min-height: 230px;
            padding: 11px;
            border: 1px solid #e0e7ef;
            border-radius: 13px;
            background: #eef3f8;
        }
        .column-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 3px 12px; }
        .column-title { display: flex; align-items: center; gap: 7px; min-width: 0; font-weight: 760; }
        .column-title span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .count { display: grid; min-width: 21px; height: 21px; padding: 0 6px; place-items: center; border-radius: 999px; color: #4e6074; background: white; font-size: 11px; }
        .task-stack { display: grid; gap: 9px; }
        .task-card {
            padding: 13px;
            border: 1px solid #dce4ec;
            border-radius: 11px;
            background: white;
            box-shadow: 0 3px 10px rgba(33, 62, 92, .06);
            cursor: grab;
            transition: opacity .15s ease, transform .15s ease, box-shadow .15s ease;
        }
        .task-card:hover { transform: translateY(-1px); box-shadow: 0 7px 18px rgba(33, 62, 92, .1); }
        .task-card.dragging { opacity: .38; cursor: grabbing; transform: rotate(1deg); }
        .task-column.drop-target { border-color: var(--blue); background: #e5f3ff; box-shadow: inset 0 0 0 2px rgba(1,118,211,.12); }
        .task-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 9px; }
        .priority { padding: 3px 7px; border-radius: 999px; color: #496074; background: #edf2f7; font-size: 10px; font-weight: 750; text-transform: uppercase; }
        .priority-high { color: #9b2f2f; background: #fff0f0; }
        .priority-low { color: #476075; background: #eff4f8; }
        .task-card h3 { margin: 0; font-size: 14px; line-height: 1.35; }
        .task-due { margin-top: 8px; color: var(--muted); font-size: 11px; }
        .task-owner { display: flex; align-items: center; gap: 8px; margin-top: 13px; padding-top: 11px; border-top: 1px solid #edf1f5; }
        .avatar { display: grid; width: 26px; height: 26px; flex: 0 0 auto; place-items: center; border-radius: 50%; color: white; background: linear-gradient(135deg, #0b74c8, #42a5e8); font-size: 10px; font-weight: 800; }
        .owner-copy { min-width: 0; flex: 1; }
        .owner-copy strong, .owner-copy span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .owner-copy strong { font-size: 11px; }
        .owner-copy span { color: var(--muted); font-size: 9px; text-transform: uppercase; }
        .card-actions { display: flex; gap: 4px; }
        .column-empty { padding: 32px 8px; color: #8794a4; text-align: center; font-size: 11px; }
        .grid { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(280px, .85fr); gap: 18px; }
        .panel { overflow: hidden; border-radius: 16px; }
        .panel-head { display: flex; align-items: end; justify-content: space-between; gap: 12px; padding: 20px 22px 15px; border-bottom: 1px solid var(--line); }
        h2 { margin: 0; font-size: 18px; letter-spacing: -.01em; }
        .panel-head span, .empty { color: var(--muted); font-size: 12px; }
        .table-wrap { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 14px 22px; text-align: left; border-bottom: 1px solid #edf1f5; white-space: nowrap; }
        th { color: var(--muted); background: #fafbfd; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
        td.subject { max-width: 300px; overflow: hidden; text-overflow: ellipsis; color: #123f6b; font-weight: 650; }
        tbody tr:last-child td { border-bottom: 0; }
        .badge { display: inline-flex; padding: 4px 9px; border-radius: 999px; color: #155d42; background: #e5f6ef; font-size: 12px; font-weight: 700; }
        .side-body { padding: 18px 20px 22px; }
        .flow-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
        .flow {
            padding: 11px 12px;
            border: 1px solid #e5ebf2;
            border-radius: 10px;
            background: #fafcfe;
        }
        .flow strong, .flow span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .flow span { margin-top: 2px; color: var(--muted); font-size: 11px; }
        .fields { display: flex; flex-wrap: wrap; gap: 7px; padding: 18px 22px 22px; }
        .field { padding: 5px 8px; border: 1px solid #dae5ef; border-radius: 7px; color: #36536f; background: #f7fafc; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
        .wide { grid-column: 1 / -1; }
        .loading { padding: 70px 20px; color: var(--muted); text-align: center; }
        .error { margin: 18px 0; padding: 15px 18px; border: 1px solid #f0b8b8; border-radius: 12px; color: #8f2020; background: #fff2f2; }
        .toast-region {
            position: fixed;
            top: 18px;
            right: 18px;
            z-index: 1000;
            width: min(380px, calc(100% - 36px));
            pointer-events: none;
        }
        .toast {
            padding: 13px 16px;
            border: 1px solid;
            border-radius: 12px;
            box-shadow: 0 16px 45px rgba(7, 26, 49, .2);
            opacity: 0;
            transform: translateY(-10px);
            transition: opacity .18s ease, transform .18s ease;
        }
        .toast.visible { opacity: 1; transform: translateY(0); }
        .toast-success { color: #155d42; border-color: #a9dec8; background: #ecfaf5; }
        .toast-error { color: #8f2020; border-color: #f0b8b8; background: #fff2f2; }
        dialog {
            width: min(520px, calc(100% - 28px));
            padding: 0;
            border: 0;
            border-radius: 18px;
            color: var(--ink);
            box-shadow: 0 30px 90px rgba(7, 26, 49, .3);
        }
        dialog::backdrop { background: rgba(7, 26, 49, .55); backdrop-filter: blur(3px); }
        .dialog-head { padding: 22px 24px 16px; border-bottom: 1px solid var(--line); }
        .dialog-head p { margin: 5px 0 0; color: var(--muted); }
        form { padding: 20px 24px 24px; }
        .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        label { display: grid; gap: 7px; color: #3e536b; font-size: 12px; font-weight: 700; }
        label.full { grid-column: 1 / -1; }
        input, select {
            width: 100%;
            padding: 10px 11px;
            border: 1px solid #cbd7e3;
            border-radius: 9px;
            color: var(--ink);
            background: white;
            font: inherit;
        }
        input:focus, select:focus { outline: 3px solid rgba(1,118,211,.14); border-color: var(--blue); }
        .dialog-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 22px; }
        footer { margin-top: 20px; color: var(--muted); text-align: center; font-size: 12px; }
        @media (max-width: 850px) {
            .stats { grid-template-columns: repeat(2, 1fr); }
            .grid { grid-template-columns: 1fr; }
            .wide { grid-column: auto; }
            .board { grid-auto-columns: minmax(220px, 1fr); }
        }
        @media (max-width: 520px) {
            .header-inner, main { width: min(100% - 24px, 1180px); }
            .header-inner { padding-top: 26px; }
            .toolbar { align-items: flex-start; }
            .toolbar-actions { align-items: flex-end; flex-direction: column-reverse; }
            .realtime { max-width: 160px; }
            .stats { grid-template-columns: 1fr 1fr; gap: 9px; }
            .stat { padding: 15px; }
            .stat-value { font-size: 24px; }
            th, td { padding-left: 14px; padding-right: 14px; }
            .form-grid { grid-template-columns: 1fr; }
            label.full { grid-column: auto; }
        }
    </style>
</head>
<body>
    <div id="toast-region" class="toast-region" aria-live="polite"></div>
    <header>
        <div class="header-inner">
            <div class="eyebrow"><span class="mark">P</span> Party Stack Integration Demo</div>
            <h1>Salesforce Task Manager</h1>
            <p class="subtitle">Plan, update, and complete work through a generated Party Stack ontology backed by live Salesforce Tasks.</p>
        </div>
    </header>
    <main>
        <div class="toolbar">
            <div class="connection">
                <span class="dot"></span>
                <div class="connection-copy">
                    <strong id="connection-title">Connecting to Salesforce…</strong>
                    <span id="connection-meta">Loading live org data</span>
                </div>
            </div>
            <div class="toolbar-actions">
                <div id="realtime" class="realtime">
                    <span class="realtime-dot"></span>
                    <span id="realtime-label">Connecting realtime…</span>
                </div>
                <button id="refresh" type="button">Refresh data</button>
            </div>
        </div>
        <div id="error"></div>
        <div id="content"><div class="panel loading">Loading Salesforce data…</div></div>
        <footer>Local demo · Writes go directly to Salesforce · Access tokens never leave the local Party Stack process</footer>
    </main>
    <dialog id="task-dialog">
        <div class="dialog-head">
            <h2 id="dialog-title">Create Salesforce Task</h2>
            <p>Changes are written immediately to the connected Salesforce org.</p>
        </div>
        <form id="task-form">
            <input id="task-id" type="hidden">
            <div class="form-grid">
                <label class="full">Subject
                    <input id="task-subject" name="subject" maxlength="255" required>
                </label>
                <label>Status
                    <select id="task-status" name="status" required></select>
                </label>
                <label>Priority
                    <select id="task-priority" name="priority" required></select>
                </label>
                <label class="full">Due date
                    <input id="task-date" name="activityDate" type="date">
                </label>
            </div>
            <div class="dialog-actions">
                <button id="task-cancel" class="secondary" type="button">Cancel</button>
                <button id="task-save" type="submit">Save task</button>
            </div>
        </form>
    </dialog>
    <script>
        const escapeHtml = (value) => String(value ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
        const formatDate = (value) => {
            if (!value) return "—";
            const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
                ? value + "T00:00:00"
                : value;
            return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
                new Date(normalized)
            );
        };
        const number = (value) => new Intl.NumberFormat().format(value ?? 0);
        let currentData;
        let draggedTaskId;
        let toastTimer;

        function optionsHtml(options, selected) {
            return options.map((option) =>
                '<option value="' + escapeHtml(option.value) + '"' +
                (option.value === selected ? " selected" : "") + ">" +
                escapeHtml(option.label || option.value) + "</option>"
            ).join("");
        }

        function showMessage(message, kind = "success") {
            const region = document.getElementById("toast-region");
            clearTimeout(toastTimer);
            region.innerHTML =
                '<div class="toast toast-' + kind + '" role="status">' +
                escapeHtml(message) + "</div>";
            const toast = region.firstElementChild;
            requestAnimationFrame(() => toast.classList.add("visible"));
            toastTimer = setTimeout(() => {
                toast.classList.remove("visible");
                setTimeout(() => {
                    if (region.firstElementChild === toast) region.innerHTML = "";
                }, 200);
            }, kind === "error" ? 6_000 : 3_000);
        }

        function wireTaskActions() {
            document.getElementById("new-task").addEventListener("click", () => openTaskDialog());
            document.querySelectorAll("[data-edit-task]").forEach((button) => {
                button.addEventListener("click", () => {
                    const task = currentData.tasks.records.find(
                        (candidate) => candidate.Id === button.dataset.editTask
                    );
                    if (task) openTaskDialog(task);
                });
            });
            document.querySelectorAll("[data-delete-task]").forEach((button) => {
                button.addEventListener("click", () => deleteTask(button.dataset.deleteTask));
            });
            document.querySelectorAll("[data-drag-task]").forEach((card) => {
                card.addEventListener("dragstart", (event) => {
                    draggedTaskId = card.dataset.dragTask;
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", draggedTaskId);
                    requestAnimationFrame(() => card.classList.add("dragging"));
                });
                card.addEventListener("dragend", () => {
                    draggedTaskId = undefined;
                    card.classList.remove("dragging");
                    document.querySelectorAll(".drop-target").forEach((column) =>
                        column.classList.remove("drop-target")
                    );
                });
            });
            document.querySelectorAll("[data-drop-status]").forEach((column) => {
                column.addEventListener("dragover", (event) => {
                    if (!draggedTaskId) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    column.classList.add("drop-target");
                });
                column.addEventListener("dragleave", (event) => {
                    if (!column.contains(event.relatedTarget)) {
                        column.classList.remove("drop-target");
                    }
                });
                column.addEventListener("drop", (event) => {
                    event.preventDefault();
                    column.classList.remove("drop-target");
                    const id = event.dataTransfer.getData("text/plain") || draggedTaskId;
                    if (id) void updateTaskStatus(id, column.dataset.dropStatus);
                });
            });
        }

        function openTaskDialog(task) {
            const dialog = document.getElementById("task-dialog");
            document.getElementById("dialog-title").textContent =
                task ? "Edit Salesforce Task" : "Create Salesforce Task";
            document.getElementById("task-id").value = task?.Id || "";
            document.getElementById("task-subject").value = task?.Subject || "";
            document.getElementById("task-status").innerHTML = optionsHtml(
                currentData.task.statusOptions,
                task?.Status || currentData.task.defaultStatus
            );
            document.getElementById("task-priority").innerHTML = optionsHtml(
                currentData.task.priorityOptions,
                task?.Priority || currentData.task.defaultPriority
            );
            document.getElementById("task-date").value = task?.ActivityDate || "";
            dialog.showModal();
            document.getElementById("task-subject").focus();
        }

        async function saveTask(event) {
            event.preventDefault();
            const id = document.getElementById("task-id").value;
            const button = document.getElementById("task-save");
            button.disabled = true;
            button.textContent = "Saving…";
            try {
                const response = await fetch(id ? "/api/tasks/" + encodeURIComponent(id) : "/api/tasks", {
                    method: id ? "PATCH" : "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        subject: document.getElementById("task-subject").value,
                        status: document.getElementById("task-status").value,
                        priority: document.getElementById("task-priority").value,
                        activityDate: document.getElementById("task-date").value,
                    }),
                });
                const body = await response.json();
                if (!response.ok) throw new Error(body.error || "Task write failed.");
                document.getElementById("task-dialog").close();
                await load();
                showMessage(id ? "Task updated in Salesforce." : "Task created in Salesforce.");
            } catch (error) {
                showMessage(error.message, "error");
            } finally {
                button.disabled = false;
                button.textContent = "Save task";
            }
        }

        async function deleteTask(id) {
            const task = currentData.tasks.records.find((candidate) => candidate.Id === id);
            if (!task || !confirm('Delete "' + (task.Subject || "Untitled task") + '" from Salesforce?')) {
                return;
            }
            try {
                const response = await fetch("/api/tasks/" + encodeURIComponent(id), {
                    method: "DELETE",
                });
                const body = await response.json();
                if (!response.ok) throw new Error(body.error || "Task deletion failed.");
                await load();
                showMessage("Task deleted from Salesforce.");
            } catch (error) {
                showMessage(error.message, "error");
            }
        }

        async function updateTaskStatus(id, status) {
            const task = currentData.tasks.records.find((candidate) => candidate.Id === id);
            if (!task || !status || task.Status === status) return;
            const previousStatus = task.Status;
            draggedTaskId = undefined;
            task.Status = status;
            render(currentData);
            try {
                const response = await fetch("/api/tasks/" + encodeURIComponent(id), {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        subject: task.Subject,
                        status,
                        priority: task.Priority,
                        activityDate: task.ActivityDate || "",
                    }),
                });
                const body = await response.json();
                if (!response.ok) throw new Error(body.error || "Task status update failed.");
                await load();
                showMessage("Task moved to " + status + " in Salesforce.");
            } catch (error) {
                const currentTask = currentData.tasks.records.find(
                    (candidate) => candidate.Id === id
                );
                if (currentTask) currentTask.Status = previousStatus;
                render(currentData);
                showMessage(error.message, "error");
            }
        }

        function render(data) {
            currentData = data;
            document.getElementById("connection-title").textContent =
                data.user.name || "Connected Salesforce user";
            document.getElementById("connection-meta").textContent =
                data.user.username + " · API v" + data.apiVersion;

            const initials = (name) => String(name || "?")
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((part) => part[0])
                .join("")
                .toUpperCase();
            const configuredStatuses = data.task.statusOptions.map((option) => option.value);
            const statuses = [...new Set([
                ...configuredStatuses,
                ...data.tasks.records.map((task) => task.Status || "Unknown"),
            ])];
            const board = statuses.map((status) => {
                const columnTasks = data.tasks.records.filter(
                    (task) => (task.Status || "Unknown") === status
                );
                const cards = columnTasks.length
                    ? columnTasks.map((task) => {
                        const creator = task.CreatedBy?.Name || "Unknown creator";
                        const priorityClass = String(task.Priority || "").toLowerCase() === "high"
                            ? " priority-high"
                            : String(task.Priority || "").toLowerCase() === "low"
                                ? " priority-low"
                                : "";
                        return '<article class="task-card" draggable="true" data-drag-task="' +
                            escapeHtml(task.Id) + '">' +
                            '<div class="task-card-top"><span class="priority' + priorityClass + '">' +
                                escapeHtml(task.Priority || "No priority") +
                            '</span><div class="card-actions">' +
                                '<button class="secondary mini" type="button" data-edit-task="' + escapeHtml(task.Id) + '" aria-label="Edit task">Edit</button>' +
                                '<button class="danger mini" type="button" data-delete-task="' + escapeHtml(task.Id) + '" aria-label="Delete task">×</button>' +
                            "</div></div>" +
                            "<h3>" + escapeHtml(task.Subject || "Untitled task") + "</h3>" +
                            '<div class="task-due">Due ' + escapeHtml(formatDate(task.ActivityDate)) +
                                " · Created " + escapeHtml(formatDate(task.CreatedDate)) + "</div>" +
                            '<div class="task-owner"><span class="avatar">' + escapeHtml(initials(creator)) +
                                '</span><div class="owner-copy"><strong>' + escapeHtml(creator) +
                                "</strong><span>Created by</span></div></div>" +
                        "</article>";
                    }).join("")
                    : '<div class="column-empty">No tasks in this stage</div>';
                return '<section class="task-column" data-drop-status="' +
                    escapeHtml(status) + '"><div class="column-head">' +
                    '<div class="column-title"><span>' + escapeHtml(status) + '</span><span class="count">' +
                    number(columnTasks.length) + "</span></div></div>" +
                    '<div class="task-stack">' + cards + "</div></section>";
            }).join("");

            const flows = data.flows.actions.length
                ? data.flows.actions.slice(0, 12).map((flow) =>
                    '<li class="flow"><strong>' + escapeHtml(flow.label || flow.name) + "</strong>" +
                    "<span>" + escapeHtml(flow.name) + "</span></li>"
                ).join("")
                : '<li class="empty">' + escapeHtml(data.flows.error || "No Flow actions found.") + "</li>";

            const fields = data.task.fields.slice(0, 45)
                .map((field) => '<span class="field">' + escapeHtml(field.name) + " · " + escapeHtml(field.type) + "</span>")
                .join("");

            document.getElementById("content").innerHTML =
                '<section class="stats">' +
                    '<div class="stat"><div class="stat-label">Ontology objects</div><div class="stat-value">' + number(data.sobjectCount) + "</div></div>" +
                    '<div class="stat"><div class="stat-label">Task fields</div><div class="stat-value">' + number(data.task.fieldCount) + "</div></div>" +
                    '<div class="stat"><div class="stat-label">Visible tasks</div><div class="stat-value">' + number(data.tasks.totalSize) + "</div></div>" +
                    '<div class="stat"><div class="stat-label">Runtime actions</div><div class="stat-value">' + number(data.flows.count) + "</div></div>" +
                "</section>" +
                '<section class="panel task-manager"><div class="panel-head"><div><h2>Task board</h2><span>Live Salesforce Tasks grouped by status · ' + escapeHtml(data.refreshedAt) + '</span></div><button id="new-task" type="button">New task</button></div>' +
                    '<div class="board-wrap"><div class="board">' + board + "</div></div></section>" +
                '<section class="grid">' +
                    '<aside class="panel"><div class="panel-head"><div><h2>Runtime actions</h2><span>Generated ontology action types</span></div></div><div class="side-body"><ul class="flow-list">' + flows + "</ul></div></aside>" +
                    '<article class="panel"><div class="panel-head"><div><h2>Task ontology</h2><span>Fields returned by Salesforce describe</span></div></div><div class="fields">' + fields + "</div></article>" +
                "</section>";
            wireTaskActions();
        }

        async function load() {
            const button = document.getElementById("refresh");
            button.disabled = true;
            button.textContent = "Refreshing…";
            document.getElementById("error").innerHTML = "";
            try {
                const response = await fetch("/api/dashboard", { cache: "no-store" });
                const body = await response.json();
                if (!response.ok) throw new Error(body.error || "Dashboard request failed.");
                render(body);
            } catch (error) {
                document.getElementById("error").innerHTML =
                    '<div class="error"><strong>Salesforce request failed.</strong><br>' +
                    escapeHtml(error.message) + "</div>";
            } finally {
                button.disabled = false;
                button.textContent = "Refresh data";
            }
        }

        function setRealtimeStatus(status, message) {
            const indicator = document.getElementById("realtime");
            indicator.className = "realtime " + status;
            document.getElementById("realtime-label").textContent = message;
        }

        function connectRealtime() {
            const events = new EventSource("/api/events");
            let refreshTimer;
            events.addEventListener("status", (event) => {
                const status = JSON.parse(event.data);
                setRealtimeStatus(
                    status.state,
                    status.state === "connected"
                        ? "Realtime connected"
                        : status.state === "error"
                            ? "Realtime unavailable"
                            : "Connecting realtime…"
                );
                if (status.state === "error" && status.message) {
                    document.getElementById("realtime").title = status.message;
                }
            });
            events.addEventListener("task-change", (event) => {
                const change = JSON.parse(event.data);
                setRealtimeStatus("connected", "Salesforce change received");
                clearTimeout(refreshTimer);
                refreshTimer = setTimeout(() => {
                    void load().then(() =>
                        showMessage(
                            "Board refreshed after Salesforce " +
                            String(change.changeType || "change").toLowerCase() +
                            "."
                        )
                    );
                }, 250);
            });
            events.onerror = () => {
                setRealtimeStatus("error", "Realtime reconnecting…");
            };
        }

        document.getElementById("refresh").addEventListener("click", load);
        document.getElementById("task-cancel").addEventListener("click", () =>
            document.getElementById("task-dialog").close()
        );
        document.getElementById("task-form").addEventListener("submit", saveTask);
        connectRealtime();
        void load();
    </script>
</body>
</html>`;
}

function createDashboardData(runtime) {
    return runtime.getDashboardData();
}

function sendJson(response, status, body) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
    let raw = "";
    for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 32_768) {
            throw new Error("Request body is too large.");
        }
    }
    if (!raw) return {};
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Expected a JSON object.");
    }
    return value;
}

function taskRecordFromBody(body) {
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const status = typeof body.status === "string" ? body.status.trim() : "";
    const priority = typeof body.priority === "string" ? body.priority.trim() : "";
    const activityDate =
        typeof body.activityDate === "string" ? body.activityDate.trim() : "";

    if (!subject || subject.length > 255) {
        throw new Error("Task subject must be between 1 and 255 characters.");
    }
    if (!status || status.length > 80) {
        throw new Error("Task status is required.");
    }
    if (!priority || priority.length > 80) {
        throw new Error("Task priority is required.");
    }
    if (activityDate && !/^\d{4}-\d{2}-\d{2}$/.test(activityDate)) {
        throw new Error("Task due date must use YYYY-MM-DD.");
    }

    return {
        subject,
        status,
        priority,
        activityDate: activityDate || undefined,
    };
}

function validateTaskId(id) {
    if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
        throw new Error("Invalid Salesforce Task ID.");
    }
    return id;
}

const runtime = await createTaskManagerDemoRuntime();
const port = Number(process.env.SALESFORCE_DEMO_PORT ?? 4173);
const hostname = "127.0.0.1";
const eventClients = new Set();
let unsubscribeFromTaskChanges;
let shuttingDown = false;
let streamStatus = {
    state: "connecting",
    message: "Connecting to Salesforce Change Data Capture.",
};

function writeServerEvent(response, event, data) {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastServerEvent(event, data) {
    for (const response of eventClients) {
        writeServerEvent(response, event, data);
    }
}

function updateStreamStatus(state, message) {
    streamStatus = { state, message };
    broadcastServerEvent("status", streamStatus);
}

async function startTaskChangeStream() {
    if (shuttingDown || unsubscribeFromTaskChanges) return;
    updateStreamStatus("connecting", "Connecting to Salesforce Change Data Capture.");
    try {
        unsubscribeFromTaskChanges =
            runtime.subscribeToTaskChanges(
            (event) => {
                const header = event.payload?.ChangeEventHeader;
                if (!header) return;
                broadcastServerEvent("task-change", {
                    changeType: header.changeType,
                    changedFields: header.changedFields ?? [],
                    recordIds: header.recordIds,
                    replayId: event.event?.replayId,
                });
            }
        );
        updateStreamStatus(
            "connected",
            `Subscribed to ${runtime.changeEventChannel}.`
        );
        console.log(`Realtime connected: ${runtime.changeEventChannel}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateStreamStatus("error", message);
        console.warn(`Realtime unavailable: ${message}`);
    }
}

const heartbeat = setInterval(() => {
    for (const response of eventClients) {
        response.write(": heartbeat\n\n");
    }
}, 15_000);

const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const mutation =
        request.method === "POST" ||
        request.method === "PATCH" ||
        request.method === "DELETE";
    const allowedOrigins = new Set([
        `http://localhost:${port}`,
        `http://127.0.0.1:${port}`,
    ]);
    if (
        mutation &&
        request.headers.origin &&
        !allowedOrigins.has(request.headers.origin)
    ) {
        sendJson(response, 403, { error: "Request origin is not allowed." });
        return;
    }
    if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        });
        response.end(dashboardHtml());
        return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
        response.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Content-Type-Options": "nosniff",
        });
        response.write(": connected\n\n");
        writeServerEvent(response, "status", streamStatus);
        eventClients.add(response);
        request.once("close", () => {
            eventClients.delete(response);
        });
        return;
    }
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
        try {
            sendJson(response, 200, await createDashboardData(runtime));
        } catch (error) {
            sendJson(response, 500, {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return;
    }
    if (request.method === "POST" && url.pathname === "/api/tasks") {
        try {
            const record = taskRecordFromBody(await readJsonBody(request));
            await runtime.createTask(record);
            sendJson(response, 201, {
                success: true,
            });
        } catch (error) {
            sendJson(response, 400, {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return;
    }
    const taskRoute = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
    if (taskRoute && request.method === "PATCH") {
        try {
            const id = validateTaskId(decodeURIComponent(taskRoute[1]));
            const record = taskRecordFromBody(await readJsonBody(request));
            await runtime.updateTask(id, record);
            sendJson(response, 200, { id });
        } catch (error) {
            sendJson(response, 400, {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return;
    }
    if (taskRoute && request.method === "DELETE") {
        try {
            const id = validateTaskId(decodeURIComponent(taskRoute[1]));
            await runtime.deleteTask(id);
            sendJson(response, 200, { id });
        } catch (error) {
            sendJson(response, 400, {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return;
    }
    if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
    }
    sendJson(response, 404, { error: "Not found" });
});

await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, resolve);
});

const dashboardUrl = `http://localhost:${port}`;
console.log(`Salesforce demo is running at ${dashboardUrl}`);
console.log("Press Ctrl+C to stop.");
void startTaskChangeStream();
await open(dashboardUrl);

async function shutdown() {
    shuttingDown = true;
    clearInterval(heartbeat);
    unsubscribeFromTaskChanges?.();
    for (const response of eventClients) {
        response.end();
    }
    eventClients.clear();
    await new Promise((resolve) => server.close(resolve));
    await runtime.cleanup();
}

process.once("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
});
