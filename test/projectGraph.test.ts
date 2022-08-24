import { getProjectsToBuild } from '../src/utils/projectGraph'

describe("getProjectsToBuild", () => {
    it("gets a simple project", async () => {
        const result = await getProjectsToBuild("./testResources/simpleProject")
        expect(result.simpleProjects[0].path.endsWith("testResources/simpleProject/tsconfig.json"))
        delete (result.simpleProjects[0] as any).path
        expect(result).toEqual({
            simpleProjects: [{
                hasParseError: false,
                hasExtensionError: false,
                hasReferenceError: false,
                isComposite: false,
                references: [],
                referencedBy: [],
                extends: [],
                extendedBy: [],
            }],
            rootCompositeProjects: [],
            hasError: false,
        })
    })
})
