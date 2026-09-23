import * as path from "node:path";
import { mainAsync, reportError, type TsEntrypoint } from "./main.js";

const { argv } = process;

if (argv.length < 11) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <ts_entrypoint> <old_ts_npm_version> <new_ts_npm_version> <repo_list_path> <worker_count> <worker_number> <result_dir_name> <diagnostic_output> <prng_seed> <use_overlay_fs>?`);
    process.exit(-1);
}

const [,, entrypoint, oldTsNpmVersion, newTsNpmVersion, repoListPath, workerCount, workerNumber, resultDirName, diagnosticOutput, prngSeed, useOverlayFs] = argv;

mainAsync({
    testType: "scheduled",
    useOverlayFs: useOverlayFs && useOverlayFs.toLowerCase() === "false" ? false : true,
    entrypoint: entrypoint as TsEntrypoint,
    diagnosticOutput: diagnosticOutput.toLowerCase() === "true",
    buildWithNewWhenOldFails: false,
    repoListPath,
    workerCount: +workerCount,
    workerNumber: +workerNumber,
    oldTsNpmVersion,
    newTsNpmVersion,
    resultDirName,
    prngSeed: prngSeed.toLowerCase() === "n/a" ? undefined : prngSeed,
}).catch(err => {
    reportError(err, "Unhandled exception");
    process.exit(1);
});
