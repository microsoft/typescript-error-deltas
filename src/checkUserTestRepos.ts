import path = require("path");
import { mainAsync, reportError, TsEntrypoint } from "./main";

const { argv } = process;

if (argv.length !== 12) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <ts_entrypoint> <old_ts_repo_url> <old_head_ref> <pr_number> <is_top_repos> <repo_list_path> <worker_count> <worker_number> <result_dir_name> <diagnostic_output>`);
    process.exit(-1);
}

const [,, entrypoint, oldTsRepoUrl, oldHeadRef, prNumber, buildWithNewWhenOldFails, repoListPath, workerCount, workerNumber, resultDirName, diagnosticOutput] = argv;

mainAsync({
    testType: "user",
    tmpfs: true,
    entrypoint: entrypoint as TsEntrypoint,
    oldTsRepoUrl,
    oldHeadRef,
    prNumber: +prNumber,
    buildWithNewWhenOldFails: buildWithNewWhenOldFails.toLowerCase() !== "true",
    repoListPath,
    workerCount: +workerCount,
    workerNumber: +workerNumber,
    resultDirName,
    diagnosticOutput: diagnosticOutput.toLowerCase() === "true",
}).catch(err => {
    reportError(err, "Unhandled exception");
    process.exit(1);
});
