/// <reference types="jest" />
import { mainAsync, UserParams } from './main'
import { UserResult } from './gitUtils'
describe("main", () => {
    jest.setTimeout(10 * 60 * 1000)
    it("user tests run from scratch", async () => {
        const options: UserParams = {
            postResult: false, // for testing
            repoCount: 1, // also for testing
            testType: "user",
            oldTypescriptRepoUrl: 'https://github.com/microsoft/typescript',
            oldHeadRef: 'main', // TODO: only branch names seem to work here, not all refs
            requestingUser: 'sandersn',
            sourceIssue: 44585,
            statusComment: 990374547,
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
- \`error TS2496: The 'arguments' object cannot be referenced in an arrow function in ES3 and ES5. Consider using a standard function expression.\``))
    })
})
