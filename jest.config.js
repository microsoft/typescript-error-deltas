module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/*.test.ts"],
  globals: {
    "ts-jest": {
      tsconfig: "<rootDir>/src/tsconfig.json",
      diagnostics: false
    }
  }
};
