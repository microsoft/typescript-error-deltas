import exercise = require("./utils/exerciseServerConstants");
import ge = require("./utils/getTscErrors");
import pu = require("./utils/packageUtils");
import git = require("./utils/gitUtils");
import { execAsync, getProcessRssKb, SpawnResult, spawnWithTimeoutAsync } from "./utils/execUtils";
import type { LspRequestStats } from "./utils/exerciseLspServer";
import ip = require("@typescript/server-replay/installPackages");
import ut = require("./utils/userTestUtils");
import fs = require("fs");
import path = require("path");
import mdEscape = require("markdown-escape");
import randomSeed = require("random-seed");
import { getErrorMessageFromStack, getHash, getHashForStack, getHashForGoStack } from "./utils/hashStackTrace";
import { createCopyingOverlayFS, createTempOverlayFS, OverlayBaseFS } from "./utils/overlayFS";
import { asMarkdownInlineCode } from "./utils/markdownUtils";

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
    diagnosticOutput?: boolean;
    /**
     * True to allow errors in the baseline build and report as missing any not reported by the candidate build.
     */
    buildWithNewWhenOldFails: boolean;
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
     * Name of a directory in which a summary file should be written for each repo to be included in the output
     * (i.e. those with interesting failures).
     * Sneakiness: not a path since referred to in output as component of AzDO artifact name
     */
    resultDirName: string;
    /**
     * Which TypeScript entrypoint (tsc or tsserver) to test.
     */
    entrypoint: TsEntrypoint;
    /**
     * Used to make runs repeatable (e.g. when confirming that a PR no longer introduces failures).
     * Pass undefined to have a seed generated.
     */
    prngSeed: string | undefined;

}
export interface ScheduledParams extends Params {
    testType: "scheduled";
    oldTsNpmVersion: string;
    newTsNpmVersion: string;
    candidateImplementation: TypeScriptImplementation;
}
export interface TriggeredParams extends Params {
    testType: "triggered";
    oldTsRepoUrl: string;
    oldHeadRef: string;
    prNumber: number;
}

export type TsEntrypoint = "tsc" | "tsserver" | "fuzzer";
export type TypeScriptImplementation = "strada" | "corsa";

const processCwd = process.cwd();
const packageTimeout = 10 * 60 * 1000;
const executionTimeout = 10 * 60 * 1000;

const prng = randomSeed.create();

export type RepoStatus =
    | "Unknown failure"
    | "Git clone failed"
    | "Package install failed"
    | "Project-graph error in old TS"
    | "Too many errors in old TS"
    | "Language service disabled in new TS"
    | "Detected interesting changes"
    | "Detected no interesting changes"
    | "Timeout"
    ;

interface TSServerResult {
    oldServerFailed: boolean;
    oldSpawnResult?: SpawnResult;
    newServerFailed: boolean;
    newSpawnResult: SpawnResult;
    replayScriptPath: string;
    installCommand: string | undefined;
}

interface Summary {
    tsServerResult: TSServerResult;
    repo: git.Repo;
    oldTsEntrypointPath: string;
    rawErrorArtifactPath: string;
    replayScript: string;
    replayScriptArtifactPath: string;
    replayScriptName: string;
    resultDirName: string;
    entrypoint: TsEntrypoint;
    commit?: string;
}

interface RepoResult {
    readonly status: RepoStatus;
    readonly summary?: string;
    readonly tsServerResult?: TSServerResult;
    readonly replayScriptPath?: string;
    readonly rawErrorPath?: string;
    readonly lspStats?: LspRequestStats;
}

function logStepTime(diagnosticOutput: boolean, repo: git.Repo, step: string, start: number): void {
    if (diagnosticOutput) {
        const end = performance.now();
        console.log(`PERF { "repo": "${repo.url ?? repo.name}", "step": "${step}", "time": ${Math.round(end - start)} }`);
    }
}

async function cloneRepo(
    repo: git.Repo,
    userTestsDir: string,
    downloadDir: string,
    diagnosticOutput: boolean): Promise<boolean> {
    const cloneStart = performance.now();
    try {
        const isUserTestRepo = !repo.url;
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
                return false;
            }
        }

        return true;
    } finally {
        logStepTime(diagnosticOutput, repo, "clone", cloneStart);
    }
}

async function getMonorepoPackages(repoDir: string): Promise<readonly string[] | undefined> {
    try {
        return await pu.getMonorepoOrder(repoDir);
    }
    catch (e) {
        reportError(e, `Error identifying monorepo packages for ${repoDir} - treating as separate packages`);
        return undefined;
    }
}

async function tryInstallPackages(
    repo: git.Repo,
    downloadDir: string,
    repoDir: string,
    cleanOnFailure: boolean,
    diagnosticOutput: boolean): Promise<string | undefined> {
    const packageInstallStart = performance.now();
    const isUserTestRepo = !repo.url;
    const recursiveSearch = !isUserTestRepo;
    try {
        console.log("Installing packages if absent");
        await ip.installDependencies(
            repoDir,
                /*quietOutput*/ !diagnosticOutput,
                /*recursiveSearch*/ recursiveSearch,
                /*packageTimeout*/ packageTimeout);
        // The repro instructions install packages via `npx tsreplay install`, mirroring the options used here.
        return `npx tsreplay install ./${repo.name}${recursiveSearch ? "" : " --recursiveSearch false"}`;
    }
    catch (err) {
        reportError(err, `Error installing packages for ${repo.name}`);
        if (/ENOSPC/.test(String(err))) {
            await reportResourceUsage(downloadDir);
        }

        if (cleanOnFailure) {
            // It's perfectly reasonable to run the server against a repo with only some packages installed,
            // but making that mode repro-able could be complicated, so remove all packages for simplicity.
            console.log("Removing installed packages");
            await execAsync(repoDir, "git clean -xdff");
        }

        return undefined;
    }
    finally {
        logStepTime(diagnosticOutput, repo, "package install", packageInstallStart);
    }
}

