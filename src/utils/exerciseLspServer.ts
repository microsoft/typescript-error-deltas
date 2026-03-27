import fs from "fs";
import * as glob from "glob";
import path from "path";
import { performance } from "perf_hooks";
import process from "process";
import randomSeed from "random-seed";
import * as protocol from "vscode-languageserver-protocol";
import { EXIT_BAD_ARGS, EXIT_SERVER_COMMUNICATION_ERROR, EXIT_SERVER_CRASH, EXIT_SERVER_ERROR, EXIT_UNHANDLED_EXCEPTION } from "./exerciseServerConstants";
import { getProcessRssKb } from "./execUtils";
import * as lsp from "./lspHarness";

const testDirUriPlaceholder = "@PROJECT_ROOT_URI@";
const testDirPlaceholder = "@PROJECT_ROOT@";

const argv = process.argv;

if (argv.length !== 8) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <project_dir> <requests_path> <server_path> <diagnostic_output> <prng_seed> <stats_output>`);
    process.exit(EXIT_BAD_ARGS);
}

// CONVENTION: stderr is for output to the log; stdout is for output to the user

const [, , testDir, replayScriptPath, lspServerPath, diag, seed, statsOutputPath] = argv;
const diagnosticOutput = diag.toLocaleLowerCase() === "true";
const prng = randomSeed.create(seed);

exerciseLspServer(testDir, replayScriptPath, lspServerPath, statsOutputPath).catch(e => {
    console.error(e);
    process.exit(EXIT_UNHANDLED_EXCEPTION);
});

export interface LspRequestStats {
    successCount: number;
    failCount: number;
}

export async function exerciseLspServer(testDir: string, replayScriptPath: string, lspServerPath: string, statsOutputPath: string): Promise<void> {
    const requestTimes: Record<string, number> = {};
    const requestCounts: Record<string, number> = {};
    const requestStats: LspRequestStats = { successCount: 0, failCount: 0 };
    const start = performance.now();

    const oldCwd = process.cwd();
    const replayScriptHandle = await fs.promises.open(replayScriptPath, "w");
    try {
        await exerciseLspServerWorker(testDir, lspServerPath, replayScriptHandle, requestTimes, requestCounts, requestStats);
    }
    finally {
        await replayScriptHandle.close();
        if (statsOutputPath != "n/a") {
            await fs.promises.writeFile(statsOutputPath, JSON.stringify(requestStats), { encoding: "utf-8" });
        }

        process.chdir(oldCwd);

        const end = performance.now();
        if (diagnosticOutput) {
            console.error(`Elapsed time ${Math.round(end - start)} ms`);
            for (const method in requestTimes) {
                console.error(`${method}:\t${Math.round(requestTimes[method])} ms (${requestCounts[method]} calls)`);
            }
        }
    }
}

function getLanguageId(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case ".ts": return "typescript";
        case ".mts": return "typescript";
        case ".cts": return "typescript";

        case ".js": return "javascript";
        case ".mjs": return "javascript";
        case ".cjs": return "javascript";

        case ".tsx": return "typescriptreact";
        case ".jsx": return "javascriptreact";

        default: return "typescript";
    }
}

async function exerciseLspServerWorker(testDir: string, lspServerPath: string, replayScriptHandle: fs.promises.FileHandle, requestTimes: Record<string, number>, requestCounts: Record<string, number>, requestStats: LspRequestStats): Promise<void> {
    let seq = 0;
    const files = await glob.glob("**/*.@(ts|tsx|mts|cts|js|jsx|mjs|cjs)", { cwd: testDir, absolute: true, ignore: ["**/node_modules/**", "**/*.min.js"], nodir: true, follow: false });

    const serverArgs: string[] = ["--lsp", "--stdio"];

    await replayScriptHandle.write(JSON.stringify({
        rootDirUriPlaceholder: testDirUriPlaceholder,
        rootDirPlaceholder: testDirPlaceholder,
        serverArgs,
    }) + "\n");

    // TODO: would be nice if we could make this work with node_modules/.bin/*.CMD files on Windows
    if (path.extname(lspServerPath).toLowerCase().endsWith("js")) {
        // Use Node.js or Bun or whatever we ran under.
        serverArgs.unshift(lspServerPath);
        lspServerPath = process.execPath;
    }

    const server = lsp.startServer(lspServerPath, {
        args: serverArgs,
    }, { traceOutput: diagnosticOutput });

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
            const errorMessage = lastErrorLogMessage || `Server connection closed prematurely: ${e}`;
            console.log(JSON.stringify({ method: "unknown", message: errorMessage, seq }));
            console.error("Server connection closed prematurely:", e);
            process.exit(EXIT_SERVER_CRASH);
        }
    });

    async function killServer() {
        exitExpected = true;
        await server.kill();
    }
    
    let documentVersion = 0;

    const testDirUrl = lsp.filePathToUri(testDir);

    // Initialize the server
    const initializeParams: protocol.InitializeParams = {
        processId: null,
        capabilities: {
            textDocument: {
                completion: {
                    completionItem: {
                        snippetSupport: true,
                        insertReplaceSupport: true,
                        resolveSupport: {
                            properties: ["documentation", "detail", "additionalTextEdits"],
                        },
                        commitCharactersSupport: true,
                        deprecatedSupport: true,
                        preselectSupport: true,
                        labelDetailsSupport: true,
                        documentationFormat: ["markdown", "plaintext"],
                        insertTextModeSupport: {
                            valueSet: [
                                protocol.InsertTextMode.asIs,
                                protocol.InsertTextMode.adjustIndentation,
                            ],
                        },
                        // TODO: ...
                    },
                    contextSupport: true,
                },
                definition: {
                    linkSupport: true,
                },
                references: {},
                documentSymbol: {
                    hierarchicalDocumentSymbolSupport: true,
                    labelSupport: true,
                    // TODO: ...
                },
                foldingRange: {
                    foldingRange: { collapsedText: true },
                    // TODO: ...
                },
                codeAction: {
                    disabledSupport: true,
                    dataSupport: true,
                    // TODO: ...
                    codeActionLiteralSupport: {
                        codeActionKind: {
                            valueSet: [
                                protocol.CodeActionKind.QuickFix,
                                protocol.CodeActionKind.Refactor,
                                protocol.CodeActionKind.RefactorExtract,
                                protocol.CodeActionKind.RefactorInline,
                                protocol.CodeActionKind.RefactorRewrite,
                                protocol.CodeActionKind.Source,
                                protocol.CodeActionKind.SourceOrganizeImports,
                            ],
                        },
                    },
                },
                hover: { contentFormat: ["markdown", "plaintext"] },
                diagnostic: { relatedDocumentSupport: true },
                implementation: { linkSupport: true },
                typeDefinition: { linkSupport: true },
                documentHighlight: {},
                selectionRange: {},
                rename: {},
                callHierarchy: {},
                onTypeFormatting: {
                    dynamicRegistration: false,
                },
                // TODO: ...

            },
            workspace: {
                symbol: {
                    // TODO: ...
                },
                // TODO
                // codeLens: { refreshSupport: true },
                // inlayHint: { refreshSupport: true, },
                // foldingRange: { refreshSupport: true },
                // semanticTokens: { refreshSupport: true },
                // diagnostics: { refreshSupport: true },
                // configuration: true,
                // TODO: ...
            },
        },
        rootUri: testDirUrl,
        // workspaceFolders: [
        //     {
        //         uri: testDirUrl,
        //         name: path.basename(testDir),
        //     },
        // ],
    };

    try {
        await request("initialize", initializeParams);
        await notify("initialized", {});

        const openFileUris: string[] = [];

        // NB: greater than 1 behaves the same as 1
        const skipFileProb = 1000 / files.length;
        for (const openFileAbsolutePath of files) {
            if (prng.random() > skipFileProb) continue;

            const openFileUri = lsp.filePathToUri(openFileAbsolutePath);

            if (openFileUris.length === 5) {
                const closedFileUri = openFileUris.shift()!;
                // Close the document
                await notify("textDocument/didClose", {
                    textDocument: {
                        uri: closedFileUri,
                    },
                });
            }

            openFileUris.push(openFileUri);

            const openFileContents = await fs.promises.readFile(openFileAbsolutePath, { encoding: "utf-8" });
            const languageId = getLanguageId(openFileAbsolutePath);
            documentVersion++;

            // Open the document
            await notify("textDocument/didOpen", {
                textDocument: {
                    uri: openFileUri,
                    languageId,
                    version: documentVersion,
                    text: openFileContents,
                },
            });

            const triggerChars = [".", '"', "'", "`", "/", "@", "<", "#", " "];
            const signatureHelpTriggerChars = ["(", ",", "<"];

            let line = 0; // LSP uses 0-based lines
            let character = 0; // LSP uses 0-based characters
            let characterDelta = 0; // Net character offset from insertions/deletions on the current line
            const totalLines = openFileContents.split(/\r\n|\r|\n/).length;

            let prev = "";

            // Organize imports (source.organizeImports code action)
            await request("textDocument/codeAction", {
                textDocument: { uri: openFileUri },
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                context: {
                    diagnostics: [],
                    only: [protocol.CodeActionKind.SourceOrganizeImports],
                },
            }, 0.5);

            if (openFileContents.length < 1e6) {
                // Folding ranges (equivalent to getOutliningSpans)
                await request("textDocument/foldingRange", {
                    textDocument: { uri: openFileUri },
                });

                // Document symbols (equivalent to navtree/navbar)
                await request("textDocument/documentSymbol", {
                    textDocument: { uri: openFileUri },
                });

            }

            // Workspace symbol search (equivalent to navto)
            const workspaceSymbolResponse = await request("workspace/symbol", {
                query: "a",
            }, 0.5);

            if (workspaceSymbolResponse && Array.isArray(workspaceSymbolResponse) && workspaceSymbolResponse.length > 0) {
                const symbolEntry = workspaceSymbolResponse.find((x: protocol.SymbolInformation | protocol.WorkspaceSymbol) => x.name.length > 4);
                if (symbolEntry) {
                    await request("workspace/symbol", {
                        query: symbolEntry.name.slice(0, 3),
                    });
                }
            }

            // Diagnostics (equivalent to geterr)
            const diagnosticsPromise = request("textDocument/diagnostic", {
                textDocument: { uri: openFileUri },
            });

            const codeLensesPromise = request("textDocument/codeLens", {
                textDocument: { uri: openFileUri },
            });

            const inlayHintsPromise = request("textDocument/inlayHint", {
                textDocument: { uri: openFileUri },
                // TODO - this is still a hack.
                // Could just move it to the end after we've iterated through the file.
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: openFileContents.length } },
            });

            const [diagResult, codeLenses, _inlayHints] = await Promise.all([diagnosticsPromise, codeLensesPromise, inlayHintsPromise]);

            if (codeLenses) {
                await Promise.all(codeLenses.map(async (lens) => {
                    await request("codeLens/resolve", lens);
                }));
            }

            // Code actions based on diagnostics (equivalent to getCodeFixes)
            if (diagResult && "items" in diagResult && diagResult.items.length > 0) {
                const diag = diagResult.items[0];
                await request("textDocument/codeAction", {
                    textDocument: { uri: openFileUri },
                    range: diag.range,
                    context: {
                        diagnostics: [diag],
                        only: [protocol.CodeActionKind.QuickFix],
                    },
                }, 0.5);
            }

            const isJsx = languageId === "typescriptreact" || languageId === "javascriptreact";

            const standardProb = 0.001;
            for (let i = 0; i < openFileContents.length; i++) {
                const curr = openFileContents[i];
                const next = openFileContents[i + 1];

                // Increase probabilities around things that look like jsdoc, where we've had problems in the past
                const isAt = curr === "@";

                // Single character mutations (insertion/deletion/reset)
                const delimiters = ",.;:{}[]<>()";
                const isDelimiter = delimiters.includes(curr);
                const mutationRoll = prng.random();
                if (mutationRoll < (isDelimiter ? standardProb * 3 : standardProb)) {
                    const mutationType = prng.random();
                    const serverCharacter = character + characterDelta;
                    // Delimiter characters have increased probability of single character deletion
                    if (mutationType < (isDelimiter ? 2 / 20 : 5 / 20)) {
                        // Insert "."
                        documentVersion++;
                        await notify("textDocument/didChange", {
                            textDocument: {
                                uri: openFileUri,
                                version: documentVersion,
                            },
                            contentChanges: [
                                {
                                    range: {
                                        start: { line, character: serverCharacter },
                                        end: { line, character: serverCharacter },
                                    },
                                    text: ".",
                                },
                            ],
                        });
                        characterDelta++;
                    }
                    else if (mutationType < (isDelimiter ? 4 / 20 : 10 / 20)) {
                        // Insert random character
                        const randomChar = String.fromCharCode(prng.intBetween(32, 126));
                        documentVersion++;
                        await notify("textDocument/didChange", {
                            textDocument: {
                                uri: openFileUri,
                                version: documentVersion,
                            },
                            contentChanges: [
                                {
                                    range: {
                                        start: { line, character: serverCharacter },
                                        end: { line, character: serverCharacter },
                                    },
                                    text: randomChar,
                                },
                            ],
                        });
                        characterDelta++;
                    }
                    else if (mutationType < (isDelimiter ? 16 / 20 : 15 / 20)) {
                        // Delete current character, but not newlines (to preserve line count invariant)
                        if (curr !== "\r" && curr !== "\n") {
                            documentVersion++;
                            await notify("textDocument/didChange", {
                                textDocument: {
                                    uri: openFileUri,
                                    version: documentVersion,
                                },
                                contentChanges: [
                                    {
                                        range: {
                                            start: { line, character: serverCharacter },
                                            end: { line, character: serverCharacter + 1 },
                                        },
                                        text: "",
                                    },
                                ],
                            });
                            characterDelta--;
                        }
                    }
                    else if (mutationType < 19 / 20) {
                        // Delete rest of line (not including newline)
                        let endIdx = i;
                        while (endIdx < openFileContents.length && openFileContents[endIdx] !== "\r" && openFileContents[endIdx] !== "\n") {
                            endIdx++;
                        }
                        const remainingChars = endIdx - i;
                        if (remainingChars > 0) {
                            documentVersion++;
                            await notify("textDocument/didChange", {
                                textDocument: {
                                    uri: openFileUri,
                                    version: documentVersion,
                                },
                                contentChanges: [
                                    {
                                        range: {
                                            start: { line, character: serverCharacter },
                                            end: { line, character: serverCharacter + remainingChars },
                                        },
                                        text: "",
                                    },
                                ],
                            });
                            characterDelta -= remainingChars;
                            // Skip to the newline; remaining positions no longer exist on the server.
                            // The loop increment will place i at the newline for normal newline handling.
                            character += remainingChars;
                            i = endIdx - 1;
                        }
                    }
                    else {
                        // Reset file to original contents
                        documentVersion++;
                        await notify("textDocument/didChange", {
                            textDocument: {
                                uri: openFileUri,
                                version: documentVersion,
                            },
                            contentChanges: [
                                {
                                    text: openFileContents,
                                },
                            ],
                        });
                        characterDelta = 0;
                    }
                }

                const serverCharacter = Math.max(0, character + characterDelta);

                // Note that this only catches Latin letters - we'll test within tokens of non-Latin characters
                if (!(/\w/.test(prev) && /\w/.test(curr)) && !(/[ \t]/.test(prev) && /[ \t]/.test(curr))) {
                    // Definition (equivalent to definitionAndBoundSpan)
                    await request("textDocument/definition", {
                        textDocument: { uri: openFileUri },
                        position: { line, character: serverCharacter },
                    }, isAt ? 0.5 : standardProb);

                    // References
                    await request("textDocument/references", {
                        textDocument: { uri: openFileUri },
                        position: { line, character: serverCharacter },
                        context: { includeDeclaration: true },
                    }, isAt ? 0.5 : 0.00005);

                    // Hover (equivalent to quickinfo)
                    await request("textDocument/hover", {
                        textDocument: { uri: openFileUri },
                        position: { line, character: serverCharacter },
                    }, isAt ? 0.5 : standardProb);

                    // Implementation (equivalent to implementation)
                    await request("textDocument/implementation", {
                        textDocument: { uri: openFileUri },
                        position: { line, character: serverCharacter },
                    }, isAt ? 0.3 : 0.0003);

                    // Type definition (equivalent to typeDefinition)
                    await request("textDocument/typeDefinition", {
                        textDocument: { uri: openFileUri },
                        position: { line, character: serverCharacter },
                    }, isAt ? 0.3 : 0.0003);

                    // Document highlight (equivalent to documentHighlights)
                    await request("textDocument/documentHighlight", {
                        textDocument: { uri: openFileUri },
                        position: { line, character: serverCharacter },
                    }, isAt ? 0.3 : 0.0003);

                    // Call hierarchy (equivalent to prepareCallHierarchy + incoming/outgoing)
                    const callHierarchyItems = await request("textDocument/prepareCallHierarchy", {
                        textDocument: { uri: openFileUri },
                        position: { line, character: serverCharacter },
                    }, isAt ? 0.3 : 0.0002);

                    if (callHierarchyItems && callHierarchyItems.length > 0) {
                        const item = callHierarchyItems[0];
                        await request("callHierarchy/incomingCalls", { item }, 0.5);
                        await request("callHierarchy/outgoingCalls", { item }, 0.5);
                    }

                    // Code action for refactors (equivalent to getApplicableRefactors)
                    const refactorActions = await request("textDocument/codeAction", {
                        textDocument: { uri: openFileUri },
                        range: { start: { line, character: serverCharacter }, end: { line, character: serverCharacter } },
                        context: {
                            diagnostics: [],
                            only: [protocol.CodeActionKind.Refactor],
                        },
                    }, isAt ? 0.3 : 0.0005);

                    // Rename (equivalent to rename)
                    await request("textDocument/rename", {
                        textDocument: { uri: openFileUri },
                        position: { line, character: serverCharacter },
                        newName: "renamedSymbol",
                    }, isAt ? 0.2 : 0.0002);

                    // Selection range (equivalent to selectionRange)
                    await request("textDocument/selectionRange", {
                        textDocument: { uri: openFileUri },
                        positions: [{ line, character: serverCharacter }],
                    }, isAt ? 0.3 : 0.0003);

                    // Range formatting (equivalent to format with range)
                    await request("textDocument/rangeFormatting", {
                        textDocument: { uri: openFileUri },
                        range: { start: { line, character: 0 }, end: { line: Math.min(line + 10, totalLines - 1), character: 0 } },
                        options: {
                            tabSize: prng.intBetween(1, 4),
                            insertSpaces: prng.random() < 0.5,
                        },
                    }, isAt ? 0.3 : 0.0003);

                    if (isJsx) {
                        await request("textDocument/linkedEditingRange", {
                            textDocument: { uri: openFileUri },
                            position: { line, character: serverCharacter },
                        }, 0.001);
                    }

                    // Completions (equivalent to completionInfo)
                    const completionResponse = await request("textDocument/completion", {
                        textDocument: { uri: openFileUri },
                        position: { line, character: serverCharacter },
                        context: {
                            triggerKind: protocol.CompletionTriggerKind.Invoked,
                        },
                    }, isAt ? 0.5 : standardProb);

                    // Completion resolve (equivalent to completionEntryDetails)
                    if (completionResponse) {
                        const items = "items" in completionResponse ? completionResponse.items : completionResponse;
                        if (Array.isArray(items) && items.length > 0) {
                            await request("completionItem/resolve", items.find(item => item.preselect) ?? items[0]);
                        }
                    }

                    // Triggered completions
                    const triggerCharIndex = triggerChars.indexOf(curr);
                    if (triggerCharIndex >= 0 && /\w/.test(prev)) {
                        await request("textDocument/completion", {
                            textDocument: { uri: openFileUri },
                            position: { line, character: serverCharacter },
                            context: {
                                triggerKind: protocol.CompletionTriggerKind.TriggerCharacter,
                                triggerCharacter: triggerChars[triggerCharIndex],
                            },
                        }, standardProb);
                    }
                }

                let currisSignatureHelpTrigger = false;
                if ((currisSignatureHelpTrigger = signatureHelpTriggerChars.includes(curr)) || signatureHelpTriggerChars.includes(next)) {
                    // Signature help (equivalent to signatureHelp)
                    await request("textDocument/signatureHelp", {
                        textDocument: { uri: openFileUri },
                        position: { line, character: serverCharacter },
                        context: {
                            triggerCharacter: currisSignatureHelpTrigger ? curr : undefined,
                            triggerKind: currisSignatureHelpTrigger ? protocol.SignatureHelpTriggerKind.TriggerCharacter : protocol.SignatureHelpTriggerKind.Invoked,
                            isRetrigger: signatureHelpTriggerChars.includes(prev),
                        }
                    }, 0.005);
                }

                // On-type formatting (equivalent to formatonkey)
                if (curr === ";" || curr === "}") {
                    await request("textDocument/onTypeFormatting", {
                        textDocument: { uri: openFileUri },
                        position: { line, character: serverCharacter },
                        ch: curr,
                        options: {
                            tabSize: 4,
                            insertSpaces: true,
                        },
                    }, 0.01);
                }

                if (curr === "\r" || curr === "\n") {
                    if (line === 0) {
                        // Apply a text change (equivalent to updateOpen with changedFiles)
                        documentVersion++;
                        await notify("textDocument/didChange", {
                            textDocument: {
                                uri: openFileUri,
                                version: documentVersion,
                            },
                            contentChanges: [
                                {
                                    range: {
                                        start: { line, character: serverCharacter },
                                        end: { line, character: serverCharacter },
                                    },
                                    text: " //comment",
                                },
                            ],
                        });
                    }

                    line++;
                    character = 0;
                    characterDelta = 0;
                    if (curr === "\r" && next === "\n") {
                        i++;
                    }
                }
                else {
                    character++;
                }

                prev = curr;
            }

            // We do these at the end since we'd prefer to catch other crashes like completions first.
            await request("textDocument/formatting", {
                textDocument: { uri: openFileUri },
                options: {
                    tabSize: prng.intBetween(0, 4),
                    insertSpaces: prng.random() < 0.5,
                    trimTrailingWhitespace: prng.random() < 0.90,
                    trimFinalNewlines: prng.random() < 0.90,
                    insertFinalNewline: prng.random() < 0.90,
                },
            });
        }

        console.error("\nShutting down server");
        exitExpected = true;
        // Send shutdown request and exit notification
        await request(protocol.ShutdownRequest.method, undefined);
        await notify("exit", undefined);
    } catch (e) {
        console.error("Killing server after unhandled exception");
        console.error(e);
        
        await killServer();
        clearInterval(memoryLogInterval)
        process.exit(EXIT_UNHANDLED_EXCEPTION);
    }

    await server.kill();

    clearInterval(memoryLogInterval);

    async function request<K extends keyof lsp.RequestToParams>(
        method: K,
        params: lsp.RequestToParams[K],
        prob = 1,
    ): Promise<lsp.MessageResponseType[K] extends never ? never : lsp.MessageResponseType[K]> {
        seq++;
        if (prng.random() > prob) return undefined as any;

        const replayEntry = { kind: "request", method, params };
        const replayStr = JSON.stringify(replayEntry).replaceAll(testDirUrl, testDirUriPlaceholder).replaceAll(testDir, testDirPlaceholder);
        await replayScriptHandle.write(replayStr + "\n");

        const start = performance.now();
        try {
            const response = await server.sendRequest(method, params);
            const end = performance.now();
            requestTimes[method] = (requestTimes[method] ?? 0) + (end - start);
            requestCounts[method] = (requestCounts[method] ?? 0) + 1;
            requestStats.successCount++;
            return response;
        } catch (e: any) {
            const end = performance.now();
            requestTimes[method] = (requestTimes[method] ?? 0) + (end - start);
            requestCounts[method] = (requestCounts[method] ?? 0) + 1;
            requestStats.failCount++;

            const errorMessage = lastErrorLogMessage || e.message || "Unknown error";
            if (diagnosticOutput) {
                console.error(`Request failed:\n${JSON.stringify(replayEntry, undefined, 2)}\n${e}`);
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

    async function notify<K extends keyof lsp.NotificationToParams>(
        method: K,
        params: lsp.NotificationToParams[K],
    ): Promise<void> {
        seq++;
        const replayEntry = { kind: "notification", method, params };
        const replayStr = JSON.stringify(replayEntry).replaceAll(testDirUrl, testDirUriPlaceholder).replaceAll(testDir, testDirPlaceholder);
        await replayScriptHandle.write(replayStr + "\n");

        try {
            await server.sendNotification(method, params);
        }
        catch (e: any) {
            const errorMessage = lastErrorLogMessage || e.message || "Unknown error";
            if (diagnosticOutput) {
                console.error(`Notification failed:\n${JSON.stringify(replayEntry, undefined, 2)}\n${e}`);
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