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

export async function getPopularRepos(language = "TypeScript", count = 100, repoStartIndex = 0, skipRepos?: string[], cachePath?: string): Promise<readonly Repo[]> {
    const cacheEncoding = { encoding: "utf-8" } as const;

    if (cachePath && await utils.exists(cachePath)) {
        const contents = await fs.promises.readFile(cachePath, cacheEncoding);
        const cache: Repo[] = JSON.parse(contents);
        if (cache.length >= count) {
            return cache.slice(0, count);
        }
    }

    const kit = new octokit.Octokit({
        auth: process.env.GITHUB_PAT,
    });
    const perPage = Math.min(100, count + (skipRepos?.length ?? 0));

    let repos: Repo[] = [];
    for (let page = 1; repos.length < count; page++) {
        const response = await kit.search.repos({
            q: `language:${language}+stars:>100 archived:no`,
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

export async function createIssue(postResult: boolean, title: string, bodyChunks: readonly string[], sawNewErrors: boolean): Promise<GitResult | undefined> {
    const issue = {
        ...repoProperties,
        title,
        body: bodyChunks[0],
    };

    const additionalComments = bodyChunks.slice(1).map(chunk => ({
        ...repoProperties,
        body: chunk,
    }));

    if (!postResult) {
        console.log("Issue not posted: ");
        console.log(JSON.stringify(issue));
        for (const comment of additionalComments) {
            console.log(JSON.stringify(comment));
        }
        return { kind: 'git', ...issue };
    }

    console.log("Creating a summary issue");

    const kit = new octokit.Octokit({
        auth: process.env.GITHUB_PAT,
    });

    const created = await kit.issues.create(issue);

    const issueNumber = created.data.number;
    console.log(`Created issue #${issueNumber}: ${created.data.html_url}`);

    for (const comment of additionalComments) {
        await kit.issues.createComment({ issue_number: issueNumber, ...comment });
    }

    if (!sawNewErrors) {
        await kit.issues.update({
            ...repoProperties,
            issue_number: issueNumber,
            state: "closed",
        });
    }
}

export async function createComment(prNumber: number, statusComment: number, postResult: boolean, bodyChunks: readonly string[]): Promise<void> {
    const newComments = bodyChunks.map(body => ({
        ...repoProperties,
        issue_number: prNumber,
        body,
    }));

    // Occasionally, GH posting fails, so it helps to dump the comment
    console.log("GH comment(s): ");
    console.log(JSON.stringify(newComments, undefined, " "));

    if (!postResult) {
        return;
    }

    console.log("Posting github comment(s)");

    const kit = new octokit.Octokit({
        auth: process.env.GITHUB_PAT,
    });

    const newCommentUrls: string[] = [];

    for (const newComment of newComments) {
        const response = await kit.issues.createComment(newComment);

        const newCommentUrl = response.data.html_url;
        console.log(`Created comment #${response.data.id}: ${newCommentUrl}`);

        newCommentUrls.push(newCommentUrl);
    }

    // Update typescript-bot comment
    const comment = await kit.issues.getComment({
        ...repoProperties,
        comment_id: statusComment
    });

    let newBody = `${comment.data.body}\n\n`;
    if (newCommentUrls.length === 1) {
        newBody += `Update: [The results are in!](${newCommentUrls[0]})`;
    }
    else {
        newBody += `Update: The results are in! `;
        newBody += newCommentUrls.map((url, i) => `[Part ${i + 1}](${url})`).join(", ");
    }

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
