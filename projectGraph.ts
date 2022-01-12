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

export interface ScriptProject {
    path: string,
    contents: string,
}

export interface ProjectsToBuild {
    /** Order matters */
    simpleProjects: readonly Project[],
    /** Order matters */
    rootCompositeProjects: readonly Project[],
    /** Just follow the script */
    scriptedProjects: readonly ScriptProject[],
    hasError: boolean,
}

function resolvePath(...pathSegments: readonly string[]): string {
    const resolved = path.resolve(...pathSegments);
    return resolved.replace(/\\/g, "/");
}

function getFileNameFromProjectName(projectName: string): string {
    return projectName.endsWith(".json") ? projectName
        : path.basename(projectName).match(/tsconfig/) ? projectName + ".json"
        : path.join(projectName, "tsconfig.json");
}

/**
 * Note that the returned projects are ordered in lerna scenarios -
 * they should be built in the order in which they are returned.
 */
function getProjectPaths(repoDir: string): readonly string[] {
    if (fs.existsSync(path.join(repoDir, "build.sh"))) {
        return [path.join(repoDir, "build.sh")]
    }
    const projectPaths = [];
    const seen = new Set<string>();
    // TODO: Change this to work the same way that user tests do (JUST RUN TSC)
    for (const path of (utils.glob(repoDir, "**/*tsconfig*.json"))) {
        if (!seen.has(path)) {
            seen.add(path);
            projectPaths.push(path);
        }
    }
    return projectPaths;
}

function dependsOnProjectWithError(project: Project): boolean {
    const stack = [ project ];
    const seen = new Set<Project>();

    while (stack.length) {
        const curr = stack.pop()!;

        if (seen.has(curr)) {
            continue;
        }
        seen.add(curr);

        if (curr.hasParseError || curr.hasReferenceError) {
            return true;
        }

        stack.push(...curr.references);
        stack.push(...curr.extends);
    }

    return false;
}

/**
 * Heuristically, returns a collection of projects that should be built (excluding, for example, downstream and base projects).
 */
export function getProjectsToBuild(repoDir: string): ProjectsToBuild {
    // TODO: Don't need to return arrays anymore now that we're not faking lerna (or project) build order
    const scriptedProjects: ScriptProject[] = []
    const projectPaths = getProjectPaths(repoDir);
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
            const contents = fs.readFileSync(projectPath, { encoding: "utf-8" });
            if (projectPath.endsWith("build.sh")) {
                scriptedProjects.push({
                    path: projectPath,
                    contents,
                })
                continue
            }
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
        if (project.path.endsWith("build.sh")) {
            // already added to scriptedProjects in previous loop
        }
        else if (project.isComposite || project.references.length) {
            // Composite project
            if (dependsOnProjectWithError(project)) {
                // Can't trust results if one of the project files is bad
                hasError = true;
                continue;
            }
            rootCompositeProjects.push(project);
        }
        else {
            // Simple project
            if (project.hasParseError) {
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
        scriptedProjects,
        hasError
    };
}
