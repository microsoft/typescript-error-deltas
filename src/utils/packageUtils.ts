import fs = require("fs");
import globCps = require("glob");
import json5 = require("json5");
import path = require("path");
import yaml = require("js-yaml");

interface Package {
    meta_dir: string,
    meta_state: "unvisited" | "visiting" | "visited",
    name: string,
    workspaces?: readonly string[] | { packages: readonly string[] },
    dependencies?: readonly string[],
    devDependencies?: readonly string[],
    peerDependencies?: readonly string[],
}

/**
 * `glob`, but ignoring node_modules and symlinks, and returning absolute paths.
 */
export function glob(cwd: string, pattern: string): string[] {
    return globCps.sync(pattern, { cwd, absolute: true, ignore: "**/node_modules/**", follow: false })
}

/**
 * Returns true if the path exists.
 */
export async function exists(path: string): Promise<boolean> {
    return new Promise(resolve => fs.exists(path, e => resolve(e)));
}

/**
 * Heuristically returns a list of package.json paths in monorepo dependency order.
 * NB: Does not actually consume lerna.json.
 */
export async function getMonorepoOrder(repoDir: string): Promise<readonly string[]> {
    const yarnLockFiles = glob(repoDir, "**/yarn.lock");
    if (yarnLockFiles.length) {
        const yarnWorkspaceOrder: string[] = [];
        for (const yarnLockFile of yarnLockFiles) {
            const yarnDir = path.dirname(yarnLockFile);
            const pkgPath = path.join(yarnDir, "package.json");
            if (await exists(pkgPath)) {
                const contents = await fs.promises.readFile(pkgPath, { encoding: "utf-8" });
                const pkg: Package = json5.parse(contents);
                const workspaces = pkg.workspaces;
                if (workspaces) {
                    const workspaceDirs = "packages" in workspaces ? workspaces.packages : workspaces;
                    for (const workspaceDir of workspaceDirs) {
                        // workspaceDir might end with `/*` - glob will do the right thing
                        const pkgPaths = glob(yarnDir, path.join(workspaceDir, "package.json"));
                        await appendOrderedMonorepoPackages(pkgPaths, yarnWorkspaceOrder);
                    }
                }
            }
        }
        if (yarnWorkspaceOrder.length) {
            return yarnWorkspaceOrder;
        }
    }

    const pnpmWorkspaceFiles = glob(repoDir, "**/pnpm-workspace.yaml");
    if (pnpmWorkspaceFiles.length) {
        const pnpmWorkspaceOrder: string[] = [];
        for (const pnpmWorkspaceFile of pnpmWorkspaceFiles) {
            const contents = await fs.promises.readFile(pnpmWorkspaceFile, { encoding: "utf-8" });
            const config = yaml.load(contents) as { packages?: string[] } | undefined; // undefined for an empty test fixture
            const workspaceDirs = config?.packages;
            if (workspaceDirs) {
                const pnpmDir = path.dirname(pnpmWorkspaceFile);
                for (const workspaceDir of workspaceDirs) {
                    // CONSIDER: Should technically exclude those beginning with `!`
                    if (workspaceDir.startsWith("!")) continue;
                        // workspaceDir might end with `/*` - glob will do the right thing
                    const pkgPaths = glob(pnpmDir, path.join(workspaceDir, "package.json"));
                    await appendOrderedMonorepoPackages(pkgPaths, pnpmWorkspaceOrder);
                }
            }
        }
        if (pnpmWorkspaceOrder.length) {
            return pnpmWorkspaceOrder;
        }
    }

    const lernaFiles = glob(repoDir, "**/lerna.json");
    if (lernaFiles.length) {
        const lernaOrder: string[] = [];
        for (const lernaFile of lernaFiles) {
            const lernaDir = path.dirname(lernaFile);
            if (await exists(path.join(lernaDir, "packages"))) {
                const pkgPaths = glob(path.join(lernaDir, "packages"), "**/package.json");
                await appendOrderedMonorepoPackages(pkgPaths, lernaOrder);
            }
        }
        if (lernaOrder.length) {
            return lernaOrder;
        }
    }

    const npmLockFiles = glob(repoDir, "**/package-lock.json");
    if (npmLockFiles.length) {
        const npmWorkspaceOrder: string[] = [];
        for (const npmLockFile of npmLockFiles) {
            const npmDir = path.dirname(npmLockFile);
            const pkgPath = path.join(npmDir, "package.json");
            if (await exists(pkgPath)) {
                const contents = await fs.promises.readFile(pkgPath, { encoding: "utf-8" });
                const pkg: Package = json5.parse(contents);
                const workspaces = pkg.workspaces;
                if (workspaces) {
                    const workspaceDirs = "packages" in workspaces ? workspaces.packages : workspaces;
                    for (const workspaceDir of workspaceDirs) {
                        // workspaceDir might end with `/*` - glob will do the right thing
                        const pkgPaths = glob(npmDir, path.join(workspaceDir, "package.json"));
                        await appendOrderedMonorepoPackages(pkgPaths, npmWorkspaceOrder);
                    }
                }
            }
        }
        if (npmWorkspaceOrder.length) {
            return npmWorkspaceOrder;
        }
    }

    return [];
}

async function appendOrderedMonorepoPackages(pkgPaths: string[], monorepoOrder: string[]) {
    const pkgs = await Promise.all(pkgPaths.map(async (pkgPath) => {
        const contents = await fs.promises.readFile(pkgPath, { encoding: "utf-8" });
        const pkg: Package = json5.parse(contents);
        pkg.meta_dir = path.dirname(pkgPath);
        pkg.meta_state = "unvisited";
        return pkg;
    }));
    const pkgMap: Record<string, Package | undefined> = {};
    for (const pkg of pkgs) {
        pkgMap[pkg.name] = pkg;
    }

    while (true) {
        const pkg = pkgs.find(p => p.meta_state === "unvisited");
        if (!pkg) break;
        visit(pkg);
    }

    function visit(pkg: Package): void {
        // "visiting" indicates a cycle, which some monorepo systems (e.g. lerna) allow
        if (pkg.meta_state !== "unvisited") return;

        pkg.meta_state = "visiting";

        if (pkg.dependencies) {
            for (const dep in pkg.dependencies) {
                const depPkg = pkgMap[dep];
                if (depPkg) visit(depPkg);
            }
        }

        if (pkg.devDependencies) {
            for (const dep in pkg.devDependencies) {
                const depPkg = pkgMap[dep];
                if (depPkg) visit(depPkg);
            }
        }

        if (pkg.peerDependencies) {
            for (const dep in pkg.peerDependencies) {
                const depPkg = pkgMap[dep];
                if (depPkg) visit(depPkg);
            }
        }

        pkg.meta_state = "visited";
        monorepoOrder.push(pkg.meta_dir);
    }
}

