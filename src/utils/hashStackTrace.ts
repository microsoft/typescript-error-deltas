import { createHash } from "crypto";

/** Matches any line containing 'tsserver.js' followed by line numbers. */
const serverLinePattern = /tsserver\.js:(\d+)(?::(\d+))?/i;

export function getHash(methods: string[]): string {
    const lines = methods.join("\n");
    return createHash("md5").update(lines).digest("hex");
}

export function getHashForStack(stack: string): string {
    const stackLines = stack.split(/\r?\n|\r/);

    const errorMessage = stackLines[1];

    // We will only match methods that contains tsserver. Everything else is ignored.
    return getHash([errorMessage, ...stackLines.filter(l => serverLinePattern.exec(l))]);
}

export function getErrorMessageFromStack(stack: string): string {
    const stackLines = stack.split(/\r?\n|\r/, 2);

    return stackLines[1];
}