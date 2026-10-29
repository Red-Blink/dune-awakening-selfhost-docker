import { get } from "node:http";

const bindHost = process.env.ADMIN_BIND_HOST || "0.0.0.0";
const hostname = bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost === "::" ? "::1" : bindHost;
const request = get({ hostname, port: Number(process.env.ADMIN_BIND_PORT || 8088), path: "/api/health", timeout: 4000 }, response => {
  response.resume();
  process.exitCode = response.statusCode === 200 ? 0 : 1;
});
request.on("error", () => { process.exitCode = 1; });
request.on("timeout", () => request.destroy());
