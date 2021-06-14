import path = require("path");
import { mainAsync, reportError } from "./main";

const { argv } = process;

if (argv.length !== 10) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <post_result> <old_typescript_repo_url> <old_head_ref> <new_typescript_repo_url> <new_head_url> <requesting_user> <source_issue> <status_comment>`);
    process.exit(-1);
}

mainAsync({
    testType: "user",
    postResult: argv[2].toLowerCase() === "true", // Only accept true.
    oldTypescriptRepoUrl: argv[3],
    oldHeadRef: argv[4],
    newTypescriptRepoUrl: argv[5],
    newHeadRef: argv[6],
    requestingUser: argv[7],
    sourceIssue: +argv[8],
    statusComment: +argv[9]
}).catch(err => {
    reportError(err, "Unhandled exception");
    process.exit(1);
});