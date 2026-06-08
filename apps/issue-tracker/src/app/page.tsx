"use client";

import dynamic from "next/dynamic";

const Home = dynamic(() => import("./TaskList").then((module) => module.TaskList), {
    ssr: false,
});

export default Home;
