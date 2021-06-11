import path = require("path");
import { mainAsync, reportError } from "./main";

const { argv } = process;

if (argv.length !== 7) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <file_issue> <old_typescript_repo_url> <old_head_ref> <new_typescript_repo_url> <new_head_url>`);
    process.exit(-1);
}

mainAsync({
    testType: "user",
    fileIssue: argv[3].toLowerCase() === "true", // Only accept true.
    oldTypescriptRepoUrl: argv[4],
    oldHeadRef: argv[5],
    newTypescriptRepoUrl: argv[6],
    newHeadRef: argv[7],
}).catch(err => {
    reportError(err, "Unhandled exception");
    process.exit(1);
});