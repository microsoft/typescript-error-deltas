import ge = require("./getErrors");
import pu = require("./packageUtils");
import git = require("./gitUtils");
import ip = require("./installPackages");
import ur = require("./userRepos");
import cp = require("child_process");
import fs = require("fs");
import path = require("path");

export interface GitParams {
    repoCount: number;
    oldTscVersion: string;
    newTscVersion: string;
}
export interface UserParams {
    oldTypescriptRepoUrl: string;
    oldHeadRef: string;
    newTypescriptRepoUrl: string;
    newHeadRef: string;
    sourceIssue: number;
    requestingUser: string;
    statusComment: number;
}

interface Params extends Partial<GitParams & UserParams> {
    postResult: boolean;
    testType: string;
}

const skipRepos = [
    "https://github.com/storybookjs/storybook", // Too big to fit on VM
    "https://github.com/microsoft/frontend-bootcamp", // Can't be built twice in a row
];
const processCwd = process.cwd();
const processPid = process.pid;
const executionTimeout = 10 * 60 * 1000;

export async function mainAsync(params: Params) {
    const { testType } = params;
    
    const downloadDir = "/mnt/ts_downloads";
    await execAsync(processCwd, "sudo mkdir " + downloadDir);

    const { tscPath: oldTscPath, resolvedVersion: oldTscResolvedVersion } = await downloadTypeScriptAsync(processCwd, params.oldTscVersion, params.oldTypescriptRepoUrl, params.oldHeadRef);
    const { tscPath: newTscPath, resolvedVersion: newTscResolvedVersion } = await downloadTypeScriptAsync(processCwd, params.newTscVersion, params.newTypescriptRepoUrl, params.newHeadRef);

    // Get the name of the typescript folder.
    const oldTscDirPath = path.resolve(oldTscPath, "../../");
    const newTscDirPath = path.resolve(newTscPath, "../../");

    console.log("Old version = " + oldTscResolvedVersion);
    console.log("New version = " + newTscResolvedVersion);

    const testDir = path.join(processCwd, "userTests");

    const repos = testType === "git"
        ? await git.getPopularTypeScriptRepos(params.repoCount!)
        : testType === "user"
            ? ur.getUserTestsRepos(testDir)
            : undefined;

    if (!repos) {
        throw new Error(`Parameter <test_type> with value ${testType} is not existent.`);
    }

    let summary = "";
    let sawNewErrors = false;

    let i = 0;

    for (const repo of repos) {
        if (repo.url && skipRepos.includes(repo.url)) continue;

        console.log(`Starting #${++i}: ${repo.url ?? repo.name}`);

        await execAsync(processCwd, "sudo mount -t tmpfs -o size=2g tmpfs " + downloadDir);

        try {
            if (repo.url) {
                try {
                    console.log("Cloning if absent");
                    await git.cloneRepoIfNecessary(downloadDir, repo);
                }
                catch (err) {
                    reportError(err, "Error cloning " + repo.url);
                    continue;
                }
            }
            else {
                await ur.copyUserRepo(downloadDir, testDir, repo);
            }

            const repoDir = path.join(downloadDir, repo.name);

            try {
                console.log("Installing packages if absent");
                await withTimeout(executionTimeout, installPackages(repoDir, /*recursiveSearch*/ testType !== "user", repo.types));
            }
            catch (err) {
                reportError(err, "Error installing packages for " + repo.name);
                await reportResourceUsage(downloadDir);
                continue;
            }

            try {
                console.log(`Building with ${oldTscPath} (old)`);
                const oldErrors = await buildAndGetErrors(repoDir, oldTscPath, /*skipLibCheck*/ true, testType);

                if (oldErrors.hasConfigFailure) {
                    console.log("Unable to build project graph");
                    console.log(`Skipping build with ${newTscPath} (new)`);
                    continue;
                }

                const numProjects = oldErrors.projectErrors.length;

                let numFailed = 0;
                for (const oldProjectErrors of oldErrors.projectErrors) {
                    if (oldProjectErrors.hasBuildFailure || oldProjectErrors.errors.length) {
                        numFailed++;
                    }
                }

                if (numFailed === numProjects) {
                    console.log(`Skipping build with ${newTscPath} (new)`);
                    continue;
                }

                let sawNewRepoErrors = false;
                let repoSummary = `# [${repo.owner}/${repo.name}]${repo.url ? `(${repo.url})` : ``}\n`;

                if (numFailed > 0) {
                    const oldFailuresMessage = `${numFailed} of ${numProjects} projects failed to build with the old tsc`;
                    console.log(oldFailuresMessage);
                    repoSummary += `**${oldFailuresMessage}**\n`;
                }

                console.log(`Building with ${newTscPath} (new)`);
                const newErrors = await buildAndGetErrors(repoDir, newTscPath, /*skipLibCheck*/ true, testType);

                if (newErrors.hasConfigFailure) {
                    console.log("Unable to build project graph");

                    sawNewErrors = true;
                    repoSummary += ":exclamation::exclamation: **Unable to build the project graph with the new tsc** :exclamation::exclamation:\n";

                    summary += repoSummary;
                    continue;
                }

                console.log("Comparing errors");
                for (const oldProjectErrors of oldErrors.projectErrors) {
                    // To keep things simple, we'll focus on projects that used to build cleanly
                    if (oldProjectErrors.hasBuildFailure || oldProjectErrors.errors.length) {
                        continue;
                    }

                    // TS 5055 generally indicates that the project can't be built twice in a row without cleaning in between.
                    const newProjectErrors = newErrors.projectErrors.find(pe => pe.projectUrl == oldProjectErrors.projectUrl)?.errors?.filter(e => e.code !== 5055);
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
                    sawNewErrors = true;
                    summary += repoSummary;
                }
            }
            catch (err) {
                reportError(err, "Error building " + repo.url ?? repo.name);
                continue;
            }

            console.log("Done " + repo.url ?? repo.name);
        }
        finally {
            // Throw away the repo so we don't run out of space
            // Note that we specifically don't recover and attempt another repo if this fails
            console.log("Cleaning up repo");
            await execAsync(processCwd, "sudo umount " + downloadDir);
            await reportResourceUsage(downloadDir);
        }
    }

    await execAsync(processCwd, "sudo rm -rf " + downloadDir);
    await execAsync(processCwd, "sudo rm -rf " + oldTscDirPath);
    await execAsync(processCwd, "sudo rm -rf " + newTscDirPath);

    if (params.testType === "git") {
        const title = `[NewErrors] ${newTscResolvedVersion} vs ${oldTscResolvedVersion}`;
        const body = `The following errors were reported by ${newTscResolvedVersion}, but not by ${oldTscResolvedVersion}

        ${summary}`;
        await git.createIssue(params.postResult, title, body, sawNewErrors);
    }
    else if(params.testType === "user") {
        const body = `@${params.requestingUser}\nThe results of the user tests run you requested are in!\n<details><summary> Here they are:</summary><p>\n<b>Comparison Report - ${oldTscResolvedVersion}..${newTscResolvedVersion}</b>\n\n${summary}</p></details>`;
        await git.createComment(params.sourceIssue!, params.statusComment!, params.postResult, body);
    }
    else {
        throw new Error(`testType "${params.testType}" doesn't exists.`);
    }
}

