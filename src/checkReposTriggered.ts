import * as path from "node:path";
import { mainAsync, reportError, type TsEntrypoint } from "./main.js";

const { argv } = process;

if (argv.length < 13) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <ts_entrypoint> <old_ts_repo_url> <old_head_ref> <pr_number> <is_top_repos> <repo_list_path> <worker_count> <worker_number> <result_dir_name> <diagnostic_output> <prng_seed> <use_overlay_fs>? <expected_head_sha>? <expected_base_sha>? <expected_merge_sha>?`);
    process.exit(-1);
}

const [,, entrypoint, oldTsRepoUrl, oldHeadRef, prNumber, buildWithNewWhenOldFails, repoListPath, workerCount, workerNumber, resultDirName, diagnosticOutput, prngSeed, useOverlayFs, expectedHeadSha, expectedBaseSha, expectedMergeSha] = argv;

mainAsync({
    testType: "triggered",
    useOverlayFs: useOverlayFs && useOverlayFs.toLowerCase() === "false" ? false : true,
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
    prngSeed: prngSeed.toLowerCase() === "n/a" ? undefined : prngSeed,
    expectedPrSnapshot: expectedHeadSha || expectedBaseSha || expectedMergeSha ? {
        headSha: expectedHeadSha,
        baseSha: expectedBaseSha,
        mergeSha: expectedMergeSha,
    } : undefined,
}).catch(err => {
    reportError(err, "Unhandled exception");
    process.exit(1);
});
