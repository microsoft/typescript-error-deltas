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
        // Strip goroutine IDs: "goroutine 554 [running]:" -> "goroutine [running]:"
        line = line.replace(/goroutine \d+/, "goroutine <number>");
        // Strip hex memory addresses: 0xc004bfed20, 0x441ea5?
        line = line.replace(/0x[0-9a-fA-F]+\??/g, "0x?");
        // Strip Go function argument lists (all hex pointers in parens)
        line = line.replace(/\((?:0x\?[,} ]*)+\)/g, "(...)");
        // Strip +0x... offsets at end of lines
        line = line.replace(/\+0x\?$/g, "");
        return line;
    });
    return getHash(normalized);
}

export function getErrorMessageFromStack(stack: string): string {
    const stackLines = stack.split(/\r?\n/, 2);

    return stackLines[1];
}