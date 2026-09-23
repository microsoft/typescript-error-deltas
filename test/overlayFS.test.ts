import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOverlayFS } from "../src/utils/overlayFS.js";

const commands = vi.hoisted(() => ({
    mountStatus: 32,
    mountpoint: vi.fn<(command: string, args: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>>(),
    execFileAsync: vi.fn<(cwd: string, command: string, args: readonly string[]) => Promise<string>>(),
}));

vi.mock("tinyexec", () => ({ x: commands.mountpoint }));
vi.mock("../src/utils/execUtils.js", () => ({ execFileAsync: commands.execFileAsync }));

let root: string;

beforeEach(() => {
    const testDir = path.join(process.cwd(), "testDownloads");
    fs.mkdirSync(testDir, { recursive: true });
    root = fs.mkdtempSync(path.join(testDir, "overlay-mountpoint-"));
    commands.mountStatus = 32;
    commands.mountpoint.mockImplementation(async () => ({ exitCode: commands.mountStatus, stdout: "", stderr: "" }));
    commands.execFileAsync.mockResolvedValue("");
});

afterEach(() => {
    vi.useRealTimers();
    commands.mountpoint.mockReset();
    commands.execFileAsync.mockReset();
    fs.rmSync(root, { recursive: true, force: true });
});

it("removes a stale unmounted directory without unmounting or killing processes", async () => {
    fs.mkdirSync(path.join(root, "_", "m"), { recursive: true });

    await using overlay = await createOverlayFS(root, false);

    expect(commands.mountpoint).toHaveBeenCalledWith("mountpoint", ["-q", path.join(root, "_", "m")]);
    expect(commands.execFileAsync.mock.calls.map(([, , args]) => args[0])).toEqual(["rm"]);
    expect(overlay.path).toBe(path.join(root, "base"));
});

it("does not remove a mounted overlay if unmounting fails", async () => {
    fs.mkdirSync(path.join(root, "_", "m"), { recursive: true });
    commands.mountStatus = 0;
    commands.execFileAsync.mockImplementation(async (_cwd, _command, args) => {
        if (args[0] === "umount") throw new Error("busy");
        return "";
    });

    vi.useFakeTimers();
    const cleanup = createOverlayFS(root, false);
    const failure = expect(cleanup).rejects.toThrow("busy");
    await vi.runAllTimersAsync();
    await failure;

    expect(commands.execFileAsync.mock.calls.some(([, , args]) => args[0] === "rm")).toBe(false);
    const fuserCalls = commands.execFileAsync.mock.calls.filter(([, , args]) => args[0] === "fuser");
    expect(fuserCalls).toHaveLength(4);
    expect(fuserCalls.every(([, , args]) => args.includes("-M"))).toBe(true);
});
