import ge = require("./getErrors");
import pu = require("./packageUtils");
import git = require("./gitUtils");
import { execAsync, spawnWithTimeoutAsync } from "./execUtils";
import ip = require("./installPackages");
import ut = require("./userTestUtils");
import fs = require("fs");
import path = require("path");

interface Params {
    /**
     * Store test repos on a tmpfs.
     * Basically, the only reason not to do this would be lack of `sudo`.
     */
    tmpfs: boolean;
    /**
     * True to produce more verbose output (e.g. to help diagnose resource exhaustion issues).
     * Default is false to save time and space.
     */
    diagnosticOutput?: boolean | undefined;
    /**
     * Path to a JSON file containing an array of Repo objects to be processed.
     */
    repoListPath: string;
    /**
     * How many workers are processing the same repo list.
     */
    workerCount: number;
    /**
     * 1-indexed position of the current worker.
     */
    workerNumber: number;
    /**
     * Path to a directory in which a summary file should be written for each repo to be included in the output
     * (i.e. those with interesting failures).
     */
    resultDirPath: string;
}
export interface GitParams extends Params {
    testType: 'git';
    oldTscVersion: string;
    newTscVersion: string;
}
export interface UserParams extends Params {
    testType: 'user';
    oldTypescriptRepoUrl: string;
    oldHeadRef: string;
    prNumber: number;
}

const processCwd = process.cwd();
const processPid = process.pid;
const packageTimeout = 10 * 60 * 1000;
const executionTimeout = 10 * 60 * 1000;

export type RepoStatus =
    | "CloneFailed"
    | "PackageInstallFailed"
    | "OldBuildFailed"
    | "OldBuildHadErrors"
    | "NewBuildFailed"
    | "NewBuildHadErrors"
    | "NewBuildSucceeded"
    | "UnknownFailure"
    ;

interface RepoResult {
    readonly status: RepoStatus;
    readonly summary?: string;
}

