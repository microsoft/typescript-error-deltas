import ge = require("./getErrors");
import pu = require("./packageUtils");
import git = require("./gitUtils");
import type { GitResult, UserResult } from "./gitUtils";
import ip = require("./installPackages");
import ur = require("./userRepos");
import cp = require("child_process");
import fs = require("fs");
import path = require("path");

interface Params {
    /** True to post the result to Github, false to print to console.  */
    postResult: boolean;
    /** Store test repos on a tmpfs */
    tmpfs: boolean;
    /**
     * Number of repos to test, undefined for the default.
     * Git repos are chosen from Typescript-language repos based on number of stars; default is 100.
     * User repos start at the top of the list; default is all of them.
     */
    repoCount?: number | undefined;
    /**
     * The index to start counting repositories; defaults to `0`.
     * If `repoStartIndex` is 100 and `repoCount` is 100, the 100th to the 199th repos will be tested.
     */
    repoStartIndex?: number | undefined;
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
    sourceIssue: number;
    requestingUser: string;
    statusComment: number;
    topRepos: boolean;
}

const skipRepos = [
    "https://github.com/storybookjs/storybook", // Too big to fit on VM
    "https://github.com/microsoft/frontend-bootcamp", // Can't be built twice in a row
    "https://github.com/BabylonJS/Babylon.js", // Runs out of space during compile
];
const processCwd = process.cwd();
const processPid = process.pid;
const executionTimeout = 10 * 60 * 1000;
export async function innerloop(params: GitParams | UserParams, topGithubRepos: boolean, downloadDir: string, userTestDir: string, repo: git.Repo, oldTscPath: string, newTscPath: string, outputs: string[]) {
    const { testType } = params
    if (params.tmpfs)
        await execAsync(processCwd, "sudo mount -t tmpfs -o size=4g tmpfs " + downloadDir);

    try {
        if (repo.url) {
            try {
                console.log("Cloning if absent");
                await git.cloneRepoIfNecessary(downloadDir, repo);
            }
            catch (err) {
                reportError(err, "Error cloning " + repo.url);
                return;
            }
        }
        else {
            await ur.copyUserRepo(downloadDir, userTestDir, repo);
        }

        const repoDir = path.join(downloadDir, repo.name);

        try {
            console.log("Installing packages if absent");
            await withTimeout(executionTimeout, installPackages(repoDir, /*recursiveSearch*/ topGithubRepos, repo.types));
        }
        catch (err) {
            reportError(err, `Error installing packages for ${err.packageRoot ?? "some package.json file"} in ${repo.name}`);
            await reportResourceUsage(downloadDir);
            return;
        }

        try {
            console.log(`Building with ${oldTscPath} (old)`);
            const oldErrors = await buildAndGetErrors(repoDir, oldTscPath, /*skipLibCheck*/ true, topGithubRepos, params.postResult);

            if (oldErrors.hasConfigFailure) {
                console.log("Unable to build project graph");
                console.log(`Skipping build with ${newTscPath} (new)`);
                return;
            }

            const numProjects = oldErrors.projectErrors.length;

            let numFailed = 0;
            for (const oldProjectErrors of oldErrors.projectErrors) {
                if (oldProjectErrors.hasBuildFailure || oldProjectErrors.errors.length) {
                    numFailed++;
                }
            }

            // User tests ignores build failures.
            if (testType === "git" && numFailed === numProjects) {
                console.log(`Skipping build with ${newTscPath} (new)`);
                return;
            }

            let sawNewRepoErrors = false;
            const owner = repo.owner ? `${repo.owner}/` : "";
            const url = repo.url ? `(${repo.url})` : "";

            let repoSummary = `# [${owner}${repo.name}]${url}\n`;

            if (numFailed > 0) {
                const oldFailuresMessage = `${numFailed} of ${numProjects} projects failed to build with the old tsc`;
                console.log(oldFailuresMessage);
                repoSummary += `**${oldFailuresMessage}**\n`;
            }

            console.log(`Building with ${newTscPath} (new)`);
            const newErrors = await buildAndGetErrors(repoDir, newTscPath, /*skipLibCheck*/ true, topGithubRepos, params.postResult);

            if (newErrors.hasConfigFailure) {
                console.log("Unable to build project graph");

                repoSummary += ":exclamation::exclamation: **Unable to build the project graph with the new tsc** :exclamation::exclamation:\n";

                outputs.push(repoSummary)
                return true;
            }

            console.log("Comparing errors");
            for (const oldProjectErrors of oldErrors.projectErrors) {
                // To keep things simple, we'll focus on projects that used to build cleanly
                if (testType === "git" && (oldProjectErrors.hasBuildFailure || oldProjectErrors.errors.length)) {
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

                repoSummary += `### ${makeMarkdownLink(oldProjectErrors.projectUrl)}\n`
                for (const errorMessage of errorMessages) {
                    repoSummary += ` - \`${errorMessage}\`\n`;

                    for (const error of errorMessageMap.get(errorMessage)!) {
                        repoSummary += `   - ${error.fileUrl ? makeMarkdownLink(error.fileUrl) : "Project Scope"}${oldProjectErrors.isComposite ? ` in ${makeMarkdownLink(error.projectUrl)}` : ``}\n`;
                    }
                }
            }

            if (sawNewRepoErrors) {
                // sawNewErrors = true;
                // summary += repoSummary;
                outputs.push(repoSummary)
                return true;
            }
        }
        catch (err) {
            reportError(err, "Error building " + repo.url ?? repo.name);
            return;
        }

        console.log("Done " + repo.url ?? repo.name);
    }
    finally {
        // Throw away the repo so we don't run out of space
        // Note that we specifically don't recover and attempt another repo if this fails
        console.log("Cleaning up repo");
        if (params.tmpfs) {
            await execAsync(processCwd, "sudo umount " + downloadDir);
            await reportResourceUsage(downloadDir);
        }
    }
}

export async function mainAsync(params: GitParams | UserParams): Promise<GitResult | UserResult | undefined> {
    const { testType } = params;

    const downloadDir = params.tmpfs ? "/mnt/ts_downloads" : "./ts_downloads";
    // TODO: check first whether the directory exists and skip downloading if possible
    // TODO: Seems like this should come after the typescript download
    if (params.tmpfs)
        await execAsync(processCwd, "sudo mkdir " + downloadDir);
    else
        await execAsync(processCwd, "mkdir " + downloadDir);

    // TODO: Only download if the commit has changed (need to map refs to commits and then download to typescript-COMMIT instead)
    const { oldTscPath, oldTscResolvedVersion, newTscPath, newTscResolvedVersion } = await downloadTypeScriptAsync(processCwd, params);

    // Get the name of the typescript folder.
    const oldTscDirPath = path.resolve(oldTscPath, "../../");
    const newTscDirPath = path.resolve(newTscPath, "../../");

    console.log("Old version = " + oldTscResolvedVersion);
    console.log("New version = " + newTscResolvedVersion);

    const userTestDir = path.join(processCwd, "userTests");

    const topGithubRepos = testType === "git" || params.topRepos;
    const repos = topGithubRepos ? await git.getPopularTypeScriptRepos(params.repoCount, params.repoStartIndex)
        : testType === "user" ? ur.getUserTestsRepos(userTestDir)
        : undefined;

    if (!repos) {
        throw new Error(`Parameter <test_type> with value ${testType} is not existent.`);
    }

    const outputs: string[] = [];
    // let summary = "";
    let sawNewErrors: true | undefined = undefined;

    let i = 0;
    const startIndex = params.repoStartIndex ?? 0;
    const maxCount = Math.min(typeof params.repoCount === 'number' ? params.repoCount : Infinity, repos.length) + startIndex;

    for (const repo of repos) {
        if (repo.url && skipRepos.includes(repo.url)) continue;
        i++;
        if (i > maxCount) break;
        console.log(`Starting #${i + startIndex} / ${maxCount}: ${repo.url ?? repo.name}`);
        if (await innerloop(params, topGithubRepos, downloadDir, userTestDir, repo, oldTscPath, newTscPath, outputs)) {
            sawNewErrors = true;
        }
    }
    const summary = outputs.join("")

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

    if (testType === "git") {
        const title = `[NewErrors] ${newTscResolvedVersion} vs ${oldTscResolvedVersion}`;
        const body = `The following errors were reported by ${newTscResolvedVersion}, but not by ${oldTscResolvedVersion}
[Pipeline that generated this bug](https://typescript.visualstudio.com/TypeScript/_build?definitionId=48)
[File that generated the pipeline](https://github.com/microsoft/typescript-error-deltas/blob/main/azure-pipelines-gitTests.yml)

${summary}`;
        return git.createIssue(params.postResult, title, body, !!sawNewErrors);
    }
    else if (testType === "user") {
        const body = summary
            ? `@${params.requestingUser}\nThe results of the user tests run you requested are in!\n<details><summary> Here they are:</summary><p>\n<b>Comparison Report - ${oldTscResolvedVersion}..${newTscResolvedVersion}</b>\n\n${summary}</p></details>`
            : `@${params.requestingUser}\nGreat news! no new errors were found between ${oldTscResolvedVersion}..${newTscResolvedVersion}`;
        return git.createComment(params.sourceIssue, params.statusComment, params.postResult, body);
    }
    else {
        throw new Error(`testType "${(params as any).testType}" is not a recognised test type.`);
    }
}

async function buildAndGetErrors(repoDir: string, tscPath: string, skipLibCheck: boolean, topGithubRepos: boolean, realTimeout: boolean): Promise<ge.RepoErrors> {
    if (realTimeout) {
        const p = new Promise<ge.RepoErrors>((resolve, reject) => {
            const p = cp.fork(path.join(__dirname, "run-build.js"));
            p.on('message', (m: 'ready' | ge.RepoErrors) =>
                m === 'ready'
                    ? p.send({ repoDir, tscPath, topGithubRepos, skipLibCheck })
                    : resolve(m));
            p.on('exit', reject);
        });
        return withTimeout(executionTimeout, p);
    }
    else {
        return ge.buildAndGetErrors(repoDir, tscPath, topGithubRepos, skipLibCheck)
    }
}

async function installPackages(repoDir: string, recursiveSearch: boolean, types?: string[]) {
    const commands = await ip.restorePackages(repoDir, /*ignoreScripts*/ true, recursiveSearch, /*lernaPackages*/ undefined, types);
    let usedYarn = false;
    for (const { directory: packageRoot, tool, arguments: args } of commands) {
        await new Promise<void>((resolve, reject) => {
            usedYarn = usedYarn || tool === ip.InstallTool.Yarn;
            cp.execFile(tool, args, { cwd: packageRoot }, err => err ? (((err as any).packageRoot = packageRoot), reject(err)) : resolve());
        });
    }
    if (usedYarn) {
        await execAsync(repoDir, "yarn cache clean --all");
    }
}

function withTimeout<T>(ms: number, promise: Promise<T>): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    return Promise.race([
        promise.finally(() => timeout && clearTimeout(timeout)),
        new Promise<T>((_resolve, reject) =>
            timeout = setTimeout(async () => {
                await execAsync(processCwd, `./kill-children-of ${processPid} node`);
                return reject(new Error(`Timed out after ${ms} ms`));
            }, ms)),
    ]);
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
    console.log(reduceSpew(err.message ?? "No message").replace(/(^|\n)/g, "$1> "));
    console.log(reduceSpew(err.stack ?? "Unknown Stack").replace(/(^|\n)/g, "$1> "));
}

