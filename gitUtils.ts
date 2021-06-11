import octokit = require("@octokit/rest");
import utils = require("./packageUtils");
import git = require("simple-git/promise");
import fs = require("fs");
import path = require("path");

export interface Repo {
    name: string;
    url?: string;
    owner?: string;
    types?: string[];
    branch?: string;
}

export async function getPopularTypeScriptRepos(count: number, cachePath?: string): Promise<readonly Repo[]> {
    const cacheEncoding = { encoding: "utf-8" } as const;

    if (cachePath && await utils.exists(cachePath)) {
        const contents = await fs.promises.readFile(cachePath, cacheEncoding);
        const cache: Repo[] = JSON.parse(contents);
        if (cache.length >= count) {
            return cache.slice(0, count);
        }
    }

    const kit = new octokit.Octokit();
    const perPage = Math.min(100, count);

    let repos: Repo[] = [];
    for (let page = 1; repos.length < count; page++) {
        const response = await kit.search.repos({
            q: "language:TypeScript+stars:>100 archived:no",
            sort: "stars",
            order: "desc",
            per_page: perPage,
            page,
        });

        if (response.status !== 200) throw response;

        for (const repo of response.data.items) {
            if (repo.full_name !== "microsoft/TypeScript" && repo.full_name !== "DefinitelyTyped/DefinitelyTyped") {
                repos.push({ url: repo.html_url, name: repo.name, owner: repo.owner.login });
            }
            if (repos.length >= count) {
                break;
            }
        }

        if (!response.headers.link || !response.headers.link.includes('rel="next"')) break;
    }

    if (cachePath) {
        await fs.promises.writeFile(cachePath, JSON.stringify(repos), cacheEncoding);
    }

    return repos;
}

export async function cloneRepoIfNecessary(parentDir: string, repo: Repo): Promise<void> {
    if (!repo.url) {
        throw new Error("Repo url cannot be `undefined`");
    }

    if (!await utils.exists(path.join(parentDir, repo.name))) {
        console.log(`Cloning ${repo.url} into ${repo.name}`);

        let options = ["--recurse-submodules", "--depth=1"];
        if (repo.branch) {
            options.push(`--branch=${repo.branch}`);
        }

        await git(parentDir).clone(repo.url, repo.name, options);
    }
}