// Exported for testing
export async function getRepoResult(
    repo: git.Repo,
    userTestsDir: string,
    oldTscPath: string,
    newTscPath: string,
    ignoreOldTscFailures: boolean,
    downloadDir: string,
    isDownloadDirOnTmpFs: boolean,
    diagnosticOutput: boolean): Promise<RepoResult> {

    if (isDownloadDirOnTmpFs) {
        await execAsync(processCwd, "sudo mount -t tmpfs -o size=4g tmpfs " + downloadDir);
    }

    try {
        const isUserTestRepo = !repo.url;

        const cloneStart = performance.now();
        try {
            if (isUserTestRepo) {
                await ut.copyUserRepo(downloadDir, userTestsDir, repo);
            }
            else {
                try {
                    console.log("Cloning if absent");
                    await git.cloneRepoIfNecessary(downloadDir, repo);
                }
                catch (err) {
                    reportError(err, "Error cloning " + repo.url);
                    return { status: "CloneFailed" };
                }
            }
        } finally {
            logStepTime("clone", cloneStart);
        }

        const repoDir = path.join(downloadDir, repo.name);

        const packageInstallStart = performance.now();
        try {
            console.log("Installing packages if absent");
            await installPackages(repoDir, /*recursiveSearch*/ !isUserTestRepo, packageTimeout, /*quietOutput*/ !diagnosticOutput, repo.types);
        }
        catch (err) {
            reportError(err, `Error installing packages for ${repo.name}`);
            if (diagnosticOutput || /ENOSPC/.test(String(err))) {
                await reportResourceUsage(downloadDir);
            }
            return { status: "PackageInstallFailed" };
        }
        finally {
            logStepTime("package install", packageInstallStart);
        }

        const buildStart = performance.now();
        try {
            console.log(`Building with ${oldTscPath} (old)`);
            const oldErrors = await ge.buildAndGetErrors(repoDir, isUserTestRepo, oldTscPath, executionTimeout, /*skipLibCheck*/ true);

            if (oldErrors.hasConfigFailure) {
                console.log("Unable to build project graph");
                console.log(`Skipping build with ${newTscPath} (new)`);
                return { status: "OldBuildFailed" };
            }

            const numProjects = oldErrors.projectErrors.length;

            let numFailed = 0;
            for (const oldProjectErrors of oldErrors.projectErrors) {
                if (oldProjectErrors.hasBuildFailure || oldProjectErrors.errors.length) {
                    numFailed++;
                }
            }

            // User tests ignores build failures.
            if (!ignoreOldTscFailures && numFailed === numProjects) {
                console.log(`Skipping build with ${newTscPath} (new)`);
                return { status: "OldBuildHadErrors" };
            }

            let sawNewRepoErrors = false;
            const owner = repo.owner ? `${repo.owner}/` : "";
            const url = repo.url ?? "";

            let summary = `<details open="true">
<summary>
<h2><a href="${url}">${owner}${repo.name}</a></h2>
</summary>

`;

            if (numFailed > 0) {
                const oldFailuresMessage = `${numFailed} of ${numProjects} projects failed to build with the old tsc and were ignored`;
                console.log(oldFailuresMessage);
                summary += `**${oldFailuresMessage}**\n`;
            }

            console.log(`Building with ${newTscPath} (new)`);
            const newErrors = await ge.buildAndGetErrors(repoDir, isUserTestRepo, newTscPath, executionTimeout, /*skipLibCheck*/ true);

            if (newErrors.hasConfigFailure) {
                console.log("Unable to build project graph");

                summary += ":exclamation::exclamation: **Unable to build the project graph with the new tsc** :exclamation::exclamation:\n";

                summary += "\n</details>\n";
                return { status: "NewBuildFailed", summary };
            }

            console.log("Comparing errors");
            for (const oldProjectErrors of oldErrors.projectErrors) {
                // To keep things simple, we'll focus on projects that used to build cleanly
                if (!ignoreOldTscFailures && (oldProjectErrors.hasBuildFailure || oldProjectErrors.errors.length)) {
                    continue;
                }

                // TS 5055 generally indicates that the project can't be built twice in a row without cleaning in between.
                // Filter out errors reported already on "old".
                const newProjectErrors = newErrors.projectErrors.find(pe => pe.projectUrl == oldProjectErrors.projectUrl)?.errors?.filter(e => e.code !== 5055)
                    .filter(ne => !oldProjectErrors.errors.find(oe => ge.errorEquals(oe, ne)));
                if (!newProjectErrors?.length) {
                    continue;
                }

                sawNewRepoErrors = true;

                const errorMessageMap = new Map<string, ge.Error[]>();
                const errorMessages: string[] = [];

                console.log(`New errors for ${oldProjectErrors.isComposite ? "composite" : "non-composite"} project ${oldProjectErrors.projectUrl}`);
                for (const newError of newProjectErrors) {
                    const newErrorText = newError.text;

                    console.log(`\tTS${newError.code} at ${newError.fileUrl ?? "project scope"}${oldProjectErrors.isComposite ? ` in ${newError.projectUrl}` : ``}`);
                    console.log(`\t\t${newErrorText}`);

                    if (!errorMessageMap.has(newErrorText)) {
                        errorMessageMap.set(newErrorText, []);
                        errorMessages.push(newErrorText);
                    }

                    errorMessageMap.get(newErrorText)!.push(newError);
                }

                summary += `### ${makeMarkdownLink(oldProjectErrors.projectUrl)}\n`
                for (const errorMessage of errorMessages) {
                    summary += ` - \`${errorMessage}\`\n`;

                    for (const error of errorMessageMap.get(errorMessage)!) {
                        summary += `   - ${error.fileUrl ? makeMarkdownLink(error.fileUrl) : "Project Scope"}${oldProjectErrors.isComposite ? ` in ${makeMarkdownLink(error.projectUrl)}` : ``}\n`;
                    }
                }
            }

            if (sawNewRepoErrors) {
                // sawNewErrors = true;
                // summary += repoSummary;
                summary += "\n</details>\n";
                return { status: "NewBuildHadErrors", summary };
            }
        }
        catch (err) {
            reportError(err, `Error building ${repo.url ?? repo.name}`);
            return { status: "UnknownFailure" };
        }
        finally {
            logStepTime("build", buildStart);
        }

        console.log(`Done ${repo.url ?? repo.name}`);
        return { status: "NewBuildSucceeded" };
    }
    finally {
        // Throw away the repo so we don't run out of space
        // Note that we specifically don't recover and attempt another repo if this fails
        console.log("Cleaning up repo");
        if (isDownloadDirOnTmpFs) {
            if (diagnosticOutput) {
                // Dump any processes holding onto the download directory in case umount fails
                await execAsync(processCwd, `lsof | grep ${downloadDir} || true`);
            }
            try {
                await execAsync(processCwd, "sudo umount " + downloadDir);
            }
            catch (e) {
                await execAsync(processCwd, `pstree -palT ${processPid}`);
                throw e;
            }
            if (diagnosticOutput) {
                await reportResourceUsage(downloadDir);
            }
        }
    }

    function logStepTime(step: string, start: number): void {
        if (diagnosticOutput) {
            const end = performance.now();
            console.log(`PERF { "repo": "${repo.url ?? repo.name}", "step": "${step}", "time": ${Math.round(end - start)} }`);
        }
    }
}

