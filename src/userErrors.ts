import path = require("path");
import { mainAsync, reportError } from "./main";

const { argv } = process;

if (argv.length !== 11) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <old_typescript_repo_url> <old_head_ref> <pr_number> <is_top_repos> <repo_list_path> <worker_count> <worker_number> <result_dir_path> <diagnostic_output>`);
    process.exit(-1);
}

mainAsync({
    testType: "user",
    tmpfs: true,
    oldTypescriptRepoUrl: argv[2],
    oldHeadRef: argv[3],
    prNumber: +argv[4],
    buildWithNewWhenOldFails: argv[5].toLowerCase() !== "true",
    repoListPath: argv[6],
    workerCount: +argv[7],
    workerNumber: +argv[8],
    resultDirPath: argv[9],
    diagnosticOutput: argv[10].toLowerCase() === "true",
}).catch(err => {
    reportError(err, "Unhandled exception");
    process.exit(1);
});
