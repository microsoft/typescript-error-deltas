import fs = require("fs");
import path = require("path");
import { artifactFolderUrlPlaceholder, Metadata, metadataFileName, RepoStatus, resultFileNameSuffix } from "./main";
import git = require("./utils/gitUtils");
import pu = require("./utils/packageUtils");

const { argv } = process;

if (argv.length !== 10) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <user_to_tag> <pr_number> <comment_number> <distinct_id> <is_top_repos_run> <result_dir_path> <artifacts_uri> <post_result>`);
    process.exit(-1);
}

const [, , userToTag, prNumber, commentNumber, distinctId, isTop, resultDirPath, artifactsUri, post] = argv;
const isTopReposRun = isTop.toLowerCase() === "true";
const postResult = post.toLowerCase() === "true";

const metadataFilePaths = pu.glob(resultDirPath, `**/${metadataFileName}`);

let newTscResolvedVersion: string | undefined;
let oldTscResolvedVersion: string | undefined;

let somethingChanged = false;
const infrastructureFailures = new Map<RepoStatus, number>();

for (const path of metadataFilePaths) {
    const metadata: Metadata = JSON.parse(fs.readFileSync(path, { encoding: "utf-8" }));

    newTscResolvedVersion ??= metadata.newTsResolvedVersion;
    oldTscResolvedVersion ??= metadata.oldTsResolvedVersion;

    for (const s in metadata.statusCounts) {
        const status = s as RepoStatus;
        switch (status) {
            case "Detected no interesting changes":
                break;
            case "Detected interesting changes":
                somethingChanged = true;
                break;
            default:
                infrastructureFailures.set(status, (infrastructureFailures.get(status) ?? 0) + 1)
                break;
        }
    }
}

const summary: string[] = [];

// In a top-repos run, the test set is arbitrary, so we ignore infrastructure failures
// as it's possible that there's a repo that just doesn't work.
if (!isTopReposRun && infrastructureFailures.size) {
    summary.push("There were infrastructure failures potentially unrelated to your change:");
    summary.push("");
    for (const [status, count] of infrastructureFailures) {
        summary.push(`- ${count} ${count === 1 ? "instance" : "instances"} of "${status}"`);
    }
    summary.push("");
    summary.push("Otherwise...");
    summary.push("");
}

if (somethingChanged) {
    summary.push("Something interesting changed - please have a look.");
}
else {
    summary.push("Everything looks good!");
}

// Files starting with an exclamation point are old server errors.
const hasOldErrors = pu.glob(resultDirPath, `**/!*.${resultFileNameSuffix}`).length !== 0;

const resultPaths = pu.glob(resultDirPath, `**/*.${resultFileNameSuffix}`).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
const outputs = resultPaths.map(p => fs.readFileSync(p, { encoding: "utf-8" }).replace(new RegExp(artifactFolderUrlPlaceholder, "g"), artifactsUri));

const suiteDescription = isTopReposRun ? "top-repos" : "user test";
let header = `@${userToTag} Here are the results of running the ${suiteDescription} suite comparing \`${oldTscResolvedVersion}\` and \`${newTscResolvedVersion}\`:

${summary.join("\n")}`;

if (!outputs.length) {
    git.createComment(+prNumber, +commentNumber, distinctId, postResult, [header], somethingChanged);
}
else {
    const oldErrorHeader = `<h2>:warning: Old server errors :warning:</h2>`;
    const openDetails = `\n\n<details>\n<summary>Details</summary>\n\n`;
    const closeDetails = `\n</details>`;
    const initialHeader = header + openDetails + (hasOldErrors ? oldErrorHeader : '');
    const continuationHeader = `@${userToTag} Here are some more interesting changes from running the ${suiteDescription} suite${openDetails}`;
    const trunctationSuffix = `\n:error: Truncated - see log for full output :error:`;

    // GH caps the maximum body length, so paginate if necessary
    const bodyChunks: string[] = [];
    let chunk = initialHeader;
    for (const output of outputs) {
        if (chunk.length + output.length + closeDetails.length > 65535) {
            if (chunk === initialHeader || chunk === continuationHeader) {
                // output is too long and bumping it to the next comment won't help
                console.log("Truncating output to fit in GH comment");
                chunk += output.substring(0, 65535 - chunk.length - closeDetails.length - trunctationSuffix.length);
                chunk += trunctationSuffix;
                chunk += closeDetails;
                bodyChunks.push(chunk);
                chunk = continuationHeader;
                continue; // Specifically, don't append output below
            }

            chunk += closeDetails;
            bodyChunks.push(chunk);
            chunk = continuationHeader;
        }
        chunk += output;
    }
    chunk += closeDetails;
    bodyChunks.push(chunk);

    for (const chunk of bodyChunks) {
        console.log(`Chunk of size ${chunk.length}`);
    }

    git.createComment(+prNumber, +commentNumber, distinctId, postResult, bodyChunks, somethingChanged);
}
