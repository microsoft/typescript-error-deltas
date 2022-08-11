import path = require("path");
import { mainAsync, reportError } from "./main";

const { argv } = process;

if (argv.length !== 7) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <post_result> <old_tsc_version> <new_tsc_version> <repo_list_path> <diagnostic_output>`);
    process.exit(-1);
}

const [,, postResultStr, oldTscVersion, newTscVersion, repoListPath, diagnosticOutput] = argv;

mainAsync({
    testType: "git",
    postResult: postResultStr.toLowerCase() === "true", // Only accept true.
    tmpfs: true,
    diagnosticOutput: diagnosticOutput.toLowerCase() === "true",
    repoListPath,
    oldTscVersion,
    newTscVersion,
}).catch(err => {
    reportError(err, "Unhandled exception");
    process.exit(1);
});
