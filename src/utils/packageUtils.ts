import fs = require("fs");
import globCps = require("glob");
import json5 = require("json5");
import path = require("path");

interface Package {
    meta_dir: string,
    meta_state: "unvisited" | "visiting" | "visited",
    name: string,
    dependencies: string[],
    devDependencies: string[],
    peerDependencies: string[],
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
    const monorepoOrder: string[] = [];
    const lernaFiles = glob(repoDir, "**/lerna.json");
    for (const lernaFile of lernaFiles) {
        const lernaDir = path.dirname(lernaFile);
        if (await exists(path.join(lernaDir, "packages"))) {
            const pkgPaths = glob(path.join(lernaDir, "packages"), "**/package.json");
            await getMonorepoOrderWorker(pkgPaths, monorepoOrder);
        }
    }

    return monorepoOrder;
}
async function getMonorepoOrderWorker(pkgPaths: string[], monorepoOrder: string[]) {
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

        for (const dep in pkg.dependencies) {
            const depPkg = pkgMap[dep];
            if (depPkg) visit(depPkg);
        }

        for (const dep in pkg.devDependencies) {
            const depPkg = pkgMap[dep];
            if (depPkg) visit(depPkg);
        }

        for (const dep in pkg.peerDependencies) {
            const depPkg = pkgMap[dep];
            if (depPkg) visit(depPkg);
        }

        pkg.meta_state = "visited";
        monorepoOrder.push(pkg.meta_dir);
    }
}

