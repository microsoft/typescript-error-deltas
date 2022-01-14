import path = require("path");
import { mainAsync, reportError } from "./main";

const { argv } = process;

if (argv.length !== 6) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <post_result> <repo_count> <old_tsc_version> <new_tsc_version>`);
    process.exit(-1);
}

mainAsync({
    testType: "git",
    postResult: argv[2].toLowerCase() === "true", // Only accept true.
    tmpfs: true,
    repoCount: +argv[3],
    oldTscVersion: argv[4],
    newTscVersion: argv[5],
}).catch(err => {
    reportError(err, "Unhandled exception");
    process.exit(1);
});
