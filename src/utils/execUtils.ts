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
    return new Promise<SpawnResult | undefined>((resolve, _reject) => {
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
            timeout: timeoutMs | 0, // Truncate to integer for spawn
        });

        let stdout = "";
        let stderr = "";

        childProcess.stdout.on("data", data => {
            stdout += data;
        });

        childProcess.stderr.on("data", data => {
            stderr += data;
        });

        childProcess.on("close", async (code, signal) => {
            // SIGTERM indicates timeout
            if (signal === "SIGTERM") {
                // CONSIDER: Does this do anything?  Won't all child processes have PPID 1 by now, since the parent has exited?
                await execAsync(path.join(__dirname, "..", "..", "scripts"), `./kill-children-of ${childProcess.pid}`);
                resolve(undefined);
                return;
            }

            resolve({ stdout, stderr, code, signal });
        });
    });
}
