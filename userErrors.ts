import path = require("path");
import { mainAsync, reportError } from "./main";

const { argv } = process;

if (argv.length !== 8) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <post_result> <old_typescript_repo_url> <old_head_ref> <requesting_user> <source_issue> <status_comment>`);
    process.exit(-1);
}

mainAsync({
    testType: "user",
    postResult: argv[2].toLowerCase() === "true", // Only accept true.
    tmpfs: true,
    oldTypescriptRepoUrl: argv[3],
    oldHeadRef: argv[4],
    requestingUser: argv[5],
    sourceIssue: +argv[6], // Github's pr ID number.
    statusComment: +argv[7]
}).catch(err => {
    reportError(err, "Unhandled exception");
    process.exit(1);
});
