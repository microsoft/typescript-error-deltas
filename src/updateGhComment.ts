import fs = require("fs");
import path = require("path");
import { Metadata, metadataFileName, RepoStatus, resultFileNameSuffix } from "./main";
import git = require("./gitUtils");
import pu = require("./packageUtils");

const { argv } = process;

if (argv.length !== 8) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <user_to_tag> <pr_number> <comment_number> <is_top_repos_run> <result_dir_path> <post_result>`);
    process.exit(-1);
}

const [, , userToTag, prNumber, commentNumber, isTop, resultDirPath, post] = argv;
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

const suiteDescription = isTopReposRun ? "top-repos" : "user test";
let header = `@${userToTag} Here are the results of running the ${suiteDescription} suite comparing \`${oldTscResolvedVersion}\` and \`${newTscResolvedVersion}\`:

${summary}`;

if (!outputs.length) {
    git.createComment(+prNumber, +commentNumber, postResult, [header]);
}
else {
    const openDetails = `\n\n<details>\n<summary>Details</summary>\n\n`;
    const closeDetails = `\n</details>`;

    // GH caps the maximum body length, so paginate if necessary
    const bodyChunks: string[] = [];
    let chunk = header + openDetails;
    for (const output of outputs) {
        if (chunk.length + output.length + closeDetails.length > 65535) {
            chunk += closeDetails;
            bodyChunks.push(chunk);
            chunk = `@${userToTag} Here are some more interesting changes from running the ${suiteDescription} suite${openDetails}`;
        }
        chunk += output;
    }
    chunk += closeDetails;
    bodyChunks.push(chunk);

    for (const chunk of bodyChunks) {
        console.log(`Chunk of size ${chunk.length}`);
    }

    git.createComment(+prNumber, +commentNumber, postResult, bodyChunks);
}
