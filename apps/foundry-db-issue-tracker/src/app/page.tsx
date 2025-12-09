"use client";

import { ClientOnly } from "./ClientOnly";
import { FormList } from "./FormList";

function Home() {
    return <FormList />;
}

export default ClientOnly(Home);
