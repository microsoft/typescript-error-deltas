import octokit = require("@octokit/rest");
import { execAsync } from "./execUtils";
import utils = require("./packageUtils");
import fs = require("fs");
import path = require("path");

// The bundled types don't work with CJS imports
import { simpleGit as git } from "simple-git";

export interface Repo {
    name: string;
    url?: string;
    owner?: string;
    types?: string[];
    branch?: string;
}

const repoProperties = {
    owner: "microsoft",
    repo: "typescript",
};

export async function getPopularTypeScriptRepos(count = 100, repoStartIndex = 0, skipRepos?: string[], cachePath?: string): Promise<readonly Repo[]> {
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

        let items = response.data.items;
        if (repoStartIndex > 0) {
            if (repoStartIndex < items.length) {
                items = items.slice(repoStartIndex);
                repoStartIndex = 0;
            }
            else {
                repoStartIndex -= items.length;
                continue;
            }
        }

        if (response.status !== 200) throw response;

        for (const repo of items) {
            if (!skipRepos?.includes(repo.html_url)) {
                repos.push({ url: repo.html_url, name: repo.name, owner: repo.owner.login });
                if (repos.length >= count) {
                    break;
                }
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

type Result = {
    body: string,
    owner: string,
    repo: string,
}
export type GitResult = Result & { kind: 'git', title: string }
export type UserResult = Result & { kind: 'user', issue_number: number }

export async function createIssue(postResult: boolean, title: string, body: string, sawNewErrors: boolean): Promise<GitResult | undefined> {
    const issue = {
        ...repoProperties,
        title,
        body,
    };

    if (!postResult) {
        console.log("Issue not posted: ");
        console.log(JSON.stringify(issue));
        return { kind: 'git', ...issue };
    }

    console.log("Creating a summary issue");

    const kit = new octokit.Octokit({
        auth: process.env.GITHUB_PAT,
    });

    const created = await kit.issues.create(issue);

    const issueNumber = created.data.number;
    console.log(`Created issue #${issueNumber}: ${created.data.html_url}`);

    if (!sawNewErrors) {
        await kit.issues.update({
            ...repoProperties,
            issue_number: issueNumber,
            state: "closed",
        });
    }
}

export async function createComment(sourceIssue: number, statusComment: number, postResult: boolean, body: string): Promise<UserResult | undefined> {
    const newComment = {
        ...repoProperties,
        issue_number: sourceIssue,
        body,
    };

    if (!postResult) {
        console.log("Comment not posted: ");
        console.log(JSON.stringify(newComment));
        return { kind: 'user', ...newComment };
    }

    console.log("Creating a github comment");

    const kit = new octokit.Octokit({
        auth: process.env.GITHUB_PAT,
    });

    const data = await kit.issues.createComment(newComment);

    const newCommentUrl = data.data.html_url;
    console.log(`Created comment #${data.data.id}: ${newCommentUrl}`);

    // Update typescript-bot comment
    const comment = await kit.issues.getComment({
        ...repoProperties,
        comment_id: statusComment
    });
    const newBody = `${comment.data.body}\n\nUpdate: [The results are in!](${newCommentUrl})`;
    await kit.issues.updateComment({
        ...repoProperties,
        comment_id: statusComment,
        body: newBody
    });
}

export async function checkout(cwd: string, branch: string) {
    await execAsync(cwd, `git fetch origin ${branch}:${branch} --recurse-submodules --depth=1`);
    await execAsync(cwd, `git checkout ${branch}`);
}
