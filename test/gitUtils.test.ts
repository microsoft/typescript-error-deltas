import { describe, expect, it, vi } from "vitest";
import { createComment, createIssue } from "../src/utils/gitUtils.js";

describe("report destination", () => {
    it("creates scheduled issues in microsoft/TypeScript", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
            const issue = await createIssue(false, "New errors", ["Summary"], true);
            expect(issue).toMatchObject({ owner: "microsoft", repo: "typescript", title: "New errors" });
        }
        finally {
            log.mockRestore();
        }
    });

    it("posts PR results in microsoft/TypeScript", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
            await createComment(42, 123, "test", false, ["Results"], true);
            expect(JSON.parse(log.mock.calls[1][0])).toEqual([
                { owner: "microsoft", repo: "typescript", issue_number: 42, body: "Results" },
            ]);
        }
        finally {
            log.mockRestore();
        }
    });
});
