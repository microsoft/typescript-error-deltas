/// <reference types="jest" />
import { UserResult } from './gitUtils'
import { mainAsync, Params } from './main'
describe("main", () => {
    jest.setTimeout(500_000)
    it("user tests run from scratch", async () => {
        const options: Params = {
            postResult: false, // for testing
            testType: "user",
            oldTypescriptRepoUrl: 'https://github.com/microsoft/typescript',
            oldHeadRef: 'main', // TODO: only branch names seem to work here, not all refs
            requestingUser: 'sandersn',
            sourceIssue: 44585,
            statusComment: 990374547,
        }
        const result = await mainAsync(options) // no wait this should be JSON
        expect(result).toBeDefined()
        expect(result!.kind).toEqual('user')
        const uresult = result as UserResult
        expect(uresult.issue_number).toEqual(44585)
    })
})