async function getTsServerRepoResult(
    repo: git.Repo,
    userTestsDir: string,
    oldTsServerPath: string,
    newTsServerPath: string,
    downloadDir: OverlayBaseFS,
    replayScriptArtifactPath: string,
    rawErrorArtifactPath: string,
    diagnosticOutput: boolean,
    isPr: boolean,
    implementation: TypeScriptImplementation,
): Promise<RepoResult> {
    const isCorsa = implementation === "corsa";

    if (!await cloneRepo(repo, userTestsDir, downloadDir.path, diagnosticOutput)) {
        return { status: "Git clone failed" };
    }

    const repoDir = path.join(downloadDir.path, repo.name);
    const monorepoPackages = await getMonorepoPackages(repoDir);

    // Presumably, people occasionally browse repos without installing the packages first
    const installCommand = (prng.random() > 0.2) && !!monorepoPackages
        ? await tryInstallPackages(repo, downloadDir.path, repoDir, /*cleanOnFailure*/ true, diagnosticOutput)
        : undefined;

    const replayScriptName = path.basename(replayScriptArtifactPath);
    const replayScriptPath = path.join(downloadDir.path, replayScriptName);

    const rawErrorName = path.basename(rawErrorArtifactPath);
    const rawErrorPath = path.join(downloadDir.path, rawErrorName);

    // Periodically log memory usage of the main fuzzer process
    const mainMemoryInterval = diagnosticOutput ? setInterval(async () => {
        const rssKb = await getProcessRssKb(process.pid);
        if (rssKb !== undefined) {
            const rssMb = Math.round(rssKb / 1024);
            console.error(`Main process memory (pid ${process.pid}): ${rssMb} MB`);
        }
    }, 30_000) : undefined;
    mainMemoryInterval?.unref();

    const lsStart = performance.now();
    try {
        console.log(`Testing with ${newTsServerPath} (new)`);

        const newSpawnResult = isCorsa ?
            await spawnWithTimeoutAsync(repoDir, process.argv[0], [path.join(__dirname, "utils", "exerciseLspServer.js"), repoDir, replayScriptPath, newTsServerPath, diagnosticOutput.toString(), prng.string(10), "n/a"], executionTimeout) :
            await spawnWithTimeoutAsync(repoDir, process.argv[0], [path.join(__dirname, "utils", "exerciseServer.js"), repoDir, replayScriptPath, newTsServerPath, diagnosticOutput.toString(), prng.string(10)], executionTimeout);

        if (!newSpawnResult) {
            // CONSIDER: It might be interesting to treat timeouts as failures, but they'd be harder to baseline and more likely to have flaky repros
            console.log(`New server timed out after ${executionTimeout} ms`);
            return { status: "Timeout" };
        }

        if (diagnosticOutput) {
            console.log("Raw spawn results (new):");
            dumpSpawnResult(newSpawnResult);
        }

        switch (newSpawnResult.code) {
            case 0:
            case null:
                if (newSpawnResult.signal !== null) {
                    console.log(`Exited with signal ${newSpawnResult.signal}`);
                    return { status: "Unknown failure" };
                }

                console.log("No issues found");
                break;
            case exercise.EXIT_LANGUAGE_SERVICE_DISABLED:
                if (!isCorsa) {
                    console.log("Skipping since language service was disabled");
                    return { status: "Language service disabled in new TS" };
                }
            case exercise.EXIT_SERVER_CRASH:
            case exercise.EXIT_SERVER_ERROR:
            case exercise.EXIT_SERVER_EXIT_FAILED:
                // These deserve to be mentioned in the summary
                break;
            case exercise.EXIT_BAD_ARGS:
            case exercise.EXIT_UNHANDLED_EXCEPTION:
            default:
                console.log(`Exited with code ${newSpawnResult.code}`);
                // Don't duplicate if printed above
                if (!diagnosticOutput) {
                    dumpSpawnResult(newSpawnResult);
                }
                return { status: "Unknown failure" };
        }

        const newServerFailed = !!newSpawnResult.code;

        if (newServerFailed) {
            console.log(`Issue found in ${newTsServerPath} (new):`);
            const harnessOutput = isCorsa ? prettyPrintLspHarnessOutput(newSpawnResult.stdout, /*filter*/ false) : prettyPrintServerHarnessOutput(newSpawnResult.stdout, /*filter*/ false);
            console.log(insetLines(harnessOutput));
            await fs.promises.writeFile(rawErrorPath, harnessOutput);
        }

        console.log(`Testing with ${oldTsServerPath} (old)`);
        const oldSpawnResult = isCorsa ?
            await spawnWithTimeoutAsync(repoDir, process.argv[0], [path.join(__dirname, "utils", "replayLspServer.js"), repoDir, replayScriptPath, oldTsServerPath, diagnosticOutput.toString()], executionTimeout) :
            await spawnWithTimeoutAsync(repoDir, process.argv[0], [path.join(__dirname, "..", "node_modules", "@typescript", "server-replay", "bin", "tsreplay.js"), "strada-replay", repoDir, replayScriptPath, oldTsServerPath, "-u"], executionTimeout);

        if (diagnosticOutput && oldSpawnResult) {
            console.log("Raw spawn results (old):");
            dumpSpawnResult(oldSpawnResult);
        }

        // NB: Unlike newServerFailed, this includes timeouts because "it used to timeout" is useful context for an error in the new server
        const oldServerFailed = !oldSpawnResult || !!oldSpawnResult.code || !!oldSpawnResult.signal;

        if (!newServerFailed && !oldServerFailed) {
            return { status: "Detected no interesting changes" };
        }

        if (oldServerFailed) {
            const oldHarnessOutput = oldSpawnResult?.stdout &&
                (isCorsa ?
                    prettyPrintLspHarnessOutput(oldSpawnResult.stdout, /*filter*/ false) :
                    prettyPrintServerHarnessOutput(oldSpawnResult.stdout, /*filter*/ false));
            console.log(`Issue found in ${oldTsServerPath} (old):`);
            console.log(
                insetLines(
                    oldHarnessOutput ?? `Timed out after ${executionTimeout} ms`));

            await fs.promises.writeFile(rawErrorPath, oldSpawnResult?.stdout ?? `Timed out after ${executionTimeout} ms`);

            // We don't want to drown PRs with comments.
            // Override the results to say nothing interesting changed.
            if (isPr && newServerFailed && oldSpawnResult) {
                if (isCorsa) {
                    const oldOut = parseLspHarnessOutput(oldSpawnResult.stdout);
                    const newOut = parseLspHarnessOutput(newSpawnResult.stdout);
                    if (
                        typeof oldOut !== "string" && typeof newOut !== "string"
                        && oldOut.message === newOut.message
                        && oldOut.method === newOut.method
                    ) {
                        return { status: "Detected no interesting changes" };
                    }
                } else {
                    const oldOut = parseServerHarnessOutput(oldSpawnResult.stdout);
                    const newOut = parseServerHarnessOutput(newSpawnResult.stdout);
                    if (
                        typeof oldOut !== "string" && typeof newOut !== "string"
                        && oldOut.request_seq === newOut.request_seq
                        && oldOut.command === newOut.command
                    ) {
                        return { status: "Detected no interesting changes" };
                    }
                }
            }
        }

        const tsServerResult = {
            oldServerFailed,
            oldSpawnResult,
            newServerFailed,
            newSpawnResult,
            replayScriptPath,
            installCommand,
        };

        return { status: "Detected interesting changes", tsServerResult: tsServerResult, replayScriptPath, rawErrorPath };
    }
    catch (err) {
        reportError(err, `Error running tsserver on ${repo.url ?? repo.name}`);
        return { status: "Unknown failure" };
    }
    finally {
        console.log(`Done ${repo.url ?? repo.name}`);
        logStepTime(diagnosticOutput, repo, "language service", lsStart);
    }
}

