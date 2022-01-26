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
export function glob(cwd: string, pattern: string): readonly string[] {
    return globCps.sync(pattern, { cwd, absolute: true, ignore: "**/node_modules/**", follow: false })
}

/**
 * Returns true if the path exists.
 */
export async function exists(path: string): Promise<boolean> {
    return new Promise(resolve => fs.exists(path, e => resolve(e)));
}
