import type { Repo } from "./gitUtils";
import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";

interface UserConfig {
    types: string[];
    cloneUrl: string;
    branch?: string;
    path?: string;
}

export function getUserTestsRepos(testDir: string): Repo[] {
    // TODO: Figure out why chrome-devtools-frontend is failing.

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
        else if (fs.existsSync(path.join(testDir, directory, "package.json"))) {
            repos.push({
                name: directory,
            });
        }
    }

    return repos;
}

export async function copyUserRepo(parentDir: string, testDir: string, repo: Repo,) {
    const repoDir = path.join(parentDir, repo.name);
    await execAsync(parentDir, `mkdir ${repoDir}`);
    await execAsync(repoDir, `cp -R ${path.join(testDir, repo.name)}/* .`);
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