export const metadataFileName = "metadata.json";
export const resultFileNameSuffix = "results.txt";

export type StatusCounts = {
    [P in RepoStatus]?: number
};

export interface Metadata {
    readonly newTscResolvedVersion: string;
    readonly oldTscResolvedVersion: string;
    readonly statusCounts: StatusCounts;
}

function getWorkerRepos(allRepos: readonly git.Repo[], workerCount: number, workerNumber: number): git.Repo[] {
    const workerIndex = workerNumber - 1;
    const repoCount = allRepos.length;
    const batchSize = Math.ceil(repoCount / workerCount);
    const start = workerIndex * batchSize;
    const end = Math.min((workerIndex + 1) * batchSize, repoCount);
    console.log(`Worker ${workerNumber} will process repos [${start}, ${end})`);
    return allRepos.slice(start, end);
}

export async function mainAsync(params: GitParams | UserParams): Promise<void> {
    const { testType } = params;

    const downloadDir = params.tmpfs ? "/mnt/ts_downloads" : "./ts_downloads";
    // TODO: check first whether the directory exists and skip downloading if possible
    // TODO: Seems like this should come after the typescript download
    if (params.tmpfs)
        await execAsync(processCwd, "sudo mkdir " + downloadDir);
    else
        await execAsync(processCwd, "mkdir " + downloadDir);

    if (!(await pu.exists(params.resultDirPath))) {
        await fs.promises.mkdir(params.resultDirPath, { recursive: true });
    }

    // TODO: Only download if the commit has changed (need to map refs to commits and then download to typescript-COMMIT instead)
    const { oldTscPath, oldTscResolvedVersion, newTscPath, newTscResolvedVersion } = await downloadTypeScriptAsync(processCwd, params);

    // Get the name of the typescript folder.
    const oldTscDirPath = path.resolve(oldTscPath, "../../");
    const newTscDirPath = path.resolve(newTscPath, "../../");

    console.log("Old version = " + oldTscResolvedVersion);
    console.log("New version = " + newTscResolvedVersion);

    const userTestsDir = path.join(processCwd, "userTests");

    const allRepos: readonly git.Repo[] = JSON.parse(fs.readFileSync(params.repoListPath, { encoding: "utf-8" }));
    const repos = getWorkerRepos(allRepos, params.workerCount, params.workerNumber);

    // An object is easier to de/serialize than a real map
    const statusCounts: { [P in RepoStatus]?: number } = {};

    let i = 1;
    for (const repo of repos) {
        console.log(`Starting #${i++} / ${repos.length}: ${repo.url ?? repo.name}`);

        const { status, summary } = await getRepoResult(repo, userTestsDir, oldTscPath, newTscPath, /*ignoreOldTscFailures*/ testType === "user", downloadDir, params.tmpfs, !!params.diagnosticOutput);
        console.log(`Repo ${repo.url ?? repo.name} had status ${status}`);
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;
        if (summary) {
            const filename = repo.owner
                ? `${repo.owner}.${repo.name}.${resultFileNameSuffix}`
                : `${repo.name}.${resultFileNameSuffix}`;
            await fs.promises.writeFile(path.join(params.resultDirPath, filename), summary, { encoding: "utf-8" });
        }
    }

    if (params.tmpfs) {
        await execAsync(processCwd, "sudo rm -rf " + downloadDir);
        await execAsync(processCwd, "sudo rm -rf " + oldTscDirPath);
        await execAsync(processCwd, "sudo rm -rf " + newTscDirPath);
    }
    else {
        await execAsync(processCwd, "rm -rf " + downloadDir);
        await execAsync(processCwd, "rm -rf " + oldTscDirPath);
        await execAsync(processCwd, "rm -rf " + newTscDirPath);
    }

    console.log("Statuses");
    for (const status of Object.keys(statusCounts).sort()) {
        console.log(`${status}\t${statusCounts[status as RepoStatus]}`);
    }

    const metadata: Metadata = {
        newTscResolvedVersion,
        oldTscResolvedVersion,
        statusCounts,
    };
    await fs.promises.writeFile(path.join(params.resultDirPath, metadataFileName), JSON.stringify(metadata), { encoding: "utf-8" });
}

