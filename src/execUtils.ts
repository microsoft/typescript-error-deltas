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

export interface ExecFileResult {
    err: cp.ExecException | null,
    stdout: string,
    stderr: string,
}

/** Returns undefined if and only if executions times out. */
export function execFileWithTimeoutAsync(cwd: string, command: string, args: readonly string[], timeoutMs: number, env?: {}): Promise<ExecFileResult | undefined> {
    return new Promise<ExecFileResult | undefined>((resolve, _reject) => {
        let timedOut = false;

        const childProcess = cp.execFile(command, args, { cwd, env }, (err, stdout, stderr) => {
            if (!timedOut) {
                clearTimeout(timeout);
                resolve({ err, stdout, stderr } as const);
            }
        });

        const timeout = setTimeout(async () => {
            timedOut = true;
            await execAsync(path.join(__dirname, "..", "scripts"), `./kill-children-of ${childProcess.pid}`);
            if (!childProcess.kill()) {
                console.log(`Failed to kill ${childProcess.pid}`);
            }
            resolve(undefined);
        }, timeoutMs);
    });
}