/**
 * Tests the LSP server against a single TypeScript native version and reports all crashes found.
 */
export async function getLSPResult(
    repo: git.Repo,
    userTestsDir: string,
    lspServerPath: string,
    downloadDir: OverlayBaseFS,
    replayScriptArtifactPath: string,
    rawErrorArtifactPath: string,
    diagnosticOutput: boolean,
): Promise<RepoResult> {

    if (!await cloneRepo(repo, userTestsDir, downloadDir.path, diagnosticOutput)) {
        return { status: "Git clone failed" };
    }

    const repoDir = path.join(downloadDir.path, repo.name);
    const monorepoPackages = await getMonorepoPackages(repoDir);

    // Presumably, people occasionally browse repos without installing the packages first
    const installCommand = (prng.random() > 0.2) && !!monorepoPackages
        ? await tryInstallPackages(repo, downloadDir.path, repoDir, /*cleanOnFailure*/ true, diagnosticOutput)
        : undefined;

    const replayScriptName = path.basename(replayScriptArtifactPath);
    const replayScriptPath = path.join(downloadDir.path, replayScriptName);

    const rawErrorName = path.basename(rawErrorArtifactPath);
    const rawErrorPath = path.join(downloadDir.path, rawErrorName);

    const statsName = `${prng.string(8)}.lspStats.json`;
    const statsPath = path.join(downloadDir.path, statsName);

    const lsStart = performance.now();
    // Periodically log memory usage of the main fuzzer process
    const mainMemoryInterval = diagnosticOutput ? setInterval(async () => {
        const rssKb = await getProcessRssKb(process.pid);
        if (rssKb !== undefined) {
            const rssMb = Math.round(rssKb / 1024);
            console.error(`Main process memory (pid ${process.pid}): ${rssMb} MB`);
        }
    }, 30_000) : undefined;
    mainMemoryInterval?.unref();
    try {
        console.log(`Testing LSP server with ${lspServerPath}`);
        const spawnResult = await spawnWithTimeoutAsync(repoDir, process.argv[0], [path.join(__dirname, "utils", "exerciseLspServer.js"), repoDir, replayScriptPath, lspServerPath, diagnosticOutput.toString(), prng.string(10), statsPath], executionTimeout);

        if (!spawnResult) {
            console.log(`LSP server timed out after ${executionTimeout} ms`);
            return { status: "Timeout", lspStats: await tryReadLspStats(statsPath) };
        }

        if (diagnosticOutput) {
            console.log("Raw spawn results:");
            dumpSpawnResult(spawnResult);
        }

        switch (spawnResult.code) {
            case 0:
            case null:
                if (spawnResult.signal !== null) {
                    console.log(`Exited with signal ${spawnResult.signal}`);
                    return { status: "Unknown failure", lspStats: await tryReadLspStats(statsPath) };
                }

                console.log("No crashes found");
                return { status: "Detected no interesting changes", lspStats: await tryReadLspStats(statsPath) };
            case exercise.EXIT_SERVER_CRASH:
            case exercise.EXIT_SERVER_ERROR:
            case exercise.EXIT_SERVER_EXIT_FAILED:
                // These are the crashes we want to report
                break;
            case exercise.EXIT_BAD_ARGS:
            case exercise.EXIT_UNHANDLED_EXCEPTION:
            default:
                console.log(`Exited with code ${spawnResult.code}`);
                if (!diagnosticOutput) {
                    dumpSpawnResult(spawnResult);
                }
                return { status: "Unknown failure", lspStats: await tryReadLspStats(statsPath) };
        }

        // Server crashed - report the error
        console.log(`Crash found in ${lspServerPath}:`);
        const harnessOutput = prettyPrintLspHarnessOutput(spawnResult.stdout, /*filter*/ false);
        console.log(insetLines(harnessOutput));
        await fs.promises.writeFile(rawErrorPath, harnessOutput);

        const tsServerResult: TSServerResult = {
            oldServerFailed: false,
            oldSpawnResult: undefined,
            newServerFailed: true,
            newSpawnResult: spawnResult,
            replayScriptPath,
            installCommand,
        };

        return { status: "Detected interesting changes", tsServerResult, replayScriptPath, rawErrorPath, lspStats: await tryReadLspStats(statsPath) };
    }
    catch (err) {
        reportError(err, `Error running LSP server on ${repo.url ?? repo.name}`);
        return { status: "Unknown failure", lspStats: await tryReadLspStats(statsPath) };
    }
    finally {
        clearInterval(mainMemoryInterval);
        console.log(`Done ${repo.url ?? repo.name}`);
        logStepTime(diagnosticOutput, repo, "language service", lsStart);
    }
}

function groupErrors(summaries: Summary[], implementation: TypeScriptImplementation) {
    const isCorsa = implementation === "corsa";
    const groupedOldErrors = new Map<string, Summary[]>();
    const groupedNewErrors = new Map<string, Summary[]>();
    let group: Map<string, Summary[]>;
    let error: ServerHarnessOutput | LspHarnessOutput | string;
    for (const summary of summaries) {
        if (summary.tsServerResult.newServerFailed) {
            // Group new errors
            error = isCorsa
                ? parseLspHarnessOutput(summary.tsServerResult.newSpawnResult.stdout)
                : parseServerHarnessOutput(summary.tsServerResult.newSpawnResult.stdout);
            group = groupedNewErrors;
        }
        else if (summary.tsServerResult.oldServerFailed) {
            // Group old errors
            const { oldSpawnResult } = summary.tsServerResult;
            error = oldSpawnResult?.stdout
                ? (isCorsa ? parseLspHarnessOutput(oldSpawnResult.stdout) : parseServerHarnessOutput(oldSpawnResult.stdout))
                : `Timed out after ${executionTimeout} ms`;

            group = groupedOldErrors;
        }
        else {
            continue;
        }

        const key = typeof error === "string"
            ? getHash([error])
            : isCorsa
                ? getHashForGoStack(error.message)
                : getHashForStack(error.message);
        const value = group.get(key) ?? [];
        value.push(summary);
        group.set(key, value);
    }

    return { groupedOldErrors, groupedNewErrors }
}

function getJSErrorMessage(output: string): string {
    const error = parseServerHarnessOutput(output);

    return typeof error === "string" ? error : getErrorMessageFromStack(error.message);
}

