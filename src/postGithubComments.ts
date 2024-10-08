import fs = require("fs");
import path = require("path");
import { artifactFolderUrlPlaceholder, getArtifactsApiUrlPlaceholder, Metadata, metadataFileName, RepoStatus, resultFileNameSuffix } from "./main";
import git = require("./utils/gitUtils");
import pu = require("./utils/packageUtils");
import { asMarkdownInlineCode } from "./utils/markdownUtils";

const { argv } = process;

if (argv.length !== 13) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <entrypoint> <user_to_tag> <pr_number> <comment_number> <distinct_id> <is_top_repos_run> <result_dir_path> <artifacts_uri> <post_result> <repo_count> <get_artifacts_api>`);
    process.exit(-1);
}

const [, , entrypoint, userToTag, prNumber, commentNumber, distinctId, isTop, resultDirPath, artifactsUri, post, repoCount, getArtifactsApi] = argv;
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
const outputs = resultPaths.map(p =>
    fs.readFileSync(p, { encoding: "utf-8" })
        .replaceAll(artifactFolderUrlPlaceholder, artifactsUri)
        .replaceAll(getArtifactsApiUrlPlaceholder, getArtifactsApi));

const suiteDescription = isTopReposRun ? `top ${repoCount} repos` : "user tests";
let header = `@${userToTag} Here are the results of running the ${suiteDescription} with ${entrypoint} comparing ${asMarkdownInlineCode(oldTscResolvedVersion ?? "old")} and ${asMarkdownInlineCode(newTscResolvedVersion ?? "new")}:

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
    const maxCommentLength = 65535;

    const bodyChunks: string[] = [];
    let chunk = initialHeader;

    for (let i = 0; i < outputs.length;) {
        const output = outputs[i];
        if ((chunk.length + output.length + closeDetails.length) < maxCommentLength) {
            // Output still fits within chunk; add and continue.
            chunk += output;
            i++;
            continue;
        }

        // The output is too long to fit in the current chunk.

        if (chunk === initialHeader || chunk === continuationHeader) {
            // We only have a header, but the output still doesn't fit. Truncate and continue.
            console.log("Truncating output to fit in GH comment");
            chunk += output.slice(0, maxCommentLength - chunk.length - closeDetails.length - trunctationSuffix.length);
            chunk += trunctationSuffix;
            chunk += closeDetails;
            bodyChunks.push(chunk);
            chunk = continuationHeader;
            i++;
            continue;
        }

        // Close the chunk and try the same output again.
        chunk += closeDetails;
        bodyChunks.push(chunk);
        chunk = continuationHeader;
    }

    if (chunk !== initialHeader && chunk !== continuationHeader) {
        chunk += closeDetails;
        bodyChunks.push(chunk);
    }
    

    for (const chunk of bodyChunks) {
        console.log(`Chunk of size ${chunk.length}`);
    }

    git.createComment(+prNumber, +commentNumber, distinctId, postResult, bodyChunks, somethingChanged);
}
