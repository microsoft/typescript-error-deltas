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

        childProcess.on("close", (code, signal) => {
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
            // Note that killing childProcess resets the PPID of each of its children to 1, so this has to happen first
            await execAsync(path.join(__dirname, "..", "..", "scripts"), `./kill-children-of ${childProcess.pid}`);
            childProcess.kill("SIGKILL"); // This may fail if the process exited when its children were killed
            resolve(undefined);
        }, timeoutMs | 0); // Truncate to int
    });
}
