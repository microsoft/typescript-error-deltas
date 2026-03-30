import readline from "readline";
import fs from "fs";
import * as lsp from "./lspHarness";
import { getProcessRssKb } from "./execUtils";
import { EXIT_BAD_ARGS, EXIT_SERVER_COMMUNICATION_ERROR, EXIT_SERVER_CRASH, EXIT_SERVER_ERROR, EXIT_UNHANDLED_EXCEPTION } from "./exerciseServerConstants";
import path from "path";
import events from "node:events";
import { ShutdownRequest } from "vscode-languageserver-protocol";
import { getPanicMessageFromStderr } from "./hashStackTrace";


const argv = process.argv;
if (argv.length !== 6) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <project_dir> <requests_path> <server_path> <diagnostic_output>`);
    process.exit(EXIT_BAD_ARGS);
}

const [testDir, replayPath, lspServerPath, diag] = argv.slice(2);
const diagnosticOutput = diag.toLocaleLowerCase() === "true";

replayServer(testDir, lspServerPath, replayPath).catch(e => {
    console.error(e);
    process.exit(EXIT_UNHANDLED_EXCEPTION);
});

async function replayServer(testDir: string, lspServerPath: string, replayPath: string) {
    const testDirUri = lsp.filePathToUri(testDir);
    const rl = readline.createInterface({
        input: fs.createReadStream(replayPath),
        crlfDelay: Infinity,
    });

    let rootDirPlaceholder = "@PROJECT_ROOT@"
    let rootDirUriPlaceHolder = "@PROJECT_ROOT_URI@"
    let serverArgs = ["--lsp", "--stdio"];

    let isFirstLine = true;
    let messages: Message[] = [];
    
    rl.on("line", (line) => {
        try {
            // Ignore blank lines
            if (line.trim().length === 0) {
                return;
            }

            if (isFirstLine) {
                const obj = JSON.parse(line);
                if (!obj.command) {
                    rootDirPlaceholder = obj.rootDirPlaceholder || rootDirPlaceholder;
                    rootDirUriPlaceHolder = obj.rootDirUriPlaceHolder || rootDirUriPlaceHolder;
                    serverArgs = obj.serverArgs || serverArgs;
                    return;
                }
            }

            const message = JSON.parse(line.replace(new RegExp(rootDirPlaceholder, "g"), testDir).replace(new RegExp(rootDirUriPlaceHolder, "g"), testDirUri));
            messages.push(message);
        } catch (e) {
            console.log(e);
        } finally {
            isFirstLine = false;
        }
    });
    await events.once(rl, 'close');

    await replayServerWorker(testDir, lspServerPath, messages, serverArgs);

    console.log("Replay completed successfully");
}

type Message = {
    kind: "request" | "notification";
    method: string;
    params?: any;
}

async function replayServerWorker(testDir: string, lspServerPath: string, messages: Message[], serverArgs: string[]) {
    let seq = 0;
    const server = lsp.startServer(lspServerPath, {
        args: serverArgs,
    });

    // Collect stderr output from the server process
    const stderrChunks: string[] = [];
    server.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrChunks.push(text);
        if (diagnosticOutput) {
            process.stderr.write(text);
        }
    });

    // Periodically log memory usage of the LSP server process and the harness process
    const memoryLogInterval = diagnosticOutput ? setInterval(async () => {
        const serverRssKb = await getProcessRssKb(server.pid);
        if (serverRssKb !== undefined) {
            const rssMb = Math.round(serverRssKb / 1024);
            console.error(`LSP server memory (pid ${server.pid}): ${rssMb} MB`);
        }
        const harnessRssKb = await getProcessRssKb(process.pid);
        if (harnessRssKb !== undefined) {
            const rssMb = Math.round(harnessRssKb / 1024);
            console.error(`Harness memory (pid ${process.pid}): ${rssMb} MB`);
        }
    }, 30_000) : undefined;
    memoryLogInterval?.unref();

    server.handleAnyRequest(async (...args) => {
        console.error("Server sent request:", ...args);
    });

    // Capture the last error-level log message from the server (e.g. Go panic stack traces)
    let lastErrorLogMessage = "";

    server.handleAnyNotification(async (...args: any[]) => {
        console.error("Server sent notification:", ...args);
        const [method, params] = args;
        if (method === "window/logMessage" && params?.type === 1) {
            lastErrorLogMessage = params.message;
        }
        if (method !== "window/logMessage") {
            console.error("Server sent notification:", ...args);
        }
    });

    let exitExpected = false;
    server.onError(async ([error, message, count]) => {
        console.error(`Server connection error: ${error} ${message} ${count}`);
        await killServer();
        process.exit(EXIT_SERVER_COMMUNICATION_ERROR);
    });
    
    server.onClose((e) => {
        if (!exitExpected) {
            const stderrOutput = stderrChunks.join("");
            const panicMsg = getPanicMessageFromStderr(stderrOutput);
            const errorMessage = panicMsg || lastErrorLogMessage || `Server connection closed prematurely: ${e}`;
            console.log(JSON.stringify({ method: "unknown", message: errorMessage, seq }));
            console.error(errorMessage);
            process.exit(EXIT_SERVER_CRASH);
        }
    });

    async function killServer() {
        exitExpected = true;
        await server.kill();
    }

    try {
        for (const msg of messages) {
            if (msg.kind === "request") {
                if (msg.method === ShutdownRequest.method) {
                    exitExpected = true;
                }
                await request(msg.method, msg.params);
            }
            else if (msg.kind === "notification") {
                await notify(msg.method, msg.params);
            }
        }
    } catch (e: any) {
        console.error("Killing server after unhandled exception");
        console.error(e);
        
        await killServer();
        clearInterval(memoryLogInterval)
        process.exit(EXIT_UNHANDLED_EXCEPTION);
    }

    await killServer();

    clearInterval(memoryLogInterval);

    async function request(
        method: string,
        params: any
    ): Promise<any> {
        seq++;
        try {
            return await server.sendRequestUntyped(method, params);
        } catch (e: any) {
            const errorMessage = lastErrorLogMessage || e.message || "Unknown error";
            if (diagnosticOutput) {
                console.error(`Request failed:\n${JSON.stringify({ method, params }, undefined, 2)}\n${e}`);
            }
            else {
                console.error(errorMessage);
            }
            console.log(JSON.stringify({ method, message: errorMessage, seq }));

            await killServer();
            clearInterval(memoryLogInterval);
            process.exit(EXIT_SERVER_ERROR);
        }
    }

    async function notify(
        method: string,
        params: any,
    ): Promise<void> {
        seq++;
        try {
            await server.sendNotificationUntyped(method, params);
        }
        catch (e: any) {
            const errorMessage = lastErrorLogMessage || e.message || "Unknown error";
            if (diagnosticOutput) {
                console.error(`Notification failed:\n${JSON.stringify({ method, params }, undefined, 2)}\n${e}`);
            }
            else {
                console.error(errorMessage);
            }
            console.log(JSON.stringify({ method, message: errorMessage, seq }));

            await killServer();
            clearInterval(memoryLogInterval);
            process.exit(EXIT_SERVER_ERROR);
        }
    }
}