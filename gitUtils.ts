import octokit = require("@octokit/rest");
import utils = require("./packageUtils");
import git = require("simple-git/promise");
import path = require("path");
import cp = require("child_process");

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

export type Result = {
    body: string,
    owner: string,
    repo: string,
    issue_number: number,
}

export async function createComment(sourceIssue: number, statusComment: number, postResult: boolean, body: string): Promise<Result | undefined> {
    const newComment = {
        ...repoProperties,
        issue_number: sourceIssue,
        body,
    };

    if (!postResult) {
        console.log("Comment not posted: ");
        console.log(JSON.stringify(newComment));
        return newComment;
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
