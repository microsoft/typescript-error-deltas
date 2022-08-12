import path = require("path");
import { mainAsync, reportError } from "./main";

const { argv } = process;

if (argv.length !== 8) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <old_typescript_repo_url> <old_head_ref> <pr_number> <repo_list_path> <result_dir_path> <diagnostic_output>`);
    process.exit(-1);
}

mainAsync({
    testType: "user",
    tmpfs: true,
    oldTypescriptRepoUrl: argv[2],
    oldHeadRef: argv[3],
    prNumber: +argv[4],
    repoListPath: argv[5],
    resultDirPath: argv[6],
    diagnosticOutput: argv[7].toLowerCase() === "true",
}).catch(err => {
    reportError(err, "Unhandled exception");
    process.exit(1);
});