async function installPackages(repoDir: string, recursiveSearch: boolean, timeoutMs: number, quietOutput: boolean, types?: string[]) {
    let usedYarn = false;
    try {
        let timedOut = false;
        const startMs = performance.now();
        const commands = await ip.restorePackages(repoDir, /*ignoreScripts*/ true, quietOutput, recursiveSearch, /*lernaPackages*/ undefined, types);
        for (const { directory: packageRoot, tool, arguments: args } of commands) {
            if (timedOut) break;

            usedYarn = usedYarn || tool === ip.InstallTool.Yarn;

            const elapsedMs = performance.now() - startMs;
            const packageRootDescription = packageRoot.substring(repoDir.length + 1) || "root directory";

            // yarn2 produces extremely verbose output unless CI=true is set and it should be harmless for yarn1 and npm
            const spawnResult = await spawnWithTimeoutAsync(packageRoot, tool, args, timeoutMs - elapsedMs, { ...process.env, CI: "true" });
            if (!spawnResult) {
                throw new Error(`Timed out after ${timeoutMs} ms`);
            }

            if (spawnResult.code || spawnResult.signal) {
                if (tool === ip.InstallTool.Npm && args[0] === "ci" && /update your lock file/.test(spawnResult.stderr)) {
                    const elapsedMs2 = performance.now() - startMs;
                    const args2 = args.slice();
                    args2[0] = "install";
                    const spawnResult2 = await spawnWithTimeoutAsync(packageRoot, tool, args2, timeoutMs - elapsedMs2, { ...process.env, CI: "true" });
                    if (spawnResult2 && !spawnResult2.code && !spawnResult2.signal) {
                        continue; // Succeeded on retry
                    }
                }

                const errorText = `Exited with ${spawnResult.code ? `code ${spawnResult.code}` : `signal ${spawnResult.signal}`}
${spawnResult.stdout.trim() || "No stdout"}\n${spawnResult.stderr.trim() || "No stderr"}`;

                if (/(?:ex|s)amples?\//i.test(packageRootDescription) || /tests?\//i.test(packageRootDescription)) {
                    console.log(`Ignoring package install error from non-product folder ${packageRootDescription}:`);
                    console.log(sanitizeErrorText(errorText));
                }
                else {
                    throw new Error(`Failed to install packages for ${packageRootDescription}:\n${errorText}`);
                }
            }
        }
    }
    finally {
        if (usedYarn) {
            await execAsync(repoDir, "yarn cache clean --all");
        }
    }
}

async function reportResourceUsage(downloadDir: string) {
    try {
        console.log("Memory");
        await execAsync(processCwd, "free -h");
        console.log("Disk");
        await execAsync(processCwd, "df -h");
        await execAsync(processCwd, "df -i");
        console.log("Download Directory");
        await execAsync(processCwd, "ls -lh " + downloadDir);
        console.log("Home Directory");
        await execAsync(processCwd, "du -csh ~/.[^.]*");
        await execAsync(processCwd, "du -csh ~/.cache/*");
    }
    catch { } // noop
}

export function reportError(err: any, message: string) {
    console.log(`${message}:`);
    if (err.message && err.stack && err.stack.indexOf(err.message) >= 0) {
        console.log(sanitizeErrorText(err.stack));
    }
    else {
        console.log(sanitizeErrorText(err.message ?? "No message"));
        console.log(sanitizeErrorText(err.stack ?? "Unknown Stack"));
    }
}

function sanitizeErrorText(text: string): string {
    return reduceSpew(text).replace(/(^|\n)/g, "$1> ");
}

function reduceSpew(message: string): string {
    // These are uninteresting in general and actually problematic when there are
    // thousands of instances of ENOSPC (which also appears as an error anyway)
    return message.replace(/npm WARN.*\n/g, "");
}

