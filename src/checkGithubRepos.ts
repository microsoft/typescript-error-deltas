import path = require("path");
import { mainAsync, reportError, TsEntrypoint } from "./main";

const { argv } = process;

if (argv.length !== 10) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <ts_entrypoint> <old_ts_npm_version> <new_ts_npm_version> <repo_list_path> <worker_count> <worker_number> <result_dir_name> <diagnostic_output>`);
    process.exit(-1);
}

const [,, entrypoint, oldTsNpmVersion, newTsNpmVersion, repoListPath, workerCount, workerNumber, resultDirName, diagnosticOutput] = argv;

mainAsync({
    testType: "github",
    tmpfs: true,
    entrypoint: entrypoint as TsEntrypoint,
    diagnosticOutput: diagnosticOutput.toLowerCase() === "true",
    buildWithNewWhenOldFails: false,
    repoListPath,
    workerCount: +workerCount,
    workerNumber: +workerNumber,
    oldTsNpmVersion,
    newTsNpmVersion,
    resultDirName,
}).catch(err => {
    reportError(err, "Unhandled exception");
    process.exit(1);
});
