import fs = require("fs");
import path = require("path");
import { Metadata, metadataFileName, RepoStatus, resultFileNameSuffix } from "./main";
import git = require("./gitUtils");
import pu = require("./packageUtils");

const { argv } = process;

if (argv.length !== 9) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <user_to_tag> <pr_number> <comment_number> <is_top_repos_run> <result_dir_path> <log_uri> <post_result>`);
    process.exit(-1);
}

const [, , userToTag, prNumber, commentNumber, isTop, resultDirPath, logUri, post] = argv;
const isTopReposRun = isTop.toLowerCase() === "true";
const postResult = post.toLowerCase() === "true";

const metadataFilePaths = pu.glob(resultDirPath, `**/${metadataFileName}`);

let newTscResolvedVersion: string | undefined;
let oldTscResolvedVersion: string | undefined;

let somethingChanged = false;
let infrastructureFailed = false;

for (const path of metadataFilePaths) {
    const metadata: Metadata = JSON.parse(fs.readFileSync(path, { encoding: "utf-8" }));

    newTscResolvedVersion ??= metadata.newTscResolvedVersion;
    oldTscResolvedVersion ??= metadata.oldTscResolvedVersion;

    for (const s in metadata.statusCounts) {
        const status = s as RepoStatus;
        switch (status) {
            case "Detected no interesting changes":
                break;
            case "Detected interesting changes":
                somethingChanged = true;
                break;
            default:
                infrastructureFailed = true;
                break;
        }
    }
}

let summary: string;
if (infrastructureFailed) {
    summary = `Unfortunately, something went wrong, but it probably wasn't caused by your change.`;
}
else if (somethingChanged) {
    summary = `Something interesting changed - please have a look.`;
}
else {
    summary = `Everything looks good!`;
}

const resultPaths = pu.glob(resultDirPath, `**/*.${resultFileNameSuffix}`).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
const outputs = resultPaths.map(p => fs.readFileSync(p, { encoding: "utf-8" }));

// TODO: this should probably be paginated
let body = `@${userToTag} Here are the results of running the ${isTopReposRun ? "top-repos" : "user test"} suite comparing \`${oldTscResolvedVersion}\` and \`${newTscResolvedVersion}\`:

${summary}`;

if (outputs.length) {
    body += `

<details>
<summary>Details</summary>

${outputs.join("")}
</details>
`;
}

body += `\n\n[Run logs](${logUri})`;

git.createComment(+prNumber, +commentNumber, postResult, body);
