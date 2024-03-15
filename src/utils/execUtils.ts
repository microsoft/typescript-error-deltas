import cp = require("child_process");
import path = require("path");

export async function execAsync(cwd: string, command: string): Promise<string> {
    return new Promise((resolve, reject) => {
        console.log(`${cwd}> ${command}`);
        cp.exec(command, { cwd }, (err, stdout, stderr) => {
            if (stdout?.length) {
                console.log(stdout);
            }
            if (stderr?.length) {
                console.log(stderr); // To stdout to maintain order
            }

            if (err) {
                return reject(err);
            }
            return resolve(stdout);
        });
    });
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
            stdout += data;
        });

        childProcess.stderr.on("data", data => {
            stderr += data;
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

        cp.exec("ps -e -o pid,ppid --no-headers", (err, stdout) => {
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
