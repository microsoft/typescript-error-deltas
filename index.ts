import ge = require("@typescript/get-errors");
import git = require("@typescript/git-utils");
import ip = require("@typescript/install-packages");
import pu = require("@typescript/package-utils");
import cp = require("child_process");
import fs = require("fs");
import path = require("path");

const { argv } = process;

if (argv.length !== 5) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} {repo_count} {old_tsc_version} {new_tsc_version}`);
    process.exit(-1);
}

const processCwd = process.cwd();

const repoCount = +argv[2];
const oldTscVersion = argv[3];
const newTscVersion = argv[4];


mainAsync().catch(err => {
    reportError(err, "Unhandled exception");
    process.exit(1);
});

async function mainAsync() {
    const downloadDir = "/mnt/ts_downloads";
    await execAsync(processCwd, "sudo", ["mkdir", downloadDir]);

    const { tscPath: oldTscPath, resolvedVersion: oldTscResolvedVersion } = await downloadTypeScriptAsync(processCwd, oldTscVersion);
    const { tscPath: newTscPath, resolvedVersion: newTscResolvedVersion } = await downloadTypeScriptAsync(processCwd, newTscVersion);

    console.log("Old version = " + oldTscResolvedVersion);
    console.log("New version = " + newTscResolvedVersion);

    const resultsDir = path.join(processCwd, "_Results_");
    await fs.promises.mkdir(resultsDir);

    const repos = await git.getPopularTypeScriptRepos(repoCount);

    const writeFileOptions = { encoding: "utf-8" } as const;

    for (const repo of repos) {
        // These repos generally have custom build systems (e.g. bazel)
        if (/angular/.exec(repo.name)) {
            continue;
        }

        console.log("Starting " + repo.url);

        await execAsync(processCwd, "sudo", ["mount", "-t", "tmpfs", "-o", "size=3g", "tmpfs", downloadDir]);

        try {
            console.log("Cloning if absent");
            await git.cloneRepoIfNecessary(downloadDir, repo);
        }
        catch (err) {
            reportError(err, "Error cloning " + repo.url);
            continue;
        }

        const repoDir = path.join(downloadDir, repo.name);

        try {
            console.log("Installing packages if absent");
            const commands = await ip.restorePackages(repoDir, /*ignoreScripts*/ true);
            for (const { directory: packageRoot, tool, arguments: args } of commands) {
                await execAsync(packageRoot, tool, args);
            }
        }
        catch (err) {
            reportError(err, "Error installing packages for " + repo.url);
            console.log("Memory");
            console.log(await execAsync(processCwd, "free", ["-h"]));
            console.log("Disk");
            console.log(await execAsync(processCwd, "df", ["-h"]));
            console.log(await execAsync(processCwd, "df", ["-i"]));
            continue;
        }

        try {
            console.log(`Building with ${oldTscPath} (old)`);
            const oldErrors = await ge.buildAndGetErrors(repoDir, oldTscPath, /*skipLibCheck*/ true);
            await fs.promises.writeFile(path.join(resultsDir, repo.name + "_old.json"), JSON.stringify(oldErrors), writeFileOptions);

            if (oldErrors.hasConfigFailure) {
                continue;
            }

            // CONSIDER: Could skip the second build if no project succeeded in the first

            console.log(`Building with ${newTscPath} (new)`);
            const newErrors = await ge.buildAndGetErrors(repoDir, newTscPath, /*skipLibCheck*/ true);
            await fs.promises.writeFile(path.join(resultsDir, repo.name + "_new.json"), JSON.stringify(newErrors), writeFileOptions);

            if (newErrors.hasConfigFailure) {
                throw new Error("No longer able to build project graph for " + repo.url);
            }

            let numSkipped = 0;

            console.log("Comparing errors");
            for (const oldProjectErrors of oldErrors.projectErrors) {
                // To keep things simple, we'll focus on projects that used to build cleanly
                if (oldProjectErrors.hasBuildFailure || oldProjectErrors.errors.length) {
                    numSkipped++;
                    continue;
                }

                const newProjectErrors = newErrors.projectErrors.find(pe => pe.projectUrl == oldProjectErrors.projectUrl);
                if (!newProjectErrors || !newProjectErrors.errors.length) {
                    continue;
                }

                console.log(`New errors for ${oldProjectErrors.isComposite ? "composite" : "non-composite"} project ${oldProjectErrors.projectUrl}`);
                for (const newError of newProjectErrors.errors) {
                    console.log(`\tTS${newError.code} at ${newError.fileUrl ?? "project scope"}${oldProjectErrors.isComposite ? ` in ${newError.projectUrl}`: ``}`);
                    console.log(`\t\t${newError.text}`);
                }
            }

            console.log(`Skipped ${numSkipped} of ${oldErrors.projectErrors.length} projects for not building with the old tsc`);
        }
        catch (err) {
            reportError(err, "Error building " + repo.url);
            continue;
        }

        // Throw away the repo so we don't run out of space
        // Note that we specifically don't recover and attempt another repo if this fails
        await execAsync(processCwd, "sudo", ["umount", downloadDir]);

        console.log("Done " + repo.url);
    }
}

function reportError(err: any, message: string) {
    console.error(message);
    console.error(truncate(err.message, 1024));
    console.error(err.stack ?? "Unknown Stack");
}

async function execAsync(cwd: string, command: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) =>
        cp.execFile(command, args, { cwd }, (err, stdout, stderr) => {
            if (err) {
                console.log(truncate(stdout, 1024));
                console.error(truncate(stderr, 1024));
                reject(err);
            }
            resolve(stdout);
         }));
}

function truncate(message: string, maxLength: number): string {
    return message.length < maxLength
        ? message
        : (message.substring(0, maxLength - 3) + "...");
}

async function downloadTypeScriptAsync(cwd: string, version: string): Promise<{ tscPath: string, resolvedVersion: string }> {
    const tarName = (await execAsync(cwd, "npm", ["pack", `typescript@${version}`, "--quiet"])).trim();

    const tarMatch = /^(typescript-(.+))\..+$/.exec(tarName);
    if (!tarMatch) {
        throw new Error("Unexpected tarball name format: " + tarName);
    }

    const resolvedVersion = tarMatch[2];
    const dirName = tarMatch[1];
    const dirPath = path.join(processCwd, dirName);

    await execAsync(cwd, "tar", ["xf", tarName]);
    await fs.promises.rename(path.join(processCwd, "package"), dirPath);

    const tscPath = path.join(dirPath, "lib", "tsc.js");
    if (!await pu.exists(tscPath)) {
        throw new Error("Cannot find file " + tscPath);
    }

    return { tscPath, resolvedVersion };
}