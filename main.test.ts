/// <reference types="jest" />
import { mainAsync, innerloop, Params, downloadTypescriptRepoAsync } from './main'
import { execSync } from "child_process"
import { existsSync } from "fs"
import { Result } from './gitUtils'
import path = require('path')
describe("main", () => {
    jest.setTimeout(10 * 60 * 1000)
    it("user tests run from scratch", async () => {
        const options: Params = {
            postResult: false, // for testing
            tmpfs: false,
            repoCount: 1, // also for testing
            oldTypescriptRepoUrl: 'https://github.com/microsoft/typescript',
            oldHeadRef: 'main', // TODO: only branch names seem to work here, not all refs
            requestingUser: 'sandersn',
            sourceIssue: 44585,
            statusComment: 990374547,
        }
        await execSync("rm -rf ./ts_downloads")
        await execSync("rm -rf ./typescript-main")
        await execSync("rm -rf ./typescript-44585")
        const result = await mainAsync(options)
        expect(result).toBeDefined()
        const ur = result as Result;
        expect(ur.owner).toEqual('microsoft')
        expect(ur.repo).toEqual('typescript')
        expect(ur.issue_number).toEqual(44585)
        expect(ur.body.includes("The results of the user tests run you requested are in!")).toBeTruthy()
        expect(ur.body.includes("TypeScript-Node-Starter/tsconfig.json")).toBeTruthy()
        expect(ur.body.includes("- \`error TS2496: The 'arguments' object cannot be referenced in an arrow function in ES3 and ES5. Consider using a standard function expression.\`")).toBeTruthy()
    })
    it("build-only correctly caches", async () => {
        const options: Params = {
            postResult: false, // for testing
            tmpfs: false,
            repoCount: 1, // also for testing
            oldTypescriptRepoUrl: 'https://github.com/microsoft/typescript',
            oldHeadRef: 'main', // TODO: only branch names seem to work here, not all refs
            requestingUser: 'sandersn',
            sourceIssue: 44585,
            statusComment: 990374547,
        }
        const outputs: string[] = []
        const hasNewErrors = await innerloop(
            options,
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
        if (existsSync("typescript-test-fake-error"))
            execSync("cd typescript-test-fake-error && git restore . && cd ..")
        await downloadTypescriptRepoAsync('./', 'https://github.com/sandersn/typescript', 'test-fake-error')
    })
})