async function execAsync(cwd: string, command: string): Promise<string> {
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

function reduceSpew(message: string): string {
    // Since this is only a warning, it tends to be reported many (i.e. thousands of) times
    const problemString = "npm WARN tar ENOSPC: no space left on device, write\n";
    const index = message.indexOf(problemString);
    if (index < 0) return message;

    return message.substring(0, index) + problemString + replaceAll(message.substring(index), problemString, "");
}

function replaceAll(message: string, oldStr: string, newStr: string) {
    let result = "";
    let index = 0;
    while (true) {
        const newIndex = message.indexOf(oldStr, index);
        if (newIndex < 0) {
            return index === 0
                ? message
                : result + message.substring(index);
        }

        result += message.substring(index, newIndex);
        result += newStr;

        index = newIndex + oldStr.length;
    }
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
        const { tscPath: newTscPath, resolvedVersion: newTscResolvedVersion } = await downloadTypescriptSourceIssueAsync(cwd, params.oldTypescriptRepoUrl, params.sourceIssue);

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
        tscPath: await buildTsc(repoPath),
        resolvedVersion: headRef
    };
}

async function downloadTypescriptSourceIssueAsync(cwd: string, repoUrl: string, sourceIssue: number): Promise<{ tscPath: string, resolvedVersion: string }> {
    const repoName = `typescript-${sourceIssue}`;
    await git.cloneRepoIfNecessary(cwd, { name: repoName, url: repoUrl });

    const repoPath = path.join(cwd, repoName);
    const headRef = `refs/pull/${sourceIssue}/merge`;

    await git.checkout(repoPath, headRef);

    return {
        tscPath: await buildTsc(repoPath),
        resolvedVersion: headRef
    };
}

async function buildTsc(repoPath: string) {
    await execAsync(repoPath, "npm ci");
    await execAsync(repoPath, "npx gulp tsc");
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
