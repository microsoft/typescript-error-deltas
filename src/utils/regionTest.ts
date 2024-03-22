import sh = require("@typescript/server-harness");
import fs = require("fs");
import type typescript = require("typescript");
import process = require("process");
import path = require("path");
import glob = require("glob");
import { performance } from "perf_hooks";
import randomSeed = require("random-seed");
import { EXIT_BAD_ARGS, EXIT_UNHANDLED_EXCEPTION, EXIT_SERVER_EXIT_FAILED, EXIT_SERVER_CRASH, EXIT_SERVER_ERROR, EXIT_LANGUAGE_SERVICE_DISABLED, EXIT_SERVER_COMMUNICATION_ERROR } from "./exerciseServerConstants";

type RequestBase<T extends typescript.server.protocol.Request> = Omit<T, "command" | "seq" | "type"> & {
    command: `${T["command"]}`
}

type Body = typescript.server.protocol.DiagnosticEventBody & { duration: number };

type FullPerfResult = {
    fullDiagnosticsCount: number,
    fullDuration: number,
}
type RegionPerfResult = {
    regionDiagnosticsCount: number,
    regionDuration: number,
}
type PerfResult = FullPerfResult & Partial<RegionPerfResult>;

const testDirPlaceholder = "@PROJECT_ROOT@";

const exitTimeoutMs = 5000;

const argv = process.argv;

