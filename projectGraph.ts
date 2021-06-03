import fs = require("fs");
import json5 = require("json5");
import path = require("path");
import utils = require("./packageUtils");

export interface Project {
    path: string,
    hasParseError: boolean,
    hasExtensionError: boolean,
    hasReferenceError: boolean,
    isComposite: boolean,
    extends: /*readonly*/ Project[],
    extendedBy: /*readonly*/ Project[],
    references: /*readonly*/ Project[],
    referencedBy: /*readonly*/ Project[]
}

export interface ProjectsToBuild {
    /** Order matters */
    simpleProjects: readonly Project[],
    /** Order matters */
    rootCompositeProjects: readonly Project[],
    hasError: boolean,
}

function resolvePath(...pathSegments: readonly string[]): string {
    const resolved = path.resolve(...pathSegments);
    return resolved.replace(/\\/g, "/");
}

function getFileNameFromProjectName(projectName: string): string {
    return projectName.endsWith(".json")
        ? projectName
        : path.basename(projectName).match(/tsconfig/)
            ? projectName + ".json"
            : path.join(projectName, "tsconfig.json");
}

/**
 * Note that the returned projects are ordered in lerna scenarios -
 * they should be built in the order in which they are returned.
 */
async function getProjectPaths(repoDir: string, lernaOrder: readonly string[]): Promise<readonly string[]> {
    const projectPaths = [];
    const seen = new Set<string>();

    for (const lernaDir of lernaOrder) {
        for (const path of (await utils.glob(lernaDir, "**/*tsconfig*.json"))) {
            if (!seen.has(path)) {
                seen.add(path);
                projectPaths.push(path);
            }
        }
    }

    for (const path of (await utils.glob(repoDir, "**/*tsconfig*.json"))) {
        if (!seen.has(path)) {
            seen.add(path);
            projectPaths.push(path);
        }
    }

    return projectPaths;
}

function dependsOnProjectWithError(project: Project, ignoreExtensionErrors: boolean): boolean {
    const stack = [ project ];
    const seen = new Set<Project>();

    while (stack.length) {
        const curr = stack.pop()!;

        if (seen.has(curr)) {
            continue;
        }
        seen.add(curr);

        if (curr.hasParseError || curr.hasReferenceError|| (!ignoreExtensionErrors && curr.hasExtensionError)) {
            return true;
        }

        stack.push(...curr.references);
        stack.push(...curr.extends);
    }

    return false;
}

/**
 * Heuristically, returns a collection of projects that should be built (excluding, for example, downstream and base projects).
 * Note: Providing a list of lernaPackages is a performance optimization - they'll be computed otherwise.
 */
export async function getProjectsToBuild(repoDir: string, ignoreExtensionErrors: boolean = true, lernaPackages?: readonly string[]): Promise<ProjectsToBuild> {
    lernaPackages = await utils.getLernaOrder(repoDir);

    const projectPaths = await getProjectPaths(repoDir, lernaPackages);

    const projectMap = new Map<string, Project>(); // path to data
    for (const projectPath of projectPaths) {
        projectMap.set(projectPath,
        {
            path: projectPath,
            hasParseError: false,
            hasExtensionError: false,
            hasReferenceError: false,
            isComposite: false,
            extends: [],
            extendedBy: [],
            references: [],
            referencedBy: []
        });
    }

    const projectsWithCompositeFlag: Project[] = [];

    for (const projectPath of projectPaths) {
        const project = projectMap.get(projectPath)!;

        let config: any = {};
        try {
            const contents = await fs.promises.readFile(projectPath, { encoding: "utf-8" });
            config = json5.parse(contents);
        }
        catch {
            project.hasParseError = true;
            continue;
        }

        const projectDir = path.dirname(projectPath);

        if (config.compilerOptions && config.compilerOptions.composite) {
            projectsWithCompositeFlag.push(project);
        }

        if (config.extends) {
            const extendedPath = resolvePath(projectDir, getFileNameFromProjectName(config.extends));
            if (projectMap.has(extendedPath)) {
                const extendedProject = projectMap.get(extendedPath)!;
                project.extends.push(extendedProject);
                extendedProject.extendedBy.push(project);
            }
            else {
                project.hasExtensionError = true;
            }
        }

        if (config.references) {
            for (const reference of config.references) {
                const referencedPath = resolvePath(projectDir, getFileNameFromProjectName(reference.path));
                if (projectMap.has(referencedPath)) {
                    const referencedProject = projectMap.get(referencedPath)!;
                    project.references.push(referencedProject);
                    referencedProject.referencedBy.push(project);
                }
                else {
                    project.hasReferenceError = true;
                }
            }
        }
    }

    for (const project of projectsWithCompositeFlag) {
        if (!project.extendedBy.length) {
            project.isComposite = true;
            continue;
        }

        const stack: Project[] = [ project ];
        while (stack.length) {
            const curr = stack.pop()!;

            if (curr.isComposite) {
                continue;
            }
            curr.isComposite = true;

            stack.push(...curr.extendedBy);
        }
    }

    const simpleProjects: Project[] = [];
    const rootCompositeProjects: Project[] = [];
    let hasError = false;
    for (const projectPath of projectPaths) {
        const project = projectMap.get(projectPath)!;

        if (project.referencedBy.length) {
            // Should be built by the upstream project
            continue;
        }

        if (project.isComposite || project.references.length) {
            // Composite project

            if (dependsOnProjectWithError(project, ignoreExtensionErrors)) {
                // Can't trust results if one of the project files is bad
                hasError = true;
                continue;
            }

            rootCompositeProjects.push(project);
        }
        else {
            // Simple project

            if (project.hasParseError || (!ignoreExtensionErrors && project.hasExtensionError)) {
                hasError = true;
                continue;
            }

            // Sometimes, source configs are extended by test configs and do need to be built.
            // Sometimes, base configs neglect to explicitly drop all inputs and should not be built.
            // As a heuristic, build the ones with simple names.
            if (project.extendedBy.length && !path.basename(projectPath).match(/^[tj]sconfig.json$/)) {
                continue;
            }

            simpleProjects.push(project);
        }
    }

    return {
        simpleProjects,
        rootCompositeProjects,
        hasError
    };
}