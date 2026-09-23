import * as cp from "node:child_process";
import * as fs from "node:fs";
import { constants } from "node:buffer";
import { x } from "tinyexec";

const MAX_LENGTH = constants.MAX_STRING_LENGTH;
const TRUNCATION_MESSAGE = "\n...truncated...\n";

function cappedAppend(current: string, data: string): string {
    if (current.length + data.length <= MAX_LENGTH) {
        return current + data;
    }
    // Truncate before appending to avoid exceeding the limit.
    // Preserve the tail of the output.
    const hasTruncationMessage = current.startsWith(TRUNCATION_MESSAGE);
    const available = hasTruncationMessage ? MAX_LENGTH : MAX_LENGTH - TRUNCATION_MESSAGE.length;
    const tail = data.length >= available
        ? data.slice(data.length - available)
        : current.slice(current.length - (available - data.length)) + data;
    return hasTruncationMessage ? tail : TRUNCATION_MESSAGE + tail;
}

export async function execFileAsync(cwd: string, command: string, args: readonly string[] = []): Promise<string> {
    console.log(`${cwd}> ${command} ${args.map(arg => JSON.stringify(arg)).join(" ")}`.trimEnd());
    const result = await x(command, args, {
        nodeOptions: {
            cwd,
            windowsHide: true,
        },
    });
    if (result.stdout.length) {
        console.log(result.stdout);
    }
    if (result.stderr.length) {
        console.log(result.stderr); // To stdout to maintain order
    }
    if (result.exitCode !== 0) {
        throw new Error(`${command} exited with code ${result.exitCode}`);
    }
    return result.stdout;
}

export async function execFileWithRetryAsync(cwd: string, command: string, args: readonly string[], attempts: number): Promise<string> {
    if (attempts < 1) {
        throw new Error("attempts must be at least 1");
    }

    for (let attempt = 1; ; attempt++) {
        try {
            return await execFileAsync(cwd, command, args);
        }
        catch (err) {
            if (attempt === attempts) {
                throw err;
            }
            console.log(`${command} failed; retrying (${attempt}/${attempts})`);
            await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        }
    }
}

export interface SpawnResult {
    stdout: string,
    stderr: string,
    code: number | null,
    signal: NodeJS.Signals | null,
}

/** Returns undefined if and only if executions times out. */
export function spawnWithTimeoutAsync(cwd: string, command: string, args: readonly string[], timeoutMs: number, env?: {}): Promise<SpawnResult | undefined> {
    console.log(`${cwd}> ${command} ${args.join(" ")}`);
    return new Promise<SpawnResult | undefined>((resolve, reject) => {
        if (timeoutMs <= 0) {
            resolve(undefined);
            return;
        }

        // We use `spawn`, rather than `execFile`, because package installation tends to write a lot
        // of data to stdout, overflowing `execFile`'s buffer.
        const childProcess = cp.spawn(command, args, {
            cwd,
            env,
            windowsHide: true,
        });

        let timedOut = false;

        let stdout = "";
        let stderr = "";

        childProcess.once("close", (code, signal) => {
            if (!timedOut) {
                clearTimeout(timeout);
                resolve({ stdout, stderr, code, signal });
            }
        });

        childProcess.stdout.on("data", data => {
            stdout = cappedAppend(stdout, data);
        });

        childProcess.stderr.on("data", data => {
            stderr = cappedAppend(stderr, data);
        });

        const timeout = setTimeout(async () => {
            timedOut = true;
            await killTree(childProcess);
            resolve(undefined);
        }, timeoutMs | 0); // Truncate to int
    });
}

function killTree(childProcess: cp.ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        // Ideally, we would wait for all of the processes to close, but we only get events for
        // this one, so we'll kill it last and hope for the best.
        childProcess.once("close", () => {
            resolve();
        });

        cp.execFile("ps", ["-e", "-o", "pid,ppid", "--no-headers"], (err, stdout) => {
            if (err) {
                reject (err);
                return;
            }

            const childProcessPid = childProcess.pid!;
            let sawChildProcessPid = false;

            const childMap: Record<number, number[]> = {};
            const pidList = stdout.trim().split(/\s+/);
            for (let i = 0; i + 1 < pidList.length; i += 2) {
                const childPid = +pidList[i];
                const parentPid = +pidList[i + 1];

                childMap[parentPid] ||= [];
                childMap[parentPid].push(childPid);

                sawChildProcessPid ||= childPid === childProcessPid;
            }

            if (!sawChildProcessPid) {
                // Descendent processes may still be alive, but we have no way to identify them
                resolve();
                return;
            }

            const strictDescendentPids: number[] = [];
            const stack: number[] = [ childProcessPid ];
            while (stack.length) {
                const pid = stack.pop()!;
                if (pid !== childProcessPid) {
                    strictDescendentPids.push(pid);
                }
                const children = childMap[pid];
                if (children) {
                    stack.push(...children);
                }
            }

            console.log(`Killing process ${childProcessPid} and its descendents: ${strictDescendentPids.join(", ")}`);

            strictDescendentPids.forEach(pid => process.kill(pid));
            childProcess.kill();
            // Resolve when we detect that childProcess has closed (above)
        });
    });
}

export async function getProcessRssKb(pid: number): Promise<number | undefined> {
    try {
        const status = await fs.promises.readFile(`/proc/${pid}/status`, { encoding: "utf-8" });
        const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
        return match ? parseInt(match[1], 10) : undefined;
    }
    catch {
        return undefined;
    }
}
