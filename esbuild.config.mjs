import esbuild from "esbuild";
import http from "http";
import crypto from "crypto";

const isProduction = process.argv.includes("--production");
const isWatch = process.argv.includes("--watch");

/**
 * Trigger the plugin's hot-reload command via CDP (Chrome DevTools Protocol).
 * Only fires in watch mode. Fails silently if Obsidian isn't running with
 * --remote-debugging-port=9222.
 */
function triggerHotReload() {
  if (!isWatch) return;
  http.get("http://localhost:9222/json", (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => {
      try {
        const targets = JSON.parse(data);
        const target = targets.find((t) => t.type === "page");
        if (!target) return;
        const wsUrl = target.webSocketDebuggerUrl;
        if (!wsUrl) return;
        const url = new URL(wsUrl);
        const key = crypto.randomBytes(16).toString("base64");
        const req = http.request({
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "GET",
          headers: {
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Key": key,
            "Sec-WebSocket-Version": "13",
          },
        });
        req.on("upgrade", (_res, socket) => {
          const expression = `app.commands.executeCommandById('work-terminal:reload-plugin')`;
          const msg = JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true, awaitPromise: true },
          });
          const payload = Buffer.from(msg);
          const mask = crypto.randomBytes(4);
          let header;
          if (payload.length < 126) {
            header = Buffer.alloc(6);
            header[0] = 0x81;
            header[1] = 0x80 | payload.length;
            mask.copy(header, 2);
          } else {
            header = Buffer.alloc(8);
            header[0] = 0x81;
            header[1] = 0x80 | 126;
            header.writeUInt16BE(payload.length, 2);
            mask.copy(header, 4);
          }
          const masked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
          socket.write(Buffer.concat([header, masked]));
          socket.on("data", () => {
            socket.destroy();
            console.log("Hot reload triggered via CDP");
          });
          setTimeout(() => socket.destroy(), 3000);
        });
        req.on("error", () => {});
        req.end();
        setTimeout(() => req.destroy(), 5000);
      } catch {
        // Obsidian not running - silent
      }
    });
  }).on("error", () => {});
}

let isFirstBuild = true;

const hotReloadPlugin = {
  name: "hot-reload",
  setup(build) {
    build.onEnd(() => {
      if (isWatch && !isFirstBuild) {
        triggerHotReload();
      }
      isFirstBuild = false;
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  platform: "node",
  external: [
    "obsidian",
    "electron",
    "child_process",
    "fs",
    "path",
    "os",
    "string_decoder",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  minify: isProduction,
  sourcemap: isProduction ? false : "inline",
  treeShaking: true,
  plugins: [hotReloadPlugin],
});

if (isWatch) {
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
