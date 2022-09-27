// @ts-check

import sh = require("@typescript/server-harness");
import fs = require("fs");
import process = require("process");
import path = require("path");
import glob = require("glob");
import { performance } from "perf_hooks";
import randomSeed = require("random-seed");
import { EXIT_BAD_ARGS, EXIT_UNHANDLED_EXCEPTION, EXIT_SERVER_EXIT_FAILED, EXIT_SERVER_CRASH, EXIT_SERVER_ERROR, EXIT_LANGUAGE_SERVICE_DISABLED, EXIT_SERVER_COMMUNICATION_ERROR } from "./exerciseServerConstants";

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

exerciseServer(testDir, replayScriptPath, tsserverPath).catch(e => {
    console.error(e);
    process.exit(EXIT_UNHANDLED_EXCEPTION);
});

export async function exerciseServer(testDir: string, replayScriptPath: string, tsserverPath: string): Promise<void> {
    const requestTimes: Record<string, number> = {};
    const requestCounts: Record<string, number> = {};
    const start = performance.now();

    const oldCwd = process.cwd();
    const replayScriptHandle = await fs.promises.open(replayScriptPath, "w");
    try {
        // Needed for excludedDirectories
        process.chdir(testDir);
        await exerciseServerWorker(testDir, tsserverPath, replayScriptHandle, requestTimes, requestCounts);
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

async function exerciseServerWorker(testDir: string, tsserverPath: string, replayScriptHandle: fs.promises.FileHandle, requestTimes: Record<string, number>, requestCounts: Record<string, number>): Promise<void> {
    const files = await (new Promise<string[]>((resolve, reject) => {
        glob("**/*.@(ts|tsx|js|jsx)", { cwd: testDir, absolute: false, ignore: ["**/node_modules/**"], nodir: true, follow: false }, (err, results) => {
            if (err) {
                reject(err);
            }
            else {
                resolve(results);
            }
        });
    }));

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
                    "includePackageJsonAutoImports": "off" // Handle per-request instead
                },
                "watchOptions": {
                    "excludeDirectories": ["**/node_modules"]
                }
            }
        });

        const openFileAbsolutePaths = [];

        // NB: greater than 1 behaves the same as 1
        const skipFileProb = 1000 / files.length;
        for (const openFileRelativePath of files) {
            if (prng.random() > skipFileProb) continue;

            const openFileAbsolutePath = path.join(testDirPlaceholder, openFileRelativePath).replace(/\\/g, "/");

            if (openFileAbsolutePaths.length == 5) {
                const closedFileAbsolutePath = openFileAbsolutePaths.shift();
                // This could be combined with the next updateOpen, but it's easier to simplify the repro if they're separate
                await message({
                    "command": "updateOpen",
                    "arguments": {
                        "changedFiles": [],
                        "closedFiles": [closedFileAbsolutePath],
                        "openFiles": []
                    }
                });
            }

            openFileAbsolutePaths.push(openFileAbsolutePath);

            const openFileContents = await fs.promises.readFile(openFileRelativePath, { encoding: "utf-8" });
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
            });

            const triggerChars = [".", '"', "'", "`", "/", "@", "<", "#", " "];

            let line = 1;
            let column = 1;

            let prev = "";

            await message({
                "command": "organizeImports",
                "arguments": {
                    "scope": {
                        "type": "file",
                        "args": {
                            "file": openFileAbsolutePath
                        }
                    },
                    "skipDestructiveCodeActions": true
                }
            }, 0.5);

            await message({
                "command": "organizeImports",
                "arguments": {
                    "scope": {
                        "type": "file",
                        "args": {
                            "file": openFileAbsolutePath
                        }
                    },
                    "skipDestructiveCodeActions": false
                }
            }, 0.5);

            if (openFileContents.length < 1e6) {
                await message({
                    "command": "getOutliningSpans",
                    "arguments": {
                        "file": openFileAbsolutePath
                    }
                }, 0.9);
            }

            if (loadedNewProject) {
                loadedNewProject = false;

                const navtoResponse = await message({
                    "command": "navto",
                    "arguments": {
                        "searchValue": "a",
                        "maxResultCount": 256
                    }
                }, 0.5);

                const navtoEntry = navtoResponse?.body.find((x: any) => x.name.length > 4);
                if (navtoEntry) {
                    await message({
                        "command": "navto",
                        "arguments": {
                            "searchValue": navtoEntry.name.substr(0, 3),
                            "maxResultCount": 256
                        }
                    });
                }
            }

            for (let i = 0; i < openFileContents.length; i++) {
                const curr = openFileContents[i];
                const next = openFileContents[i + 1];

                // Increase probabilities around things that look like jsdoc, where we've had problems in the past
                const isAt = curr === "@";

                // Note that this only catches Latin letters - we'll test within tokens of non-Latin characters
                if (!(/\w/.test(prev) && /\w/.test(curr)) && !(/[ \t]/.test(prev) && /[ \t]/.test(curr))) {
                    await message({
                        "command": "definitionAndBoundSpan",
                        "arguments": {
                            "file": openFileAbsolutePath,
                            "line": line,
                            "offset": column,
                        }
                    }, isAt ? 0.5 : 0.001);

                    await message({
                        "command": "references",
                        "arguments": {
                            "file": openFileAbsolutePath,
                            "line": line,
                            "offset": column,
                        }
                    }, isAt ? 0.5 : 0.00005);

                    const invokedResponse = await message({
                        "command": "completionInfo",
                        "arguments": {
                            "file": openFileAbsolutePath,
                            "line": line,
                            "offset": column,
                            "includeExternalModuleExports": prng.random() < 0.01, // auto-imports are too slow to test everywhere
                            "includeInsertTextCompletions": true,
                            "triggerKind": 1,
                        }
                    }, isAt ? 0.5 : 0.001);

                    if (invokedResponse?.body && invokedResponse.body.entries.length > 0) {
                        await message({
                            "command": "completionEntryDetails",
                            "arguments": {
                                "file": openFileAbsolutePath,
                                "line": line,
                                "offset": column,
                                "entryNames": [
                                    invokedResponse.body.entries[0].name,
                                ],
                            }
                        });
                    }

                    const triggerCharIndex = triggerChars.indexOf(curr);
                    if (triggerCharIndex >= 0 && /\w/.test(prev)) {
                        await message({
                            "command": "completionInfo",
                            "arguments": {
                                "file": openFileAbsolutePath,
                                "line": line,
                                "offset": column,
                                "includeExternalModuleExports": false,
                                "includeInsertTextCompletions": true,
                                "triggerKind": 2,
                                "triggerCharacter": triggerChars[triggerCharIndex],
                            }
                        }, 0.005);
                    }
                }

                if (curr === "\r" || curr === "\n") {
                    if (line == 1) {
                        // Note that this does not modify openFileContents, so it does not update `i`
                        await message({
                            "command": "updateOpen",
                            "arguments": {
                                "changedFiles": [
                                    {
                                        "fileName": openFileAbsolutePath,
                                        "textChanges": [
                                            {
                                                "newText": " //comment",
                                                "start": {
                                                    "line": line,
                                                    "offset": column,
                                                },
                                                "end": {
                                                    "line": line,
                                                    "offset": column,
                                                }
                                            }
                                        ]
                                    }
                                ],
                                "closedFiles": [],
                                "openFiles": [],
                            }
                        }, 0.5);
                    }

                    line++;
                    column = 1;
                    if (curr === "\r" && next === "\n") {
                        i++;
                    }
                }
                else {
                    column++;
                }

                prev = curr;
            }
        }

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

        if (response && !response.success && response.message !== "No content available.") {
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
}