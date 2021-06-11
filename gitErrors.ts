import path = require("path");
import { mainAsync, reportError } from "./main";

const { argv } = process;

if (argv.length !== 6) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <file_issue> <repo_count> <old_tsc_version> <new_tsc_version>`);
    process.exit(-1);
}

mainAsync({
    testType: "git",
    fileIssue: argv[3].toLowerCase() === "true", // Only accept true.
    repoCount: +argv[4],
    oldTscVersion: argv[5],
    newTscVersion: argv[6],
}).catch(err => {
    reportError(err, "Unhandled exception");
    process.exit(1);
});