function getErrorMessage(output: string, implementation: TypeScriptImplementation): string {
    return implementation === "corsa" ? getLspErrorMessage(output) : getJSErrorMessage(output);
}

function prettyPrint(output: string, filter: boolean, implementation: TypeScriptImplementation): string {
    return implementation === "corsa" ? prettyPrintLspHarnessOutput(output, filter) : prettyPrintServerHarnessOutput(output, filter);
}

function getReplayInstructions(summary: Summary): string {
    let text = `<h4>Repro steps</h4>

\`\`\`bash
#!/bin/bash

`;
    // No url means is user test repo
    if (!summary.repo.url) {
        text += `# Manually download user test ${asMarkdownInlineCode(summary.repo.name)}\n`;
    }
    else {
        text += `git clone ${summary.repo.url} --recurse-submodules\n`;

        if (summary.commit) {
            text += `git -C "./${summary.repo.name}" reset --hard ${summary.commit}\n`;
        }
    }

    text += `downloadUrl=$(curl -s "${getArtifactsApiUrlPlaceholder}?artifactName=${summary.resultDirName}&api-version=7.0" | jq -r ".resource.downloadUrl")
wget -O ${summary.resultDirName}.zip "$downloadUrl"
unzip -p ${summary.resultDirName}.zip ${summary.resultDirName}/${summary.replayScriptName} > ${summary.replayScriptName}
npm install --no-save @typescript/server-replay
`;
    if (summary.tsServerResult.installCommand) {
        text += `# Install the repro project's packages
${summary.tsServerResult.installCommand}
`;
    }
    text += `\`\`\`

To run the repro, use the "Launch replay test" launch configuration in your local copy of native TypeScript.

</details>
`;

    return text;
}

function createOldErrorSummary(summaries: Summary[], implementation: TypeScriptImplementation): string {
    const { oldSpawnResult } = summaries[0].tsServerResult;

    const oldServerError = oldSpawnResult?.stdout
        ? prettyPrint(oldSpawnResult.stdout, /*filter*/ true, implementation)
        : `Timed out after ${executionTimeout} ms`;

    const errorMessage = oldSpawnResult?.stdout ? getErrorMessage(oldSpawnResult.stdout, implementation) : oldServerError;

    let text = `
<details>
<summary>New server no longer reports this error: ${errorMessage}</summary>

\`\`\`
${oldServerError}
\`\`\`

<h4>Affected repos</h4>`;

    for (const summary of summaries) {
        const owner = summary.repo.owner ? `${mdEscape(summary.repo.owner)}/` : "";
        const url = summary.repo.url ?? "";

        text += `
<details>
<summary><a href="${url}">${owner + mdEscape(summary.repo.name)}</a></summary>
Raw error text: <code>${summary.rawErrorArtifactPath}</code> in the <a href="${artifactFolderUrlPlaceholder}">artifact folder</a> <br />
Replay commands: <code>${summary.replayScriptArtifactPath}</code> in the <a href="${artifactFolderUrlPlaceholder}">artifact folder</a>
<h4>Last few requests</h4>

\`\`\`json
${summary.replayScript}
\`\`\`

`;
        text += getReplayInstructions(summary);
    }

    text += `
</details>
`;

    return text;
}

async function createNewErrorSummaryAsync(summaries: Summary[], implementation: TypeScriptImplementation): Promise<string> {
    const stdout = summaries[0].tsServerResult.newSpawnResult.stdout;

    let text = `<h2>${getErrorMessage(stdout, implementation)}</h2>

\`\`\`
${prettyPrint(stdout, /*filter*/ true, implementation)}
\`\`\`

<h4>Affected repos</h4>`;

    for (const summary of summaries) {
        const owner = summary.repo.owner ? `${mdEscape(summary.repo.owner)}/` : "";
        const url = summary.repo.url ?? "";

        text += `
<details>
<summary><a href="${url}">${owner + mdEscape(summary.repo.name)}</a></summary>
Raw error text: <code>${summary.rawErrorArtifactPath}</code> in the <a href="${artifactFolderUrlPlaceholder}">artifact folder</a> <br />
Replay commands: <code>${summary.replayScriptArtifactPath}</code> in the <a href="${artifactFolderUrlPlaceholder}">artifact folder</a>
`;

        // Show what happened with the old server
        const { oldServerFailed, oldSpawnResult } = summary.tsServerResult;
        if (!oldServerFailed) {
            text += `<h4>Old server result</h4>
<p>The old server completed successfully for this repo.</p>
`;
        }
        else if (!oldSpawnResult) {
            text += `<h4>Old server result</h4>
<p>The old server timed out after ${executionTimeout} ms.</p>
`;
        }
        else {
            const oldHarnessOutput = prettyPrint(oldSpawnResult.stdout, /*filter*/ true, implementation);
            text += `<h4>Old server result</h4>

\`\`\`
${oldHarnessOutput}
\`\`\`
`;
        }

        text += `<h4>Last few requests</h4>

\`\`\`json
${summary.replayScript}
\`\`\`

`;
        text += getReplayInstructions(summary);
    }

    return text;
}