async function buildAndGetErrors(repoDir: string, tscPath: string, skipLibCheck: boolean, testType: string) {
    const p = new Promise<ge.RepoErrors>((resolve, reject) => {
        const p = cp.fork(path.join(__dirname, "run-build.js"));
        p.on('message', (m: 'ready' | ge.RepoErrors) =>
            m === 'ready'
                ? p.send({ repoDir, tscPath, testType, skipLibCheck })
                : resolve(m));
        p.on('exit', reject);
    });
    return withTimeout(executionTimeout, p);
}

async function installPackages(repoDir: string, recursiveSearch: boolean, types?: string[]) {
    const commands = await ip.restorePackages(repoDir, /*ignoreScripts*/ true, recursiveSearch, /*lernaPackages*/ undefined, types);
    let usedYarn = false;
    for (const { directory: packageRoot, tool, arguments: args } of commands) {
        await new Promise<void>((resolve, reject) => {
            usedYarn = usedYarn || tool === ip.InstallTool.Yarn;
            cp.execFile(tool, args, { cwd: packageRoot }, err => err ? reject(err) : resolve());
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

async function downloadTypeScriptAsync(cwd: string, version?: string, repoUrl?: string, headRef?: string): Promise<{ tscPath: string, resolvedVersion: string }> {
    if (repoUrl && headRef) {
        return await downloadTypescriptRepoAsync(cwd, repoUrl, headRef)
    }
    else if (version) {
        return await downloadTypeScriptNpmAsync(cwd, version);
    }
    else {
        throw new Error('Invalid parameters');
    }
}

async function downloadTypescriptRepoAsync(cwd: string, repoUrl: string, headRef: string): Promise<{ tscPath: string, resolvedVersion: string }> {
    const repoName = `typescript-${headRef}`;
    await git.cloneRepoIfNecessary(cwd, { name: repoName, url: repoUrl, branch: headRef });

    const repoPath = path.join(cwd, repoName);

    await execAsync(repoPath, "npm ci");
    await execAsync(repoPath, "npm run build:compiler");

    const tscPath = path.join(repoPath, "built", "local", "tsc.js");
    return {
        tscPath,
        resolvedVersion: headRef
    };
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
