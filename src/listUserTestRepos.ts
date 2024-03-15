import fs = require("fs");
import path = require("path");
import { reportError } from "./main";
import { getUserTestsRepos } from "./utils/userTestUtils";

const { argv } = process;

if (argv.length !== 4) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <user_tests_dir> <output_path>`);
    process.exit(-1);
}

const userTestsDir = argv[2];
const outputPath = argv[3];

try {
    const repos = getUserTestsRepos(userTestsDir).filter(r => {
        // TODO(jakebailey): revert me
        switch (r.name) {
            case "azure-sdk":
            case "follow-redirects":
            case "puppeteer":
            case "pyright":
                return true;
            default:
                return false;
        }
    });
    fs.writeFileSync(outputPath, JSON.stringify(repos), { encoding: "utf-8" });
}
catch (err) {
    reportError(err, "Unhandled exception");
    process.exit(1);
}
