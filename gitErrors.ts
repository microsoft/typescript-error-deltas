import path = require("path");
import { mainAsync, reportError } from "./main";

const { argv } = process;

if (argv.length !== 7) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <post_result> <repo_count> <repo_start_index> <old_tsc_version> <new_tsc_version>`);
    process.exit(-1);
}

const [,, postResultStr, repoCountStr, repoStartIndexStr, oldTscVersion, newTscVersion] = argv;

mainAsync({
    testType: "git",
    postResult: postResultStr.toLowerCase() === "true", // Only accept true.
    tmpfs: true,
    repoCount: +repoCountStr,
    repoStartIndex: +repoStartIndexStr,
    oldTscVersion,
    newTscVersion,
}).catch(err => {
    reportError(err, "Unhandled exception");
    process.exit(1);
});
