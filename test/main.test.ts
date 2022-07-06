/// <reference types="jest" />
import { mainAsync, processRepo, UserParams, downloadTypescriptRepoAsync } from '../src/main'
import { execSync } from "child_process"
import { existsSync, mkdirSync } from "fs"
import { UserResult } from '../src/gitUtils'
import path = require("path")
describe("main", () => {
    jest.setTimeout(10 * 60 * 1000)
    xit("user tests run from scratch", async () => {
        const options: UserParams = {
            postResult: false, // for testing
            tmpfs: false,
            repoCount: 1, // also for testing
            testType: "user",
            oldTypescriptRepoUrl: 'https://github.com/microsoft/typescript',
            oldHeadRef: 'main', // TODO: only branch names seem to work here, not all refs
            requestingUser: 'sandersn',
            sourceIssue: 44585,
            statusComment: 990374547,
            topRepos: false,
        }
        const result = await mainAsync(options)
        expect(result).toBeDefined()
        const ur = result as UserResult;
        expect(ur.kind).toEqual('user')
        expect(ur.owner).toEqual('microsoft')
        expect(ur.repo).toEqual('typescript')
        expect(ur.issue_number).toEqual(44585)
        expect(ur.body.startsWith(`@sandersn
The results of the user tests run you requested are in!
<details><summary> Here they are:</summary><p>
<b>Comparison Report - main..refs/pull/44585/merge</b>

# [TypeScript-Node-Starter](https://github.com/Microsoft/TypeScript-Node-Starter.git)
### /mnt/ts_downloads/TypeScript-Node-Starter/tsconfig.json
- \`error TS2496: The 'arguments' object cannot be referenced in an arrow function in ES3 and ES5. Consider using a standard function expression.\``)).toBeTruthy()
    })
    xit("build-only correctly caches", async () => {
        const options: UserParams = {
            postResult: false, // for testing
            tmpfs: false,
            repoCount: 1, // also for testing
            testType: "user",
            oldTypescriptRepoUrl: 'https://github.com/microsoft/typescript',
            oldHeadRef: 'main', // TODO: only branch names seem to work here, not all refs
            requestingUser: 'sandersn',
            sourceIssue: 44585,
            statusComment: 990374547,
            topRepos: false,
        }
        const outputs: string[] = []
        const hasNewErrors = await processRepo(
            options,
            /*topGithubRepos*/ false,
            "./ts_downloads",
            "./userTests",
            {
                name: "TypeScript-Node-Starter",
                url: "https://github.com/Microsoft/TypeScript-Node-Starter.git"
            },
            path.resolve("./typescript-main/built/local/tsc.js"),
            path.resolve("./typescript-44585/built/local/tsc.js"),
            outputs)
        expect(hasNewErrors).toBeTruthy()
        expect(outputs.join("").startsWith(`# [TypeScript-Node-Starter](https://github.com/Microsoft/TypeScript-Node-Starter.git)`)).toBeTruthy()
        expect(outputs.join("").includes("- \`error TS2496: The 'arguments' object cannot be referenced in an arrow function in ES3 and ES5. Consider using a standard function expression.\`")).toBeTruthy()
    })
    it("downloads from a branch", async () => {
        if (!existsSync("./testDownloads/main")) {
            mkdirSync("./testDownloads/main", { recursive: true });
        }
        else if (existsSync("./testDownloads/main/typescript-test-fake-error")) {
            execSync("cd ./testDownloads/main/typescript-test-fake-error && git restore . && cd ..")
        }
        await downloadTypescriptRepoAsync('./testDownloads/main', 'https://github.com/sandersn/typescript', 'test-fake-error')
    })
})