// Exported for testing
export async function getTscRepoResult(
    repo: git.Repo,
    userTestsDir: string,
    oldTscPath: string,
    newTscPath: string,
    /**
     * Two possible approaches:
     *   1) If a project fails to build with the old tsc, don't bother building it with the new tsc - the results will be unrelatiable (breaking change detector)
     *   2) Errors are expected when building with the old tsc and we're specifically interested in changes (user tests)
     */
    buildWithNewWhenOldFails: boolean,
    downloadDir: OverlayBaseFS,
    diagnosticOutput: boolean,
): Promise<RepoResult> {

    if (!await cloneRepo(repo, userTestsDir, downloadDir.path, diagnosticOutput)) {
        return { status: "Git clone failed" };
    }

    const baseRepoDir = path.join(downloadDir.path, repo.name);
    const monorepoPackages = await getMonorepoPackages(baseRepoDir);

    if (!monorepoPackages || !await tryInstallPackages(repo, downloadDir.path, baseRepoDir, /*cleanOnFailure*/ false, diagnosticOutput)) {
        return { status: "Package install failed" };
    }

    const relativeMonorepoPackages = monorepoPackages.map(p => path.relative(baseRepoDir, path.resolve(baseRepoDir, p)));

    const isUserTestRepo = !repo.url;

    const buildStart = performance.now();
    try {
        console.log(`Building with ${oldTscPath} (old)`);
        let oldErrors;
        {
            await using overlay = await downloadDir.createOverlay();
            const repoDir = path.join(overlay.path, repo.name);
            const overlayMonorepoPackages = relativeMonorepoPackages.map(p => path.join(overlay.path, p));
            oldErrors = await ge.buildAndGetErrors(repoDir, overlayMonorepoPackages, isUserTestRepo, oldTscPath, executionTimeout, /*skipLibCheck*/ true);
        }

        if (oldErrors.hasConfigFailure) {
            console.log("Unable to build project graph");
            console.log(`Skipping build with ${newTscPath} (new)`);
            return { status: "Project-graph error in old TS" };
        }

        const numProjects = oldErrors.projectErrors.length;

        let numFailed = 0;
        for (const oldProjectErrors of oldErrors.projectErrors) {
            if (oldProjectErrors.hasBuildFailure || oldProjectErrors.errors.length) {
                numFailed++;
            }
        }

        if (!buildWithNewWhenOldFails && numFailed === numProjects) {
            console.log(`Skipping build with ${newTscPath} (new)`);
            return { status: "Too many errors in old TS" };
        }

        let sawDifferentErrors = false;
        const owner = repo.owner ? `${mdEscape(repo.owner)}/` : "";
        const url = repo.url ?? "";

        let summary = `<details open="true">
<summary>
<h2><a href="${url}">${owner}${mdEscape(repo.name)}</a></h2>
</summary>

`;

        if (!buildWithNewWhenOldFails && numFailed > 0) {
            const oldFailuresMessage = `${numFailed} of ${numProjects} projects failed to build with the old tsc and were ignored`;
            console.log(oldFailuresMessage);
            summary += `**${oldFailuresMessage}**\n`;
        }

        console.log(`Building with ${newTscPath} (new)`);
        let newErrors;
        {
            await using overlay = await downloadDir.createOverlay();
            const repoDir = path.join(overlay.path, repo.name);
            const overlayMonorepoPackages = relativeMonorepoPackages.map(p => path.join(overlay.path, p));
            newErrors = await ge.buildAndGetErrors(repoDir, overlayMonorepoPackages, isUserTestRepo, newTscPath, executionTimeout, /*skipLibCheck*/ true);
        }

        if (newErrors.hasConfigFailure) {
            console.log("Unable to build project graph");

            // This doesn't depend on tsc at all, so it shouldn't be possible for it to fail.
            // Throw so we don't get confusing results if the seemingly impossible happens.
            throw new Error("Project graph changed between builds");
        }

        console.log("Comparing errors");
        for (const oldProjectErrors of oldErrors.projectErrors) {
            if (!buildWithNewWhenOldFails && (oldProjectErrors.hasBuildFailure || oldProjectErrors.errors.length)) {
                continue;
            }

            const { projectUrl, isComposite } = oldProjectErrors;

            // TS 5055 generally indicates that the project can't be built twice in a row without cleaning in between.
            const newErrorList = newErrors.projectErrors.find(pe => pe.projectUrl == projectUrl)?.errors?.filter(e => e.code !== 5055) ?? [];
            // Obviously, 5055 doesn't indicate a problem with building twice if it occurs during the first build,
            // but it's still not interesting to report that it went away (which we would, since we drop it from `newErrorList`).
            const oldErrorList = oldProjectErrors.errors.filter(e => e.code !== 5055);

            console.log(`Error counts for ${projectUrl}: new = ${newErrorList.length}, old = ${oldErrorList.length}`);

            // If both succeeded, there's nothing interesting to report.
            // Sneakiness: if !buildWithNewWhenOldFails, then we already know oldErrorList is empty.
            if (!oldErrorList.length && !newErrorList.length) {
                continue;
            }

            const newlyReported = newErrorList.filter(ne => !oldErrorList.find(oe => ge.errorEquals(oe, ne)));
            const newlyUnreported = buildWithNewWhenOldFails ? oldErrorList.filter(oe => !newErrorList.find(ne => ge.errorEquals(ne, oe))) : [];

            // If the errors are exactly the same, there's nothing interesting to report.
            if (!newlyReported.length && !newlyUnreported.length) {
                continue;
            }

            sawDifferentErrors = true;

            const newlyReportedErrorMessageMap = new Map<string, ge.Error[]>();
            const newlyReportedErrorMessages: string[] = [];

            console.log(`New errors for ${isComposite ? "composite" : "non-composite"} project ${projectUrl}`);
            for (const newError of newlyReported) {
                const newErrorText = newError.text;

                console.log(`\tTS${newError.code} at ${newError.fileUrl ?? "project scope"}${isComposite ? ` in ${projectUrl}` : ``}`);
                console.log(`\t\t${newErrorText}`);

                if (!newlyReportedErrorMessageMap.has(newErrorText)) {
                    newlyReportedErrorMessageMap.set(newErrorText, []);
                    newlyReportedErrorMessages.push(newErrorText);
                }

                newlyReportedErrorMessageMap.get(newErrorText)!.push(newError);
            }

            const newlyUnreportedErrorMessageMap = new Map<string, ge.Error[]>();
            const newlyUnreportedErrorMessages: string[] = [];

            console.log(`No-longer-reported errors for ${isComposite ? "composite" : "non-composite"} project ${projectUrl}`);
            for (const oldError of newlyUnreported) {
                const oldErrorText = oldError.text;

                console.log(`\tTS${oldError.code} at ${oldError.fileUrl ?? "project scope"}${isComposite ? ` in ${oldError.projectUrl}` : ``}`);
                console.log(`\t\t${oldErrorText}`);

                if (!newlyUnreportedErrorMessageMap.has(oldErrorText)) {
                    newlyUnreportedErrorMessageMap.set(oldErrorText, []);
                    newlyUnreportedErrorMessages.push(oldErrorText);
                }

                newlyUnreportedErrorMessageMap.get(oldErrorText)!.push(oldError);
            }

            summary += `### ${makeMarkdownLink(projectUrl)}\n`;

            for (const errorMessage of newlyReportedErrorMessages) {
                summary += ` - ${buildWithNewWhenOldFails ? "[NEW] " : ""}${asMarkdownInlineCode(errorMessage)}\n`;

                for (const error of newlyReportedErrorMessageMap.get(errorMessage)!) {
                    summary += `   - ${error.fileUrl ? makeMarkdownLink(error.fileUrl) : "Project Scope"}${isComposite ? ` in ${makeMarkdownLink(error.projectUrl)}` : ``}\n`;
                }
            }

            for (const errorMessage of newlyUnreportedErrorMessages) {
                summary += ` - ${buildWithNewWhenOldFails ? "[MISSING] " : ""}${asMarkdownInlineCode(errorMessage)}\n`;

                for (const error of newlyUnreportedErrorMessageMap.get(errorMessage)!) {
                    summary += `   - ${error.fileUrl ? makeMarkdownLink(error.fileUrl) : "Project Scope"}${isComposite ? ` in ${makeMarkdownLink(error.projectUrl)}` : ``}\n`;
                }
            }
        }

        summary += "\n</details>\n\n";

        if (sawDifferentErrors) {
            return { status: "Detected interesting changes", summary };
        }
    }
    catch (err) {
        reportError(err, `Error building ${repo.url ?? repo.name}`);
        if (err instanceof ge.TimeoutError) {
            return { status: "Timeout" };
        }
        return { status: "Unknown failure" };
    }
    finally {
        logStepTime(diagnosticOutput, repo, "build", buildStart);
    }

    return { status: "Detected no interesting changes" };
}