function makeMarkdownLink(url: string) {
    const match = /\/blob\/[a-f0-9]+\/(.+)$/.exec(url);
    return !match
        ? url
        : `[${match[1]}](${url})`;
}

async function downloadTypeScriptAsync(cwd: string, params: GitParams | UserParams): Promise<{ oldTscPath: string, oldTscResolvedVersion: string, newTscPath: string, newTscResolvedVersion: string }> {
    if (params.testType === 'user') {
        const { tscPath: oldTscPath, resolvedVersion: oldTscResolvedVersion } = await downloadTypescriptRepoAsync(cwd, params.oldTypescriptRepoUrl, params.oldHeadRef);
        // We need to handle the ref/pull/*/merge differently as it is not a branch and cannot be pulled during clone.
        const { tscPath: newTscPath, resolvedVersion: newTscResolvedVersion } = await downloadTypescriptPrAsync(cwd, params.oldTypescriptRepoUrl, params.prNumber);

        return {
            oldTscPath,
            oldTscResolvedVersion,
            newTscPath,
            newTscResolvedVersion
        };
    }
    else if (params.testType === 'git') {
        const { tscPath: oldTscPath, resolvedVersion: oldTscResolvedVersion } = await downloadTypeScriptNpmAsync(cwd, params.oldTscVersion);
        const { tscPath: newTscPath, resolvedVersion: newTscResolvedVersion } = await downloadTypeScriptNpmAsync(cwd, params.newTscVersion);

        return {
            oldTscPath,
            oldTscResolvedVersion,
            newTscPath,
            newTscResolvedVersion
        };
    }
    else {
        throw new Error('Invalid parameters');
    }
}

export async function downloadTypescriptRepoAsync(cwd: string, repoUrl: string, headRef: string): Promise<{ tscPath: string, resolvedVersion: string }> {
    const repoName = `typescript-${headRef}`;
    await git.cloneRepoIfNecessary(cwd, { name: repoName, url: repoUrl, branch: headRef });

    const repoPath = path.join(cwd, repoName);

    return {
        // tscPath: path.join(repoPath, "lib", "tsc.js"),// Handy for local testing
        tscPath: await buildTsc(repoPath),
        resolvedVersion: headRef
    };
}

async function downloadTypescriptPrAsync(cwd: string, repoUrl: string, prNumber: number): Promise<{ tscPath: string, resolvedVersion: string }> {
    const repoName = `typescript-${prNumber}`;
    await git.cloneRepoIfNecessary(cwd, { name: repoName, url: repoUrl });

    const repoPath = path.join(cwd, repoName);
    const headRef = `refs/pull/${prNumber}/merge`;

    await git.checkout(repoPath, headRef);

    return {
        // tscPath: path.join(repoPath, "lib", "tsc.js"),// Handy for local testing
        tscPath: await buildTsc(repoPath),
        resolvedVersion: headRef
    };
}

async function buildTsc(repoPath: string) {
    await execAsync(repoPath, "npm ci");
    await execAsync(repoPath, "npm run build:compiler");

    // We build the LKG for the benefit of scenarios that want to install it as an npm package
    await execAsync(repoPath, "npx gulp configure-insiders");
    await execAsync(repoPath, "npx gulp LKG");

    return path.join(repoPath, "built", "local", "tsc.js");
}

async function downloadTypeScriptNpmAsync(cwd: string, version: string): Promise<{ tscPath: string, resolvedVersion: string }> {
    const tarName = (await execAsync(cwd, `npm pack typescript@${version} --quiet`)).trim();

    const tarMatch = /^(typescript-(.+))\..+$/.exec(tarName);
    if (!tarMatch) {
        throw new Error("Unexpected tarball name format: " + tarName);
    }

    const resolvedVersion = tarMatch[2];
    const dirName = tarMatch[1];
    const dirPath = path.join(processCwd, dirName);

    await execAsync(cwd, `tar xf ${tarName} && rm ${tarName}`);
    await fs.promises.rename(path.join(processCwd, "package"), dirPath);

    const tscPath = path.join(dirPath, "lib", "tsc.js");
    if (!await pu.exists(tscPath)) {
        throw new Error("Cannot find file " + tscPath);
    }

    return { tscPath, resolvedVersion };
}
