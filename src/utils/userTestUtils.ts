import type { Repo } from "./gitUtils";
import * as fs from "node:fs";
import * as path from "node:path";

interface UserConfig {
    types: string[];
    cloneUrl: string;
    branch?: string;
    path?: string;
}

export function getUserTestsRepos(testDir: string): Repo[] {
    const repoDirectories = fs.readdirSync(`${testDir}`, { withFileTypes: true })
        .filter(value => value.isDirectory())
        .map(value => value.name);

    const repos: Repo[] = [];
    for (let directory of repoDirectories) {
        const testFile = path.join(testDir, directory, "test.json");
        if (fs.existsSync(testFile)) {
            const config = JSON.parse(fs.readFileSync(testFile, { encoding: "utf8" })) as UserConfig;
            repos.push({
                name: directory,
                url: config.cloneUrl,
                types: config.types,
                branch: config.branch,
            });
        }
        else if (fs.existsSync(path.join(testDir, directory, "package.json")) || fs.existsSync(path.join(testDir, directory, "build.sh"))) {
            repos.push({
                name: directory,
            });
        }
    }

    return repos;
}

export async function copyUserRepo(parentDir: string, testDir: string, repo: Repo,) {
    const repoDir = path.join(parentDir, repo.name);
    await fs.promises.mkdir(repoDir);
    const sourceDir = path.join(testDir, repo.name);
    for (const entry of await fs.promises.readdir(sourceDir)) {
        await fs.promises.cp(path.join(sourceDir, entry), path.join(repoDir, entry), { recursive: true });
    }
}
