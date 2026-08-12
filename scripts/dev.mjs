import { spawn } from "node:child_process";

const children = [
  spawn(process.execPath, ["collector.mjs"], { stdio: "inherit" }),
  spawn(process.execPath, ["node_modules/vinext/dist/cli.js", "dev", "--port", "47831"], {
    stdio: "inherit",
    env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
  }),
];

function stop(signal = "SIGTERM") {
  children.forEach((child) => child.kill(signal));
}

children.forEach((child) => child.on("exit", (code) => {
  if (code) process.exitCode = code;
  stop();
}));
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop());