if (argv.length !== 7) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <project_dir> <requests_path> <server_path> <diagnostic_output> <prng_seed>`);
    process.exit(EXIT_BAD_ARGS);
}

// CONVENTION: stderr is for output to the log; stdout is for output to the user

const [, , testDir, replayScriptPath, tsserverPath, diag, seed] = argv;
const diagnosticOutput = diag.toLocaleLowerCase() === "true";
const prng = randomSeed.create(seed);

testRegion(testDir, replayScriptPath, tsserverPath).catch(e => {
    console.error(e);
    process.exit(EXIT_UNHANDLED_EXCEPTION);
});

export async function testRegion(testDir: string, replayScriptPath: string, tsserverPath: string): Promise<void> {
    const requestTimes: Record<string, number> = {};
    const requestCounts: Record<string, number> = {};
    const start = performance.now();

    const oldCwd = process.cwd();
    const replayScriptHandle = await fs.promises.open(replayScriptPath, "w");
    try {
        // Needed for excludedDirectories
        process.chdir(testDir);
        await testRegionWorker(testDir, tsserverPath, replayScriptHandle, requestTimes, requestCounts);
    }
    finally {
        await replayScriptHandle.close();

        process.chdir(oldCwd);

        const end = performance.now();
        if (diagnosticOutput) {
            console.error(`Elapsed time ${Math.round(end - start)} ms`);
            for (const command in requestTimes) {
                console.error(`${command}:\t${Math.round(requestTimes[command])} ms (${requestCounts[command]} calls)`);
            }
        }
    }
}

async function testRegionWorker(testDir: string, tsserverPath: string, replayScriptHandle: fs.promises.FileHandle, requestTimes: Record<string, number>, requestCounts: Record<string, number>): Promise<void> {
    const files = await glob.glob("**/*.@(ts|tsx)", { cwd: testDir, absolute: false, ignore: ["**/node_modules/**", "**/*.min.js"], nodir: true, follow: false });

    const serverArgs = [
        "--disableAutomaticTypingAcquisition",
    ];

    replayScriptHandle.write(JSON.stringify({
        rootDirPlaceholder: testDirPlaceholder,
        serverArgs,
    }) + "\n");

    const server = sh.launchServer(
        tsserverPath,
        serverArgs,
        [
            "--max-old-space-size=4096",
            "--expose-gc",
        ]);

    // You can only wait for kill if the process being killed is the current process's
    // child, so it's helpful to our caller if we tear down the server.
    process.once("SIGTERM", async () => {
        exitExpected = true; // Shouldn't matter, but might as well
        await server.kill();
        // This is a sneaky way to invoke node's default SIGTERM handler
        process.kill(process.pid, "SIGTERM");
    });

    const waitingSemantic: ((arg: Body) => void)[] = [];
    const waitingRegion: ((arg: Body | undefined) => void)[] = [];
    server.on("event", async (e: any) => {
        console.log(e.event);
        if (e.event === "semanticDiag") {
            const waiting = waitingSemantic.pop();
            if (waiting) {
                waiting?.(e.body);
                waitingRegion.pop()?.(undefined);
            }
        }
        if (e.event === "regionSemanticDiag") {
            const waiting = waitingRegion.pop();
            waiting?.(e.body);
        }
    });

    let loadedNewProject = false;
    server.on("event", async (e: any) => {
        switch (e.event) {
            case "projectLoadingFinish":
                loadedNewProject = true;
                break;
            case "projectLanguageServiceState":
                if (!e.body.languageServiceDisabled) {
                    const languageServiceDisabledProject = e.body.projectName ? path.normalize(e.body.projectName) : "unknown project";
                    console.error(`Language service disabled for ${languageServiceDisabledProject}`);
                    exitExpected = true;
                    await server.kill();
                    process.exit(EXIT_LANGUAGE_SERVICE_DISABLED);
                }
                break;
        }
    });

    server.on("communicationError", async (err: any) => {
        console.error(`Error communicating with server:\n${err}`);
        exitExpected = true;
        await server.kill();
        process.exit(EXIT_SERVER_COMMUNICATION_ERROR);
    });

    let exitExpected = false;
    server.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (!exitExpected) {
            console.log(`Server exited prematurely with code ${code ?? "unknown"} and signal ${signal ?? "unknown"}`);
            process.exit(EXIT_SERVER_CRASH);
        }
    });

    let seq = 1;

    try {
        await message({
            "command": "configure",
            "arguments": {
                "preferences": {
                    "disableLineTextInReferences": true, // Match VS Code (and avoid uninteresting errors)
                    "includePackageJsonAutoImports": "auto",

                    // Completions preferences
                    "includeCompletionsForImportStatements": true,
                    "includeCompletionsWithSnippetText": true,
                    "includeAutomaticOptionalChainCompletions": true,
                    "includeCompletionsWithInsertText": true,
                    "includeCompletionsWithClassMemberSnippets": true,
                    "allowIncompleteCompletions": true,

                    // 'includeExternalModuleExports' configures this per request.
                    "includeCompletionsForModuleExports": false,
                },
                "watchOptions": {
                    "excludeDirectories": ["**/node_modules"]
                }
            }
        } satisfies RequestBase<typescript.server.protocol.ConfigureRequest>);

        const results: TestFileResult[] = [];
        const skipFileProb = 0.01;
        for (const openFileRelativePath of files) {
            if (results.length > 10 && prng.random() > skipFileProb) continue;

            const openFileAbsolutePath = path.join(testDirPlaceholder, openFileRelativePath).replace(/\\/g, "/");
            const openFileContents = await fs.promises.readFile(openFileRelativePath, { encoding: "utf-8" });
            const lineCount = openFileContents.split("\n").length;
            if (lineCount < 400) {
                continue;
            }

            await message({
                "command": "updateOpen",
                "arguments": {
                    "changedFiles": [],
                    "closedFiles": [],
                    "openFiles": [
                        {
                            "file": openFileAbsolutePath,
                            "fileContent": openFileContents,
                            "projectRootPath": testDirPlaceholder,
                        }
                    ]
                }
            } satisfies RequestBase<typescript.server.protocol.UpdateOpenRequest>);

            let r = await testFile(openFileAbsolutePath, openFileContents);
            if (r) {
                results.push(r);
            }

            await message({
                "command": "updateOpen",
                "arguments": {
                    "changedFiles": [],
                    "closedFiles": [openFileAbsolutePath],
                    "openFiles": [],
                }
            } satisfies RequestBase<typescript.server.protocol.UpdateOpenRequest>);
        }

        console.log(`RegionResults:\n${JSON.stringify(results)}\n`);

        console.error("Shutting down server");
        // Will throw if the server has crashed and `exitResult` will be considered below
        exitExpected = true;
        if (!await server.exitOrKill(exitTimeoutMs)) {
            console.log(`Server didn't exit within ${exitTimeoutMs} ms and had to be killed`);
            process.exit(EXIT_SERVER_EXIT_FAILED);
        }
    } catch (e) {
        console.error("Killing server after unhandled exception");
        console.error(e);

        exitExpected = true;
        await server.kill();
        process.exit(EXIT_UNHANDLED_EXCEPTION);
    }

    async function message(request: any, prob = 1) {
        if (prng.random() > prob) return undefined;

        request = {
            "seq": seq++,
            "type": "request",
            ...request,
        };

        const openFileContents = [];
        if (request.command === "updateOpen" || request.command === "applyChangedToOpenFiles") {
            for (const openFile of request.arguments.openFiles) {
                openFileContents.push(openFile.fileContent ?? openFile.content);
                delete openFile.fileContent;
                delete openFile.content;
            }
        }

        const replayString = JSON.stringify(request) + "\n";
        await replayScriptHandle.write(replayString);

        for (let i = 0; i < openFileContents.length; i++) {
            const propName = request.command === "updateOpen" ? "fileContent" : "content";
            request.arguments.openFiles[i][propName] = openFileContents[i];
        }

        const requestString = JSON.stringify(request).replace(new RegExp(testDirPlaceholder, "g"), testDir);

        const start = performance.now();
        const response = await server.message(JSON.parse(requestString));
        const end = performance.now();
        requestTimes[request.command] = (requestTimes[request.command] ?? 0) + (end - start);
        requestCounts[request.command] = (requestCounts[request.command] ?? 0) + 1;

        if (response && response.type === "response" && !response.success && response.message !== "No content available.") {
            const errorMessage = response.message ?? "Unknown error";
            if (diagnosticOutput) {
                console.error(`Request failed:
${JSON.stringify(request, undefined, 2)}
${JSON.stringify(response, undefined, 2)}`);
            }
            else {
                console.error(errorMessage);
            }
            console.log(JSON.stringify(response));

            exitExpected = true;
            await server.kill();
            process.exit(EXIT_SERVER_ERROR);
        }

        return response;
    }

    type TestFileResult = {
        filePath: string,
        results: (FullPerfResult | RegionPerfResult)[]
    }
    async function testFile(filePath: string, fileContents: string): Promise<TestFileResult | undefined> {
        console.error(`\nTesting file '${filePath}'`);
        const lines = fileContents.split("\n");
        let line = prng.intBetween(0, lines.length - 1);
        // look for a non-whitespace character
        while (!/\S/.test(lines[line]) && line < lines.length) {
            line++;
        }
        if (line >= lines.length) {
            return undefined;
        }
        const matches = Array.from(lines[line].matchAll(/\S/g)!);
        const matchIdx = prng.intBetween(0, matches.length - 1);
        const match = matches[matchIdx];
        const column = match.index;
        const oldChar = lines[line][column];

        const results = [];
        // Delete a character
        console.error(`\nDeleting line ${line + 1} column ${column + 1} char: '${oldChar}'`);
        
        await message({
            "command": "updateOpen",
            "arguments": {
                "changedFiles": [
                    {
                        "fileName": filePath,
                        "textChanges": [
                            {
                                "start": { "line": line + 1, "offset": column + 1 },
                                "end": { "line": line + 1, "offset": column + 2 },
                                "newText": ""
                            }
                        ],
                    }
                ],
                "closedFiles": [],
                "openFiles": []
            }
        } satisfies RequestBase<typescript.server.protocol.UpdateOpenRequest>);
        let r = await measureDiagnostics(filePath);
        results.push(r);

        // Insert a character
        console.error(`Inserting line ${line + 1} column ${column + 1} char: '${oldChar}'`);
        await message({
            "command": "updateOpen",
            "arguments": {
                "changedFiles": [
                    {
                        "fileName": filePath,
                        "textChanges": [
                            {
                                "start": { "line": line + 1, "offset": column + 1 },
                                "end": { "line": line + 1, "offset": column + 1 },
                                "newText": oldChar,
                            }
                        ],
                    }
                ],
                "closedFiles": [],
                "openFiles": []
            }
        } satisfies RequestBase<typescript.server.protocol.UpdateOpenRequest>);
        r = await measureDiagnostics(filePath);
        results.push(r);

        // Now do the same but with region diagnostics
        const totalLines = 200;
        const startLine = Math.max(0, line - totalLines);
        const endLine = Math.min(lines.length - 1, startLine + totalLines);
        const endOffset = lines[endLine].length;

        const range: FileRange = {
            startLine: startLine + 1,
            startOffset: 1,
            endLine: endLine + 1,
            endOffset: endOffset + 1,
        }

        // Delete a character
        console.error(`\nDeleting line ${line + 1} column ${column + 1} char: '${oldChar}'`);
        await message({
            "command": "updateOpen",
            "arguments": {
                "changedFiles": [
                    {
                        "fileName": filePath,
                        "textChanges": [
                            {
                                "start": { "line": line + 1, "offset": column + 1 },
                                "end": { "line": line + 1, "offset": column + 2 },
                                "newText": ""
                            }
                        ],
                    }
                ],
                "closedFiles": [],
                "openFiles": []
            }
        });
        r = await measureRegionDiagnostics(filePath, range);
        results.push(r);

        // Insert a character
        console.error(`Inserting line ${line + 1} column ${column + 1} char: '${oldChar}'`);
        await message({
            "command": "updateOpen",
            "arguments": {
                "changedFiles": [
                    {
                        "fileName": filePath,
                        "textChanges": [
                            {
                                "start": { "line": line + 1, "offset": column + 1 },
                                "end": { "line": line + 1, "offset": column + 1 },
                                "newText": oldChar,
                            }
                        ],
                    }
                ],
                "closedFiles": [],
                "openFiles": []
            }
        });
        r = await measureRegionDiagnostics(filePath, range);
        results.push(r);

        return {
            filePath,
            results,
        };
    }

    async function getDiagnostics(filePath: string): Promise<Body> {
        const promise: Promise<Body> = new Promise((resolve) => {
            waitingSemantic.push(resolve);
        });
        await message({
            "command": "geterr",
            "arguments": {
                "delay": 0,
                "files": [filePath],
            }
        } satisfies RequestBase<typescript.server.protocol.GeterrRequest>);
        return promise;
    }

    async function measureDiagnostics(filePath: string): Promise<FullPerfResult> { 
        console.error(`Checking diagnostics`);
        const diagnosticsBody = await getDiagnostics(filePath);

        console.error(`Time: ${diagnosticsBody.duration}ms`);
        console.error(`Diagnostics: ${JSON.stringify(diagnosticsBody)}`);

        return {
            fullDiagnosticsCount: diagnosticsBody.diagnostics.length,
            fullDuration: diagnosticsBody.duration,
        };
    }

    type FileRange = Omit<typescript.server.protocol.FileRangeRequestArgs, "file" | "projectFileName">;
    type GeterrRequestArgs = Omit<typescript.server.protocol.GeterrRequestArgs, "files"> & {
        files: (string | FileWithRanges)[],
    };
    type GeterrRequest = Omit<RequestBase<typescript.server.protocol.GeterrRequest>, "arguments"> & {
        arguments: GeterrRequestArgs
    };
    type FileWithRanges = {
        file: string,
        ranges: FileRange[];
    };
    async function getRegionDiagnostics(filePath: string, range: FileRange): Promise<[Promise<Body | undefined>, Promise<Body>]> {
        const semantic: Promise<Body> = new Promise((resolve) => {
            waitingSemantic.push(resolve);
        });
        const regionSemantic: Promise<Body | undefined> = new Promise((resolve) => {
            waitingRegion.push(resolve);
        });
        await message({
            "command": "geterr",
            "arguments": {
                "delay": 0,
                "files": [
                    {
                        "file": filePath,
                        "ranges": [range],
                    }
                ],
            }
        } satisfies GeterrRequest);
        return [regionSemantic, semantic];
    }

    async function measureRegionDiagnostics(filePath: string, range: FileRange): Promise<PerfResult> {
        console.error(`Checking diagnostics for region: ${JSON.stringify(range)}`);
        const [reg, sem] = await getRegionDiagnostics(filePath, range);
        const regionDiagnosticsBody = await reg;
        const semanticDiagnosticsBody = await sem;

        if (regionDiagnosticsBody) {
            console.error(`Region time: ${regionDiagnosticsBody.duration}ms`);
            console.error(`Region diagnostics: ${JSON.stringify(regionDiagnosticsBody)}`);
        }
        else {
            console.error(`Region skipped`);
        }
        console.error(`Semantic time: ${semanticDiagnosticsBody.duration}ms`);
        console.error(`Semantic diagnostics: ${JSON.stringify(semanticDiagnosticsBody)}`);

        return {
            regionDiagnosticsCount: regionDiagnosticsBody?.diagnostics.length,
            regionDuration: regionDiagnosticsBody?.duration,
            fullDiagnosticsCount: semanticDiagnosticsBody.diagnostics.length,
            fullDuration: semanticDiagnosticsBody.duration,
        };
    }
}
