import * as yadda from "./src/utils/lspHarness.mts";
import { readFileSync } from "fs";
import { pathToFileURL } from "url";

const [, , scriptPath, testDir] = process.argv;

const testUrl = testDir ?
    pathToFileURL(testDir).toString() :
    "file:///workspaces/typescript-error-deltas";

const server = yadda.startServer("./tsgo/tsgo-noracedetection", {
    args: ["--lsp", "--stdio"],
}, {
    traceOutput: true,
});

server.handleAnyNotification(async (...args) => {
    console.log("Notification received:", ...args);
});

server.handleAnyRequest(async (...args) => {
    console.log("Request received:", ...args);
    return {};
});

const script = readFileSync(scriptPath, "utf-8");
const lines = script.split(/\r?\n/g);
let rootDirPlaceholder = "@PROJECT_ROOT@";
let initialize: object | undefined;
let initialized: object | undefined;
if (true) {
    for (let line of lines) {
        line = line.trim();
        if (line.length === 0) continue;

        let obj = JSON.parse(line)
        if (obj.rootDirPlaceholder) {
            rootDirPlaceholder = obj.rootDirPlaceholder;
            continue;
        }

        obj = JSON.parse(line.replaceAll(rootDirPlaceholder, testUrl));

        console.log(obj)
        try {
            if (obj.kind === "request") {
                if (obj.method === "initialize") {
                    if (initialize) {
                        continue;
                    }
                    initialize = obj.params;
                }

                const responsePromise = server.sendRequest(obj.method, obj.params);;
                if (obj.method !== "shutdown") {
                    await responsePromise;
                    continue;
                }
            }
            else if (obj.kind === "notification") {
                if (obj.method === "initialized") {
                    if (initialized) {
                        continue;
                    }
                    initialized = obj.params;
                }
                await server.sendNotification(obj.method, obj.params);
            }
            else {
                throw new Error(`Unknown replay entry kind: ${JSON.stringify(obj)}`);
            }
        }
        catch (e) {
            console.log(e);
        }
        
        // Slow down requests - sometimes helpful for ATA races.
        // await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

server.kill();
