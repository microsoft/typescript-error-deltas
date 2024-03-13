import * as parser from "@typescript-eslint/parser";
import * as path from "path";

const code = `
import { something } from '__PLACEHOLDER__';

something();
`;

const fixturesDirectory = path.resolve(__dirname, "fixtures");
const projectDirectory = path.resolve(fixturesDirectory, "project");

parser
  .parseAndGenerateServices(code, {
    comment: true,
    filePath: path.resolve(projectDirectory, "file.ts"),
    loc: true,
    moduleResolver: path.resolve(fixturesDirectory, "./moduleResolver.js"),
    project: "./tsconfig.json",
    range: true,
    tokens: true,
    tsconfigRootDir: projectDirectory,
  })
  .services.program.getSemanticDiagnostics();