export const metadataFileName = "metadata.json";
export const resultFileNameSuffix = "results.txt";
export const replayScriptFileNameSuffix = "replay.txt";
export const rawErrorFileNameSuffix = "rawError.txt";
export const lspStatsFileName = "lspRequestStats.json";
export const artifactFolderUrlPlaceholder = "PLACEHOLDER_ARTIFACT_FOLDER";
export const getArtifactsApiUrlPlaceholder = "PLACEHOLDER_GETARTIFACTS_API";

async function tryReadLspStats(statsPath: string): Promise<LspRequestStats | undefined> {
    try {
        const content = await fs.promises.readFile(statsPath, { encoding: "utf-8" });
        return JSON.parse(content) as LspRequestStats;
    }
    catch {
        return undefined;
    }
}

export type StatusCounts = {
    [P in RepoStatus]?: number
};

export interface Metadata {
    readonly newTsResolvedVersion: string;
    readonly oldTsResolvedVersion: string;
    readonly statusCounts: StatusCounts;
    readonly lspRequestStats?: LspRequestStats;
    readonly prngSeed: string;
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

export async function mainAsync(params: ScheduledParams | TriggeredParams): Promise<void> {
    const effectiveSeed = params.prngSeed ?? randomSeed.create().string(20);
    prng.seed(effectiveSeed);
    console.log("PRNG seed: " + effectiveSeed);

    const downloadDirPath = params.tmpfs ? "/mnt/ts_downloads" : path.join(processCwd, "ts_downloads");
    const createFs = params.tmpfs ? createTempOverlayFS : createCopyingOverlayFS;

    const resultDirPath = path.join(processCwd, params.resultDirName);

    if (!(await pu.exists(resultDirPath))) {
        await fs.promises.mkdir(resultDirPath, { recursive: true });
    }

    // TODO: Only download if the commit has changed (need to map refs to commits and then download to typescript-COMMIT instead)
    const { oldTsEntrypointPath, oldTsResolvedVersion, newTsEntrypointPath, newTsResolvedVersion, implementation } = await downloadTsAsync(processCwd, params);

    // Get the name of the typescript folder.
    const oldTscDirPath = oldTsEntrypointPath && path.resolve(oldTsEntrypointPath, "../../");
    const newTscDirPath = path.resolve(newTsEntrypointPath, "../../");

    console.log("Old version = " + oldTsResolvedVersion);
    console.log("New version = " + newTsResolvedVersion);

    const userTestsDir = path.join(processCwd, "userTests");

    const allRepos: readonly git.Repo[] = JSON.parse(fs.readFileSync(params.repoListPath, { encoding: "utf-8" }));
    const repos = getWorkerRepos(allRepos, params.workerCount, params.workerNumber);

    // An object is easier to de/serialize than a real map
    const statusCounts: { [P in RepoStatus]?: number } = {};

    const isPr = params.testType === "triggered" && !!params.prNumber

    var summaries: Summary[] = [];

    const aggregateLspStats: LspRequestStats = { successCount: 0, failCount: 0 };
    const diagnosticOutput = !!params.diagnosticOutput;

    let i = 1;
    for (const repo of repos) {
        console.log(`Starting #${i++} / ${repos.length}: ${repo.url ?? repo.name}`);

        await using downloadDir = await createFs(downloadDirPath, diagnosticOutput);

        const repoPrefix = repo.owner
            ? `${repo.owner}.${repo.name}`
            : repo.name;
        const replayScriptFileName = `${repoPrefix}.${replayScriptFileNameSuffix}`;
        const rawErrorFileName = `${repoPrefix}.${rawErrorFileNameSuffix}`;

        const rawErrorArtifactPath = path.join(params.resultDirName, rawErrorFileName);
        const replayScriptArtifactPath = path.join(params.resultDirName, replayScriptFileName);

        let repoResult: RepoResult;
        switch (params.entrypoint) {
            case "tsc":
                repoResult = await getTscRepoResult(repo, userTestsDir, oldTsEntrypointPath!, newTsEntrypointPath, params.buildWithNewWhenOldFails, downloadDir, diagnosticOutput);
                break;
            case "tsserver":
                repoResult = await getTsServerRepoResult(repo, userTestsDir, oldTsEntrypointPath!, newTsEntrypointPath, downloadDir, replayScriptArtifactPath, rawErrorArtifactPath, diagnosticOutput, isPr, implementation);
                break;
            case "fuzzer":
                repoResult = await getLSPResult(repo, userTestsDir, newTsEntrypointPath, downloadDir, replayScriptArtifactPath, rawErrorArtifactPath, diagnosticOutput);
                break;
            default:
                throw new Error(`Unknown entrypoint: ${params.entrypoint}`);
        }
        const { status, summary, tsServerResult: tsServerResult, replayScriptPath, rawErrorPath, lspStats } = repoResult;
        console.log(`Repo ${repo.url ?? repo.name} had status "${status}"`);
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;

        if (lspStats) {
            aggregateLspStats.successCount += lspStats.successCount;
            aggregateLspStats.failCount += lspStats.failCount;
        }

        if (summary) {
            const resultFileName = `${repoPrefix}.${resultFileNameSuffix}`;
            await fs.promises.writeFile(path.join(resultDirPath, resultFileName), summary, { encoding: "utf-8" });
        }

        if (tsServerResult) {
            const replayScriptPath = path.join(downloadDir.path, path.basename(replayScriptArtifactPath));
            const repoDir = path.join(downloadDir.path, repo.name);

            let commit: string | undefined;
            try {
                console.log("Extracting commit SHA for repro steps");
                commit = (await execAsync(repoDir, `git rev-parse @`)).trim()
            }
            catch {
                //noop
            }

            summaries.push({
                tsServerResult,
                repo,
                oldTsEntrypointPath: oldTsEntrypointPath || "",
                rawErrorArtifactPath,
                replayScript: fs.readFileSync(replayScriptPath, { encoding: "utf-8" }).split(/\r?\n/).slice(-5).join("\n"),
                replayScriptArtifactPath,
                replayScriptName: path.basename(replayScriptArtifactPath),
                resultDirName: params.resultDirName,
                entrypoint: params.entrypoint,
                commit
            });
        }

        if (summary || tsServerResult) {
            // In practice, there will only be a replay script when the entrypoint is tsserver
            // There can be replay steps without a summary, but then they're not interesting
            if (replayScriptPath) {
                await fs.promises.copyFile(replayScriptPath, path.join(resultDirPath, replayScriptFileName));
            }
            if (rawErrorPath) {
                await fs.promises.copyFile(rawErrorPath, path.join(resultDirPath, rawErrorFileName));
            }
        }
    }

    // Group errors and create summary files.
    if (summaries.length > 0) {
        const { groupedOldErrors, groupedNewErrors } = groupErrors(summaries, implementation);

        for (let [key, value] of groupedOldErrors) {
            const summary = createOldErrorSummary(value, implementation);
            const resultFileName = `!${key}.${resultFileNameSuffix}`; // Exclamation point makes the file to be put first when ordering.

            await fs.promises.writeFile(path.join(resultDirPath, resultFileName), summary, { encoding: "utf-8" });
        }

        for (let [key, value] of groupedNewErrors) {
            const summary = await createNewErrorSummaryAsync(value, implementation);
            const resultFileName = `${key}.${resultFileNameSuffix}`;

            await fs.promises.writeFile(path.join(resultDirPath, resultFileName), summary, { encoding: "utf-8" });
        }
    }

    if (oldTscDirPath) {
        await execAsync(processCwd, "rm -rf " + oldTscDirPath);
    }
    await execAsync(processCwd, "rm -rf " + newTscDirPath);

    console.log("Statuses");
    for (const status of Object.keys(statusCounts).sort()) {
        console.log(`${status}\t${statusCounts[status as RepoStatus]}`);
    }

    const metadata: Metadata = {
        newTsResolvedVersion: newTsResolvedVersion,
        oldTsResolvedVersion: oldTsResolvedVersion || "",
        statusCounts,
        lspRequestStats: params.entrypoint === "fuzzer" ? aggregateLspStats : undefined,
        prngSeed: effectiveSeed,
    };
    await fs.promises.writeFile(path.join(resultDirPath, metadataFileName), JSON.stringify(metadata), { encoding: "utf-8" });
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
        console.log(insetLines(reduceSpew(err.stack)));
    }
    else {
        console.log(insetLines(reduceSpew(err.message ?? "No message")));
        console.log(insetLines(err.stack ?? "Unknown Stack"));
    }
}

