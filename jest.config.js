module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/*.test.ts"],
  roots: ["<rootDir>/test"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {
      tsconfig: "<rootDir>/test/tsconfig.json",
      diagnostics: false
    }]
  }
};
