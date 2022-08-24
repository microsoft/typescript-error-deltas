import fs = require("fs");
import path = require("path");
import { getPopularRepos } from "./utils/gitUtils";
import { reportError } from "./main";

const { argv } = process;

if (argv.length !== 6) {
    console.error(`Usage: ${path.basename(argv[0])} ${path.basename(argv[1])} <language> <repo_count> <repo_start_index> <output_path>`);
    process.exit(-1);
}

const language = argv[2];
const repoCount = +argv[3];
const repoStartIndex = +argv[4];
const outputPath = argv[5];

// If you think we need coverage of one of these, consider adding a user test with custom build steps
const skipRepos = [
    "https://github.com/microsoft/TypeScript", // Test files expected to have errors
    "https://github.com/DefinitelyTyped/DefinitelyTyped", // Test files expected to have errors
    "https://github.com/storybookjs/storybook", // Too big to fit on VM
    "https://github.com/microsoft/frontend-bootcamp", // Can't be built twice in a row
    "https://github.com/BabylonJS/Babylon.js", // Runs out of space during compile
    "https://github.com/eclipse-theia/theia", // Probably same
    "https://github.com/wbkd/react-flow", // Probably same
    "https://github.com/remix-run/remix", // Too big to fit on VM
    "https://github.com/NervJS/taro", // Too big to fit on VM
    "https://github.com/TanStack/table", // Too big to fit on VM
    "https://github.com/doczjs/docz", // Too big to fit on VM
    "https://github.com/NativeScript/NativeScript", // Uses NX package manager
    "https://github.com/wulkano/Kap", // Incompatible with Linux
    "https://github.com/lit/lit", // Depends on non-public package
    "https://github.com/coder/code-server", // Takes ~15 minutes and overlaps heavily with vscode
];

async function mainAsync() {
    const repos = await getPopularRepos(language, repoCount, repoStartIndex, skipRepos);
    await fs.promises.writeFile(outputPath, JSON.stringify(repos), { encoding: "utf-8" });
}

mainAsync().catch(err => {
    reportError(err, "Unhandled exception");
    process.exit(1);
});