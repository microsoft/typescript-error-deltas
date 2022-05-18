import cp = require("child_process");
import path = require("path");
import url = require("url");

if (require.main === module) {
    const { argv } = process;

    if (argv.length !== 3 && argv.length !== 4) {
        console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} {file_path} [{line_number}]`);
        process.exit(-1);
    }

    let localPath = argv[2];
    let lineNumber = argv[3]; // May be undefined

    if (!lineNumber) {
        const lineNumberMatch = localPath.match(/[:,]([0-9]+)/);
        if (lineNumberMatch) {
            lineNumber = lineNumberMatch[1];
            localPath = localPath.substr(0, lineNumberMatch.index);
        }
    }

    getGithubUrl(localPath, !!lineNumber ? +lineNumber : undefined).then(
        url => {
            console.log(url);
        },
        err => {
            console.error(err.message);
            process.exit(-2);
        });
}

export interface SourceLocation {
    path: string;
    lineNumber?: number;
}

/**
 * Returns a GitHub URL (or a file URL, if the file is untracked).
 * Throws if no appropriate remote can be identified.
 */
export async function getGithubUrl(path: string, lineNumber?: number): Promise<string> {
    return (await getGithubUrlWorker([{ path, lineNumber }]))[0];
}

/**
 * Returns a GitHub URL (or a file URL, if untracked) for each location.
 * Throws if no appropriate remote can be identified.
 */
export async function getGithubUrls(locations: readonly SourceLocation[]): Promise<string[]> {
    return await getGithubUrlWorker(locations);
}

async function getGithubUrlWorker(locations: readonly SourceLocation[]): Promise<string[]> {
    if (!locations.length) {
        return [];
    }

    const cwd = path.dirname(locations[0].path);

    // This is a clever way to quickly retrieve the current commit
    const commit = await getExecOutput("git", ["rev-parse", "@"], cwd);
    if (!commit) {
        throw new Error(`Couldn't identify commit - not a repository?`);
    }

    const preferredRemote = await getPreferredRemote(cwd, commit);
    if (!preferredRemote) {
        throw new Error(`Commit ${commit} is not present on any remote`);
    }

    const repoUrl = (await getExecOutput("git", ["remote", "get-url", `${preferredRemote}`], cwd)).replace(/\.git$/, "");

    // In practice, it's common to see many requests for (different lines in) the same file
    const serverPathCache = new Map<string, string>(); // local to server

    const urls: string[] = [];
    for (const location of locations) {
        const localPath = path.resolve(location.path);
        const lineNumber = location.lineNumber;

        // We would just use path math, but this will also respect git's casing

        let serverPath = serverPathCache.get(localPath);
        if (!serverPath) {
            serverPath = await getExecOutput("git", ["ls-files", "--full-name", "--", `${localPath}`], cwd);
            serverPathCache.set(localPath, serverPath);
        }

        // Use a file URL if the file is untracked
        const fileUrl = serverPath
            ? `${repoUrl}/blob/${commit}/${serverPath}`
            : url.pathToFileURL(localPath).toString();

        // Cheat and add line numbers to file URLs too - VS Code handles it
        urls.push(lineNumber ? `${fileUrl}#L${lineNumber}` : fileUrl);
    }
    return urls;
}

async function getPreferredRemote(cwd: string, commit: string): Promise<string | undefined> {
    let containingRemotes: string[] = [];
    const refsRegex = /^refs\/remotes\/([^\/]+)/gm;
    const refs = await getExecOutput("git", ["for-each-ref", `--format=%(refname)`, "--contains", commit, "refs/remotes"], cwd);
    let refMatch: RegExpExecArray | null;
    while (refMatch = refsRegex.exec(refs)) {
        containingRemotes.push(refMatch[1]);
    }

    if (containingRemotes.length) {
        return containingRemotes.find(r => r === "origin") || containingRemotes[0];
    }

    // Sometimes, the for-each-ref trick doesn't work (e.g. in some submodules), so we fall back on a slower method

    // Sort `origin` to the front, if it's present
    const allRemotes = (await getExecOutput("git", ["remote"], cwd)).split(/\r\n?|\n/).sort((a, b) => +(b === "origin") - +(a === "origin"));

    for (const remote of allRemotes) {
        const status = await getSpawnExitCode("git", ["fetch", "--dry-run", "--quiet", remote, commit], cwd);
        if (status === 0) {
            return remote;
        }
    }

    return undefined;
}

function getExecOutput(command: string, args: readonly string[], cwd: string): Promise<string> {
    return new Promise(resolve => {
        cp.execFile(command, args, { cwd, encoding: "utf-8" }, (err, stdout, stderr) => {
            resolve((err || stderr) ? "" : stdout.trim());
        });
    });
}

function getSpawnExitCode(command: string, args: readonly string[], cwd: string): Promise<number> {
    return new Promise(resolve => {
        const proc = cp.spawn(command, args, { cwd, stdio: "ignore" });
        proc.on("close", code => resolve(code!));
        proc.stderr
    });
}