function dumpSpawnResult(spawnResult: SpawnResult): void {
    console.log(`ExitCode: ${spawnResult.code}
Signal: ${spawnResult.signal}
stdout:
>>>
${spawnResult.stdout}
<<<
stderr:
>>>
${spawnResult.stderr}
<<<
`);
}


export interface ServerHarnessOutput {
    request_seq: number;
    command: string;
    message: string
}

function parseServerHarnessOutput(error: string): ServerHarnessOutput | string {
    try {
        return JSON.parse(error)
    }
    catch {
        // Sometimes, the response isn't JSON and that's fine
        return error;
    }
}

function prettyPrintServerHarnessOutput(error: string, filter: boolean): string {
    const errorObj = parseServerHarnessOutput(error);
    if (typeof errorObj === "string") {
        return errorObj;
    }

    if (errorObj.message) {
        return `Req #${errorObj.request_seq} - ${errorObj.command}
${filter ? filterToTsserverLines(errorObj.message) : errorObj.message}`;
    }

    // It's not really clear how this could happen, but reporting the whole repsonse should be fine
    // if there's no message property
    return JSON.stringify(errorObj, undefined, 2);
}

function filterToTsserverLines(stackLines: string): string {
    const tsserverRegex = /^.*(?:tsserver|typescript)\.js.*$/mg;
    let tsserverLines = "";
    let match;
    while (match = tsserverRegex.exec(stackLines)) {
        tsserverLines += match[0].replace(processCwd, "") + "\n";
    }
    return tsserverLines.trimEnd();
}

// LSP harness output helpers

export interface LspHarnessOutput {
    method: string;
    message: string;
    seq: number;
}

function parseLspHarnessOutput(output: string): LspHarnessOutput | string {
    try {
        const parsed = JSON.parse(output);
        if (parsed.method !== undefined && parsed.message !== undefined) {
            return parsed as LspHarnessOutput;
        }
        return output;
    }
    catch {
        return output;
    }
}

function prettyPrintLspHarnessOutput(error: string, filter: boolean): string {
    const errorObj = parseLspHarnessOutput(error);
    if (typeof errorObj === "string") {
        return errorObj;
    }

    if (errorObj.message) {
        return `${errorObj.method}\n${filter ? filterToGoLines(errorObj.message) : errorObj.message}`;
    }

    return JSON.stringify(errorObj, undefined, 2);
}

function getLspErrorMessage(output: string): string {
    const error = parseLspHarnessOutput(output);
    if (typeof error === "string") return error;

    // The first line of the message is typically "panic handling request <method>: <error>"
    const firstLine = error.message.split(/\r?\n/)[0];
    return firstLine;
}

function filterToGoLines(stackLines: string): string {
    const goRegex = /^.*(?:typescript-go|typescript[\\/]tsc).*$/img;
    let goLines = "";
    let match;
    while (match = goRegex.exec(stackLines)) {
        goLines += match[0] + "\n";
    }
    return goLines.trimEnd() || stackLines;
}

function insetLines(text: string): string {
    return text.trimEnd().replace(/(^|\n)/g, "$1> ");
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
        : `[${mdEscape(match[1])}](${url})`;
}

interface DownloadedTs {
    tsEntrypointPath: string;
    resolvedVersion: string;
    implementation: TypeScriptImplementation;
}

