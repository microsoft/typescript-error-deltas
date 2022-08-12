import fs = require("fs");
import path = require("path");
import { Metadata, metadataFileName, resultFileNameSuffix } from "./main";
import git = require("./gitUtils");
import pu = require("./packageUtils");

const { argv } = process;

if (argv.length !== 7) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <user_to_tag> <pr_number> <comment_number> <result_dir_path> <post_result>`);
    process.exit(-1);
}

const [, , userToTag, prNumber, commentNumber, resultDirPath, post] = argv;
const postResult = post.toLowerCase() === "true";

const metadataFilePaths = pu.glob(resultDirPath, `**/${metadataFileName}`);
const { newTscResolvedVersion, oldTscResolvedVersion }: Metadata = JSON.parse(fs.readFileSync(metadataFilePaths[0], { encoding: "utf-8" }));

const resultPaths = pu.glob(resultDirPath, `**/*.${resultFileNameSuffix}`).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
const outputs = resultPaths.map(p => fs.readFileSync(p, { encoding: "utf-8" }));

// TODO: this should probably be paginated
const summary = outputs.join("");
const body = summary
    ? `@${userToTag}\nThe results of the user tests run you requested are in!\n<details><summary> Here they are:</summary><p>\n<b>Comparison Report - ${oldTscResolvedVersion}..${newTscResolvedVersion}</b>\n\n${summary}</p></details>`
    : `@${userToTag}\nGreat news! no new errors were found between ${oldTscResolvedVersion}..${newTscResolvedVersion}`;
git.createComment(+prNumber, +commentNumber, postResult, body);
