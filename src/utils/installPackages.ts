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
    Pnpm = "pnpm",
}

export interface InstallCommand {
    directory: string;
    tool: InstallTool;
    arguments: readonly string[];
}

/**
 * Traverses the given directory and returns a list of commands that can be used, in order, to install
 * the packages required for building.
 */
export async function installPackages(repoDir: string, ignoreScripts: boolean, quietOutput: boolean, recursiveSearch: boolean, lernaPackages?: readonly string[], types?: string[]): Promise<InstallCommand[]> {
    lernaPackages = lernaPackages ?? await utils.getLernaOrder(repoDir);

    const isRepoYarn = await utils.exists(path.join(repoDir, "yarn.lock"));
    // The existence of .yarnrc.yml indicates that this repo uses yarn 2
    const isRepoYarn2 = await utils.exists(path.join(repoDir, ".yarnrc.yml"));
    const isRepoPnpm = await utils.exists(path.join(repoDir, "pnpm-lock.yaml"));

    const commands: InstallCommand[] = [];

    const globPattern = recursiveSearch ? "**/package.json" : "package.json";
    const packageFiles = utils.glob(repoDir, globPattern);

    for (const packageFile of packageFiles) {
        let inLernaPackageDir = false;
        for (const lernaPackage of lernaPackages) {
            if (inLernaPackageDir = packageFile.startsWith(lernaPackage)) break;
        }
        if (inLernaPackageDir) {
            // Skipping installation of lerna package
            continue;
        }

        // CONSIDER: If we're ignoring scripts, there are lerna packages, and we're not
        // using yarn workspaces, we might want to `lerna bootstrap`.  In practice,
        // this has not proven to be necessary, since this combination is uncommon.

        const packageRoot = path.dirname(packageFile);

        // Heuristic, these are rarely valuable and often fail.
        if (/fixtures?/i.test(packageRoot)) {
            continue;
        }

        let tool: InstallTool;
        let args: string[];

        const isProjectYarn2 = isRepoYarn2 || await utils.exists(path.join(packageRoot, ".yarnrc.yml"));
        if (isProjectYarn2 ||
            await utils.exists(path.join(packageRoot, "yarn.lock")) ||
            (isRepoYarn && !(await utils.exists(path.join(packageRoot, "package-lock.json"))))) {
            tool = InstallTool.Yarn;

            // Yarn 2 dropped support for most `install` arguments
            if (isProjectYarn2) {
                args = ["install", "--no-immutable"]

                if (ignoreScripts) {
                    // TODO: this seems to be called --skip-build in yarn 3 - we might want to try to distinguish
                    args.push("--mode=skip-build");
                }
            }
            else {
                args = ["install", "--silent", "--ignore-engines"];

                if (ignoreScripts) {
                    args.push("--ignore-scripts");
                }

                if (quietOutput) {
                    args.push("--silent");
                }
            }
        }
        else if (isRepoPnpm || await utils.exists(path.join(packageRoot, "pnpm-lock.yaml"))) {
            tool = InstallTool.Pnpm;
            args = ["install", "--no-frozen-lockfile", "--prefer-offline"];

            if (ignoreScripts) {
                args.push("--ignore-scripts");
            }

            if (quietOutput) {
                args.push("--reporter=silent");
            }

        }
        else if (await utils.exists(path.join(packageRoot, "package.json"))) {
            tool = InstallTool.Npm;

            const haveLock = await utils.exists(path.join(packageRoot, "package-lock.json")) ||
                await hasCurrentShrinkwrap(packageRoot);

            args = [haveLock ? "ci" : "install", "--prefer-offline", "--no-audit", "--no-progress", "--legacy-peer-deps"];

            if (ignoreScripts) {
                args.push("--ignore-scripts");
            }

            if (quietOutput) {
                args.push("-q");
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
            // `types` is only present for user tests and all known user tests use npm, not yarn
            // Besides, we're using --no-save, so it shouldn't matter which tool we use
            const typesPackageNames = types.map(t => `@types/${t}`);
            const args = ["install", ...typesPackageNames, "--no-save", "--ignore-scripts", "--legacy-peer-deps"];

            commands.push({
                directory: packageRoot,
                tool: InstallTool.Npm,
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

