import { createHash } from "crypto";

export function getHash(methods: string[]): string {
    const lines = methods.join("\n");
    return createHash("md5").update(lines).digest("hex");
}

export function getHashForStack(stack: string): string {
    const stackLines = stack.split(/\r?\n/);

    return getHash(stackLines);
}

/**
 * Produces a stable hash for Go stack traces (e.g. from the LSP server).
 * Strips volatile parts that change between runs:
 * - The first line (panic message with specific runtime values)
 * - Memory addresses like 0xc004bfed20
 * - Goroutine IDs like "goroutine 554"
 * Keeps function names and source file locations for meaningful grouping.
 */ 
export function getHashForGoStack(stack: string): string {
    const stackLines = stack.split(/\r?\n/);
    // Skip the first line (panic message with variable runtime values)
    const normalized = stackLines.slice(1).map(line => {
        line = line.trim();
        let ignoreIdx;
        if ((ignoreIdx = line.indexOf(" +0x")) !== -1) {
            // Ignore trailing offsets e.g. " +0x58" in "github.com/microsoft/typescript-go/internal/lsp/server.go:872 +0x58"
            line = line.slice(0, ignoreIdx);
        } else if ((ignoreIdx = line.lastIndexOf(" in goroutine ")) !== -1) {
            // e.g. "created by github.com/microsoft/typescript-go/internal/lsp.(*Server).dispatchLoop in goroutine 10" ->
            // "created by github.com/microsoft/typescript-go/internal/lsp.(*Server).dispatchLoop"
            line = line.slice(0, ignoreIdx);
        }
        // Strip goroutine IDs: "goroutine 554 [running]:" -> "goroutine [running]:"
        line = line.replace(/goroutine \d+/, "goroutine <number>");
        // Strip function arguments
        line = line.replace(/^(.+)\(.+$/g, "$1()");
        return line;
    });
    console.log("Normalized Go stack trace:");
    console.log(normalized.join("\n"));
    return getHash(normalized);
}

export function getErrorMessageFromStack(stack: string): string {
    const stackLines = stack.split(/\r?\n/, 2);

    return stackLines[1];
}