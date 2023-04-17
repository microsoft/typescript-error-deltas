import { createHash } from "crypto";

export function getHash(methods: string[]): string {
    const lines = methods.join("\n");
    return createHash("md5").update(lines).digest("hex");
}

export function getHashForStack(stack: string): string {
    const stackLines = stack.split(/\r?\n/);

    return getHash(stackLines);
}

export function getErrorMessageFromStack(stack: string): string {
    const stackLines = stack.split(/\r?\n/, 2);

    return stackLines[1];
}