async function downloadTsAsync(cwd: string, params: ScheduledParams | TriggeredParams): Promise<{ oldTsEntrypointPath: string | undefined, oldTsResolvedVersion: string | undefined, newTsEntrypointPath: string, newTsResolvedVersion: string, implementation: TypeScriptImplementation }> {
    const entrypoint = params.entrypoint;
    if (params.testType === "triggered") {
        console.log("running user test, downloading TS from repo");
        if (params.entrypoint === "fuzzer") {
            throw new Error("Not implemented");
        }
        const { tsEntrypointPath: oldTsEntrypointPath, resolvedVersion: oldTsResolvedVersion, implementation: oldImplementation } = await downloadTsRepoAsync(cwd, params.oldTsRepoUrl, params.oldHeadRef, entrypoint);
        // We need to handle the ref/pull/*/merge differently as it is not a branch and cannot be pulled during clone.
        const { tsEntrypointPath: newTsEntrypointPath, resolvedVersion: newTsResolvedVersion, implementation } = await downloadTsPrAsync(cwd, params.oldTsRepoUrl, params.prNumber, entrypoint);

        if (entrypoint === "tsserver" && oldImplementation !== implementation) {
            throw new Error("Cannot compare tsserver refs across the TypeScript-to-tsgo migration boundary");
        }

        return {
            oldTsEntrypointPath,
            oldTsResolvedVersion,
            newTsEntrypointPath,
            newTsResolvedVersion,
            implementation
        };
    }
    else if (params.testType === "scheduled") {
        const { tsEntrypointPath: oldTsEntrypointPath, resolvedVersion: oldTsResolvedVersion } = params.entrypoint === "fuzzer" ?
            { tsEntrypointPath: undefined, resolvedVersion: undefined } :
            await downloadTsNpmAsync(cwd, params.oldTsNpmVersion, entrypoint);
        const { tsEntrypointPath: newTsEntrypointPath, resolvedVersion: newTsResolvedVersion, implementation } = params.entrypoint === "fuzzer" ?
            params.newTsNpmVersion === "main" ?
                await downloadTsRepoAsync(cwd, "https://github.com/microsoft/typescript-go.git", /*headRef*/ "main", entrypoint) :
                await downloadTsNativePreviewNpmAsync(cwd, params.newTsNpmVersion) :
            params.candidateImplementation === "corsa" ?
                await downloadTsNativePreviewNpmAsync(cwd, params.newTsNpmVersion) :
                await downloadTsNpmAsync(cwd, params.newTsNpmVersion, entrypoint);

        return {
            oldTsEntrypointPath,
            oldTsResolvedVersion,
            newTsEntrypointPath,
            newTsResolvedVersion,
            implementation
        };
    }
    else {
        throw new Error("Invalid parameters");
    }
}

function getTsRepoDownloadName(repoUrl: string, ref: string): string {
    const repoName = path.basename(repoUrl).replace(/\.git$/, "").toLowerCase();
    return `${repoName}-${ref}`;
}

export async function downloadTsRepoAsync(cwd: string, repoUrl: string, headRef: string, target: TsEntrypoint): Promise<DownloadedTs> {
    console.log(`Cloning ${repoUrl} at ref ${headRef}`);
    const repoName = getTsRepoDownloadName(repoUrl, headRef);
    await git.cloneRepoIfNecessary(cwd, { name: repoName, url: repoUrl, branch: headRef });

    const repoPath = path.join(cwd, repoName);
    const { tsEntrypointPath, implementation } = await buildTs(repoPath, target);

    return {
        tsEntrypointPath,
        resolvedVersion: headRef,
        implementation
    };
}

async function downloadTsPrAsync(cwd: string, repoUrl: string, prNumber: number, target: TsEntrypoint): Promise<DownloadedTs> {
    console.log(`Cloning ${repoUrl} at pull ${prNumber}`);

    const repoName = getTsRepoDownloadName(repoUrl, prNumber.toString());
    console.log(`Building in ${repoName}`);

    await git.cloneRepoIfNecessary(cwd, { name: repoName, url: repoUrl });

    const repoPath = path.join(cwd, repoName);
    const headRef = `refs/pull/${prNumber}/merge`;

    await git.checkout(repoPath, headRef);
    const { tsEntrypointPath, implementation } = await buildTs(repoPath, target);

    return {
        tsEntrypointPath,
        resolvedVersion: headRef,
        implementation
    };
}

export function detectTypeScriptImplementation(packageJson: { name?: string }): TypeScriptImplementation {
    return packageJson.name === "typescript" ? "strada" : "corsa";
}

async function buildTs(repoPath: string, entrypoint: TsEntrypoint): Promise<{ tsEntrypointPath: string, implementation: TypeScriptImplementation }> {
    const packageJsonPath = path.join(repoPath, "package.json");
    const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, { encoding: "utf-8" })) as { name?: string };
    const implementation = detectTypeScriptImplementation(packageJson);

    await execAsync(repoPath, "npm ci");
    console.log(`Building in ${repoPath}`);

    if (implementation === "corsa") {
        await execAsync(repoPath, `npx hereby build`);
        const candidates = [
            path.join(repoPath, "built", "local", "tsc"),
            path.join(repoPath, "built", "local", "tsgo"),
        ];
        for (const tsEntrypointPath of candidates) {
            if (await pu.exists(tsEntrypointPath)) {
                return { tsEntrypointPath, implementation };
            }
        }
        throw new Error(`Cannot find tsgo entrypoint in ${path.join(repoPath, "built", "local")}`);
    }
    else {
        await execAsync(repoPath, `npx gulp ${entrypoint}`);

        if (entrypoint === "tsc") {
            // We build the LKG for the benefit of scenarios that want to install it as an npm package
            await execAsync(repoPath, "npx gulp configure-insiders");
            await execAsync(repoPath, "npx gulp LKG");
        }

        return { tsEntrypointPath: path.join(repoPath, "built", "local", `${entrypoint}.js`), implementation };
    }
}

async function downloadTsNpmAsync(cwd: string, version: string, entrypoint: TsEntrypoint): Promise<DownloadedTs> {
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

    const tsEntrypointPath = path.join(dirPath, "lib", `${entrypoint}.js`);
    if (!await pu.exists(tsEntrypointPath)) {
        throw new Error("Cannot find file " + tsEntrypointPath);
    }

    return { tsEntrypointPath, resolvedVersion, implementation: "strada" };
}

async function downloadTsNativePreviewNpmAsync(cwd: string, version: string): Promise<DownloadedTs> {
    const packageName = `native-preview-${process.platform}-${process.arch}`
    const tarName = (await execAsync(cwd, `npm pack @typescript/${packageName}@${version} --quiet`)).trim();

    const tarMatch = /^(typescript-native-preview-(.+))\..+$/.exec(tarName);
    if (!tarMatch) {
        throw new Error("Unexpected tarball name format: " + tarName);
    }

    const resolvedVersion = tarMatch[2];
    const dirName = tarMatch[1];
    const dirPath = path.join(processCwd, dirName);

    await execAsync(cwd, `tar xf ${tarName} && rm ${tarName}`);
    await fs.promises.rename(path.join(processCwd, "package"), dirPath);

    const tsEntrypointPath = path.join(dirPath, "lib", "tsgo");
    if (!await pu.exists(tsEntrypointPath)) {
        throw new Error("Cannot find file " + tsEntrypointPath);
    }

    return { tsEntrypointPath, resolvedVersion, implementation: "corsa" };
}
