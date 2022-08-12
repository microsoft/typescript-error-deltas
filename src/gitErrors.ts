import path = require("path");
import { mainAsync, reportError } from "./main";

const { argv } = process;

if (argv.length !== 9) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <old_tsc_version> <new_tsc_version> <repo_list_path> <worker_count> <worker_number> <result_dir_path> <diagnostic_output>`);
    process.exit(-1);
}

const [,, oldTscVersion, newTscVersion, repoListPath, workerCount, workerNumber, resultDirPath, diagnosticOutput] = argv;

mainAsync({
    testType: "git",
    tmpfs: true,
    diagnosticOutput: diagnosticOutput.toLowerCase() === "true",
    repoListPath,
    workerCount: +workerCount,
    workerNumber: +workerNumber,
    oldTscVersion,
    newTscVersion,
    resultDirPath,
}).catch(err => {
    reportError(err, "Unhandled exception");
    process.exit(1);
});
