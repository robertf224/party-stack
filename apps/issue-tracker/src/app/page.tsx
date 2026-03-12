"use client";

import { ClientOnly } from "./ClientOnly";
import { TaskList } from "./TaskList";

function Home() {
    return <TaskList />;
}

export default ClientOnly(Home);
