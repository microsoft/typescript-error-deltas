import fs = require("fs");
import json5 = require("json5");
import path = require("path");
import utils = require("./packageUtils");

/**
 * String value will be the unqualified command name.
 */
export enum InstallTool {
    Npm = "npm",
    Yarn = "yarn",
}

export interface InstallCommand {
    directory: string;
    tool: InstallTool;
    arguments: readonly string[];
}

/**
 * Traverses the given directory and returns a list of commands that can be used, in order, to restore
 * the packages required for building.
 */
export async function restorePackages(repoDir: string, ignoreScripts: boolean = true, recursiveSearch: boolean, lernaPackages?: readonly string[], types?: string[]): Promise<readonly InstallCommand[]> {
    lernaPackages = lernaPackages ?? await utils.getLernaOrder(repoDir);

    // The existence of .yarnrc.yml indicates that this repo uses yarn 2
    const isRepoYarn2 = await utils.exists(path.join(repoDir, ".yarnrc.yml"));

    const commands: InstallCommand[] = [];

    const globPattern = recursiveSearch ? "**/package.json" : "package.json";
    const packageFiles = utils.glob(repoDir, globPattern);

    for (const packageFile of packageFiles) {
        let inLernaPackageDir = false;
        for (const lernaPackage of lernaPackages) {
            if (inLernaPackageDir = packageFile.startsWith(lernaPackage)) break;
        }
        if (inLernaPackageDir) {
            // Skipping restore of lerna package
            continue;
        }

        // CONSIDER: If we're ignoring scripts, there are lerna packages, and we're not
        // using yarn workspaces, we might want to `lerna bootstrap`.  In practice,
        // this has not proven to be necessary, since this combination is uncommon.

        const packageRoot = path.dirname(packageFile);

        let tool: InstallTool;
        let args: string[];

        const isProjectYarn2 = isRepoYarn2 || await utils.exists(path.join(packageRoot, ".yarnrc.yml"));
        if (await utils.exists(path.join(packageRoot, "yarn.lock"))) {
            tool = InstallTool.Yarn;

            // Yarn 2 dropped support for most `install` arguments
            if (isProjectYarn2) {
                args = ["install"]
            }
            else {
                args = ["install", "--silent", "--ignore-engines"];

                if (ignoreScripts) {
                    args.push("--ignore-scripts");
                }
            }
        }
        else if (await utils.exists(path.join(packageRoot, "package.json"))) {
            tool = InstallTool.Npm;

            const haveLock = await utils.exists(path.join(packageRoot, "package-lock.json")) ||
                await hasCurrentShrinkwrap(packageRoot);

            args = [haveLock ? "ci" : "install", "--prefer-offline", "--no-audit", "-q", "--no-progress"];

            if (ignoreScripts) {
                args.push("--ignore-scripts");
            }
        }
        else {
            continue;
        }

        commands.push({
            directory: packageRoot,
            tool,
            arguments: args,
        });

        if (types && types.length > 0) {
            const args = isProjectYarn2
                ? ["install", ...types.map(t => `@types/${t}`), "--ignore-scripts"]
                : ["install", ...types.map(t => `@types/${t}`), "--no-save", "--ignore-scripts", "--legacy-peer-deps"]

            commands.push({
                directory: packageRoot,
                tool,
                arguments: args
            });
        }
    }

    return commands;
}

async function hasCurrentShrinkwrap(packageRoot: string): Promise<boolean> {
    if (!utils.exists(path.join(packageRoot, "npm-shrinkwrap.json"))) {
        return false;
    }

    try {
        const contents = await fs.promises.readFile(path.join(packageRoot, "npm-shrinkwrap.json"), { encoding: "utf-8" });
        const value = json5.parse(contents);
        return +value.lockfileVersion >= 1;
    }
    catch {
        return false;
    }
}

