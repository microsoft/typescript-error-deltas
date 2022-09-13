import fs = require("fs");
import path = require("path");
import { artifactFolderUrlPlaceholder, Metadata, metadataFileName, RepoStatus, resultFileNameSuffix, StatusCounts, TsEntrypoint } from "./main";
import git = require("./utils/gitUtils");
import pu = require("./utils/packageUtils");

const { argv } = process;

if (argv.length !== 10) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <ts_entrypoint> <language> <repo_count> <repo_start_index> <result_dir_path> <log_uri> <artifacts_uri> <post_result>`);
    process.exit(-1);
}

const [, , ep, language, repoCount, repoStartIndex, resultDirPath, logUri, artifactsUri, post] = argv;
const postResult = post.toLowerCase() === "true";
const entrypoint = ep as TsEntrypoint;

const metadataFilePaths = pu.glob(resultDirPath, `**/${metadataFileName}`);

let analyzedCount = 0;
let totalCount = 0;
const statusCounts: StatusCounts = {};

let newTscResolvedVersion: string | undefined;
let oldTscResolvedVersion: string | undefined;

for (const path of metadataFilePaths) {
    const metadata: Metadata = JSON.parse(fs.readFileSync(path, { encoding: "utf-8" }));

    newTscResolvedVersion ??= metadata.newTsResolvedVersion;
    oldTscResolvedVersion ??= metadata.oldTsResolvedVersion;

    for (const s in metadata.statusCounts) {
        const status = s as RepoStatus;
        const count = metadata.statusCounts[status]!;
        statusCounts[status] = (statusCounts[status] ?? 0) + count;
        totalCount += count;
        switch (status) {
            case "Detected no interesting changes":
            case "Detected interesting changes":
                analyzedCount += count;
                break;
        }
    }
}

const title = entrypoint === "tsserver"
    ? `[ServerErrors][${language}] ${newTscResolvedVersion}`
    : `[NewErrors] ${newTscResolvedVersion} vs ${oldTscResolvedVersion}`;
const description = entrypoint === "tsserver"
    ? `The following errors were reported by ${newTscResolvedVersion}`
    : `The following errors were reported by ${newTscResolvedVersion}, but not by ${oldTscResolvedVersion}`;
const header = `${description}
[Pipeline that generated this bug](https://typescript.visualstudio.com/TypeScript/_build?definitionId=48)
[Logs for the pipeline run](${logUri})
[File that generated the pipeline](https://github.com/microsoft/typescript-error-deltas/blob/main/azure-pipelines-gitTests.yml)

This run considered ${repoCount} popular TS repos from GH (after skipping the top ${repoStartIndex}).

<details>
<summary>Successfully analyzed ${analyzedCount} of ${totalCount} visited repos</summary>

| Outcome | Count |
|---------|-------|
${Object.keys(statusCounts).sort().map(status => `| ${status} | ${statusCounts[status as RepoStatus]} |\n`).join("")}
</details>


`;

const resultPaths = pu.glob(resultDirPath, `**/*.${resultFileNameSuffix}`).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
const outputs = resultPaths.map(p => fs.readFileSync(p, { encoding: "utf-8" }).replace(new RegExp(artifactFolderUrlPlaceholder, "g"), artifactsUri));


// GH caps the maximum body length, so paginate if necessary
const bodyChunks: string[] = [];
let chunk = header;
for (const output of outputs) {
    if (chunk.length + output.length > 65535) {
        bodyChunks.push(chunk);
        chunk = "";
    }
    chunk += output;
}
bodyChunks.push(chunk);

git.createIssue(postResult, title, bodyChunks, /*sawNewErrors*/ !!outputs.length);